// 修正版：按 (turn, step) 去重 —— 每个 step 只取最后一次 usage（累积值）
import { parseArgs, loadSession, printHeader } from './audit-lib.mjs';

const args = parseArgs();
if (args.help) { printUsage(); process.exit(0); }
const S = loadSession(args);
// text / lines 与迁移前同名同义：分析段引用哪个都不受影响。
// text 用 lines 拼回来（而不是 S.raw），这样带时间窗时分析段也跟着过滤。
const text = S.lines.join('\n');
const lines = S.lines;
printHeader(S, { '口径': "按 (turn,step) 去重后的当日账" });

// 按 turn:step 归并，取每步最后一次 usage
const byStep = new Map();
for (const line of text.split('\n')) {
  if (!line.includes('"usage"')) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  const d = e.data || {};
  const turn = d.turn, step = d.step;
  if (turn == null || step == null) continue;
  const m = JSON.stringify(e).match(/"usage":\{[^{}]*"inputTokens"[^{}]*\}/);
  if (!m) continue;
  let u; try { u = JSON.parse(m[0].slice(8)); } catch { continue; }
  byStep.set(`${turn}:${step}`, { t: Number(e.time), turn, step, miss: u.inputTokens || 0, hit: u.cacheReadTokens || 0, out: u.outputTokens || 0, reason: u.reasoningTokens || 0 });
}
const rows = [...byStep.values()].sort((a, b) => a.t - b.t);
console.log('按 (turn,step) 去重后的请求数:', rows.length);

function isPeak(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}
const P = { hit: { off: 0.003, peak: 0.006 }, miss: { off: 0.15, peak: 0.30 }, out: { off: 0.6, peak: 1.2 } };
const CNY = 7.1;

function show(label, list) {
  let miss = 0, hit = 0, out = 0, usd = 0, peakN = 0, offN = 0;
  for (const r of list) {
    const peak = isPeak(r.t);
    peak ? peakN++ : offN++;
    const mode = peak ? 'peak' : 'off';
    miss += r.miss; hit += r.hit; out += r.out;
    usd += (r.miss / 1e6) * P.miss[mode] + (r.hit / 1e6) * P.hit[mode] + (r.out / 1e6) * P.out[mode];
  }
  console.log(`\n########## ${label} ##########`);
  if (!list.length) { console.log('  （无）'); return { n: 0, usd: 0 }; }
  console.log(`  请求(step)数  ${list.length}   高峰 ${peakN} / 低谷 ${offN}`);
  console.log(`  输入·未命中   ${miss.toLocaleString().padStart(10)}`);
  console.log(`  输入·缓存命中 ${hit.toLocaleString().padStart(10)}`);
  console.log(`  输出          ${out.toLocaleString().padStart(10)}`);
  console.log(`  花费          $${usd.toFixed(4)}  ≈  ¥${(usd * CNY).toFixed(3)}`);
  const turns = new Set(list.map((r) => r.turn)).size;
  console.log(`  涉及回合数    ${turns}   平均每回合 ¥${(usd * CNY / turns).toFixed(4)}`);
  console.log(`  时间          ${new Date(list[0].t).toLocaleString('zh-CN')} → ${new Date(list[list.length - 1].t).toLocaleString('zh-CN')}`);
  return { n: list.length, usd, turns };
}

const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
const yStart = new Date(todayStart); yStart.setDate(yStart.getDate() - 1);

console.log(`\n现在: ${new Date().toLocaleString('zh-CN')}`);
const A = show('今天 00:00 至今（9/17 00:00 起）', rows.filter((r) => r.t >= todayStart.getTime()));
const B = show('昨天（9/16 全天）', rows.filter((r) => r.t >= yStart.getTime() && r.t < todayStart.getTime()));
const C = show('整个群会话累计', rows);

console.log('\n########## 汇总 ##########');
console.log(`  今天 00:00 起 : ¥${(A.usd * CNY).toFixed(3)}  （${A.n} 次请求 / ${A.turns} 个回合）`);
console.log(`  昨天          : ¥${(B.usd * CNY).toFixed(3)}  （${B.n} 次请求 / ${B.turns} 个回合）`);
console.log(`  合计          : ¥${((A.usd + B.usd) * CNY).toFixed(3)}`);
