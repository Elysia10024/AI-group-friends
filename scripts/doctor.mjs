#!/usr/bin/env node
// doctor.mjs —— 一条命令体检整条链路。
//
// 存在的唯一理由：回答「我明明改了，怎么没生效？」
// 这个项目有四个各自独立的进程和一堆「改了要重启谁」的隐式知识：
//   SnowLuma（QQ 协议）→ 桥（Node）→ DSH 内核（另一个 Node）→ 控制台
// 改一个文件之后忘了重启对应的进程，症状往往只是「她今天有点怪」——
// 靠群里观察发现不了，靠人肉回想更不可靠。所以让机器来记时间线。
//
// 用法：
//   npm run doctor          # 体检
//   node scripts/doctor.mjs # 同上
// 退出码：有 ❌ 时 1，否则 0（可安全地接进脚本）。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { snowlumaStatus, DEFAULT_SNOWLUMA_DIR, PATCHED_VERSION } from '../patches/snowluma/check.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');            // qq-bridge-main
const REPO = path.resolve(ROOT, '..');            // <项目根>

const BRIDGE_SRC = path.join(ROOT, 'src', 'bridge.js');
const SRC_DIR = path.join(ROOT, 'src');
const CONFIG = path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const BRIDGE_LOCK = path.join(STATE_DIR, 'bridge.lock');
const WATCHDOG_LOG = path.join(REPO, 'logs', 'watchdog.log');
const PRESET_SRC = path.join(ROOT, 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
const PRESET_DST = path.join(REPO, 'dsh-home-legacy', '.agent-presets', 'qq-chat-v2', 'agent.cordis.yml');
// 速记的**真实源头**：2026-09-30 人设重构后是 roles/<角色>/速记.core.md（层叠结构）。
// 这里原来还写着旧路径 `roles/小鲸鱼.速记.md`（已归档进 archive/roles-legacy-2026-09-30/）——
// 文件不存在 → mtime 返回 null → 「内核人设新鲜度」那条**永远不会红**，静默失效了 12 天
// （2026-10-12 加说说时发现：速记明明改在 23:23、内核 18:11 起，体检却报"没有更新的改动"）。
const DIGEST = path.join(ROOT, 'roles', '小鲸鱼', '速记.core.md');
const SNOWLUMA_DIR = process.env.SNOWLUMA_DIR || DEFAULT_SNOWLUMA_DIR;

const PORTS = [
  [3080, 'DSH 内核'],
  [3000, 'SnowLuma OneBot HTTP'],
  [3001, 'SnowLuma OneBot WS'],
  [3100, '桥控制台'],
  [5099, 'SnowLuma WebUI']
];

// ---------------------------------------------------------------- 小工具

const results = [];
const add = (level, label, detail = '') => results.push({ level, label, detail });

/** mtime（毫秒）；文件不存在返回 null。 */
function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return null; }
}

function fmt(ms) {
  if (ms == null) return '(无)';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 把毫秒差说成人话。 */
function ago(ms, now = Date.now()) {
  if (ms == null) return '(无)';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s} 秒前`;
  if (s < 5400) return `${Math.round(s / 60)} 分钟前`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} 小时前`;
  return `${(s / 86400).toFixed(1)} 天前`;
}

function walk(dir, filter, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

function probe(port, host = '127.0.0.1', timeout = 1500) {
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

/**
 * SnowLuma 的启动时间只能从它自己的日志里找，这里踩过两个坑：
 *   - watchdog 只在**它亲自**拉起进程时才记一行，手动重启不留痕（旧实现因此误报「补丁没生效」）；
 *   - logs/snowluma.out.log 是某一种启动方式的 stdout 重定向，换启动方式后就不再更新，
 *     它的 mtime 会永远停在某个过去的时刻。
 * SnowLuma/logs/snowluma-YYYY-MM-DD.log 每次启动都会写 `[App] SnowLuma starting`，
 * 行里只有时间、没有日期，日期得从文件名补。
 */
function lastSnowLumaStart() {
  const dir = path.join(SNOWLUMA_DIR, 'logs');
  let files;
  try {
    files = fs.readdirSync(dir).filter((n) => /^snowluma-\d{4}-\d{2}-\d{2}\.log$/.test(n));
  } catch {
    return null;
  }
  let best = null;
  for (const n of files) {
    const date = n.slice('snowluma-'.length, 'snowluma-'.length + 10);   // YYYY-MM-DD
    let text;
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    const re = /^(\d{2}:\d{2}:\d{2})\s+.*\[App\] SnowLuma starting/gm;
    let m;
    while ((m = re.exec(text))) {
      const t = new Date(`${date}T${m[1]}`).getTime();
      if (!Number.isNaN(t) && (best == null || t > best.at)) best = { at: t, file: n };
    }
  }
  return best;
}

/**
 * 从 watchdog 日志里取每个进程最后一次被拉起的本地时间。
 * 格式：`2026-09-17 23:41:22  DSH (3080) DOWN -> starting`
 * 注意：只有 watchdog 主动重启才会留痕；手动 Start-Process 起的进程这里看不到，
 * 所以桥的时间改用 state/bridge.lock 的 mtime（启动时写入，一定准），
 * SnowLuma 用自己的日志（见 lastSnowLumaStart）。
 */
function lastStarts() {
  const out = {};
  let text;
  try { text = fs.readFileSync(WATCHDOG_LOG, 'utf8'); } catch { return out; }
  const re = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(DSH|bridge|SnowLuma)\s+\((\d+)\)\s+DOWN -> starting/gm;
  let m;
  while ((m = re.exec(text))) {
    const t = new Date(m[1].replace(' ', 'T')).getTime();   // 无时区 = 本地时间
    if (!Number.isNaN(t)) out[m[2]] = { at: t, port: Number(m[3]), line: m[0] };
  }
  return out;
}

// ---------------------------------------------------------------- 体检项

async function checkPorts() {
  const ups = await Promise.all(PORTS.map(([p]) => probe(p)));
  PORTS.forEach(([p, name], i) => {
    add(ups[i] ? 'ok' : 'bad', `${String(p).padEnd(5)} ${name}`, ups[i] ? '' : '连不上 —— 这个进程没在跑');
  });
}

function checkSnowluma() {
  const st = snowlumaStatus(SNOWLUMA_DIR);
  if (st.missingFile) {
    add('bad', 'SnowLuma 补丁', `找不到 ${st.index}`);
    return;
  }
  const miss = st.results.filter((r) => !r.ok);
  if (miss.length) {
    add('bad', 'SnowLuma 补丁', `${miss.length}/${st.results.length} 项标志串丢失（${miss.map((r) => r.name).join('、')}）→ 红包会退化成假红包嘲讽`);
  } else {
    add('ok', 'SnowLuma 补丁', `${st.results.length} 项标志串齐全（版本 ${st.version}）`);
  }
  if (st.version !== PATCHED_VERSION) {
    add('warn', 'SnowLuma 版本', `打补丁时是 ${PATCHED_VERSION}，现在是 ${st.version}；确认红包仍正常后更新 check.mjs 里的 PATCHED_VERSION`);
  }
}

// 她的规则里引用的工具名必须真实存在（工具删了/改名了，规则文本没人管 —— 实测踩过：
// qq_mark_read / qq_get_unread_messages 被删后规则里还留着 28 处引用，她每次调都失败）。
function checkToolRefs() {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-tool-refs.mjs')], { encoding: 'utf8' });
    const first = out.trim().split('\n')[0] ?? '';
    add('ok', '规则引用工具', first);
  } catch (error) {
    const detail = String(error?.stdout ?? '').split('\n').filter((l) => l.trim().startsWith('·')).slice(0, 3).join('；');
    add('bad', '规则引用工具', `规则里引用了不存在的工具（她调了只会失败）：${detail || '见 npm run check:tool-refs'}`);
  }
}

function checkFreshness(now, starts) {
  // --- 桥：改了 src/ 但没重启桥 ---
  //
  // 这里**只比 src/**/*.js**，不比 config.json。原因：config.json 是桥自己会写的
  // （/api/whitelist、/api/security、/api/socialV2/config 都会落盘并同步内存里的 cfg），
  // 所以「config.json 比桥启动新」既可能来自控制台写入（已热更新，不用重启），
  // 也可能来自手改（要重启）—— 光看 mtime **判不出来**。
  // 早期版本把它算进这条检查并断言"改动没进内存，需要重启桥"，对控制台写入是假警报
  // （跑一次 npm run test:console:writes 就会触发）。判不出来的事就别断言，
  // 改成下面单独一行备忘，把信息给出来但不冒充结论。
  const bridgeStart = mtime(BRIDGE_LOCK);
  const srcs = walk(SRC_DIR, (p) => p.endsWith('.js') && !p.endsWith('.test.js'));
  let newest = null;
  for (const f of srcs) {
    const t = mtime(f);
    if (t != null && (newest == null || t > newest.at)) newest = { at: t, file: f };
  }
  const cfgT = mtime(CONFIG);

  if (bridgeStart == null) {
    add('warn', '桥代码新鲜度', 'state/bridge.lock 不存在 —— 桥可能没在跑，或换过运行方式');
  } else if (newest && newest.at > bridgeStart + 2000) {
    const rel = path.relative(ROOT, newest.file);
    add('warn', '桥代码新鲜度', `${rel} 改于 ${fmt(newest.at)}（${ago(newest.at, now)}），晚于桥启动 ${fmt(bridgeStart)} → 改动没进内存，需要重启桥`);
  } else {
    add('ok', '桥代码新鲜度', `桥启动于 ${fmt(bridgeStart)}（${ago(bridgeStart, now)}），src/ 里没有更新的改动`);
  }

  // config.json 单独给一条备忘（判不出是谁改的，所以不冒充结论）：
  // 控制台写入会同步内存里的 cfg（不用重启），手改则需要重启。
  if (cfgT != null && bridgeStart != null && cfgT > bridgeStart + 2000) {
    add('info', 'config.json 改于', `${fmt(cfgT)}（${ago(cfgT, now)}），晚于桥启动 —— 控制台写入会热更新、不用重启；若是手改的则需要重启桥`);
  }

  // --- 内核：改了速记，但没重启内核 ---
  // 用速记（人真正编辑的源头）而不是 preset 的 mtime：apply-persona 即使内容没变也会重写 preset，
  // 拿 preset 比会把「刚跑过一次同步」误报成「内核没重启」。
  const dsh = starts.DSH;
  const digestT = mtime(DIGEST);
  if (!dsh) {
    add('warn', '内核人设新鲜度', 'watchdog 日志里没有 DSH 重启记录，无法判断内核是什么时候起的');
  } else if (digestT == null) {
    // 判据的文件都不在，这条检查等于没做 —— 必须说出来（上一次就是这么静默失效 12 天的）。
    add('bad', '内核人设新鲜度', `找不到速记文件 ${path.relative(ROOT, DIGEST)} —— 这条检查是空转的，先修路径`);
  } else if (digestT > dsh.at + 2000) {
    add('warn', '内核人设新鲜度', `速记改于 ${fmt(digestT)}，晚于内核启动 ${fmt(dsh.at)} → 内核跑的还是旧人设，需要 node ../scripts/apply-persona.mjs --restart`);
  } else {
    add('ok', '内核人设新鲜度', `内核启动于 ${fmt(dsh.at)}（${ago(dsh.at, now)}），速记没有更新的改动`);
  }

  // --- SnowLuma：改了 index.mjs（打补丁），但没重启 SnowLuma ---
  const sl = lastSnowLumaStart();
  const idxT = mtime(path.join(SNOWLUMA_DIR, 'index.mjs'));
  if (!sl) {
    add('warn', 'SnowLuma 新鲜度', 'SnowLuma/logs 里找不到启动记录，无法判断进程里跑的是哪版代码');
  } else if (idxT == null) {
    add('warn', 'SnowLuma 新鲜度', `找不到 ${path.join(SNOWLUMA_DIR, 'index.mjs')}`);
  } else if (idxT > sl.at + 2000) {
    add('warn', 'SnowLuma 新鲜度', `index.mjs 改于 ${fmt(idxT)}，晚于 SnowLuma 启动 ${fmt(sl.at)} → 补丁可能只在磁盘上，进程里还是旧代码`);
  } else {
    add('ok', 'SnowLuma 新鲜度', `SnowLuma 启动于 ${fmt(sl.at)}（${ago(sl.at, now)}），补丁文件没有更新的改动`);
  }
}

function checkPresetSync() {
  for (const [label, f] of [['源 preset', PRESET_SRC], ['部署 preset', PRESET_DST]]) {
    if (!fs.existsSync(f)) { add('bad', '预设同步', `${label} 不存在：${f}`); return; }
  }
  const a = sha256(PRESET_SRC);
  const b = sha256(PRESET_DST);
  if (a === b) {
    add('ok', '预设同步', `源与内核部署副本一致（${(fs.statSync(PRESET_SRC).size / 1024).toFixed(1)} KB）`);
  } else {
    add('bad', '预设同步', '源 preset 与 dsh-home-legacy 里的部署副本不一致 → 改了 preset 但没跑 node ../scripts/apply-persona.mjs（脚本在仓库外一层，不在 scripts/ 里）');
  }
}

function checkConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    add('bad', 'config.json', `解析失败：${e.message}`);
    return;
  }

  const problems = [];
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const v2send = cfg.socialV2?.send;
  const v2wake = cfg.socialV2?.wake;

  if (!String(cfg.ownerQQ ?? '').match(/^\d{5,12}$/)) problems.push(`ownerQQ 不像 QQ 号：${JSON.stringify(cfg.ownerQQ)}`);
  if (!Array.isArray(cfg.allow?.groups) || !cfg.allow.groups.length) problems.push('allow.groups 为空 —— 谁都不会被回');
  if (!num(v2send?.maxSendPerHour) || v2send.maxSendPerHour <= 0) problems.push('socialV2.send.maxSendPerHour 不是正整数');
  if (!num(v2send?.maxSendPerMinute) || v2send.maxSendPerMinute <= 0) problems.push('socialV2.send.maxSendPerMinute 不是正整数');
  if (num(v2send?.maxSendPerHour) && num(v2send?.maxSendPerMinute) && v2send.maxSendPerMinute > v2send.maxSendPerHour) {
    problems.push('maxSendPerMinute 大于 maxSendPerHour —— 每小时上限永远先触发');
  }
  if (typeof v2wake?.policy !== 'string' || !v2wake.policy) problems.push('socialV2.wake.policy 不是非空字符串');
  if (cfg.socialV2?.enabled === false && cfg.social?.proactiveEnabled === false) problems.push('socialV2 与 social 都关着 —— 她不会说话');

  if (problems.length) add('bad', 'config.json', problems.join('；'));
  else add('ok', 'config.json', `解析正常，ownerQQ=${cfg.ownerQQ}、限流 ${v2send.maxSendPerMinute}/分 · ${v2send.maxSendPerHour}/时、唤醒策略 ${v2wake.policy}`);
}

function checkState() {
  const jsonFiles = fs.existsSync(STATE_DIR)
    ? fs.readdirSync(STATE_DIR).filter((n) => n.endsWith('.json')).map((n) => path.join(STATE_DIR, n))
    : [];

  const broken = [];
  const empties = [];
  for (const f of jsonFiles) {
    try {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === 0) empties.push(path.basename(f));
    } catch (e) {
      broken.push(`${path.basename(f)}（${e.message}）`);
    }
  }

  if (broken.length) add('bad', '状态文件', `解析失败：${broken.join('、')}`);
  else if (empties.length) add('warn', '状态文件', `${empties.length} 个文件是空对象（${empties.join('、')}）—— 可能被写坏了`);
  else add('ok', '状态文件', `${jsonFiles.length} 个 JSON 全部可解析`);

  // BUG-003 的痕迹：saveState 用固定临时名，进程被杀就会留下 .tmp 垃圾
  const tmps = walk(STATE_DIR, (p) => p.endsWith('.tmp'));
  if (tmps.length) add('warn', '状态临时文件', `残留 ${tmps.length} 个 .tmp（${tmps.slice(0, 3).map((p) => path.basename(p)).join('、')}${tmps.length > 3 ? ' …' : ''}）—— BUG-003 的痕迹，可安全删除`);

  const token = path.join(STATE_DIR, 'console-token');
  if (!fs.existsSync(token)) add('warn', '控制台令牌', 'state/console-token 不存在 —— 首个访问控制台的请求会重新生成');
}

function checkLock(starts) {
  try {
    const pid = fs.readFileSync(BRIDGE_LOCK, 'utf8').trim();
    if (/^\d+$/.test(pid)) add('info', '桥 PID', `${pid}（停桥用：Stop-Process -Id ${pid}）`);
  } catch { /* 缺失已在新鲜度里提过 */ }
  const sl = lastSnowLumaStart();
  if (sl) add('info', 'SnowLuma 启动于', fmt(sl.at));
  if (starts.DSH) add('info', '内核启动于', fmt(starts.DSH.at));
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const now = Date.now();
  const starts = lastStarts();

  console.log('qq-bridge 体检   ' + new Date(now).toLocaleString('zh-CN'));
  console.log('='.repeat(64));

  const mark = () => results.length;

  console.log('\n-- 端口与进程 --');
  await checkPorts();
  printFrom(0);

  let from = mark();
  checkFreshness(now, starts);
  checkPresetSync();
  checkSnowluma();
  checkToolRefs();
  console.log('\n-- 改动是否生效 --');
  printFrom(from);

  from = mark();
  checkConfig();
  checkState();
  console.log('\n-- 配置与状态 --');
  printFrom(from);

  from = mark();
  checkLock(starts);
  if (results.length > from) {
    console.log('\n-- 备忘 --');
    printFrom(from);
  }

  const bad = results.filter((r) => r.level === 'bad').length;
  const warn = results.filter((r) => r.level === 'warn').length;
  console.log('\n' + '='.repeat(64));
  if (bad) {
    console.log(`❌ ${bad} 个问题${warn ? `、${warn} 个提醒` : ''} —— 上面标 ❌ 的先处理`);
    process.exit(1);
  }
  if (warn) {
    console.log(`⚠️  没有硬故障，但有 ${warn} 个提醒（多半是「改了没重启」）`);
    return;
  }
  console.log('✅ 全链路正常');
}

// 分段打印：这些小节在收集时并不知道自己属于哪一段，按范围切。
function printFrom(from) {
  for (const r of results.slice(from)) {
    const icon = r.level === 'ok' ? '✅' : r.level === 'warn' ? '⚠️ ' : r.level === 'bad' ? '❌' : '·';
    console.log(`  ${icon} ${r.label.padEnd(28)} ${r.detail}`.trimEnd());
  }
}

main().catch((e) => {
  console.error('体检脚本自己崩了：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
