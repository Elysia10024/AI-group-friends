// 成本审计：把「钱花在哪」拆到请求级 / 回合级 / 小时级，并统计空转回合。
import fs from 'node:fs';
import { parseArgs, loadSession, printHeader } from './audit-lib.mjs';
import { projectPath } from '../lib/paths.mjs';

const args = parseArgs();
if (args.help) { printUsage(); process.exit(0); }
const S = loadSession(args);
// text / lines 与迁移前同名同义：分析段引用哪个都不受影响。
// text 用 lines 拼回来（而不是 S.raw），这样带时间窗时分析段也跟着过滤。
const text = S.lines.join('\n');
const lines = S.lines;
printHeader(S, { '口径': "按请求/回合/小时拆成本 + 空转回合" });

const byStep = new Map();
let compactionCount = 0;
const compactionTimes = [];
for (const line of lines) {
  if (/compact/i.test(line) && !line.includes('"usage"')) {
    compactionCount++;
    const m = line.match(/"time":(\d+)/);
    if (m) compactionTimes.push(Number(m[1]));
  }
  if (!line.includes('"usage"')) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  const d = e.data || {};
  const turn = d.turn, step = d.step;
  if (turn == null || step == null) continue;
  const m = JSON.stringify(e).match(/"usage":\{[^{}]*"inputTokens"[^{}]*\}/);
  if (!m) continue;
  let u; try { u = JSON.parse(m[0].slice(8)); } catch { continue; }
  byStep.set(`${turn}:${step}`, {
    t: Number(e.time), turn, step,
    miss: u.inputTokens || 0, hit: u.cacheReadTokens || 0, out: u.outputTokens || 0
  });
}
const rows = [...byStep.values()].sort((a, b) => a.t - b.t);
for (const r of rows) r.ctx = r.miss + r.hit;

function isPeak(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
const P = { hit: { off: 0.003, peak: 0.006 }, miss: { off: 0.15, peak: 0.30 }, out: { off: 0.6, peak: 1.2 } };
const CNY = 7.1;
for (const r of rows) {
  const m = isPeak(r.t) ? 'peak' : 'off';
  r.usd = (r.miss / 1e6) * P.miss[m] + (r.hit / 1e6) * P.hit[m] + (r.out / 1e6) * P.out[m];
  r.peak = m === 'peak';
}

const pct = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0;
const fmt = (n) => Math.round(n).toLocaleString().padStart(10);

console.log('=========== 1) 每次请求的上下文规模（hit+miss） ===========');
const ctxs = rows.map((r) => r.ctx).sort((a, b) => a - b);
console.log('  请求数     ' + rows.length);
console.log('  最小       ' + fmt(ctxs[0]));
console.log('  p25        ' + fmt(pct(ctxs, 0.25)));
console.log('  中位数     ' + fmt(pct(ctxs, 0.5)));
console.log('  p75        ' + fmt(pct(ctxs, 0.75)));
console.log('  p90        ' + fmt(pct(ctxs, 0.90)));
console.log('  最大       ' + fmt(ctxs[ctxs.length - 1]));
console.log('  平均       ' + fmt(ctxs.reduce((a, b) => a + b, 0) / ctxs.length));

console.log('\n=========== 2) 成本构成（按 token 类型） ===========');
let cHit = 0, cMiss = 0, cOut = 0, nPeak = 0;
for (const r of rows) {
  const m = r.peak ? 'peak' : 'off';
  cHit += (r.hit / 1e6) * P.hit[m];
  cMiss += (r.miss / 1e6) * P.miss[m];
  cOut += (r.out / 1e6) * P.out[m];
  if (r.peak) nPeak++;
}
const cTot = cHit + cMiss + cOut;
const pc = (x) => ((x / cTot) * 100).toFixed(1).padStart(5) + '%';
console.log(`  缓存命中读取  $${cHit.toFixed(4)}  ${pc(cHit)}   <-- 上下文大小 × 请求数`);
console.log(`  未命中(新内容) $${cMiss.toFixed(4)}  ${pc(cMiss)}`);
console.log(`  输出          $${cOut.toFixed(4)}  ${pc(cOut)}`);
console.log(`  合计          $${cTot.toFixed(4)} ≈ ¥${(cTot * CNY).toFixed(2)}`);
console.log(`  高峰计费请求  ${nPeak}/${rows.length} (${((nPeak / rows.length) * 100).toFixed(0)}%)`);

console.log('\n=========== 3) 每个回合的请求数（= 上下文重读次数） ===========');
const byTurn = new Map();
for (const r of rows) {
  if (!byTurn.has(r.turn)) byTurn.set(r.turn, []);
  byTurn.get(r.turn).push(r);
}
const stepsPerTurn = [...byTurn.values()].map((v) => v.length).sort((a, b) => a - b);
console.log('  回合数     ' + byTurn.size);
console.log('  每回合请求 p50=' + pct(stepsPerTurn, 0.5) + '  p75=' + pct(stepsPerTurn, 0.75) + '  p90=' + pct(stepsPerTurn, 0.90) + '  max=' + stepsPerTurn[stepsPerTurn.length - 1]);
const turnCost = [...byTurn.values()].map((v) => v.reduce((a, b) => a + b.usd, 0) * CNY).sort((a, b) => a - b);
console.log('  每回合花费 p50=¥' + pct(turnCost, 0.5).toFixed(4) + '  p90=¥' + pct(turnCost, 0.9).toFixed(4) + '  max=¥' + turnCost[turnCost.length - 1].toFixed(4));
// 请求数 vs 单回合成本的相关性
const heavy = [...byTurn.values()].filter((v) => v.length >= 6);
console.log('  ≥6 次请求的回合: ' + heavy.length + ' 个，占成本 ' + ((heavy.reduce((a, v) => a + v.reduce((x, y) => x + y.usd, 0), 0) / cTot) * 100).toFixed(1) + '%');

console.log('\n=========== 4) 成本按本地小时分布 ===========');
const byHour = new Map();
for (const r of rows) {
  const h = new Date(r.t + 8 * 3600000).getUTCHours();
  if (!byHour.has(h)) byHour.set(h, { n: 0, usd: 0 });
  const o = byHour.get(h); o.n++; o.usd += r.usd;
}
for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
  const o = byHour.get(h);
  const bar = '#'.repeat(Math.min(60, Math.round(o.usd * CNY * 4)));
  console.log(`  ${String(h).padStart(2, '0')}:00  ¥${(o.usd * CNY).toFixed(3).padStart(7)}  ${String(o.n).padStart(4)}请求 ${bar}`);
}

console.log('\n=========== 5) 压缩事件 ===========');
console.log('  含 compact 的行: ' + compactionCount + '（时间戳可解析 ' + compactionTimes.length + ' 个）');

console.log('\n=========== 6) 桥侧：唤醒原因 & 空转回合 ===========');
const blog = fs.readFileSync(projectPath('state/bridge.log'), 'utf8').split('\n');
const reasons = new Map();
let noText = 0, sent = 0, wake = 0, limited = 0;
for (const l of blog) {
  const m = l.match(/唤醒 group:\S+（([^）]+)）/);
  if (m) { reasons.set(m[1], (reasons.get(m[1]) || 0) + 1); wake++; }
  if (l.includes('回合完成但无文本')) noText++;
  if (l.includes('工具统一发送')) sent++;
  if (l.includes('唤醒频率超限')) limited++;
}
for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)}  ${((v / wake) * 100).toFixed(0).padStart(3)}%`);
}
console.log('  ----');
console.log('  实际投递唤醒 ' + wake);
console.log('  发过消息的回合 ' + sent);
console.log('  回合完成但无文本 ' + noText + (wake ? `  (${((noText / wake) * 100).toFixed(0)}% 的唤醒啥也没说)` : ''));
console.log('  被限流丢弃 ' + limited);
