// R1 范围勘察：startConsoleServer 里到底装了什么
// 目的：搬 3037 行之前，先量清 ① 它对外暴露多少接口 ② 它依赖 main() 里多少闭包变量
import fs from 'node:fs';

const SRC = '<项目目录>/qq-bridge-main/src/bridge.js';
const lines = fs.readFileSync(SRC, 'utf8').split('\n');

const START = 1458;            // startConsoleServer 起始行（1-based）
const END = 4495;              // 下一个函数起始行（1-based）→ 本函数到 4494
const body = lines.slice(START - 1, END - 1);
const code = body.join('\n');

console.log('=== startConsoleServer 范围 ===');
console.log('  行 ' + START + ' ~ ' + (END - 1) + '，共 ' + body.length + ' 行');
console.log('  下一个函数在 L' + END + ': ' + lines[END - 1].trim().slice(0, 70));

// ---------- 1) 接口清单 ----------
console.log('\n=== 1) 对外接口 ===');
const paths = new Map();
const addPath = (p) => { if (p && p.startsWith('/')) paths.set(p, (paths.get(p) || 0) + 1); };
for (const m of code.matchAll(/url\.pathname\s*===\s*'([^']+)'/g)) addPath(m[1]);
for (const m of code.matchAll(/url\.pathname\s*===\s*"([^"]+)"/g)) addPath(m[1]);
for (const m of code.matchAll(/case\s+'(\/[^']*)'/g)) addPath(m[1]);
for (const m of code.matchAll(/pathname\.startsWith\('([^']+)'\)/g)) addPath(m[1]);
for (const m of code.matchAll(/p\s*===\s*'(\/[^']+)'/g)) addPath(m[1]);
console.log('  精确匹配/ case 到的路径: ' + paths.size + ' 个');
for (const [p, n] of [...paths.entries()].sort()) console.log('    ' + p.padEnd(46) + (n > 1 ? 'x' + n : ''));

// 路径前缀/正则式路由（startsWith / test）
console.log('\n  startsWith / 正则式路由:');
const prefixes = new Set();
for (const m of code.matchAll(/pathname\.startsWith\('([^']+)'\)/g)) prefixes.add(m[1]);
for (const m of code.matchAll(/startsWith\('(\/[^']+)'\)/g)) prefixes.add(m[1]);
for (const p of [...prefixes].sort()) console.log('    ' + p + '*');
if (!prefixes.size) console.log('    （无）');

// ---------- 2) 对外依赖（闭包变量）----------
console.log('\n=== 2) 依赖 main() 的闭包变量（= 搬迁时要注入的参数）===');
const declaredInside = new Set();
for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declaredInside.add(m[1]);
for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) declaredInside.add(m[1]);
for (const m of code.matchAll(/\(([^)]*)\)\s*=>/g)) {
  for (const p of m[1].split(',')) { const t = p.trim().split(/[\s=:]/)[0]; if (/^[A-Za-z_$][\w$]*$/.test(t)) declaredInside.add(t); }
}
const KEYWORDS = new Set(('const let var function return if else for while do break continue new typeof instanceof in of delete void this null undefined true false try catch finally throw switch case default class extends super import export await async yield static get set ' +
  'JSON Object Array String Number Boolean Math Date Promise Map Set Buffer RegExp Error URL URLSearchParams Symbol BigInt parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent setTimeout setInterval clearTimeout clearInterval structuredClone globalThis process require console').split(/\s+/));

const ids = new Map();
for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\b(?!\s*:)/g)) {
  const id = m[1];
  if (KEYWORDS.has(id) || declaredInside.has(id)) continue;
  ids.set(id, (ids.get(id) || 0) + 1);
}
// 只保留出现在成员访问/调用位置、且不像局部变量的
const deps = [...ids.entries()].filter(([k, v]) => v >= 2).sort((a, b) => b[1] - a[1]);
console.log('  候选外部标识符 ' + deps.length + ' 个（出现 ≥2 次）:');
for (const [k, v] of deps.slice(0, 60)) console.log('    ' + k.padEnd(34) + 'x' + v);
if (deps.length > 60) console.log('    …还有 ' + (deps.length - 60) + ' 个');

// ---------- 3) 会写哪些状态 ----------
console.log('\n=== 3) 会写哪些状态/文件 ===');
const writes = new Set();
for (const m of code.matchAll(/(atomicWriteJson|writeFileSync|appendFileSync|save\w*State|saveState|saveSticker\w*|saveSlang\w*)\(/g)) writes.add(m[1]);
console.log('  写操作: ' + [...writes].join(', '));
const files = new Set();
for (const m of code.matchAll(/\b([A-Z_]{4,})\b/g)) { if (/FILE|LOG|DIR|PATH/.test(m[1])) files.add(m[1]); }
console.log('  用到的路径常量: ' + [...files].join(', '));

// ---------- 4) 子块结构 ----------
console.log('\n=== 4) 内部大块（注释分节）===');
for (let i = 0; i < body.length; i++) {
  const t = body[i].trim();
  if (/^\/\/\s*[-=—]{4,}/.test(t) || /^\/\/\s*【/.test(t) || /^\/\/ ={4,}/.test(t)) {
    console.log('  L' + (START + i) + '  ' + t.slice(0, 76));
  }
}

// ---------- 5) 独立度评估 ----------
console.log('\n=== 5) 搬迁难度评估 ===');
const htmlCount = (code.match(/<!doctype|<\/html>|text\/html/g) || []).length;
console.log('  内嵌 HTML/CSS/JS 片段: ' + htmlCount + ' 处');
console.log('  顶层闭包依赖数: ' + deps.length + '（越多注入面越大）');
console.log('  行数占比: ' + ((body.length / lines.length) * 100).toFixed(1) + '%');
