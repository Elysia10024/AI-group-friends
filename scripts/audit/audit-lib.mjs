// 成本/会话审计的公共核心：定位会话 → 解压 → 拆行 → 时间窗 → 输出头。
//
// 为什么要有这一层：原先 5~6 个审计脚本各自内联同一段"写死 SID + 遍历 sessions + zstd 解压"，
// 于是 ① 换个会话就得改源码 ② 输出不带口径，两天/两个会话的数字没法比
// ③ 没人知道它到底审的是哪个会话（全局 `latest` 会被黑话学习、自检的会话抢走）。
//
// 口径约定（写死在输出头里，避免"看起来一样其实不一样"）：
//   · 默认会话 = QQ 主工作区（MAIN_WORKSPACE）里**最近改动**的那个，不是全局最近；
//   · 不给 --since/--until 时**完全不过滤** —— 保证与收口前的数字逐字一致；
//   · 给窗时按行内 "time" 过滤；**没有时间戳的行保留**并单独报数，不静默丢弃。
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

// 会话根目录可用环境变量覆盖：复现/测试时把某个会话冻结成副本，
// 才能证明"改造前后数字一致"（会话文件在被 DSH 实时追加，直接比对会天然失真）。
export const SESSIONS_ROOT = process.env.AUDIT_SESSIONS_ROOT || '<项目根>/dsh-home-legacy/sessions';
export const MAIN_WORKSPACE = 'qq-bridge-main-state-agents';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const USAGE = `用法：node <脚本>.mjs [--session main|latest|<id前缀>] [--workspace <子串>] [--since <YYYY-MM-DD[THH:mm]>] [--until <同上>]

  --session main     默认。QQ 主工作区里最近改动的会话
  --session latest   全局最近改动的会话（含黑话学习/自检等）
  --session <id>     指定会话 id（前缀匹配即可）
  --workspace <子串> 限定工作区目录名
  --since/--until    时间窗；只按行内 "time" 过滤，无时间戳的行保留并在头部报数`;

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { session: 'main', workspace: null, since: null, until: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--session') out.session = argv[++i];
    else if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--until') out.until = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

export function printUsage() {
  console.log(USAGE);
}

/** 列出所有会话（按改动时间倒序）。带 workspace 时只列工作区名含该子串的。 */
export function listSessions({ workspace = null } = {}) {
  const out = [];
  if (!fs.existsSync(SESSIONS_ROOT)) return out;
  for (const ws of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue;
    if (workspace && !ws.name.includes(workspace)) continue;
    const wsDir = path.join(SESSIONS_ROOT, ws.name);
    for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory() || !s.name.startsWith('session-')) continue;
      const file = path.join(wsDir, s.name, 'session.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      out.push({ sid: s.name, workspace: ws.name, file, mtimeMs: st.mtimeMs, size: st.size });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function resolveSession({ session = 'main', workspace = null } = {}) {
  const all = listSessions({ workspace });
  if (!all.length) throw new Error(`没找到会话（workspace=${workspace ?? '不限'}）`);
  if (session === 'latest') return all[0];
  if (session === 'main') {
    const hit = all.find((s) => s.workspace.includes(MAIN_WORKSPACE));
    if (hit) return hit;
    throw new Error(`没找到 QQ 主工作区（${MAIN_WORKSPACE}）。用 --session latest 或 --session <id>`);
  }
  const hit = all.find((s) => s.sid === session) ?? all.find((s) => s.sid.includes(session));
  if (!hit) throw new Error(`没找到会话 ${session}`);
  return hit;
}

/** zstd 多帧解压：DSH 的 session.jsonl.zstd 是若干 zstd 帧拼起来的。 */
export function decompressSession(file) {
  const buf = fs.readFileSync(file);
  const idx = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { idx.push(i); i += 4; }
  let text = '';
  for (let k = 0; k < idx.length; k += 1) {
    const to = k + 1 < idx.length ? idx[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(idx[k], to)).toString('utf8'); } catch { /* 坏帧跳过：能解多少算多少 */ }
  }
  return text;
}

export function parseTimeSpec(s) {
  if (s == null) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`时间格式看不懂：${s}（用 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm 或毫秒）`);
  return t;
}

/** 从一行事件里取时间戳（毫秒）。取不到返回 null。 */
export function lineTime(line) {
  const m = line.match(/"time":(\d{10,})/);
  return m ? Number(m[1]) : null;
}

export function loadSession(opts = {}) {
  const info = resolveSession(opts);
  const raw = decompressSession(info.file);
  const allLines = raw.split('\n');
  const since = parseTimeSpec(opts.since);
  const until = parseTimeSpec(opts.until);
  let lines = allLines;
  let droppedOut = 0;
  let untimed = 0;
  if (since != null || until != null) {
    lines = [];
    for (const l of allLines) {
      if (!l) continue;
      const t = lineTime(l);
      if (t == null) { untimed += 1; lines.push(l); continue; }
      if (since != null && t < since) { droppedOut += 1; continue; }
      if (until != null && t > until) { droppedOut += 1; continue; }
      lines.push(l);
    }
  }
  return { ...info, raw, lines, allLines, since, until, droppedOut, untimed };
}

// 统一用 UTC 标注（本地时区随环境变，跨机器比对会错位）；末尾的 Z 是显式声明。
const fmtTime = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

export function printHeader(S, meta = {}) {
  const when = S.since || S.until
    ? `${S.since ? fmtTime(S.since) : '不限'} ~ ${S.until ? fmtTime(S.until) : '不限'}`
    : '全量（未过滤）';
  console.log(`口径: ${meta['口径'] ?? '(未标)'}`);
  console.log(`会话: ${S.sid}  [${S.workspace}]`);
  console.log(`文件: ${S.file}`);
  console.log(`      ${(S.size / 1048576).toFixed(1)} MB  改于 ${fmtTime(S.mtimeMs)}`);
  console.log(`时间窗: ${when}${(S.droppedOut || S.untimed) ? `  （窗外丢 ${S.droppedOut} 行 / 无时间戳保留 ${S.untimed} 行）` : ''}`);
  console.log(`解压后: ${S.lines.length} 行 / ${(S.raw.length / 1048576).toFixed(1)} MB`);
  console.log('');
}
