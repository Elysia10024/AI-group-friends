// check-atomic-write —— 静态守卫：全仓的原子写只允许 core/state-io.js 一个实现。
//
// 背景（2026-10-27 第 1 期 / 审计 D-04）：state-io.js 的注释明令禁止固定临时名，
// 但历史上先后有 6 处各自重抄了「写 tmp → rename」（runtime.saveState、image-library、
// mom-channel、takeover、slang-learner、sticker-lib），其中 2 处用的正是被点名的固定名。
// 规矩写在注释里拦不住下一份抄写，所以用这条守卫拦：src 下除 state-io.js 外，
// 出现 renameSync( 或往 *.tmp 写文件就直接红。
//
// 用法：node scripts/check-atomic-write.mjs     退出码 0 = 通过
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const ALLOWED = new Set([path.join(SRC, 'core', 'state-io.js')]);

const PATTERNS = [
  { re: /renameSync\(/, why: 'renameSync 只允许出现在 core/state-io.js（原子写的唯一实现）' },
  { re: /writeFileSync\([^)]*\.tmp/, why: '直接写 .tmp 临时文件：请改用 core/state-io.js 的 atomicWriteJson/atomicWriteText' },
];

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) files.push(p);
  }
})(SRC);

let bad = 0;
for (const f of files) {
  if (ALLOWED.has(f)) continue;
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((ln, i) => {
    for (const { re, why } of PATTERNS) {
      if (re.test(ln)) {
        bad += 1;
        console.error(`❌ ${path.relative(ROOT, f)}:${i + 1}  ${why}`);
        console.error(`     ${ln.trim()}`);
      }
    }
  });
}

if (bad > 0) {
  console.error(`\ncheck-atomic-write: ${bad} 处违规。原子写（写临时文件再 rename）只能由 src/core/state-io.js 实现，其余一律 import 它。`);
  process.exit(1);
}
console.log(`check-atomic-write: OK（扫了 ${files.length} 个文件，原子写实现只有 core/state-io.js 一份）`);
