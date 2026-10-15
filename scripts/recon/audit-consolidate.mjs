// 勘察"可整合项"：找出同一概念的多套实现、死掉的分支、重复的路由族
import fs from 'node:fs';

const SRC = 'E:/ai群友/qq-bridge-main/src/bridge.js';
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');

console.log('=========== 1) 同概念多套实现（foo / fooV2 / fooV3）===========');
const funcs = [...src.matchAll(/^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const constants = [...src.matchAll(/^\s{0,2}(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const names = [...new Set([...funcs, ...constants])];
const groups = new Map();
for (const n of names) {
  const base = n.replace(/V\d+$/, '');
  if (!groups.has(base)) groups.set(base, []);
  groups.get(base).push(n);
}
const pairs = [...groups.entries()].filter(([, v]) => v.length > 1 && v.some((x) => /V\d+$/.test(x)));
console.log('  成对出现的名字: ' + pairs.length + ' 组');
for (const [base, list] of pairs.sort()) {
  console.log('    ' + base.padEnd(30) + ' → ' + list.join('  |  '));
}

console.log('\n=========== 2) 两代社交引擎是否并存 ===========');
const probes = [
  ['isSocialEnabled', /isSocialEnabled/g],
  ['appendRecentMessage(一代)', /appendRecentMessage\(/g],
  ['appendSocialV2Message(二代)', /appendSocialV2Message\(/g],
  ['cfg.social.(一代)', /cfg\.social\./g],
  ['cfg.socialV2.(二代)', /cfg\.socialV2\./g],
  ["'/api/social'(一代)", /'\/api\/social'/g],
  ["'/api/socialV2/'(二代)", /'\/api\/socialV2\//g],
  ['reserved2 模式判断', /reserved2/g],
  ['一期模式判断', /'reserved'(?!2)/g]
];
for (const [label, re] of probes) {
  const n = (src.match(re) || []).length;
  console.log('  ' + label.padEnd(34) + String(n).padStart(4) + ' 次');
}

console.log('\n=========== 3) 当前生效的模式（state/mode.json + 运行时）===========');
for (const f of ['E:/ai群友/qq-bridge-main/state/mode.json', 'E:/ai群友/qq-bridge-main/state/current-role.json']) {
  if (fs.existsSync(f)) console.log('  ' + f.split('/').pop() + ': ' + fs.readFileSync(f, 'utf8').trim().slice(0, 200));
  else console.log('  ' + f.split('/').pop() + ': （不存在）');
}

console.log('\n=========== 4) 发送路径有几条 ===========');
const sendFns = [...src.matchAll(/(?:async\s+)?function\s+(send[A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
console.log('  ' + [...new Set(sendFns)].join(', '));

console.log('\n=========== 5) 状态文件与内存状态存储 ===========');
const stores = [...src.matchAll(/new Map\(\)/g)].length;
console.log('  模块级 new Map()（内存状态）: ' + stores + ' 处');
const files = [...new Set([...src.matchAll(/'([\w.-]+\.(?:json|jsonl|md|log))'/g)].map((m) => m[1]))];
console.log('  涉及文件: ' + files.join(', '));

console.log('\n=========== 6) 提示词组装有几处 ===========');
const promptFns = [...src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$]*[Pp]rompt[A-Za-z_$]*)/g)].map((m) => m[1]);
console.log('  ' + [...new Set(promptFns)].join(', '));
const lineLikes = [...src.matchAll(/const\s+(\w*Line)\s*=/g)].map((m) => m[1]);
console.log('  *Line 变量 ' + new Set(lineLikes).size + ' 个: ' + [...new Set(lineLikes)].join(', '));

console.log('\n=========== 7) 代码行数分布（哪 20% 占 80%）===========');
const fns = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  if (m) fns.push({ name: m[1], line: i + 1 });
}
for (let k = 0; k < fns.length; k++) fns[k].len = (k + 1 < fns.length ? fns[k + 1].line : lines.length) - fns[k].line;
const total = fns.reduce((a, f) => a + f.len, 0);
let acc = 0, count = 0;
for (const f of fns.slice().sort((a, b) => b.len - a.len)) { acc += f.len; count++; if (acc / total >= 0.8) break; }
console.log('  ' + count + ' / ' + fns.length + ' 个函数 = ' + ((acc / total) * 100).toFixed(0) + '% 的代码量');
console.log('  ' + fns.slice().sort((a, b) => b.len - a.len).slice(0, count).map((f) => f.name + '(' + f.len + ')').join('  '));
