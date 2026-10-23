// 最后两个未知数：① 压缩后上下文能降到多低（地板）② agent/inbox/spliced 是什么
import { parseArgs, loadSession, printHeader } from './audit-lib.mjs';

const args = parseArgs();
if (args.help) { printUsage(); process.exit(0); }
const S = loadSession(args);
// text / lines 与迁移前同名同义：分析段引用哪个都不受影响。
// text 用 lines 拼回来（而不是 S.raw），这样带时间窗时分析段也跟着过滤。
const text = S.lines.join('\n');
const lines = S.lines;
printHeader(S, { '口径': "压缩后的上下文地板 + 每回合新增构成" });

const evs = [];
for (const line of text.split('\n')) { if (!line) continue; let e; try { e = JSON.parse(line); } catch { continue; } evs.push(e); }
evs.sort((a, b) => (a.seq || 0) - (b.seq || 0));

const usage = [];
for (const e of evs) {
  if (e.type !== 'assistant/message') continue;
  const m = JSON.stringify(e).match(/"usage":\{[^{}]*"inputTokens"[^{}]*\}/);
  if (!m) continue;
  let u; try { u = JSON.parse(m[0].slice(8)); } catch { continue; }
  usage.push({ t: e.time, ctx: (u.inputTokens || 0) + (u.cacheReadTokens || 0), miss: u.inputTokens || 0, seq: e.seq });
}
console.log('请求数 ' + usage.length);

console.log('\n=========== ① 压缩后的上下文地板 ===========');
const ends = evs.filter((e) => e.type === 'compaction/end');
console.log('  compaction/end 事件数: ' + ends.length);
const after = [];
for (const ce of ends) {
  const nxt = usage.find((u) => u.seq > ce.seq);
  if (nxt) after.push({ t: ce.time, ctx: nxt.ctx });
}
const ctxs = after.map((a) => a.ctx).sort((a, b) => a - b);
if (ctxs.length) {
  console.log('  压缩后第一次请求的上下文: 最小 ' + ctxs[0].toLocaleString() + ' / 中位 ' + ctxs[Math.floor(ctxs.length / 2)].toLocaleString() + ' / 最大 ' + ctxs[ctxs.length - 1].toLocaleString());
  console.log('  最近 8 次压缩后的上下文:');
  for (const a of after.slice(-8)) console.log('    ' + new Date(a.t + 8 * 3600000).toLocaleString('zh-CN') + '  ' + a.ctx.toLocaleString());
}
const recentCtx = usage.slice(-300).map((u) => u.ctx).sort((a, b) => a - b);
console.log('  最近 300 次请求上下文: p10=' + recentCtx[30].toLocaleString() + ' p50=' + recentCtx[150].toLocaleString() + ' p90=' + recentCtx[270].toLocaleString());

console.log('\n=========== ② compaction/summary 是否累积 ===========');
const sums = evs.filter((e) => e.type === 'compaction/summary');
console.log('  条数 ' + sums.length + '，总字符 ' + sums.reduce((a, s) => a + JSON.stringify(s).length, 0).toLocaleString());
console.log('  最早 ' + new Date(sums[0].time + 8 * 3600000).toLocaleString('zh-CN') + '  最新 ' + new Date(sums[sums.length - 1].time + 8 * 3600000).toLocaleString('zh-CN'));
console.log('  平均间隔 ' + Math.round((sums[sums.length - 1].time - sums[0].time) / 60000 / Math.max(1, sums.length - 1)) + ' 分钟');

console.log('\n=========== ③ agent/inbox/spliced 是什么 ===========');
const sp = evs.filter((e) => e.type === 'agent/inbox/spliced');
console.log('  条数 ' + sp.length + '，总字符 ' + sp.reduce((a, s) => a + JSON.stringify(s).length, 0).toLocaleString());
const sample = sp.slice(-2);
for (const s of sample) {
  console.log('  --- ' + new Date(s.time + 8 * 3600000).toLocaleString('zh-CN'));
  console.log('  ' + JSON.stringify(s).slice(0, 700));
}

console.log('\n=========== ④ 每回合新增内容构成（按事件类型，最近 100 回合） ===========');
const turnStarts = evs.filter((e) => e.type === 'turn/start');
const lastTurnSeq = turnStarts.length > 100 ? turnStarts[turnStarts.length - 100].seq : 0;
const tails = evs.filter((e) => (e.seq || 0) >= lastTurnSeq);
const nTurns = tails.filter((e) => e.type === 'turn/start').length || 1;
const agg = new Map();
for (const e of tails) {
  const k = e.type;
  if (!agg.has(k)) agg.set(k, { n: 0, chars: 0 });
  const o = agg.get(k); o.n++; o.chars += JSON.stringify(e).length;
}
console.log('  最近 ' + nTurns + ' 个回合:');
for (const [k, v] of [...agg.entries()].sort((a, b) => b[1].chars - a[1].chars).slice(0, 12)) {
  console.log('  ' + k.padEnd(28) + ' n=' + String(v.n).padStart(6) + '  总字符 ' + String(v.chars).padStart(10) + '  每回合 ' + String(Math.round(v.chars / nTurns)).padStart(7));
}
