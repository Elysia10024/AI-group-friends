// bridge.js 解剖：函数清单 / 体积分布 / 重复概念 / 状态与配置面
import fs from 'node:fs';

const SRC = '<项目根>/src/bridge.js';
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');
console.log('bridge.js: ' + lines.length + ' 行 / ' + (src.length / 1024).toFixed(1) + ' KB\n');

// ---- 1) 顶层函数清单（缩进 2 空格 = 在 main() 闭包内） ----
const fns = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s{0,4}(async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/);
  if (!m) continue;
  const indent = lines[i].match(/^\s*/)[0].length;
  fns.push({ name: m[2], line: i + 1, indent, async: !!m[1] });
}
for (let k = 0; k < fns.length; k++) {
  const end = k + 1 < fns.length ? fns[k + 1].line : lines.length;
  fns[k].len = end - fns[k].line;
}
const total = fns.reduce((a, f) => a + f.len, 0);
console.log('=========== 1) 函数数量与体积 ===========');
console.log('  函数总数 ' + fns.length + '，占 ' + total + ' 行 (' + ((total / lines.length) * 100).toFixed(0) + '%)');
console.log('  最大的 20 个：');
for (const f of fns.slice().sort((a, b) => b.len - a.len).slice(0, 20)) {
  console.log('    ' + String(f.len).padStart(5) + ' 行  L' + String(f.line).padStart(5) + '  ' + (f.async ? 'async ' : '      ') + f.name);
}

// ---- 2) 命名中的"累积证据" ----
console.log('\n=========== 2)  accretions（名字里的版本后缀） ===========');
for (const pat of [/V2/g, /V3/g, /Old|old/g, /Legacy|legacy/g, /New|new_/g, /fix|Fix/g, /actual|Actual/g, /real|Real/g, /Fallback|fallback/g]) {
  const n = (src.match(pat) || []).length;
  if (n) console.log('  ' + String(pat).padEnd(24) + n);
}

// ---- 3) 顶层"段"（===== 注释） ----
console.log('\n=========== 3) ===== 标记的段落 ===========');
const secs = [];
for (let i = 0; i < lines.length; i++) {
  if (/^\s*\/\/\s*={4,}/.test(lines[i]) || /^\s*\/\/\s*[-=]{3,}.*[-=]{3,}/.test(lines[i])) {
    const t = lines[i].replace(/^[\s/=-]+/, '').trim();
    if (t) secs.push({ line: i + 1, t });
  }
}
for (const s of secs) console.log('  L' + String(s.line).padStart(5) + '  ' + s.t.slice(0, 80));
console.log('  共 ' + secs.length + ' 段');

// ---- 4) 模块级状态与配置读取 ----
console.log('\n=========== 4) 状态面 ===========');
const stateDecls = [...src.matchAll(/^const\s+([A-Z_0-9]+)\s*=\s*(path\.join\([^)]*\)|[^;]{0,80})/gm)];
for (const m of stateDecls) console.log('  const ' + m[1] + ' = ' + m[2].replace(/\s+/g, ' ').slice(0, 70));
const files = [...src.matchAll(/'(state\/[^']+|[\w.-]+\.jsonl?|[\w.-]+\.md)'/g)].map((m) => m[1]);
console.log('  引用的文件名（去重）: ' + [...new Set(files)].join(', '));

// ---- 5) cfg 读取点（每处都是一个隐式参数） ----
console.log('\n=========== 5) 配置读取面 ===========');
const cfgReads = [...src.matchAll(/cfg(?:\.\w+)+/g)].map((m) => m[0]);
const cfgAgg = new Map();
for (const c of cfgReads) {
  const root = c.split('.').slice(0, 3).join('.');
  cfgAgg.set(root, (cfgAgg.get(root) || 0) + 1);
}
console.log('  cfg.* 读取点共 ' + cfgReads.length + ' 处，去重前缀 ' + cfgAgg.size + ' 个：');
for (const [k, v] of [...cfgAgg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
  console.log('    ' + k.padEnd(40) + v);
}

// ---- 6) HTTP 路由（控制台面） ----
console.log('\n=========== 6) 控制台路由 ===========');
const routes = [...src.matchAll(/case\s+'(\/[^']+)'/g)].map((m) => m[1]);
console.log('  ' + routes.length + ' 个: ' + routes.join(' '));

// ---- 7) 顶层 try/catch 兜底（错误静默点） ----
console.log('\n=========== 7) 静默吞错 ===========');
const emptyCatch = (src.match(/catch\s*(\([^)]*\))?\s*\{\s*\}/g) || []).length;
const catchAll = (src.match(/\}\s*catch/g) || []).length;
console.log('  空 catch {} : ' + emptyCatch + ' 处');
console.log('  catch 总数   : ' + catchAll + ' 处');
