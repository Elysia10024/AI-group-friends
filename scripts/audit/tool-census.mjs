// 步数普查：把"每回合 3.3 步"拆成"哪个工具 × 几次 × 多少成本"，并推算 B 方案（取消信息类工具）后的请求数。
//
// 为什么需要：成本 = 上下文 × 请求数，而**请求数 = 1（开场）+ 每次工具调用一次**（工具的返回必须再发一次请求
// 才能继续）。所以"哪类工具值得取消"必须看这张表，不能拍脑袋。
//
// 口径：
//   · 一次请求的成本，归给**上一步调用的工具**（是它的返回把这一步撑起来的）；一回合第一步归"开场"。
//   · 一步里并行调多个工具时，成本按调用数**均分**（并在输出里注明）。
//   · 工具分类：info（查询类，桥侧可预组装）/ send（发送类，必须留）/ wait（等待/巡场）/
//     other（状态机类，如 mark-read、set-wake-config、feedback）。
//
// 用法：node scripts/audit/tool-census.mjs [--since YYYY-MM-DD] [--session main|latest|<id前缀>]
import fs from 'node:fs';
import { parseArgs, loadSession, printHeader } from './audit-lib.mjs';

const args = parseArgs();
const S = loadSession(args);
printHeader(S, { '口径': '步数普查：工具 × 次数 × 归属成本 + B 方案推算' });

const CLASS = (name) => {
  const n = name.replace(/^mcp__[a-z]+__/, '');
  if (/^qq_(send|reply)/.test(n) || n === 'mcp__snowluma__qq_send_poke') return 'send';
  if (/^qq_wait/.test(n)) return 'wait';
  if (/^qq_(get|list)/.test(n) || /^qq_slang_query/.test(n) || /^qq_social_state/.test(n) || /^qq_memory/.test(n)) return 'info';
  return 'other';
};

// 1) 每次请求的 token（与 audit-cost 同口径）
const steps = new Map();
for (const line of S.lines) {
  if (!line.includes('"usage"')) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  const d = e.data || {};
  if (d.turn == null || d.step == null) continue;
  const m = line.match(/"usage":\{[^{}]*\}/);
  if (!m) continue;
  let u; try { u = JSON.parse(m[0].slice(8)); } catch { continue; }
  steps.set(`${d.turn}:${d.step}`, { turn: d.turn, step: d.step, t: Number(e.time), miss: u.inputTokens || 0, hit: u.cacheReadTokens || 0, out: u.outputTokens || 0 });
}
const rows = [...steps.values()].sort((a, b) => a.t - b.t);
for (const r of rows) r.ctx = r.miss + r.hit;

const isPeak = (ms) => { const d = new Date(ms); const day = d.getUTCDay(); if (day === 0 || day === 6) return false; const h = d.getUTCHours(); return (h >= 1 && h < 4) || (h >= 6 && h < 10); };
const P = { hit: { off: 0.003, peak: 0.006 }, miss: { off: 0.15, peak: 0.30 }, out: { off: 0.6, peak: 1.2 } };
const CNY = 7.1;
for (const r of rows) {
  const m = isPeak(r.t) ? 'peak' : 'off';
  r.usd = (r.miss / 1e6) * P.miss[m] + (r.hit / 1e6) * P.hit[m] + (r.out / 1e6) * P.out[m];
  r.cny = r.usd * CNY;   // 一律用人民币计账，别再混 USD/CNY（第一版混了，占比全错）
}

// 2) 工具调用（按 turn:step 归位）
const calls = new Map();            // 'turn:step' -> [name]
for (const line of S.lines) {
  if (!line.includes('"tool/call"')) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  const d = e.data || {};
  if (d.turn == null || d.step == null || !d.name) continue;
  const k = `${d.turn}:${d.step}`;
  if (!calls.has(k)) calls.set(k, []);
  calls.get(k).push(d.name);
}

// 3) 归属：请求成本 → 上一步的工具
const byTool = new Map();
const bump = (name, cny, ctx, miss) => {
  const o = byTool.get(name) ?? { calls: 0, reqs: 0, cny: 0, ctx: 0, miss: 0 };
  o.reqs += 1; o.cny += cny; o.ctx += ctx; o.miss += miss;
  byTool.set(name, o);
};
let openingCny = 0; let openingReqs = 0; let openingCtx = 0; let openingMiss = 0;
const turnCalls = new Map();        // turn -> Set(工具名)
for (const r of rows) {
  const prev = calls.get(`${r.turn}:${r.step - 1}`);
  if (!prev || !prev.length) { openingReqs += 1; openingCny += r.cny; openingCtx += r.ctx; openingMiss += r.miss; continue; }
  const share = r.cny / prev.length; const ctxShare = r.ctx / prev.length; const missShare = r.miss / prev.length;
  for (const name of prev) bump(name, share, ctxShare, missShare);
}
for (const [k, names] of calls) {
  const turn = k.split(':')[0];
  if (!turnCalls.has(turn)) turnCalls.set(turn, new Set());
  for (const n of names) { turnCalls.get(turn).add(n); byTool.get(n).calls += 1; }
}

const total = rows.reduce((a, r) => a + r.cny, 0) * CNY;
const fmtY = (n) => `¥${n.toFixed(2)}`;
const pctOf = (n) => `${((n / total) * 100).toFixed(1)}%`;

console.log(`请求(步)数 ${rows.length}，回合数 ${turnCalls.size}，工具调用 ${[...byTool.values()].reduce((a, b) => a + b.calls, 0)} 次（${(rows.length / turnCalls.size).toFixed(2)} 步/回合）`);
console.log(`合计 ${fmtY(total)}（本次审计口径下的全量成本）\n`);

console.log('=========== 1) 按工具：调用次数 / 撑起的请求数 / 归属成本 ===========');
console.log('  工具'.padEnd(34) + '类别'.padEnd(7) + '调用'.padStart(6) + '请求'.padStart(6) + '成本'.padStart(10) + '占比'.padStart(8));
for (const [name, o] of [...byTool.entries()].sort((a, b) => b[1].cny - a[1].cny)) {
  console.log('  ' + name.replace(/^mcp__[a-z]+__/, '').padEnd(32) + CLASS(name).padEnd(7) + String(o.calls).padStart(6) + String(o.reqs).padStart(6) + fmtY(o.cny).padStart(10) + pctOf(o.cny).padStart(8));
}
console.log('  ' + '(回合开场，无工具前置)'.padEnd(32) + '-'.padEnd(7) + '-'.padStart(6) + String(openingReqs).padStart(6) + fmtY(openingCny).padStart(10) + pctOf(openingCny).padStart(8));

console.log('\n=========== 2) 按类别 ===========');
const byClass = new Map();
for (const [name, o] of byTool) { const c = CLASS(name); const x = byClass.get(c) ?? { calls: 0, usd: 0 }; x.calls += o.calls; x.cny += o.cny; byClass.set(c, x); }
for (const [c, x] of [...byClass.entries()].sort((a, b) => b[1].cny - a[1].cny)) {
  console.log(`  ${c.padEnd(6)} 调用 ${String(x.calls).padStart(5)}  归属成本 ${fmtY(x.cny).padStart(9)}  ${pctOf(x.cny)}`);
}
console.log(`  ${'(开场)'.padEnd(6)} 请求 ${String(openingReqs).padStart(5)}  成本 ${fmtY(openingCny).padStart(9)}  ${pctOf(openingCny)}`);

console.log('\n=========== 3) 每回合的工具调用分布 ===========');
const dist = new Map();
for (const [, names] of turnCalls) { const n = names.size; dist.set(n, (dist.get(n) ?? 0) + 1); }
for (const [n, c] of [...dist.entries()].sort((a, b) => a[0] - b[0])) console.log(`  用过 ${n} 种工具：${String(c).padStart(4)} 回合  ${((c / turnCalls.size) * 100).toFixed(0)}%`);

console.log('\n=========== 5) 谁的新增内容最多（miss token / 次）===========');
console.log('  ⚠️ 未命中单价比缓存命中贵约 50 倍：4.8k 新增 ≈ 24 万缓存上下文。所以"工具返回太大"和"上下文太大"一样烧钱。');
console.log('  工具'.padEnd(34) + '调用'.padStart(6) + '新增token'.padStart(12) + '每次平均'.padStart(10));
for (const [name, o] of [...byTool.entries()].sort((a, b) => b[1].miss - a[1].miss).slice(0, 10)) {
  console.log('  ' + name.replace(/^mcp__[a-z]+__/, '').padEnd(32) + String(o.calls).padStart(6) + Math.round(o.miss).toLocaleString().padStart(12) + Math.round(o.miss / Math.max(1, o.reqs)).toLocaleString().padStart(10));
}
console.log('  ' + '(回合开场)'.padEnd(32) + String(openingReqs).padStart(6) + Math.round(openingMiss).toLocaleString().padStart(12) + Math.round(openingMiss / Math.max(1, openingReqs)).toLocaleString().padStart(10));

console.log('\n=========== 4) 每回合步数 = 1（开场）+ 工具调用，各类别摊到每回合多少 ===========');
const perTurn = (cls) => {
  const n = [...byTool.entries()].filter(([name]) => CLASS(name) === cls).reduce((x, [, o]) => x + o.calls, 0);
  return n / turnCalls.size;
};
const markReadPerTurn = (byTool.get('mcp__snowluma__qq_mark_read')?.calls ?? 0) / turnCalls.size;
const stepsNow = rows.length / turnCalls.size;
console.log(`  开场 1.00 / send ${perTurn('send').toFixed(2)} / info ${perTurn('info').toFixed(2)} / wait ${perTurn('wait').toFixed(2)} / mark_read ${markReadPerTurn.toFixed(2)} / 其它 ${(perTurn('other') - markReadPerTurn).toFixed(2)}`);
const inputShare = 0.951;
const proj = (steps) => {
  const ratio = steps / stepsNow;                 // 请求数变成几倍
  return inputShare * ratio + (1 - inputShare);   // 总成本变成几倍（输入按比例缩，输出不变）
};
console.log('\n  取消什么 → 步/回合 → 请求数× → 总成本× → 能力代价');
const rowsOut = [
  ['（现状）', stepsNow, '—'],
  ['取消 info 类查询（桥侧预组装）', stepsNow - perTurn('info'), '信息类工具全由桥侧给；保留 1 个"回忆"兜底'],
  ['再取消 mark_read（桥侧按 deliveredSeq 自动标已读）', stepsNow - perTurn('info') - markReadPerTurn, '**零代价**：她本来就该被当作"看过了"'],
  ['再取消 wait（改用桥侧唤醒租约/睡醒机制）', stepsNow - perTurn('info') - markReadPerTurn - perTurn('wait'), '小：沉睡前观察改由桥侧计时']
];
for (const [what, steps, cost] of rowsOut) {
  console.log(`  ${what.padEnd(46)} ${steps.toFixed(2)}  ×${(steps / stepsNow).toFixed(2)}  ×${proj(steps).toFixed(3)}  ${cost}`);
}
console.log('\n  ⚠️ 这只算了"请求数"这一半。另一半是**每次请求的上下文**（现均 26.8 万/次）——');
console.log('     上下文从 26.8 万组装到 2.5 万 = 输入部分 ×0.093（总成本 ×0.137）；两半相乘才是 §9 说的十几倍。');
console.log('     两者合计：（取消 info+mark_read 的 ×0.605）×（上下文的 ×0.137）≈ **总成本 ×0.083，约 12×**。');
