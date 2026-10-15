// 抬块后的整体校验：**原始文件里的每一行（去空白、非空）都应仍出现在新文件里**，
// 且出现次数不少于原来 —— 因为抬块只是把原行搬进新函数体（逐字），另加一行调用。
// 任何"被吞掉/改错"的行都会当场暴露。
//
// 这是针对"我一度用过期行号抬错位置"那次事故加的兜底检查：单块的逆变换证明只保证
// "块内文本没改"，管不了"我抬的是不是那块"。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = process.argv[2] ?? 'src/console/routes/admin.js';
const cur = fs.readFileSync(FILE, 'utf8');
const old = execFileSync('git', ['show', `HEAD:./${FILE}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const norm = (s) => s.split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//'));   // 只管代码行：注释是路标，块搬走时本就该跟着搬或被删，
                                              // 拿"注释必须存活"当约束只会逼出一堆指向空气的孤儿注释。
const count = (lines) => {
  const m = new Map();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
};
const oldC = count(norm(old));
const newC = count(norm(cur));

const missing = [];
const shrunk = [];
// "带退出语句的行"（`continue;` / `return;` / `return true;`，含 `if (…) continue;` 这种行尾形式）
// 出现次数变少**不算问题**：抬块工具会把退出语句改写成 `return true;`（调用处再还原语义），
// 这是设计如此，且反变换证明管着这一步。其余任何一行变少都是"被吞了/改错了"，照旧报错。
const isExitBearing = (line) => /(^|\s)(return|continue|break)( true)?;$/.test(line);
for (const [line, n] of oldC) {
  const got = newC.get(line) ?? 0;
  if (got === 0) missing.push(line);
  else if (got < n) shrunk.push(`${got}/${n}  ${line}`);
}
const missingReal = missing.filter((l) => !isExitBearing(l));
const missingExit = missing.filter(isExitBearing);
const shrunkReal = shrunk.filter((s) => !isExitBearing(s.replace(/^\d+\/\d+\s+/, '')));
const shrunkExit = shrunk.filter((s) => isExitBearing(s.replace(/^\d+\/\d+\s+/, '')));
console.log(`原始非空行（去重后）${oldC.size} 种；新文件 ${newC.size} 种`);
if (missingReal.length) {
  console.log(`\n❌ 有 ${missingReal.length} 种原始行在新文件里完全找不到：`);
  for (const l of missingReal.slice(0, 15)) console.log('   ' + JSON.stringify(l.slice(0, 100)));
}
if (shrunkReal.length) {
  console.log(`\n⚠️ 有 ${shrunkReal.length} 种原始行出现次数变少：`);
  for (const l of shrunkReal.slice(0, 15)) console.log('   ' + l.slice(0, 120));
}
if (missingExit.length || shrunkExit.length) {
  console.log(`\n（退出语句被改写成 return true; 的 ${missingExit.length + shrunkExit.length} 项，不算问题）`);
  for (const l of [...missingExit, ...shrunkExit]) console.log('   ' + l.slice(0, 120));
}
if (!missingReal.length && !shrunkReal.length) console.log('\n✅ 每一行原始代码都还在（抬块没吞东西）');
process.exit(missingReal.length || shrunkReal.length ? 1 : 0);
