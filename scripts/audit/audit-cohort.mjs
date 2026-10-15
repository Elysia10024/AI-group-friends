// 按天分队列：看清「调优前 vs 调优后」的真实基线，以及各杠杆的现状值。
import { parseArgs, loadSession, printHeader } from './audit-lib.mjs';

const args = parseArgs();
if (args.help) { printUsage(); process.exit(0); }
const S = loadSession(args);
// text / lines 与迁移前同名同义：分析段引用哪个都不受影响。
// text 用 lines 拼回来（而不是 S.raw），这样带时间窗时分析段也跟着过滤。
const text = S.lines.join('\n');
const lines = S.lines;
printHeader(S, { '口径': "按天分队列的基线对照" });

const byStep = new Map();
for (const line of text.split('\n')) {
  if (!line.includes('"usage"')) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  const d = e.data || {};
  if (d.turn == null || d.step == null) continue;
  const m = JSON.stringify(e).match(/"usage":\{[^{}]*"inputTokens"[^{}]*\}/);
  if (!m) continue;
  let u; try { u = JSON.parse(m[0].slice(8)); } catch { continue; }
  byStep.set(`${d.turn}:${d.step}`, { t: Number(e.time), turn: d.turn, step: d.step, miss: u.inputTokens || 0, hit: u.cacheReadTokens || 0, out: u.outputTokens || 0 });
}
const rows = [...byStep.values()].sort((a, b) => a.t - b.t);
function isPeak(ms) {
  const d = new Date(ms), day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
const P = { hit: { off: 0.003, peak: 0.006 }, miss: { off: 0.15, peak: 0.30 }, out: { off: 0.6, peak: 1.2 } };
const CNY = 7.1;
for (const r of rows) {
  const md = isPeak(r.t) ? 'peak' : 'off';
  r.usd = (r.miss / 1e6) * P.miss[md] + (r.hit / 1e6) * P.hit[md] + (r.out / 1e6) * P.out[md];
  r.ctx = r.miss + r.hit;
}
const dayKey = (t) => new Date(t + 8 * 3600000).toISOString().slice(0, 10);
const byDay = new Map();
for (const r of rows) {
  const k = dayKey(r.t);
  if (!byDay.has(k)) byDay.set(k, []);
  byDay.get(k).push(r);
}
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

console.log('=========== 按天队列（北京时间） ===========');
console.log('  日期        请求  回合  请求/回合  上下文中位  每次重读均  每回合新增  花费      ¥/回合');
for (const k of [...byDay.keys()].sort()) {
  const list = byDay.get(k);
  const turns = new Set(list.map((r) => r.turn)).size;
  const ctxMed = med(list.map((r) => r.ctx));
  const hitAvg = list.reduce((a, b) => a + b.hit, 0) / list.length;
  const missPerTurn = list.reduce((a, b) => a + b.miss, 0) / turns;
  const usd = list.reduce((a, b) => a + b.usd, 0);
  console.log(`  ${k}  ${String(list.length).padStart(4)}  ${String(turns).padStart(4)}   ${(list.length / turns).toFixed(2).padStart(6)}   ${ctxMed.toLocaleString().padStart(9)}  ${Math.round(hitAvg).toLocaleString().padStart(10)}  ${Math.round(missPerTurn).toLocaleString().padStart(10)}  ¥${(usd * CNY).toFixed(2).padStart(6)}   ¥${(usd * CNY / turns).toFixed(4)}`);
}

console.log('\n=========== 最近 300 次请求（≈现在的稳态） ===========');
const recent = rows.slice(-300);
const rTurns = new Set(recent.map((r) => r.turn));
const rCtx = med(recent.map((r) => r.ctx));
const rHit = recent.reduce((a, b) => a + b.hit, 0) / recent.length;
const rMiss = recent.reduce((a, b) => a + b.miss, 0) / recent.length;
const rUsd = recent.reduce((a, b) => a + b.usd, 0);
let peakN = 0; for (const r of recent) if (isPeak(r.t)) peakN++;
console.log('  请求 ' + recent.length + ' / 回合 ' + rTurns.size + ' -> 每回合 ' + (recent.length / rTurns.size).toFixed(2) + ' 次请求');
console.log('  上下文中位        ' + rCtx.toLocaleString());
console.log('  每次平均重读(命中) ' + Math.round(rHit).toLocaleString());
console.log('  每次平均新增(未命中) ' + Math.round(rMiss).toLocaleString());
console.log('  每回合新增内容     ' + Math.round(recent.reduce((a, b) => a + b.miss, 0) / rTurns.size).toLocaleString());
console.log('  高峰请求占比      ' + ((peakN / recent.length) * 100).toFixed(0) + '%');
console.log('  花费 ¥' + (rUsd * CNY).toFixed(2) + '  => ¥/回合 ' + (rUsd * CNY / rTurns.size).toFixed(4));
