// 手机连接（Agents Anywhere）僵尸记录的自愈：清理 `endpoint.json` 里那条"主人早就死了"的记录。
//
// 事故与判定原则见 src/core/aa-endpoint.js 顶部（**只有能证明的才清，证据不足一律放过**）。
// 这里只负责"取证 + 落地"：
//   1. 读文件（内容、写入时间）；
//   2. 用 PowerShell 查一次进程（名字/命令行/启动时间）——查不到就说查不到，绝不当成"没人"；
//   3. 交给纯函数判定；
//   4. 允许清理时：**先比对再改名**（CAS），改名后回读归档内容，若不是我们判定过的那些字节就搬回去
//      （宁可放弃清理，也不误删并发发布出来的新记录）。
//
// 用法：
//   node scripts/check-aa-endpoint.mjs                # 只检查（不改动）：有僵尸记录 → 退出码 1
//   node scripts/check-aa-endpoint.mjs --heal         # 检查并自愈（归档僵尸记录）
//   node scripts/check-aa-endpoint.mjs --json         # 机器可读
//   node scripts/check-aa-endpoint.mjs --home=<路径>   # 指定 DSH_HOME（测试用；默认 ~/.dsh）
//
// 输出第一行是 ASCII 摘要（给看门狗/脚本读）：`OK ...` / `HEALED ...` / `PROBLEM ...`。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideEndpoint, archiveName } from '../src/core/aa-endpoint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LOGDIR = path.join(ROOT, 'logs');
const LOGFILE = path.join(LOGDIR, 'aa-endpoint.log');

function resolveHome(argv) {
  const flag = argv.find((a) => a.startsWith('--home='));
  if (flag) return flag.slice('--home='.length);
  // AA 的"本机连接"是 **DSH 桌面版**的东西，它的 home 固定是 ~/.dsh。
  // **故意不看 DSH_HOME**：看门狗在启动 QQ 那套内核时会把它设成 dsh-home-legacy（另一个安装），
  // 这个环境变量会一路传给子进程 —— 照它找就会去错的地方找端点记录，检查变成永远"没事"。
  return process.env.AA_DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function endpointPaths(home) {
  const dir = path.join(home, 'agents-anywhere', 'bridge');
  return { dir, file: path.join(dir, 'endpoint.json') };
}

/**
 * 查进程：返回 {pid,name,commandLine,startedAtMs} / null（确实没有这个进程）/ undefined（查询失败）。
 * **undefined 与 null 的区别是这个模块的命根子**：前者是"没证据"，后者是"证明它死了"。
 *
 * 两个坑都踩过（2026-10-08）：
 *   · 脚本用 `; ` 拼成一行时，`… }; else { … }` 会被 PowerShell 判成语法错（`;` 把 if 语句截断了），
 *     结果 stdout 正常但退出码 1 —— 于是判定被当成"查不到"，自愈永远不触发（fail-safe 生效了，但也瞎了）；
 *   · 命令行里带引号/中文时，从 Node 传参容易被转义搞坏：改用 -EncodedCommand（base64 UTF-16LE）。
 */
export function queryProcess(pid, { timeoutMs = 15000 } = {}) {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue`,
    'if ($p) {',
    '  [pscustomobject]@{ pid = [int]$p.ProcessId; name = $p.Name; cmd = $p.CommandLine; started = (Get-Date $p.CreationDate -Format o) } | ConvertTo-Json -Compress',
    '} else {',
    "  'null'",
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', timeout: timeoutMs });
  const out = String(r.stdout ?? '').trim();
  if (r.error || r.status !== 0 || !out) {
    return { proc: undefined, error: r.error ? String(r.error.message ?? r.error) : `powershell exit ${r.status}, stdout=${out.slice(0, 80)}` };
  }
  const lastLine = out.split(/\r?\n/).filter(Boolean).pop() ?? '';
  if (lastLine === 'null') return { proc: null, error: null };
  try {
    const o = JSON.parse(lastLine);
    const startedAtMs = o.started ? Date.parse(o.started) : NaN;
    return {
      proc: { pid: Number(o.pid), name: o.name ?? null, commandLine: o.cmd ?? null, startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null },
      error: null,
    };
  } catch (error) {
    return { proc: undefined, error: `无法解析进程查询输出：${String(lastLine).slice(0, 80)}（${error?.message ?? error}）` };
  }
}

function appendLog(line) {
  try {
    fs.mkdirSync(LOGDIR, { recursive: true });
    fs.appendFileSync(LOGFILE, `${new Date().toISOString()}  ${line}\n`, 'utf8');
  } catch { /* 日志写不进去不能影响判断 */ }
}

/**
 * 检查（可选自愈）一个 DSH_HOME 下的 AA 端点记录。
 * @returns {{home:string,file:string,exists:boolean,action:string,reason:string,detail:string,evidence:object,
 *            healed:boolean,archivedTo:string|null,error:string|null,restored:boolean}}
 */
export function checkAndHealEndpoint({ home = resolveHome([]), heal = false, nowMs = Date.now() } = {}) {
  const { dir, file } = endpointPaths(home);
  const result = { home, file, exists: false, action: 'none', reason: 'no-endpoint-file', detail: '', evidence: {}, healed: false, archivedTo: null, error: null, restored: false };

  let stat = null;
  let raw = null;
  try {
    stat = fs.statSync(file);
    raw = fs.readFileSync(file, 'utf8');
    result.exists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      result.action = 'keep';
      result.reason = 'read-failed';
      result.detail = `读 endpoint.json 失败：${error?.message ?? error}`;
      result.error = String(error?.message ?? error);
      return result;
    }
  }
  if (result.exists && stat && stat.isDirectory()) {
    result.action = 'keep';
    result.reason = 'path-is-directory';
    result.detail = `${file} 是个目录（不是文件），不碰`;
    return result;
  }

  const parsedPid = (() => {
    try { return Number(JSON.parse(raw)?.pid); } catch { return NaN; }
  })();
  const needProc = result.exists && Number.isSafeInteger(parsedPid) && parsedPid > 0;
  const q = needProc ? queryProcess(parsedPid) : { proc: null, error: null };
  if (q.error) appendLog(`proc-query-failed pid=${parsedPid} :: ${q.error}`);

  const decision = decideEndpoint({
    exists: result.exists,
    raw,
    mtimeMs: stat ? stat.mtimeMs : null,
    nowMs,
    proc: needProc ? q.proc : null,
    procQueryError: q.error,
  });
  Object.assign(result, { action: decision.action, reason: decision.reason, detail: decision.detail, evidence: decision.evidence });
  if (decision.action !== 'heal' || !heal) return result;

  // ---- 落地：CAS 改名（只在字节完全一致时动手），改完回读校验，错了就搬回去 ----
  try {
    const again = fs.readFileSync(file, 'utf8');
    if (again !== raw) {
      result.action = 'keep';
      result.reason = 'changed-under-us';
      result.detail = '准备清理的瞬间文件被改写了（多半是 bridge 正在发布新记录），本次放弃，下次再看';
      return result;
    }
    const base = path.join(dir, archiveName({ pid: decision.evidence?.pid ?? 0, reason: decision.reason, at: new Date(nowMs) }));
    // 归档名撞车时绝不覆盖：加 -2/-3…（rename 会直接盖掉同名文件，等于毁掉上一份证据）
    let target = base;
    for (let n = 2; fs.existsSync(target) && n < 100; n += 1) target = base.replace(/\.json$/, `-${n}.json`);
    fs.renameSync(file, target);
    const moved = fs.readFileSync(target, 'utf8');
    if (moved !== raw) {
      // 极小概率：改名把我们判定过的那份换成了并发发布的新文件。搬回去，绝不吞掉它。
      if (!fs.existsSync(file)) fs.renameSync(target, file);
      result.action = 'keep';
      result.reason = 'race-restored';
      result.detail = '改名时撞上了并发发布，已把文件搬回原位（没有清理）';
      result.restored = true;
      appendLog(`RACE-RESTORED ${file}`);
      return result;
    }    result.healed = true;
    result.archivedTo = target;
    appendLog(`HEALED reason=${decision.reason} :: ${decision.detail} :: 归档到 ${path.basename(target)}`);
    if (fs.existsSync(file)) {
      // 我们清掉之后，bridge 立刻发布了新的 —— 这是最好的结果，记一行。
      appendLog('note: 清理后立刻出现了新记录（bridge 已重新发布）');
    }
    return result;
  } catch (error) {
    result.error = String(error?.message ?? error);
    appendLog(`HEAL-FAILED reason=${decision.reason} :: ${result.error}`);
    return result;
  }
}

// ------------------------------------------------------------------ CLI

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const WANT_HEAL = argv.includes('--heal');
  const WANT_JSON = argv.includes('--json');
  const home = resolveHome(argv);
  const r = checkAndHealEndpoint({ home, heal: WANT_HEAL });

  // 机器可读的第一行（ASCII）：看门狗/其它脚本只认这一行
  const ascii = r.healed ? `HEALED ${r.reason} pid=${r.evidence?.pid ?? '?'}`
    : r.action === 'heal' ? `PROBLEM stale-endpoint ${r.reason} pid=${r.evidence?.pid ?? '?'} (run with --heal)`
      : r.action === 'wait' ? `WAIT ${r.reason}`
        : r.error ? `PROBLEM ${r.reason}`
          : `OK ${r.reason}`;

  if (WANT_JSON) {
    console.log(JSON.stringify({ ascii, ...r }, null, 2));
  } else {
    console.log(ascii);
    if (r.action === 'none') console.log(`✅ ${home} 下没有端点记录（bridge 还没发布过）`);
    else if (r.healed) console.log(`🩹 清掉了僵尸记录（${r.reason}）：${r.detail}\n   归档：${r.archivedTo}`);
    else if (r.action === 'heal') console.log(`⚠️ 发现僵尸记录（${r.reason}）：${r.detail}\n   → 加 --heal 可以清理`);
    else console.log(`✅ ${r.detail}`);
    if (r.error) console.log(`   （错误：${r.error}）`);
  }

  appendLog(`CHECK heal=${WANT_HEAL} :: ${ascii}`);
  const failed = Boolean(r.error) || (!WANT_HEAL && r.action === 'heal') || (WANT_HEAL && r.action === 'heal' && !r.healed);
  process.exit(failed ? 1 : 0);
}
