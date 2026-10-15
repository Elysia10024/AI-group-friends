// 手机连接（Agents Anywhere）健康巡检 + 私聊告警。
//
// 为什么要它（2026-10-05 事故，见 docs/事故-2026-10-05-手机连接同步卡死.md）：
// 那个超大会话的提交被后端 413 拒绝，Connector 每 9 秒重订阅一次、永远提交不成功，
// 面板只显示「正在同步 DSH 会话…」、手机只显示「启动中」，**静默跑了两个多小时没人知道**。
// 手机连接是独立于 QQ 桥的一条链路，桥的看门狗不管它，所以这里单独巡检。
//
// 用法：
//   node scripts/check-aa-sync.mjs               # 只检查：退出码 0=正常，1=有问题
//   node scripts/check-aa-sync.mjs --alert       # 有问题时私聊主人（带节流 + 恢复通知）
//   node scripts/check-aa-sync.mjs --json        # 机器可读输出
//   node scripts/check-aa-sync.mjs --test-alert  # 立刻发一条测试告警，验证通道
//
// 判定规则（都只看证据，不猜）：
//   1. sync-churn    最近 N 分钟内 sync.stopped ≥3 且 snapshot.completed = 0
//                    → 同步卡死（本次事故的指纹）
//   2. auth-failed   connector.jsonl 最后一条事件是 auth_failed
//                    → 设备凭据失效，需要重新扫码绑定
//   3. connector-down DSH 桌面版在跑、端点文件在，却没有 Connector 进程
//                    → 手机连接整体离线（崩溃或没启动）
//   4. endpoint-missing  Connector 在跑、桌面版在跑，却没有端点记录文件
//                    → "本机连接"没起来（2026-10-08 那次僵尸记录清理之后的形态）
//
// 顺带自愈（2026-10-08 事故）：AA 的端点记录可能留下"主人早就死了"的僵尸文件 —— 里面记的 pid 被
// Windows 回收给了别的进程，于是它会一直以为"另一个 DSH 占着连接"，面板报「本机连接被占用」，
// **重启也没用**。这里在巡检前先跑一次自愈（只清能证明是僵尸的，见 scripts/check-aa-endpoint.mjs）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkAndHealEndpoint, endpointPaths } from './check-aa-endpoint.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会给文件加 BOM，JSON.parse 不认它 —— 真的踩过。
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const CONFIG = (() => {
  try { return JSON.parse(readText(path.join(ROOT, 'config.json'))); } catch { return null; }
})();
if (!CONFIG) {
  // 配置读不出来 = 告警通道也可能是坏的，必须让看门狗看见（ASCII 一行，避免日志里出现乱码）。
  console.log('PROBLEM config-unreadable (config.json 无法解析)');
  process.exit(2);
}
/**
 * AA 的安装目录**搬过家**（2026-10-15 DSH 2.0.9 → 2.0.17）：
 *   旧：`~/.agentsanywhere/dsh-bridge-next`（写这个脚本时的位置）
 *   新：`~/.agents-anywhere/dsh-bridge-next`
 * 两个目录**会并存**，而旧的那份日志从此**冻结**——照旧路径读的后果是：
 * `events.length === 0` → `checkSyncChurn()` 直接 `return null` **静默放行**。
 * 实测：2026-10-15 手机断了几小时，巡检 16 次全报 ok，主人是自己发现的。
 * 所以这里**自动探测**：谁在写日志就用谁（按 `logs/dsh-runtime.jsonl` 的 mtime 选），
 * 以后再搬家也不用改这个脚本。
 */
function resolveAaHome() {
  if (process.env.AA_HOME) return process.env.AA_HOME;
  const candidates = ['.agents-anywhere', '.agentsanywhere']
    .map((name) => path.join(os.homedir(), name, 'dsh-bridge-next'));
  let best = candidates[candidates.length - 1];
  let bestMs = -1;
  for (const dir of candidates) {
    try {
      const m = fs.statSync(path.join(dir, 'logs', 'dsh-runtime.jsonl')).mtimeMs;
      if (m > bestMs) { bestMs = m; best = dir; }
    } catch { /* 这个候选没有日志，跳过 */ }
  }
  return best;
}
const AA = resolveAaHome();
/** 桌面版的 DSH_HOME（AA 的端点记录就在这里）。**故意不看 DSH_HOME**：看门狗启动 QQ 那套内核时会
 *  把它设成 dsh-home-legacy（另一个安装），一路传给子进程 —— 照它找就会去错地方找端点记录。
 *  AA_DSH_HOME 只给测试用（指到临时目录）。 */
const DSH_HOME = process.env.AA_DSH_HOME || path.join(os.homedir(), '.dsh');
const ENDPOINT = endpointPaths(DSH_HOME).file;
const LOGDIR = path.join(ROOT, 'logs');
const STATE = path.join(LOGDIR, 'aa-health.state.json');
const OWNLOG = path.join(LOGDIR, 'aa-health.log');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
};
const WINDOW_MINUTES = Math.max(2, Number(flag('window-minutes', 20)) || 20);
const REPEAT_MINUTES = Math.max(5, Number(flag('repeat-minutes', 30)) || 30);
const WANT_ALERT = flag('alert', false) === true || flag('alert', '') === 'true';
const WANT_JSON = flag('json', false) === true;
const TEST_ALERT = flag('test-alert', false) === true;

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function psLines(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  return String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** 当前 Connector 进程（插件的 Python Connector，命令行里带 connector.json）。 */
function connectorPids() {
  return psLines("Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*connector.json*' } | ForEach-Object { $_.ProcessId }")
    .map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

function desktopRunning() {
  return psLines("Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }").length > 0;
}

// ------------------------------------------------------------------ 判定

function checkSyncChurn() {
  const cutoff = Date.now() - WINDOW_MINUTES * 60 * 1000;
  const events = [
    ...readJsonl(path.join(AA, 'logs', 'dsh-runtime.jsonl')),
    ...readJsonl(path.join(AA, 'logs', 'dsh-runtime.previous.jsonl')),
  ].filter((o) => Date.parse(o.time) >= cutoff);
  if (!events.length) return null;

  const stops = events.filter((o) => o.event === 'sync.stopped' && o.waitingAck !== undefined && o.waitingAck !== null);
  const completed = events.filter((o) => o.event === 'snapshot.completed');
  const inventoryDone = events.filter((o) => o.event === 'sync.inventory_completed');
  if (stops.length < 3 || completed.length > 0 || inventoryDone.length > 0) return null;

  const last = stops[stops.length - 1];
  const lastLocal = new Date(last.time).toLocaleString('zh-CN', { hour12: false });
  return {
    id: 'sync-churn',
    title: '手机连接同步卡死',
    detail: `最近 ${WINDOW_MINUTES} 分钟里有 ${stops.length} 次重订阅、0 次成功提交（最后一次 ${lastLocal}）。`,
    hint: '手机端会一直显示「启动中」。多半又是某个会话的提交被后端拒绝；看 Connector 日志有没有 "snapshot history failed / truncated"。',
  };
}

function checkAuthFailed() {
  const rows = readJsonl(path.join(AA, 'logs', 'connector.jsonl'));
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  if (last.event !== 'auth_failed') return null;
  return {
    id: 'auth-failed',
    title: '手机连接的设备凭据失效',
    detail: `Connector 最后一次状态是 auth_failed（${new Date(last.time).toLocaleString('zh-CN', { hour12: false })}）。`,
    hint: '需要在 DSH 桌面版的「手机连接」面板重新绑定设备（扫码）。',
  };
}

function checkConnectorDown() {
  if (!desktopRunning()) return null;
  if (!fs.existsSync(ENDPOINT)) return null;
  if (connectorPids().length) return null;
  const rows = readJsonl(path.join(AA, 'logs', 'connector.jsonl'));
  const last = rows[rows.length - 1];
  const since = last?.time ? new Date(last.time).toLocaleString('zh-CN', { hour12: false }) : '(无记录)';
  return {
    id: 'connector-down',
    title: '手机连接的 Connector 进程不在',
    detail: `DSH 桌面版在运行，但找不到 Connector 进程；connector.jsonl 最后一条是 ${last?.event ?? '(空)'}（${since}）。`,
    hint: '如果 DSH 桌面版刚重启过，等一分钟再看；否则在「手机连接」面板点「启动 Connector」。',
  };
}

/**
 * 端点记录文件不见了，但 AA 明明在跑（Connector 进程在）：
 * 说明"本机连接"没起来 —— 2026-10-08 那次僵尸记录被我们清掉之后就是这个形态，
 * 面板上会显示「本机连接被占用/无法启动」，需要人去点一下「尝试重启」。
 */
function checkEndpointMissing() {
  if (!connectorPids().length) return null;
  if (!desktopRunning()) return null;
  if (fs.existsSync(ENDPOINT)) return null;
  return {
    id: 'endpoint-missing',
    title: '手机连接的「本机连接」没起来',
    detail: `Connector 进程在跑，但 ${DSH_HOME} 下没有端点记录文件（bridge 没有发布过本机连接）。`,
    hint: '在 DSH 桌面版的「手机连接」面板点「尝试重启」。',
  };
}

/**
 * 规则 5：Connector 进程**在跑**，但它**连不上后端**（日志里 `backend network unavailable`）。
 *
 * 为什么必须单列一条：这种形态下**根本不会发生同步**（连不上就没 sync），
 * 所以 `checkSyncChurn()` 看不到它；而进程又在，`checkConnectorDown()` 也看不到它。
 * 2026-10-15 实测：手机双向断了几小时，前四条规则**全静默**，主人是自己发现的。
 *
 * 那天的真实形态：DSH 升级后**由插件恢复路径拉起**的 Connector 运行环境不完整 ——
 * 每 3 秒重试一条 `backend authentication request failed: All connection attempts failed`，
 * 而与此同时：同一个 venv 手动 `httpx.post('/api/v2/connector/auth')` 是 **HTTP 200**（凭据完全有效）、
 * `connector.json` 的 serverUrl 也正确、网络/DNS/系统代理全正常。
 * **完整重启 DSH Desktop 之后就好了** —— 所以 hint 里第一条就是"别手动结束它"。
 *
 * 数据源注意：`connector-output.json` 是**累积的 JSON 对象**（`{entries:[…]}`），不是 jsonl。
 */
function checkBackendUnreachable() {
  if (!connectorPids().length) return null;   // 进程不在 → 交给 connector-down 那条
  let entries = [];
  try {
    // 去掉可能的 BOM：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会加 BOM，
    // 而 JSON.parse 见 BOM 直接抛错 → 被下面的 catch 吞掉 → **规则静默失效**。
    // （这个坑是我给这条规则造测试数据时自己踩出来的：假数据带 BOM，规则就不报了。
    //  真实文件是 Python 写的、没有 BOM，但守卫不该因为一个字节就闭嘴。）
    const raw = JSON.parse(fs.readFileSync(path.join(AA, 'logs', 'connector-output.json'), 'utf8').replace(/^\uFEFF/, ''));
    entries = Array.isArray(raw) ? raw : (raw.entries ?? []);
  } catch { return null; }
  const cutoff = Date.now() - WINDOW_MINUTES * 60 * 1000;
  const fails = entries.filter((o) => typeof o?.text === 'string'
    && o.text.includes('backend network unavailable')
    && Date.parse(o.time) >= cutoff);
  if (fails.length < 3) return null;
  // 还要"**此刻仍在报**"：故障时它每 3 秒重试一条，所以真在故障的话最后一条必然在几秒内。
  // 若最后一条已经是几分钟前 —— 它自己恢复了，别对着窗口里的旧记录报警。
  // （第一版只数"窗口内累计"，结果恢复后 20 分钟内仍会误报一次；这是上线自检时抓到的。）
  const lastMs = Date.parse(fails[fails.length - 1].time);
  if (!(Date.now() - lastMs < 3 * 60 * 1000)) return null;
  const lastLocal = new Date(fails[fails.length - 1].time).toLocaleString('zh-CN', { hour12: false });
  return {
    id: 'backend-unreachable',
    title: '手机连接的 Connector 连不上后端',
    detail: `最近 ${WINDOW_MINUTES} 分钟里有 ${fails.length} 次 "backend network unavailable"（最后一次 ${lastLocal}）。手机端会显示「设备已离线」，收发都不通。`,
    hint: '**别手动结束 Connector 进程** —— 恢复路径拉起的实例环境可能不完整，只会更糟。先点「手机连接」面板的「重启 Connector」；仍然不行就**完整重启 DSH Desktop**（2026-10-15 就是靠这一步好的）。完整排查见 docs/事故-2026-10-05-手机连接同步卡死.md。',
  };
}

function inspect(heal) {
  const problems = [checkSyncChurn(), checkAuthFailed(), checkConnectorDown(), checkEndpointMissing(), checkBackendUnreachable()].filter(Boolean);
  if (heal?.healed) {
    const note = `（刚自愈：清掉一条僵尸端点记录，原因 ${heal.reason} —— 原记录里的 pid ${heal.evidence?.pid ?? '?'} 已经不是当初写它的那个进程了。）`;
    for (const p of problems) if (['endpoint-missing', 'connector-down', 'sync-churn'].includes(p.id)) p.hint += note;
  }
  return { healthy: problems.length === 0, problems };
}

// ------------------------------------------------------------------ 告警

async function sendOwnerAlert(text) {
  // AA_ALERT_HTTP_URL 只给自检用：让测试把告警指到一个死端口，验证"发不出去也不会假装报过"，
  // 而不必去改真实 config.json（改坏了桥下次重启就起不来）。
  const httpUrl = String(process.env.AA_ALERT_HTTP_URL || CONFIG.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const res = await fetch(`${httpUrl}/send_private_msg`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(CONFIG.snowluma?.accessToken ? { authorization: `Bearer ${CONFIG.snowluma.accessToken}` } : {}),
    },
    body: JSON.stringify({ user_id: Number(CONFIG.ownerQQ), message: [{ type: 'text', data: { text } }] }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot send_private_msg 失败: ${body.wording || body.retcode || res.status}`);
  }
  return true;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    fs.writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {}
}

function appendLog(line) {
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    fs.appendFileSync(OWNLOG, `${new Date().toISOString()}  ${line}\n`, 'utf8');
  } catch {}
}

const alertText = (problem, { repeat = false } = {}) => [
  `⚠️ ${problem.title}。`,
  problem.detail,
  problem.hint,
  repeat
    ? `（这是系统告警，不用回我；同一场故障每 ${REPEAT_MINUTES} 分钟最多再提醒一次，恢复了我会告诉你。）`
    : '（这是系统告警，不用回我；恢复了我会告诉你。）',
].join('\n');

function recoveredText(problem) {
  return `✅ 手机连接恢复正常了（刚才是：${problem.title}）。`;
}

// ------------------------------------------------------------------ 主流程

if (TEST_ALERT) {
  const probe = {
    id: 'test',
    title: '这是一条测试告警（手机连接巡检）',
    detail: '收到就说明告警通道是通的，不是真故障。',
    hint: '',
  };
  await sendOwnerAlert(alertText(probe));
  console.log('✅ 测试告警已私聊发给主人');
  process.exit(0);
}

// 先自愈再巡检：僵尸端点记录会让"本机连接"永远起不来，而它自己不会好（2026-10-08）。
const heal = checkAndHealEndpoint({ home: DSH_HOME, heal: true });
if (heal.healed) appendLog(`HEALED endpoint ${heal.reason} pid=${heal.evidence?.pid ?? '?'} :: ${heal.detail}`);

const status = inspect(heal);
const state = loadState();
const now = Date.now();
const summary = status.healthy
  ? '正常'
  : status.problems.map((p) => `${p.id}: ${p.title}`).join('；');

if (WANT_JSON) {
  console.log(JSON.stringify({ ...status, endpoint: { file: heal.file, action: heal.action, reason: heal.reason, healed: heal.healed }, checkedAt: new Date(now).toISOString(), windowMinutes: WINDOW_MINUTES }, null, 2));
} else {
  // 第一行是给看门狗看的 ASCII 摘要（PowerShell 5.1 抓 node 输出会按 GBK 解码，
  // 中文会变乱码，所以机器读的那行必须只有 ASCII）；细节行给人看，完整记录进 logs\aa-health.log。
  if (status.healthy) console.log(`OK window=${WINDOW_MINUTES}min`);
  for (const p of status.problems) {
    console.log(`PROBLEM ${p.id}`);
    console.log(`❌ ${p.title}`);
    console.log(`   ${p.detail}`);
    if (p.hint) console.log(`   → ${p.hint}`);
  }
  if (status.healthy) console.log(`✅ 手机连接巡检正常（窗口 ${WINDOW_MINUTES} 分钟）`);
}

if (!WANT_ALERT) {
  appendLog(summary);
  process.exit(status.healthy ? 0 : 1);
}

// 节流：第一次立刻报；同一场故障每 REPEAT_MINUTES 分钟最多一次；恢复时报一声。
const sameProblem = !status.healthy && state.problem && state.problem.id === status.problems[0].id;
if (!status.healthy) {
  const problem = status.problems[0];
  const firstSeenAt = sameProblem ? state.firstSeenAt ?? now : now;
  const lastAlertAt = sameProblem ? state.lastAlertAt ?? 0 : 0;
  const due = !sameProblem || now - lastAlertAt >= REPEAT_MINUTES * 60 * 1000;
  if (due) {
    try {
      await sendOwnerAlert(alertText(problem, { repeat: sameProblem }));
      saveState({ problem, firstSeenAt, lastAlertAt: now, alerts: (state.alerts ?? 0) + 1 });
      appendLog(`ALERT ${problem.id} :: ${problem.detail}`);
    } catch (error) {
      // 发不出去（QQ 没开等）时不要假装报过：记一次尝试，下一轮还会试。
      saveState({ problem, firstSeenAt, lastAlertAt: lastAlertAt, alerts: state.alerts ?? 0, lastSendError: String(error?.message ?? error) });
      appendLog(`ALERT-FAILED ${problem.id} :: ${error?.message ?? error}`);
    }
  } else {
    appendLog(`hold ${problem.id} (last alert ${Math.round((now - lastAlertAt) / 60000)} min ago)`);
  }
  process.exit(1);
}

if (state.problem) {
  try {
    await sendOwnerAlert(recoveredText(state.problem));
    appendLog(`RECOVERED ${state.problem.id}`);
  } catch (error) {
    appendLog(`RECOVER-FAILED ${state.problem.id} :: ${error?.message ?? error}`);
  }
  saveState({});
} else {
  appendLog('ok');
}
process.exit(0);
