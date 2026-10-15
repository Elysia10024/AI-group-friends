// 重启桥，并且**在启动失败时把原因说出来**。
//
// 为什么需要它：手动 `Start-Process node src/bridge.js -WindowStyle Hidden` 不重定向
// stderr，桥一旦启动即崩（比如 import 了一个不存在的导出），报错就跟着进程一起消失，
// 表面现象只是「控制台端口没了」—— 于是排查从「读一行报错」变成「猜哪里坏了」。
// 这个脚本把 stderr 落到 logs/bridge.err.log，并在端口/接口没起来时把它打出来。
//
// 用法：
//   npm run restart          # 停旧桥 → 起新桥 → 等到控制台真的能应答
//   node scripts/restart-bridge.mjs --timeout 40000
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REPO = path.resolve(ROOT, '..');
const LOG_DIR = path.join(REPO, 'logs');
const LOCK = path.join(ROOT, 'state', 'bridge.lock');
const CONSOLE_TOKEN = path.join(ROOT, 'state', 'console-token');
const PORT = 3100;

const arg = process.argv.find((a) => a === '--timeout' || a.startsWith('--timeout='));
const TIMEOUT = arg
  ? Number(arg.includes('=') ? arg.split('=')[1] : process.argv[process.argv.indexOf(arg) + 1]) || 30000
  : 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (ok) => { if (done) return; done = true; s.destroy(); resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

/** 轮转日志，保留上一轮（与 watchdog 的 *.prev.log 约定一致）。 */
function rotate(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) fs.renameSync(file, file.replace(/\.log$/, '.prev.log'));
    else fs.rmSync(file, { force: true });
  } catch { /* 轮转失败不影响启动 */ }
}

function tailText(file, maxLines = 25, fromByte = 0) {
  try {
    const text = fs.readFileSync(file, 'utf8').slice(fromByte);
    const lines = text.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}

/**
 * 当前所有 `src/bridge.js` 进程的 PID（含本脚本刚拉起的那个）。
 * 用 PowerShell 查，因为 Windows 上拿"某个端口归谁 / 谁的命令行长什么样"没有更轻的办法。
 * 注意匹配串写成 `bridge.js` 而不是带路径分隔符的版本：JS 字符串里的 `\b` 是退格符，容易踩坑。
 */
function bridgePids() {
  const cmd = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
    + "Where-Object { $_.CommandLine -like '*bridge.js*' } | "
    + 'ForEach-Object { $_.ProcessId }';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  return String(r.stdout || '')
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** 谁在监听这个端口（没人在听 / 查不到时返回 null）。 */
function portOwnerPid(port) {
  const cmd = `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | `
    + 'Select-Object -First 1 -ExpandProperty OwningProcess)';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' });
  const pid = Number(String(r.stdout || '').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// ---------------------------------------------------------------- 1) 停

console.log('== 停旧桥 ==');
let stopped = [];
try {
  const raw = fs.readFileSync(LOCK, 'utf8').trim();
  if (/^\d+$/.test(raw)) {
    const pid = Number(raw);
    // **绝不能只凭锁里的 PID 就杀进程**：PID 会被系统复用 —— 2026-09-20 早上实测，
    // 锁里记的 PID 变成了 SnowLuma 的进程，照着杀就会把 QQ 接入层干掉。
    // 只有"这个 PID 确实是 bridge.js 进程"时才动它。
    const isBridge = bridgePids().includes(pid);
    if (alive(pid) && isBridge) {
      process.kill(pid, 'SIGKILL');
      stopped.push(pid);
      console.log(`   已终止 PID ${pid}`);
    } else if (alive(pid)) {
      console.log(`   bridge.lock 里的 PID ${pid} 还活着，但不是 bridge.js 进程（PID 被复用）—— 不动它，按过期锁处理`);
    } else {
      console.log(`   bridge.lock 里的 PID ${pid} 已经不在（上次是崩溃退出的）`);
    }
  }
} catch {
  console.log('   没有 bridge.lock，按“本来就没在跑”处理');
}
if (!stopped.length) console.log('   没有需要终止的进程');

// ---------------------------------------------------------------- 1.5) 排重（必须在起新桥之前）
//
// watchdog 每 45 秒 poll 一次，判活只看「3100 端口开不开」。本脚本杀旧桥之后端口会空几百毫秒，
// 正好撞上它的 poll → 它拉起**第二个桥**。两个桥同时连 DSH 事件流 = 同一条消息处理两遍
// （双份回复、双份 token）。所以起新桥之前先把所有 bridge.js 进程收干净 ——
// 留在起桥之后再杀是没用的：新桥那时已经 bind 失败（EADDRINUSE），
// 而"接口能应答"的检查会被旧实例骗过去（它答得好好的）。
const strays = bridgePids();
if (strays.length) {
  console.log(`== 清理多余实例 ==\n   发现 ${strays.length} 个 bridge.js 进程：${strays.join(', ')} —— 全部终止`);
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经死了 */ } }
  await sleep(500);
}

// 等到端口真的释放
for (let i = 0; i < 20; i++) {
  if (!(await portOpen(PORT))) break;
  await sleep(300);
}
if (await portOpen(PORT)) {
  console.log(`   ⚠️ ${PORT} 仍然被占用 —— 可能有另一个非 bridge.lock 记录的进程，先手动确认`);
}

// ---------------------------------------------------------------- 2) 起

console.log('== 起新桥 ==');
fs.mkdirSync(LOG_DIR, { recursive: true });
const OUT = path.join(LOG_DIR, 'bridge.out.log');
const ERR = path.join(LOG_DIR, 'bridge.err.log');
rotate(OUT);
rotate(ERR);

const fdOut = fs.openSync(OUT, 'a');
const fdErr = fs.openSync(ERR, 'a');
const child = spawn(process.execPath, ['src/bridge.js'], {
  cwd: ROOT,
  detached: true,
  stdio: ['ignore', fdOut, fdErr],
  windowsHide: true
});
console.log(`   已拉起 PID ${child.pid}`);

// ---------------------------------------------------------------- 3) 等到真的能用

console.log(`== 等控制台应答（最多 ${TIMEOUT / 1000}s）==`);
let ready = false;
let exitCode = null;
child.on('exit', (code) => { exitCode = code; });

const deadline = Date.now() + TIMEOUT;
while (Date.now() < deadline) {
  if (exitCode !== null) break;
  if (await portOpen(PORT)) {
    // 端口开了还不够，接口得真的能答 —— 控制台坏掉时端口照样是开的
    try {
      const token = fs.readFileSync(CONSOLE_TOKEN, 'utf8').trim();
      const res = await fetch(`http://127.0.0.1:${PORT}/api/status`, {
        headers: { 'x-console-token': token },
        signal: AbortSignal.timeout(3000)
      });
      if (res.ok) { ready = true; break; }
    } catch { /* 还没起来，继续等 */ }
  }
  await sleep(500);
}

if (ready) {
  const token = fs.readFileSync(CONSOLE_TOKEN, 'utf8').trim();
  console.log(`   ✅ 控制台已应答（${PORT}），PID ${child.pid}`);
  console.log(`   令牌前缀 ${token.slice(0, 8)}…`);

  // ---------------------------------------------------------------- 3.5) 收尾：验归属 + 修锁
  //
  // 只验"接口能应答"是不够的（2026-09-19 实测）：旧实例还在监听时它照样答 200，
  // 于是脚本会报告成功，而刚起的这个桥其实 bind 失败、控制台是空的。
  // 必须验**端口归谁**。锁同理：抢输的实例退出时会 releaseLock 删掉自己的锁，
  // 结果活着的桥反而没有锁，单实例保护静默失效（doctor 只 warn）。
  const owner = portOwnerPid(PORT);
  if (owner !== child.pid) {
    console.error(`   ❌ ${PORT} 的持有者是 PID ${owner ?? '未知'}，不是刚起的 ${child.pid} —— 控制台没起来`);
    console.error('   处置：npm run restart 再来一次（脚本会先清掉多余实例再起桥）');
    try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已经死了 */ }
    process.exit(1);
  }
  let lockPid = null;
  try { lockPid = Number(fs.readFileSync(LOCK, 'utf8').trim()); } catch { /* 没有锁文件 */ }
  if (lockPid !== child.pid) {
    fs.writeFileSync(LOCK, String(child.pid), { mode: 0o600 });
    console.log(`   🔒 单实例锁已修正为 PID ${child.pid}（原值 ${lockPid ?? '缺失'}）`);
  }

  console.log('\n桥日志尾部：');
  console.log(tailText(path.join(ROOT, 'state', 'bridge.log'), 6).split('\n').map((l) => '   ' + l).join('\n'));
  child.unref();
  fs.closeSync(fdOut);
  fs.closeSync(fdErr);
  process.exit(0);
}

// ---------------------------------------------------------------- 4) 失败：把原因说出来

console.error(`\n❌ 桥没起来（等了 ${TIMEOUT / 1000}s）`);
if (exitCode !== null) console.error(`   进程已退出，exit code = ${exitCode}`);
else console.error('   进程还活着，但控制台不应答');

const err = tailText(ERR, 30);
if (err) {
  console.error('\n---- logs/bridge.err.log ----');
  console.error(err.split('\n').map((l) => '   ' + l).join('\n'));
} else {
  console.error('\n   logs/bridge.err.log 是空的 —— 启动失败可能发生在更早（比如模块解析）。');
}
const out = tailText(OUT, 15);
if (out) {
  console.error('\n---- logs/bridge.out.log ----');
  console.error(out.split('\n').map((l) => '   ' + l).join('\n'));
}

try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已经死了 */ }
process.exit(1);
