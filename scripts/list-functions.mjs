// 列大函数：按**真实区间**统计 src/ 下每个函数的行数，倒序打印。
//
// 为什么需要它：`scripts/recon/audit-anatomy.mjs` 是按"到下一个 function 声明的距离"估体积的，
// 而且不认箭头常量 —— 拆完 main() 之后它给的数字全是假的（把 37 行的函数算成 467 行）。
// 这个版本用 `functionSites`（split-console.mjs，认 `function` 声明与 `const x = () => {}`）
// 拿真实 bodyStart/bodyEnd，再按行号算长度。
//
// 用法：
//   node scripts/list-functions.mjs [--min 60] [--top 30] [--all]
//     --min  只列比这个行数大的（默认 60）
//     --top  最多列几条（默认 30）
//     --all  连 src/core 的单测文件一起算
import fs from 'node:fs';
import path from 'node:path';
import { blankCode, functionSites } from './split-console.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const MIN = arg('min', 60);
const TOP = arg('top', 30);
const ALL = process.argv.includes('--all');

const ROOT = path.resolve(import.meta.dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(path.join(ROOT, 'src'));

const rows = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (!ALL && rel.includes('.test.')) continue;
  const src = fs.readFileSync(file, 'utf8');
  const code = blankCode(src);
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  const sites = functionSites(code);
  for (const s of sites) {
    const lines = lineOf(s.bodyEnd) - lineOf(s.bodyStart) + 1;
    // "容器"= 体内还套着别的函数（工厂/主函数）。它的大不等于"单体函数难读"，
    // 所以单独标注，别混进排名里误导。
    const inner = sites.filter((o) => o !== s && o.bodyStart > s.bodyStart && o.bodyEnd < s.bodyEnd).length;
    if (lines < MIN && inner === 0) continue;
    rows.push({ file: rel, name: s.name, start: lineOf(s.bodyStart), lines, inner });
  }
}
const solo = rows.filter((r) => r.inner === 0).sort((a, b) => b.lines - a.lines);
const containers = rows.filter((r) => r.inner > 0).sort((a, b) => b.lines - a.lines);

console.log(`单体函数（体内没有别的函数）行数 ≥ ${MIN} 的：共 ${solo.length} 个\n`);
for (const r of solo.slice(0, TOP)) {
  console.log(`  ${String(r.lines).padStart(5)} 行  ${r.file}:${r.start}  ${r.name}`);
}
console.log('\n容器函数（体内还套着函数，大小不等于"单个函数难读"）：');
for (const r of containers.slice(0, 10)) {
  console.log(`  ${String(r.lines).padStart(5)} 行  含 ${String(r.inner).padStart(2)} 个内部函数  ${r.file}:${r.start}  ${r.name}`);
}
const byFile = new Map();
for (const r of solo) byFile.set(r.file, (byFile.get(r.file) ?? 0) + r.lines);
console.log('\n按文件汇总（**单体**大函数总行数）：');
for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)} 行  ${f}`);
