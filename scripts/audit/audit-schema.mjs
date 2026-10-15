// DSH 会话事件的结构勘察：每类事件多少行、平均/最大多长，并抽一条最大的 assistant 行看字段。
//
// 用途：写审计脚本前先确认字段名（`usage` 在哪、`turn`/`step`/`time` 叫什么），
// 以及"哪类事件最占字节"（往往是判断成本构成的第一手线索）。
//
// 口径：行数/字节数都基于**解压后的 JSONL 原文**（不做任何过滤），空行剔除。
import { parseArgs, loadSession, printHeader } from './audit-lib.mjs';

const args = parseArgs();
const S = loadSession(args);
const lines = S.lines.filter(Boolean);           // 与原脚本一致：空行不算事件
printHeader(S, { 口径: '事件类型分布 + 单条最长样本（空行已剔除）' });
console.log(`事件行数: ${lines.length}（含空行 ${S.lines.length}）\n`);

const kinds = new Map();
for (const l of lines) {
  let e; try { e = JSON.parse(l); } catch { continue; }
  const k = (e.type || e.kind || '?') + '/' + ((e.data && e.data.type) || '');
  if (!kinds.has(k)) kinds.set(k, { n: 0, max: 0, sum: 0 });
  const o = kinds.get(k);
  o.n += 1; o.sum += l.length; o.max = Math.max(o.max, l.length);
}
console.log('=== 事件类型（行数 / 平均行长 / 最大行长）===');
for (const [k, v] of [...kinds.entries()].sort((a, b) => b[1].sum - a[1].sum).slice(0, 25)) {
  console.log(`  ${k.padEnd(40)} n=${String(v.n).padStart(6)} avg=${String(Math.round(v.sum / v.n)).padStart(7)} max=${String(v.max).padStart(8)}`);
}

console.log('\n=== 样本（取一条最大的 assistant 行，看结构）===');
let big = null;
for (const l of lines) { if (/"usage"/.test(l) && (!big || l.length > big.length)) big = l; }
try {
  const e = JSON.parse(big);
  console.log('keys:', Object.keys(e));
  console.log('data keys:', Object.keys(e.data || {}));
  console.log(JSON.stringify(e).slice(0, 1200));
} catch (err) { console.log('parse err', err.message); }
