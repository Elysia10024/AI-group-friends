// 审计控制台路由的 ctx 依赖：路由模块从 ctx 解构名字，而 ctx 来自
//   Object.assign(Object.create(deps), { 显式注入 })
// deps 由 bridge.js 的 startConsoleServer({...}) 提供。
//
// 任何一个"解构了却没人提供"的名字，运行到那一行就是 undefined ——
// 典型症状 `xxx is not a function`。发送通道就是这么整体坏掉的：
// rateLimitCheck / markAiSpoke 等没传进 deps，/api/socialV2/send-* 全 500。
//
// 注意：**不能**把 server.js 自己的 import 算成"可用" —— 那些名字只活在
// server.js 作用域里，不进 ctx（markAiSpoke 就是这么被漏报过去的）。
//
// 用法：node scripts/console-ctx-audit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { blankCode } from './split-console.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const serverSrc = read('src/console/server.js');
const bridgeSrc = read('src/bridge.js');

// 1) server.js 里显式注入 ctx 的字面量
const explicit = new Set();
{
  const m = serverSrc.match(/Object\.assign\(Object\.create\(deps\),\s*\{([\s\S]*?)\}\s*\);/);
  if (!m) { console.error('❌ 找不到 ctx 装配处，脚本需要更新'); process.exit(1); }
  for (const part of m[1].split(',')) {
    const key = part.trim().split(':')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(key)) explicit.add(key);
  }
}

// 2) bridge.js 真正传给 startConsoleServer 的 deps 对象键（含 get/set）
const depsKeys = new Set();
{
  const at = bridgeSrc.indexOf('startConsoleServer({');
  if (at < 0) { console.error('❌ 找不到 startConsoleServer 调用，脚本需要更新'); process.exit(1); }
  const open = bridgeSrc.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < bridgeSrc.length; i++) {
    if (bridgeSrc[i] === '{') depth++;
    else if (bridgeSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const code = blankCode(bridgeSrc.slice(open + 1, end));
  for (const part of code.split(/[,\n]/)) {
    let t = part.trim();
    if (!t) continue;
    t = t.replace(/^(?:async\s+)?(?:get|set)\s+/, '');
    t = t.split(/[:(]/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t)) depsKeys.add(t);
  }
}

// 2.5) deps 里的**简写项**必须在 bridge.js 里真的声明过（2026-10-13 加）。
// 真踩过：给控制台传了 `commentKey,`（简写），而 bridge.js 里根本没有这个名字 —— 桥**启动即崩**
// （`ReferenceError: commentKey is not defined`，堆栈只指向 startConsoleServer 那一行）。
// 上面两条查的都是"名字有没有人提供/有没有解构"，查不出"提供它的那个名字自己不存在"。
// 判据：deps 里以简写形式出现的名字，必须能在 bridge.js 的 import / const / let / function / 解构里找到。
const shorthand = [];
{
  const at = bridgeSrc.indexOf('startConsoleServer({');
  const open = bridgeSrc.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < bridgeSrc.length; i++) {
    if (bridgeSrc[i] === '{') depth++;
    else if (bridgeSrc[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const code = blankCode(bridgeSrc.slice(open + 1, end));
  for (const part of code.split(/[,\n]/)) {
    const t = part.trim();
    // 只看**裸名字**（`foo,`）；`foo: bar` 这种值的表达式交给运行时/JSDoc 检查，不在这里做语法分析
    if (/^[A-Za-z_$][\w$]*$/.test(t)) shorthand.push(t);
  }
}
const bridgeDeclared = new Set();
for (const m of bridgeSrc.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
  for (const p of m[1].split(',')) {
    const t = p.trim().split(/\s+as\s+/).pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t)) bridgeDeclared.add(t);
  }
}
for (const m of bridgeSrc.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) bridgeDeclared.add(m[1]);
for (const m of bridgeSrc.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) bridgeDeclared.add(m[1]);
for (const m of bridgeSrc.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) bridgeDeclared.add(m[1]);
for (const m of bridgeSrc.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
  for (const p of m[1].split(',')) {
    const t = p.trim().split(':').pop().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t)) bridgeDeclared.add(t);
  }
}
const undeclaredDeps = shorthand.filter((n) => !bridgeDeclared.has(n));

const available = new Set([...explicit, ...depsKeys]);

// 3) 逐个路由模块，收集 `handleX(ctx)` 里 `const { ... } = ctx;` 解构出来的名字
const dir = path.join(ROOT, 'src/console/routes');
const missingAll = new Map();
// 反方向（2026-10-12 加）：**用了 ctx 上的名字却没解构** —— 症状一样是 500（ReferenceError），
// 但上面那条查不出来（它只查"解构了没人提供"）。真踩过：新写的 qzone 路由里用了 `req`，
// 而 `req` 确实在 ctx 上（server.js 显式注入），只是忘了写进解构列表 → 一调就 "req is not defined"。
// 判据：文件里用到的标识符 ∩ ctx 可用名字 − 本文件声明的名字 − 解构列表。
const notDestructured = new Map();
/** 去掉注释与字符串字面量，免得注释里提到某个名字就被当成"用了"。 */
const stripNoise = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``');
/** 本文件里"自己声明过"的名字（const/let/var/function/class/形参）。 */
const declaredNames = (s) => {
  const out = new Set();
  for (const m of s.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of s.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of s.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  // 解构声明里的每个名字：const { a, b: c } = x / const [a, b] = x / 形参
  for (const m of s.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const p of m[1].split(',')) {
      const t = p.trim().split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) out.add(t);
    }
  }
  for (const m of s.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const p of m[1].split(',')) {
      const t = p.trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) out.add(t);
    }
  }
  return out;
};
/** 取一个 handler 的函数体（**跳过开头的 `const {…} = ctx;`**，否则括号配对会停在那对花括号上）。 */
function handlerBody(clean, matchIndex, matchLength) {
  const from = matchIndex + matchLength;
  const dm = /const\s*\{[\s\S]*?\}\s*=\s*ctx\s*;/.exec(clean.slice(from));
  const scanFrom = dm ? from + dm[0].length : from;
  let depth = 0;
  let started = false;
  for (let i = scanFrom; i < clean.length; i += 1) {
    if (clean[i] === '{') { depth += 1; started = true; } else if (clean[i] === '}') {
      depth -= 1;
      if (started && depth === 0) return clean.slice(scanFrom, i);
    }
  }
  return clean.slice(scanFrom);
}

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
  const src = read(`src/console/routes/${file}`);
  const clean = stripNoise(src);
  const declared = declaredNames(clean);
  // 方向一：解构了、但没人提供（在 src 上扫：要精确拿到解构列表）
  for (const hm of src.matchAll(/export\s+async\s+function\s+(handle\w+)\s*\(\s*ctx\s*\)\s*\{/g)) {
    const body = src.slice(hm.index + hm[0].length, hm.index + hm[0].length + 6000);
    const dm = body.match(/const\s*\{([\s\S]*?)\}\s*=\s*ctx\s*;/);
    if (!dm) continue;
    for (const p of dm[1].split(',')) {
      const t = p.trim().split(':').pop().trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(t)) continue;
      if (available.has(t)) continue;
      if (!missingAll.has(t)) missingAll.set(t, new Set());
      missingAll.get(t).add(`${file}:${hm[1]}`);
    }
  }
  // 方向二：用了 ctx 上的名字、却没解构（在 clean 上扫：注释/字符串里的同名不算"用了"）
  for (const hm of clean.matchAll(/export\s+async\s+function\s+(handle\w+)\s*\(\s*ctx\s*\)\s*\{/g)) {
    const destructured = new Set();
    const dm = /const\s*\{([\s\S]*?)\}\s*=\s*ctx\s*;/.exec(clean.slice(hm.index + hm[0].length));
    if (!dm) continue;
    for (const p of dm[1].split(',')) {
      const t = p.trim().split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) destructured.add(t);
    }
    const cleanBody = handlerBody(clean, hm.index, hm[0].length);
    // 认"变量用法"而不是"文本里出现过"：两处排除都是踩过的误报 ——
    //   · 前面紧挨着 `/` 的（`/api/slang` 这种路径、正则字面量里的路径）不是变量；
    //   · 后面紧跟着 `:` 的（`closedAgentPreset: deps.x` 这种对象键）不是变量用法。
    for (const im of cleanBody.matchAll(/(?<![/.\w$-])([A-Za-z_$][\w$]*)(?!\s*:)/g)) {
      const name = im[1];
      if (!available.has(name) || destructured.has(name) || declared.has(name)) continue;
      if (!notDestructured.has(name)) notDestructured.set(name, new Set());
      notDestructured.get(name).add(`${file}:${hm[1]}`);
    }
  }
}

if (missingAll.size) {
  console.log('❌ 这些名字被路由从 ctx 解构，但既不在 server.js 的显式注入里，也不在 deps 里：\n');
  for (const [name, where] of [...missingAll].sort()) {
    console.log(`   ${name.padEnd(28)} ${[...where].join(', ')}`);
  }
  console.log('\n修法：在 bridge.js 的 startConsoleServer({...}) 里补上（名字必须在 main 作用域里可用），');
  console.log('      或者在 src/console/server.js 的 Object.assign 里补 server.js 自己 import 的名字。');
  process.exit(1);
}
if (undeclaredDeps.length) {
  console.log('❌ 这些名字是以简写形式传进 startConsoleServer 的，但 bridge.js 里根本没声明过：\n');
  for (const name of undeclaredDeps) console.log(`   ${name}`);
  console.log('\n症状：桥**启动即崩**（ReferenceError: xxx is not defined），堆栈只指向 startConsoleServer 那一行。');
  console.log('修法：要么从域/模块的解构里把它取出来（`const { xxx } = someMod`），要么把 deps 里那一行删掉。');
  process.exit(1);
}
if (notDestructured.size) {
  console.log('❌ 这些名字在 route 里被用到了、ctx 上也有，但**没写进 `const { … } = ctx`**：\n');
  for (const [name, where] of [...notDestructured].sort()) {
    console.log(`   ${name.padEnd(28)} ${[...where].join(', ')}`);
  }
  console.log('\n症状：那条路由一被调用就 500（ReferenceError: xxx is not defined）—— 语法检查发现不了。');
  console.log('修法：把名字补进该 route 的 `const { … } = ctx;` 解构列表。');
  process.exit(1);
}
console.log('✅ 所有路由解构的 ctx 名字都有来源');
console.log('✅ 路由里没有"用了 ctx 上的名字却没解构"的情况');
console.log(`✅ startConsoleServer 的 ${shorthand.length} 个简写项在 bridge.js 里都有声明`);
