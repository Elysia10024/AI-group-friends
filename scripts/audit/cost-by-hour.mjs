// 按**小时**看钱花在哪 —— 跨全部工作区（不只是 QQ 主工作区）。
//
// 为什么要有它（2026-10-13 主人问"今天上午十一点到十二点干什么了，为什么花了五块多"）：
//   现有的 audit:cost / audit:today / audit:cost-by-day 都只统计 **QQ 主工作区**（她的运行）。
//   但账单里还有**别的工作区**：DSH 桌面这边我自己的会话（读代码、跑测试、改文件）同样烧钱，
//   而且往往更贵（上下文长、回合多）。只看一个工作区，得到的数字和主人界面上的对不上，
//   于是就会得出"她乱花钱"的错误结论。
//
// 口径与 cost-since.mjs **完全一致**（同一套定价与去重），只是把窗口换成"按本地小时分桶"：
//   · 未命中输入 $0.30/1M、缓存命中 $0.006/1M、输出 $1.2/1M（高峰档，UTC 01-04 / 06-10）
//     低谷档是它的一半（$0.15/$0.003/$0.6）；猜时间按 `isPeak` 逐条判；汇率 7.1
//   · 同一个 (turn, step) 只取一行（踩过：金额与请求数翻倍）
//
// 用法：
//   node scripts/audit/cost-by-hour.mjs                 # 今天（本地）逐小时
//   node scripts/audit/cost-by-hour.mjs --date 2026-10-13
//   node scripts/audit/cost-by-hour.mjs --from 2026-10-13T11:00 --to 2026-10-13T12:00   # 只看一个窗口
import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_ROOT, listSessions, decompressSession } from './audit-lib.mjs';

const P = { hit: { off: 0.003, peak: 0.006 }, miss: { off: 0.15, peak: 0.30 }, out: { off: 0.6, peak: 1.2 } };
const CNY = 7.1;
const argvVal = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };

const isPeak = (ms) => {
  const d = new Date(ms);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
};
/** 本地小时键：YYYY-MM-DDTHH */
const hourKey = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
};

const dateArg = argvVal('date');
const fromArg = argvVal('from');
const toArg = argvVal('to');
const now = Date.now();
const fromMs = fromArg ? Date.parse(fromArg) : (dateArg ? Date.parse(`${dateArg}T00:00`) : Date.parse(`${hourKey(now).slice(0, 10)}T00:00`));
const toMs = toArg ? Date.parse(toArg) : (dateArg ? Date.parse(`${dateArg}T00:00`) + 86400000 : fromMs + 86400000);
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('--date/--from/--to 时间格式看不懂');

const inWin = (t) => t >= fromMs && t < toMs;
const mk = () => ({ reqs: 0, hit: 0, miss: 0, out: 0, usd: 0, turns: new Set() });

const byHour = new Map();          // hourKey -> { total: bucket, byWs: Map<ws, bucket> }
const byWs = new Map();            // 窗口内按工作区汇总
let scanned = 0;
let skipped = 0;

// **两个 home 都要扫**（默认）：bridge 那套在 `dsh-home-legacy`（她），
// DSH 桌面/Web 这边我自己的会话在 `~/.dsh`（同一个工作区名会重名，所以桌面的加个「桌面/」前缀）。
// 只扫一个 home = 账单只算一半 —— 2026-10-13 主人问"为什么这个小时花了五块多"时，
// 我先只扫了她那边（¥0.79），差点答成"她没乱花"；补上我这边的 ¥4.88 才凑出那"五块多"。
const ROOTS = process.env.AUDIT_SESSIONS_ROOT
  ? [{ root: process.env.AUDIT_SESSIONS_ROOT, tag: '' }]
  : [
    { root: SESSIONS_ROOT, tag: '' },
    { root: path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'), tag: '桌面/' }
  ].filter((r) => r.root && fs.existsSync(r.root));

const sessions = [];
const wsNames = new Set();
for (const { root, tag } of ROOTS) {
  for (const ws of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const wsLabel = `${tag}${ws}`;
    wsNames.add(wsLabel);
    const wsDir = path.join(root, ws);
    for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory() || !s.name.startsWith('session-')) continue;
      const dir = path.join(wsDir, s.name);
      let best = null;
      for (const f of fs.readdirSync(dir)) {
        if (!/^session.*\.jsonl\.zstd$/.test(f)) continue;
        const fp = path.join(dir, f);
        const size = fs.statSync(fp).size;
        if (!best || size > best.size) best = { file: fp, size };
      }
      if (best && best.size > 0) sessions.push({ sid: s.name, workspace: wsLabel, file: best.file, size: best.size });
    }
  }
}
const workspaces = [...wsNames];
const biggest = [...sessions].sort((a, b) => b.size - a.size).slice(0, 5);
console.log('最大的几个会话文件：');
for (const s of biggest) console.log(`  ${(s.workspace || '').slice(-30).padEnd(30)} ${s.sid.slice(0, 20)} ${(s.size / 1024 / 1024).toFixed(1)}MB`);
console.log('');

for (const s of sessions) {
  let raw;
  try { raw = decompressSession(s.file); } catch { skipped += 1; continue; }
  scanned += 1;
  const seenSteps = new Set();
  const seenTurns = new Set();
  for (const line of raw.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (d.turn == null || d.step == null) continue;
    const key = `${d.turn}:${d.step}`;
    if (seenSteps.has(key)) continue;
    seenSteps.add(key);
    const m = line.match(/"usage":\{[^{}]*\}/);
    if (!m) continue;
    let u; try { u = JSON.parse(m[0].slice(8)); } catch { continue; }
    const t = Number(e.time) || s.mtimeMs;
    if (!inWin(t)) continue;
    const miss = u.inputTokens || 0; const hit = u.cacheReadTokens || 0; const out = u.outputTokens || 0;
    const peak = isPeak(t) ? 'peak' : 'off';
    const usd = (miss / 1e6) * P.miss[peak] + (hit / 1e6) * P.hit[peak] + (out / 1e6) * P.out[peak];
    const hk = hourKey(t);
    if (!byHour.has(hk)) byHour.set(hk, { total: mk(), byWs: new Map() });
    const h = byHour.get(hk);
    for (const b of [h.total, (h.byWs.get(s.workspace) ?? (h.byWs.set(s.workspace, mk()), h.byWs.get(s.workspace))), (byWs.get(s.workspace) ?? (byWs.set(s.workspace, mk()), byWs.get(s.workspace)))]) {
      b.reqs += 1; b.hit += hit; b.miss += miss; b.out += out; b.usd += usd;
      b.turns.add(`${s.sid}:${d.turn}`);
    }
    seenTurns.add(d.turn);
  }
}

const fmtCny = (n) => `¥${n.toFixed(3)}`;
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

console.log(`窗口：${new Date(fromMs).toLocaleString('zh-CN')} ~ ${new Date(toMs).toLocaleString('zh-CN')}（本地）`);
console.log(`会话：扫了 ${scanned} 个（跳过 ${skipped} 个读不动的），跨 ${workspaces.length} 个工作区\n`);

const hours = [...byHour.keys()].sort();
if (!hours.length) { console.log('这个窗口内没有任何带用量的请求。'); process.exit(0); }

console.log('本地小时      请求  回合   未命中    命中     输出      ¥');
let sum = 0;
for (const hk of hours) {
  const h = byHour.get(hk);
  sum += h.total.usd;
  console.log(`${hk.slice(11)}:00       ${String(h.total.reqs).padStart(3)}  ${String(h.total.turns.size).padStart(3)}   ${fmtTok(h.total.miss).padStart(6)}  ${fmtTok(h.total.hit).padStart(7)}  ${fmtTok(h.total.out).padStart(6)}   ${fmtCny(h.total.usd * CNY)}`);
}
console.log(`合计：${fmtCny(sum * CNY)}（${hours.length} 个小时）`);

console.log('\n=== 按工作区（谁花的钱）===');
for (const [ws, b] of [...byWs].sort((a, b) => b[1].usd - a[1].usd)) {
  console.log(`  ${(ws || '(未知)').padEnd(34)} ${fmtCny(b.usd * CNY).padStart(9)}  请求 ${String(b.reqs).padStart(3)}  回合 ${String(b.turns.size).padStart(3)}  未命中 ${fmtTok(b.miss)}｜命中 ${fmtTok(b.hit)}｜输出 ${fmtTok(b.out)}`);
}

console.log('\n=== 每个小时里谁花的（只列前 3 个工作区）===');
for (const hk of hours) {
  const h = byHour.get(hk);
  const top = [...h.byWs].sort((a, b) => b[1].usd - a[1].usd).slice(0, 3)
    .map(([ws, b]) => `${ws.split('-').slice(-2).join('-')}=${fmtCny(b.usd * CNY)}(${b.reqs}req)`).join('  ');
  console.log(`  ${hk.slice(11)}:00  ${fmtCny(h.total.usd * CNY).padStart(8)}  ${top}`);
}
