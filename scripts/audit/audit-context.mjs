// 深挖：上下文是「回合内被工具调用撑大」还是「跨回合慢慢涨」？压缩是否伤缓存？
import { parseArgs, loadSession, printHeader } from './audit-lib.mjs';

const args = parseArgs();
if (args.help) { printUsage(); process.exit(0); }
const S = loadSession(args);
// text / lines 与迁移前同名同义：分析段引用哪个都不受影响。
// text 用 lines 拼回来（而不是 S.raw），这样带时间窗时分析段也跟着过滤。
const text = S.lines.join('\n');
const lines = S.lines;
printHeader(S, { '口径': "上下文是回合内被撑大还是跨回合涨 / 压缩是否伤缓存" });

const byStep = new Map();
let assistantTexts = 0, toolCalls = 0, toolResults = 0, userMsgs = 0;
for (const line of text.split('\n')) {
  if (line.includes('"usage"')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (d.turn == null || d.step == null) continue;
    const m = JSON.stringify(e).match(/"usage":\{[^{}]*"inputTokens"[^{}]*\}/);
    if (!m) continue;
    let u; try { u = JSON.parse(m[0].slice(8)); } catch { continue; }
    byStep.set(`${d.turn}:${d.step}`, { t: Number(e.time), turn: d.turn, step: d.step, miss: u.inputTokens || 0, hit: u.cacheReadTokens || 0, out: u.outputTokens || 0 });
  }
  if (/"role":"assistant"/.test(line)) assistantTexts++;
  if (/"tool_use"|"toolUse"/.test(line)) toolCalls++;
  if (/"tool_result"|"toolResult"/.test(line)) toolResults++;
  if (/"role":"user"/.test(line)) userMsgs++;
}
const rows = [...byStep.values()].sort((a, b) => (a.turn - b.turn) || (a.step - b.step));
for (const r of rows) r.ctx = r.miss + r.hit;

console.log('=========== A) 上下文随「回合内第几步」的变化 ===========');
const byStepNo = new Map();
for (const r of rows) {
  if (!byStepNo.has(r.step)) byStepNo.set(r.step, []);
  byStepNo.get(r.step).push(r.ctx);
}
console.log('  步骤  样本  平均上下文   中位');
for (const s of [...byStepNo.keys()].sort((a, b) => a - b).slice(0, 16)) {
  const a = byStepNo.get(s).sort((x, y) => x - y);
  const avg = a.reduce((p, q) => p + q, 0) / a.length;
  console.log(`  ${String(s).padStart(4)}  ${String(a.length).padStart(4)}  ${Math.round(avg).toLocaleString().padStart(10)}  ${a[Math.floor(a.length / 2)].toLocaleString().padStart(10)}`);
}

console.log('\n=========== B) 每个回合：首步 vs 最大上下文 ===========');
const byTurn = new Map();
for (const r of rows) {
  if (!byTurn.has(r.turn)) byTurn.set(r.turn, []);
  byTurn.get(r.turn).push(r);
}
let balloon = 0, balloonSum = 0;
const firsts = [], maxes = [];
for (const v of byTurn.values()) {
  v.sort((a, b) => a.step - b.step);
  const f = v[0].ctx, mx = Math.max(...v.map((r) => r.ctx));
  firsts.push(f); maxes.push(mx);
  if (mx > f * 1.5) { balloon++; balloonSum += mx - f; }
}
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log('  回合数            ' + byTurn.size);
console.log('  首步上下文中位    ' + med(firsts).toLocaleString());
console.log('  回合内峰值中位    ' + med(maxes).toLocaleString());
console.log('  回合内涨 >50% 的  ' + balloon + ' 个 (' + ((balloon / byTurn.size) * 100).toFixed(0) + '%)');
console.log('  这些回合平均多读  ' + Math.round(balloonSum / Math.max(1, balloon)).toLocaleString() + ' token/回合');

console.log('\n=========== C) 回合内「新增内容」总量 ===========');
let missSum = 0, hitSum = 0;
for (const r of rows) { missSum += r.miss; hitSum += r.hit; }
console.log('  总未命中(新内容)  ' + missSum.toLocaleString());
console.log('  总命中(重读)      ' + hitSum.toLocaleString());
console.log('  每回合新增内容    ' + Math.round(missSum / byTurn.size).toLocaleString() + ' token');
console.log('  每回合重读上下文  ' + Math.round(hitSum / byTurn.size).toLocaleString() + ' token');
console.log('  => 重读 : 新增 = ' + (hitSum / missSum).toFixed(1) + ' : 1');

console.log('\n=========== D) 压缩前后（上下文骤降点）的缓存表现 ===========');
const drops = [];
for (let k = 1; k < rows.length; k++) {
  const prev = rows[k - 1], cur = rows[k];
  if (prev.turn === cur.turn && cur.ctx < prev.ctx * 0.6) drops.push({ k, prev, cur });
}
console.log('  回合内上下文骤降(疑似压缩) 次数: ' + drops.length);
if (drops.length) {
  let m = 0, h = 0;
  for (const d of drops) { m += d.cur.miss; h += d.cur.hit; }
  console.log('  骤降后那一步平均: 未命中 ' + Math.round(m / drops.length).toLocaleString() + ' / 命中 ' + Math.round(h / drops.length).toLocaleString());
  console.log('  对比全样本平均  : 未命中 ' + Math.round(missSum / rows.length).toLocaleString() + ' / 命中 ' + Math.round(hitSum / rows.length).toLocaleString());
}

console.log('\n=========== E) 会话内容构成（行数计数，仅粗略） ===========');
console.log('  assistant 行 ' + assistantTexts + ' / tool_use ' + toolCalls + ' / tool_result ' + toolResults + ' / user 行 ' + userMsgs);
console.log('  回合数 ' + byTurn.size + '  => 每回合 tool_use 约 ' + (toolCalls / byTurn.size).toFixed(1));
