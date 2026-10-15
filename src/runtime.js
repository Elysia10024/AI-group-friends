// 运行时基础（锁/日志/状态文件）域：从 bridge.js 的模块级整体搬出来的一个"簇"（9 个互相调用的函数）。
//
// 搬出来的理由：bridge.js 是个巨型文件（main() 曾占 86%），想读这一段得跨过整个文件。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且**在构造点之前**声明的名字走解构；
//   · **可写的**和**在构造点之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）；
//   · 被更早的构造点引用的名字，在那个更早的构造处要包 thunk（`name: (...a) => name(...a)`）。
//
// 正文与搬迁前**逐字相同**，只有上述 14 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
// 锁存活判定（纯函数，6 条单测）：PID 复用会让"PID 还活着"变成一个假信号，见该文件注释。
import { lockLiveness, LOCK_HEARTBEAT_MS } from './core/lock-policy.js';

export function createRuntimeModule(ctx) {
  const {
    ACTIVITY_LOG,
    BRIDGE_LOG,
    STATE_DIR,
    STATE_FILE,
    appendCappedLine,
    atomicWriteText,
    crypto,
    fs,
    path,
    readJsonSafe,
  } = ctx;


// 状态读写基元（readJsonSafe / atomicWriteJson / atomicWriteText）已抽到
// src/core/state-io.js（有 17 条单测，含 BOM、损坏文件、并发写等边界）。
// 所有状态落盘都走这三个函数，共 33 个调用点。

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch { /* 令牌文件读不到就当没有：下面会重新生成并落盘 */ }
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
function appendActivity(line) {
  try {
    const ts = new Date().toISOString().slice(11, 19);
    // 只保留最近 500 行
    appendCappedLine(ACTIVITY_LOG, `[${ts}] ${ctx.redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`, { cap: 500 });
  } catch { /* 写活动日志失败不能影响主流程：日志是旁路，失败就丢掉这一行 */ }
}
function loadState() {
  const loaded = readJsonSafe(STATE_FILE, null);
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') ctx.state = loaded;
  else ctx.state = { sessions: {} };
}
function saveState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ctx.state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(ctx.LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(ctx.LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        let pidAlive = false;
        try {
          process.kill(pid, 0);
          pidAlive = true;
        } catch (error) {
          if (error.code === 'ESRCH') pidAlive = false;
          else process.exit(2);
        }
        // PID 会被系统复用（2026-09-20 早上：重启后锁里的 PID 变成了 SnowLuma，
        // 于是桥每次启动都以为"已有实例在运行"而自杀，watchdog 拉一次死一次）。
        // 所以"活着"还要看**心跳新鲜度**：运行中的桥每 60 秒 touch 一次锁文件。
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(ctx.LOCK_FILE).mtimeMs; } catch { /* 拿不到就按过期处理 */ }
        const liveness = lockLiveness({ pidAlive, mtimeMs });
        if (!liveness.live) {
          stale = true;
          if (pidAlive) console.error(`[bridge] 锁里的 PID ${pid} 虽然活着，但心跳已过期（${liveness.reason}）—— 按过期锁处理（PID 很可能被复用给了别的进程）`);
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${ctx.LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在、为空、或心跳过期），删除后重试…`);
    try { fs.unlinkSync(ctx.LOCK_FILE); } catch { /* 清锁文件是尽力而为：删不掉也继续，下次启动会按 PID 判定过期 */ }
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${ctx.LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}

/**
 * 心跳：把锁文件的 mtime 顶新，证明"持锁的这个进程还活着"。
 * 只在锁确实是自己的时候才 touch —— 免得替别人续命。
 */
function refreshLock() {
  try {
    if (Number(fs.readFileSync(ctx.LOCK_FILE, 'utf8').trim()) !== process.pid) return false;
    const now = new Date();
    fs.utimesSync(ctx.LOCK_FILE, now, now);
    return true;
  } catch {
    return false;   // 心跳失败不影响主流程：真出问题会在下次启动时按过期锁处理
  }
}
function releaseLock() {
  try {
    if (fs.existsSync(ctx.LOCK_FILE) && Number(fs.readFileSync(ctx.LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(ctx.LOCK_FILE);
    }
  } catch { /* 同上：退出时清锁失败不影响退出 */ }
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）
function log(...args) {
  const line = `${new Date().toISOString().slice(11, 19)} [bridge] ${args.map((a) => ctx.redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`.replace(/[\r\n]+/g, ' ');
  console.log(line);
  try {
    appendCappedLine(BRIDGE_LOG, line + '\n', { cap: 2000 });
  } catch { /* 写桥日志失败不能影响主流程：日志是旁路，失败就丢掉这一行 */ }
}
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}


  return { loadOrCreateConsoleToken, readActivityTail, appendActivity, loadState, saveState, acquireLock, releaseLock, refreshLock, log, withTimeout };
}
