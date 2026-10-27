// R1 范围勘察 v2：用"全文件声明 ∩ 控制台内引用"算真实依赖，避免属性名污染
import fs from 'node:fs';
import { projectPath } from '../lib/paths.mjs';

const SRC = projectPath('src/bridge.js');
const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const START = 1458, END = 4495;
const body = lines.slice(START - 1, END - 1).join('\n');

// 去掉字符串/模板/行注释，减少噪声
const strip = (s) => s
  .replace(/\/\/[^\n]*/g, '')
  .replace(/'(?:[^'\\]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');
const bodyClean = strip(body);

// 全文件里声明过的名字（函数名 / 顶层 const / import 名）
const declared = new Set();
for (const m of lines.join('\n').matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
for (const m of lines.join('\n').matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
const importLine = lines.find((l) => l.includes("from './dsh-client.js'")) || '';
for (const m of (lines.filter((l) => /^import /.test(l)).join(' ')).matchAll(/([A-Za-z_$][\w$]*)\s*(?:,|\})/g)) declared.add(m[1]);

// 控制台体内声明的
const local = new Set();
for (const m of bodyClean.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
for (const m of bodyClean.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
for (const m of bodyClean.matchAll(/\(([^)]*)\)\s*=>/g)) for (const p of m[1].split(',')) { const t = p.trim().split(/[\s=:]/)[0]; if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t); }
for (const m of bodyClean.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
for (const m of bodyClean.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) local.add(m[1]);

// 引用计数（排除成员访问 a.b 里的 b）
const used = new Map();
for (const m of bodyClean.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
  const id = m[1];
  if (local.has(id)) continue;
  if (!declared.has(id)) continue;
  used.set(id, (used.get(id) || 0) + 1);
}
const deps = [...used.entries()].sort((a, b) => b[1] - a[1]);

console.log('=== 控制台真正依赖的外部名字（全文件声明 ∩ 内部引用）===');
console.log('  共 ' + deps.length + ' 个 —— 这就是搬迁时要注入的参数面');
for (const [k, v] of deps) console.log('    ' + k.padEnd(36) + 'x' + v);

console.log('\n=== 会写哪些状态 ===');
const w = new Set();
for (const m of body.matchAll(/(atomicWriteJson|writeFileSync|appendFileSync|saveSocialV2State|saveState|saveSticker\w*|saveSlang\w*|resetV2\w*)\(/g)) w.add(m[1]);
console.log('  ' + [...w].join(', '));

console.log('\n=== 内部结构分块（大段注释）===');
for (let i = 0; i < lines.length && i < END - 1; i++) {
  if (i < START - 1) continue;
  const t = lines[i].trim();
  if (/^\/\/\s*(?:[=\-—]{4,}|【)/.test(t)) console.log('  L' + (i + 1) + '  ' + t.slice(0, 74));
}

console.log('\n=== 搬迁难度 ===');
console.log('  内嵌 HTML 片段: ' + ((body.match(/<!doctype|<\/html>|text\/html/g) || []).length) + ' 处');
console.log('  路由数: 82 精确 + 4 前缀');
console.log('  需注入的外部名字: ' + deps.length + ' 个');
console.log('  占 bridge.js: ' + ((body.split('\n').length / lines.length) * 100).toFixed(1) + '%');
