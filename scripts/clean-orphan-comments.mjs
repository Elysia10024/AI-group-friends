// 清掉"抬块落下的段落路标"。
//
// 抬块工具搬的是**语句**，块上方的 `// ── xxx ──` 段落注释如果和语句之间隔了空行，
// 就会留在原地 —— 于是一个 handler 的分派尾巴上挂着几行指向**别的文件**的注释。
// （早期版本连注释一起吸走，但只吸"紧贴"的那些；隔空行的那种还得靠这个脚本收尾。）
//
// 判据：`// ── …` 后面第一个非空行是 `return false;` 或 `}` —— 说明这个段落后面已经没有
// 属于它的代码了，注释是孤儿。
//
// 用法：node scripts/clean-orphan-comments.mjs [文件…]（默认扫 src/console/routes/*.js）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(path.join(ROOT, 'src/console/routes')).filter((f) => f.endsWith('.js'))
    .map((f) => `src/console/routes/${f}`);

let total = 0;
for (const rel of files) {
  const full = path.join(ROOT, rel);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\/\/ ──/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j += 1;
      const nxt = (lines[j] ?? '').trim();
      if (nxt === 'return false;' || nxt === '}') {
        console.log(`  ${rel}:${i + 1}  删孤儿路标  ${lines[i].trim()}`);
        total += 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  if (out.length !== lines.length) fs.writeFileSync(full, out.join('\n'));
}
console.log(total ? `\n✅ 共删 ${total} 行` : '\n✅ 没有孤儿路标');
