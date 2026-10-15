// split-console.mjs —— 作用域分析工具 + 当年把 startConsoleServer 搬出 bridge.js 的搬迁脚本。
//
// **搬迁本身已完成**（2026-09-18，见 git 历史）：startConsoleServer 现在住在
// src/console/server.js，所以脚本默认输入 bridge.js 里已经没有它了 —— CLI 那条路已退休。
//
// 它现在的价值是**前半部分的库**：blankCode / matchBraces / declaredInside / countRefs /
// visibleOuterNames。按域拆 src/console/server.js 时要靠它们算「这一段路由到底用到了
// 哪些外部名字」。所以主流程包进了 main()，只在作为 CLI 跑时执行，别的工具可以安全 import
//（踩过：新的拆分工具 import 它时连带跑了对 bridge.js 的分析，直接 exit「找不到
// startConsoleServer」）。
//
// 为什么当初不按「16 段原地切分」做：那只是把平铺的 if 链包成嵌套函数，文件还是 8000 行，
// 找一行代码的成本一点没降（docs/重构方案.md R1'' 自己也承认了）。真正降本的是让
// bridge.js 变小 —— 而 console 那 3000 行几乎从不改。
//
// 难点是 console 闭包引用了 bridge.js 里的一大堆状态。做法：把用到的名字全部变成
// 解构参数（`export function startConsoleServer({ cfg, socialV2, ... })`），**正文一行不改**。
// 只读的名字直接传值；被写入的名字需要 get/set 访问器。
//
// 分析为什么不能偷懒（前两版都栽在这里）：
//   1. startConsoleServer 是嵌在 main() 里的**内层函数**，cfg / socialV2 / currentMode
//      都是 main() 的局部变量，只看"文件顶层声明"会全漏掉；
//   2. 反过来，把"文件里任何地方声明过的名字"都算进来又会把 main() 里深层箭头函数的
//      参数（ok / entries / sender …）全收进来，凭空多出 100 多个假依赖。
//   所以必须走**作用域链**：文件的顶层声明 ∪ 每个祖先函数的"直接子声明 + 形参"，
//   再减去函数体内自己声明的名字。
//   3. 引用统计还要排掉对象字面量的键：`sendJson({ ok: true })` 里的 ok 不是引用，
//      光这一个名字就制造了 406 次假引用。
//
// 用法：
//   node scripts/split-console.mjs            # 分析 bridge.js（搬迁前的输入；现在已无目标函数）
//   node scripts/split-console.mjs --json     # 同上，输出 JSON
//   import { blankCode, matchBraces, declaredInside, countRefs } from './split-console.mjs'   # 当库用
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// BRIDGE_SRC 可以指向别处的副本（重放搬迁时用：从 git 取回搬迁前的 bridge.js），
// 但输出永远写到正式的 src/bridge.js。
const SRC = process.env.BRIDGE_SRC || path.join(ROOT, 'src', 'bridge.js');
const OUT_BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const TARGET = 'startConsoleServer';

// ---------------------------------------------------------------- 词法：抹掉字符串/注释

/**
 * 把字符串 / 模板串 / 正则 / 注释的内容替换成空格，**保持长度与换行不变**。
 * 长度不变是关键：后面所有偏移量都能直接映射回原文。
 *
 * 模板串要特别小心：`${...}` 里的**是代码**，必须原样保留。第一版图省事把整个
 * `${}` 连内容一起抹平，结果 `http://127.0.0.1:${port}` 里的 port 就此消失，
 * 依赖表里少一个名字 —— 搬迁就会 ReferenceError。所以这里老老实实做状态机。
 */
export function blankCode(text) {
  const out = text.split('');
  const n = text.length;
  const keep = (j) => { if (out[j] !== '\n') out[j] = ' '; };

  let mode = 'code';            // code | sq | dq | tpl
  let braceDepth = 0;
  const saved = [];             // 进入 ${ 时保存 { mode, braceDepth }
  let prev = '';                // 上一个有意义字符，判断 `/` 是除号还是正则
  let i = 0;

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];

    if (mode === 'sq' || mode === 'dq') {
      const quote = mode === 'sq' ? "'" : '"';
      if (c === '\\') { keep(i); keep(i + 1); i += 2; continue; }
      if (c === quote) { keep(i); i++; mode = 'code'; prev = quote; continue; }
      keep(i); i++;
      continue;
    }

    if (mode === 'tpl') {
      if (c === '\\') { keep(i); keep(i + 1); i += 2; continue; }
      if (c === '`') { keep(i); i++; mode = 'code'; prev = '`'; continue; }
      if (c === '$' && c2 === '{') {
        keep(i); keep(i + 1);        // 只抹掉 ${ 本身，里面的表达式当代码处理
        saved.push({ mode: 'tpl', braceDepth });
        mode = 'code';
        braceDepth = 0;
        prev = '{';
        i += 2;
        continue;
      }
      keep(i); i++;
      continue;
    }

    // ---- mode === 'code'
    if (c === '/' && c2 === '/') {
      while (i < n && text[i] !== '\n') { keep(i); i++; }
      continue;
    }
    if (c === '/' && c2 === '*') {
      keep(i); keep(i + 1); i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { keep(i); i++; }
      if (i < n) { keep(i); keep(i + 1); i += 2; }
      continue;
    }
    if (c === "'") { keep(i); i++; mode = 'sq'; continue; }
    if (c === '"') { keep(i); i++; mode = 'dq'; continue; }
    if (c === '`') { keep(i); i++; mode = 'tpl'; continue; }
    if (c === '{') { braceDepth++; prev = c; i++; continue; }
    if (c === '}') {
      if (braceDepth > 0) { braceDepth--; prev = c; i++; continue; }
      const back = saved.pop();
      if (back) {
        keep(i);                     // 这个 } 是 ${...} 的收尾，不属于代码
        mode = back.mode;
        braceDepth = back.braceDepth;
        prev = '}';
        i++;
        continue;
      }
      prev = c; i++; continue;
    }
    if (c === '/' && /[=(,:[!&|?{};+\-*%<>~^]|^$/.test(prev)) {
      keep(i); i++;
      let inClass = false;
      while (i < n) {
        const d = text[i];
        if (d === '\\') { keep(i); keep(i + 1); i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { keep(i); i++; break; }
        else if (d === '\n') break;
        keep(i); i++;
      }
      while (i < n && /[a-z]/.test(text[i])) { keep(i); i++; }
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

/** 花括号配对：从 code[openIdx] === '{' 出发，返回 [openIdx, endExclusive)。 */
export function matchBraces(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') {
      depth--;
      if (depth === 0) return [openIdx, i + 1];
    }
  }
  return [openIdx, -1];
}

/** 找到 code[from, to) 里第一个和 code[openAt] 配对的 `(`。 */
function matchParens(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') {
      depth--;
      if (depth === 0) return [openIdx, i + 1];
    }
  }
  return [openIdx, -1];
}

// ---------------------------------------------------------------- 作用域

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'void',
  'yield', 'await', 'async', 'function', 'class', 'const', 'let', 'var', 'this', 'super', 'null',
  'undefined', 'true', 'false', 'static', 'get', 'set', 'export', 'import', 'from', 'as', 'extends'
]);

/** 从一条声明语句里抽出被声明的名字（支持多行解构，调用方负责拼好整条语句）。 */
function namesFromDecl(decl, into) {
  const d = decl.trim();
  const fn = d.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  if (fn) { into.add(fn[1]); return; }
  const cl = d.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (cl) { into.add(cl[1]); return; }
  const kw = d.match(/^(?:export\s+)?(?:const|let|var)\s+(.*)$/s);
  if (!kw) return;
  let rest = kw[1].trim();

  if (rest.startsWith('{') || rest.startsWith('[')) {
    const close = rest.startsWith('{') ? '}' : ']';
    let depth = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === rest[0]) depth++;
      else if (rest[i] === close) { depth--; if (depth === 0) { end = i; break; } }
    }
    const inner = end < 0 ? rest.slice(1) : rest.slice(1, end);
    // 顶层逗号切分，元素形如 `a` / `a: b` / `a = 1` / `a: b = 1` / `...rest`
    for (const part of splitTopLevel(inner, ',')) {
      let p = part.trim().replace(/^\.\.\./, '');
      if (!p) continue;
      const eq = p.indexOf('=');
      if (eq >= 0) p = p.slice(0, eq).trim();
      const colon = p.indexOf(':');
      if (colon >= 0) p = p.slice(colon + 1).trim();
      p = p.replace(/^\.\.\./, '');
      const m = p.match(/^([A-Za-z_$][\w$]*)/);
      if (m) into.add(m[1]);
    }
    return;
  }
  const m = rest.match(/^([A-Za-z_$][\w$]*)/);
  if (m) into.add(m[1]);
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('{[(<'.includes(ch)) depth++;
    else if ('}])>'.includes(ch)) depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * 收集"直接位于 region 最外层"的声明名。
 * region 是**已抹字面量**的代码；按行跟踪花括号深度，只认深度 0 的行 ——
 * 这样 if/for 块里的声明以及嵌套函数体里的东西都不会被误当成本层作用域。
 */
export function declsDirectIn(region) {
  const names = new Set();
  const lines = region.split('\n');
  let depth = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (depth === 0) {
      const t = line.trim();
      if (/^(?:export\s+)?(?:async\s+)?(?:const|let|var|function|class)\b/.test(t)) {
        // 跨行声明：一直拼到括号配平
        let decl = t;
        let k = li;
        while (!balancedDecl(decl) && k + 1 < lines.length) { k++; decl += ' ' + lines[k].trim(); }
        namesFromDecl(decl, names);
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
  }
  return names;
}

function balancedDecl(s) {
  let d = 0;
  let opened = false;
  for (const ch of s) {
    if ('{[('.includes(ch)) { d++; opened = true; }
    else if ('}])'.includes(ch)) d--;
  }
  return !opened || d <= 0;
}

/** 所有具名 function / 箭头函数赋值的位置和范围（用来求"祖先函数"链）。 */
export function functionSites(code) {
  const sites = [];
  const re = /(?:async\s+)?function\s*([A-Za-z_$][\w$]*)?\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const pOpen = code.indexOf('(', m.index);
    const [, pEnd] = matchParens(code, pOpen);
    if (pEnd < 0) continue;
    let bOpen = pEnd;
    while (bOpen < code.length && /\s/.test(code[bOpen])) bOpen++;
    if (code[bOpen] !== '{') continue;         // 声明（如 TS 重载 / 无体）跳过
    const [, bEnd] = matchBraces(code, bOpen);
    if (bEnd < 0) continue;
    sites.push({ name: m[1] || '(匿名)', params: code.slice(pOpen + 1, pEnd - 1), bodyStart: bOpen + 1, bodyEnd: bEnd - 1, span: bEnd - bOpen });
  }
  // const NAME = (…) => {  /  const NAME = async (…) => {
  const re2 = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g;
  while ((m = re2.exec(code))) {
    const bOpen = code.indexOf('{', m.index + m[0].length - 1);
    const [, bEnd] = matchBraces(code, bOpen);
    if (bEnd < 0) continue;
    const params = m[2].startsWith('(') ? m[2].slice(1, -1) : m[2];
    // kind:'const' —— 这个单位是**语句**（`const X = … => {…};`），结尾有分号；
    // function 声明没有。抽取工具靠它决定区间要不要把 `;` 一起带走。
    sites.push({ name: m[1], kind: 'const', params, bodyStart: bOpen + 1, bodyEnd: bEnd - 1, span: bEnd - bOpen });
  }
  return sites;
}

function paramNames(params) {
  const out = new Set();
  for (const part of splitTopLevel(params, ',')) {
    let p = part.trim().replace(/^\.\.\./, '');
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq >= 0) p = p.slice(0, eq).trim();
    // 解构形参
    namesFromDecl(`const ${p} = 0`, out);
  }
  return out;
}

/**
 * 算出 startConsoleServer 位置处**可见的外层名字**：文件顶层声明 ∪ 每个祖先函数
 * 的直接子声明与形参 ∪ import。这正是搬迁时要注入的参数面。
 */
function visibleOuterNames(code, at) {
  // 1) 文件顶层（区域就是整个文件，depth 0 即顶层）
  const names = declsDirectIn(code);

  // 2) import —— 两个坑：必须跨行匹配（bridge.js 的具名导入是多行的），
  //    而且不能要求 `from` 后面有引号 —— 字面量已经被抹成空格，引号也不在了。
  for (const m of code.matchAll(/\bimport\s*\{([\s\S]*?)\}\s*from\b/g)) {
    for (const p of m[1].split(',')) {
      const t = p.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  for (const m of code.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  // 3) 祖先函数（按 span 从小到大 = 从内到外）
  const ancestors = functionSites(code)
    .filter((s) => s.bodyStart < at && at < s.bodyEnd)
    .sort((a, b) => a.span - b.span);
  for (const a of ancestors) {
    for (const p of paramNames(a.params)) names.add(p);
    for (const n of declsDirectIn(code.slice(a.bodyStart, a.bodyEnd))) names.add(n);
  }
  return { names, ancestors: ancestors.map((a) => a.name) };
}

// ---------------------------------------------------------------- 引用

/**
 * 从一个解构模式（花括号/方括号内部文本）里抽出被声明的名字。
 * 元素形如 `a` / `a: b` / `a = 1` / `a: b = 1` / `...rest` / 嵌套。
 */
function namesFromPattern(inner, into) {
  for (const part of splitTopLevel(inner, ',')) {
    let p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq >= 0) p = p.slice(0, eq).trim();
    const colon = p.indexOf(':');
    if (colon >= 0) p = p.slice(colon + 1).trim();
    p = p.replace(/^\.\.\./, '').trim();
    if (p.startsWith('{') || p.startsWith('[')) {   // 嵌套解构
      const close = p.startsWith('{') ? '}' : ']';
      const end = p.lastIndexOf(close);
      namesFromPattern(p.slice(1, end < 0 ? undefined : end), into);
      continue;
    }
    const m = p.match(/^([A-Za-z_$][\w$]*)/);
    if (m) into.add(m[1]);
  }
}

/** 函数体内自己声明的名字（任意深度都算遮蔽）。多算只会漏依赖，这里偏保守。 */
export function declaredInside(bodyCode) {
  const local = new Set();
  for (const m of bodyCode.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  // 解构声明：`const { a, b: c } = …` / `const [x, y] = …` / `for (const [k, v] of …)`
  for (const m of bodyCode.matchAll(/(?:const|let|var)\s*\{([^{}]*)\}/g)) namesFromPattern(m[1], local);
  for (const m of bodyCode.matchAll(/(?:const|let|var)\s*\[([^\[\]]*)\]/g)) namesFromPattern(m[1], local);
  for (const m of bodyCode.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of bodyCode.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of bodyCode.matchAll(/\(([^()]*)\)\s*=>/g)) for (const p of m[1].split(',')) {
    const t = p.trim().replace(/^\.\.\./, '').split(/[\s=:]/)[0];
    if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t);
  }
  for (const m of bodyCode.matchAll(/(?:async\s+function|function|get|set|static)\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g)) {
    local.add(m[1]);
    for (const p of m[2].split(',')) {
      const t = p.trim().replace(/^\.\.\./, '').split(/[\s=:]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t);
    }
  }
  for (const m of bodyCode.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/g)) {
    if (KEYWORDS.has(m[1])) continue;
    local.add(m[1]);
    for (const p of m[2].split(',')) {
      const t = p.trim().replace(/^\.\.\./, '').split(/[\s=:]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(t)) local.add(t);
    }
  }
  for (const m of bodyCode.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  for (const m of bodyCode.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) local.add(m[1]);
  return local;
}

/** 统计 bodyCode 里对这些名字的引用次数，排掉属性访问 `a.b` 和对象键 `{ b: ... }`。 */
/**
 * 收集代码里出现的标识符。
 *
 * 关键：排除属性访问 `a.b` 里的 b，但**必须保留展开语法 `...b` 里的 b**。
 * 早先用 `(?<![.\w$])` 一个正则了事，把两者一起排除了 —— 结果
 * `{ ...SECURITY_HEADERS }` 里的 SECURITY_HEADERS 从自由变量表里消失，
 * 按域拆分后就是 "SECURITY_HEADERS is not defined"（而且只有用到展开的那几条路由会炸）。
 */
export function collectIdentifiers(code) {
  const out = new Set();
  const re = /([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(code))) {
    const i = m.index;
    // 左边界：必须不是更长 token 的一部分。
    // 漏了这条会把数字分隔符切成名字 —— 实测 `64_000_000` 被切成 `_000_000`，
    // 变成注入清单里的垃圾项，启动直接 ReferenceError。
    if (i > 0 && /[\w$]/.test(code[i - 1])) continue;
    if (code[i - 1] === '.') {
      const isSpread = code[i - 2] === '.' && code[i - 3] === '.';
      if (!isSpread) continue;
    }
    out.add(m[1]);
  }
  return out;
}

export function countRefs(bodyCode, candidates) {
  const counts = new Map();
  const re = /([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(bodyCode))) {
    const id = m[1];
    if (!candidates.has(id)) continue;
    const before = bodyCode.slice(0, m.index).match(/\S(?=\s*$)/);
    const prevCh = before ? before[0] : '';
    if (prevCh === '.') {
      // 排除 a.b 里的 b —— 但 `...x`（展开语法）的 x **不是**属性访问：
      // 那三个点里最后一个也是 `.`，早期版本一视同仁地跳过，于是展开进来的名字
      // 被漏出自由变量表，按域拆分时 `...SECURITY_HEADERS` 就变成 "SECURITY_HEADERS is not defined"。
      const isSpread = bodyCode[m.index - 2] === '.' && bodyCode[m.index - 3] === '.';
      if (!isSpread) continue;
    }
    const after = bodyCode.slice(m.index + id.length);
    const nextCh = (after.match(/^\s*(\S)/) || [])[1] || '';
    // 对象字面量的键：`{ ok: true }` / `, ok:` —— 但 `cond ? a : b` 里的 a 要保留
    if (nextCh === ':' && (prevCh === '{' || prevCh === ',')) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

/** 是否被写入（需要 get/set 访问器而不是传值）。返回赋值点相对 bodyCode 的偏移列表。 */
function writeSitesOf(bodyCode, id) {
  const esc = id.replace(/\$/g, '\\$');
  const re = new RegExp(`(?<![.\\w$])${esc}\\s*(?:=(?!=)|\\+\\+|--|\\+=|-=|\\*=|/=|\\?\\?=|\\|\\|=|&&=|\\()`, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(bodyCode))) {
    const tail = m[0].trimEnd();
    // `name(` 是函数调用，不是写入
    if (tail.endsWith('(')) continue;
    hits.push(m.index);
  }
  return hits;
}

/**
 * 这些名字的**绑定**有没有在 console 之外被重新赋值。
 *
 * 为什么必须查这个：console 只"读"一个名字，不等于可以按值传。`let dshReady = false`
 * 在 main() 里被 DSH 事件流改成 true，而 console 只是读它 —— 按第一版口径它算"只读"，
 * 于是被当成快照传进去，控制台永远显示 dshReady=false。这就是「改了没生效」的静默版本：
 * 不报错、不崩，只是永远看到旧值。
 *
 * 所以判据是「绑定是否可变」，不是「console 里有没有写」。声明语句本身（const/let/var X =）
 * 不算重新赋值。
 */
function rebindSites(code, id) {
  const esc = id.replace(/\$/g, '\\$');
  const re = new RegExp(`(?<![.\\w$])${esc}\\s*(?:=(?!=)|\\+\\+|--|\\+=|-=|\\*=|/=|\\?\\?=|\\|\\|=|&&=|\\()`, 'g');
  const hits = [];
  let m;
  while ((m = re.exec(code))) {
    const tail = m[0].trimEnd();
    if (tail.endsWith('(')) continue;                                   // 函数调用
    const before = code.slice(Math.max(0, m.index - 16), m.index);
    if (/(?:const|let|var)\s+$/.test(before)) continue;                 // 声明本身
    hits.push(m.index);
  }
  return hits;
}

// ---------------------------------------------------------------- 引用位置

/**
 * 找出 bodyCode 里对 id 的**引用**位置（偏移量可直接映射回原文，blankCode 保长度）。
 * 要区分三种写法，改写方式各不相同：
 *   `{ currentMode: x }`  → 对象键，**不能动**
 *   `{ currentMode }`     → 简写属性，必须变成 `currentMode: deps.currentMode`
 *   `currentMode`         → 普通引用，变成 `deps.currentMode`
 */
/**
 * 找到 pos 之前**最近的那个未闭合的开括号**，判断当前处在哪种括号里。
 * 简写属性（`{ X }`）只在对象字面量里成立；函数实参（`f(a, X, b)`）里的 X 是普通引用，
 * 写成 `X: ctx.X` 就是语法错误（实测把 `modePreset(key, currentMode, cfg)` 改坏过）。
 */
function enclosingBracket(code, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= 0; i -= 1) {
    const c = code[i];
    if (c === ')' || c === ']' || c === '}') depth += 1;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) return c;
      depth -= 1;
    }
  }
  return null;
}

export function refSites(bodyCode, id) {
  const esc = id.replace(/\$/g, '\\$');
  // 左边界**不能**用 `(?<![.\w$])`：它会把展开语法 `...X` 的 X 一起排掉
  // （三个点里最后一个也是 `.`），于是 X 不会被改写成 ctx.X，搬到模块里就是
  // "X is not defined"。所以左边界改到循环里逐条判断。
  const re = new RegExp(`${esc}\\b`, 'g');
  const sites = [];
  let m;
  while ((m = re.exec(bodyCode))) {
    const start = m.index;
    const end = m.index + id.length;
    const chBefore = bodyCode[start - 1];
    if (chBefore && /[\w$]/.test(chBefore)) continue;      // 更长的标识符（xS 里的 S）
    const trimmed = bodyCode.slice(0, start).replace(/\s+$/, '');
    const at = trimmed.length - 1;
    const prev = at >= 0 ? trimmed[at] : '';
    if (prev === '.') {
      const isSpread = trimmed[at - 1] === '.' && trimmed[at - 2] === '.';
      if (!isSpread) continue;                             // a.currentMode
    }
    const next = (bodyCode.slice(end).match(/^\s*(\S)/) || [])[1] || '';
    if (next === ':') continue;                            // 对象键
    // 简写属性：必须**同时**满足"前后是 { , / } ,"和"处在对象字面量里"。
    // 只看前后字符会把函数实参误判成简写（`f(a, X, b)`）。
    const shorthand = (prev === '{' || prev === ',')
      && (next === '}' || next === ',')
      && enclosingBracket(bodyCode, start) === '{';
    sites.push({ start, end, shorthand });
  }
  return sites;
}

// ---------------------------------------------------------------- 主流程

// 包成 main() 并只在作为 CLI 运行时调用 —— 否则别的工具 import 本文件复用
// blankCode / matchBraces / visibleOuterNames 时，会连带跑一遍对 bridge.js 的分析
// 然后 process.exit（踩过：新的按域拆分工具 import 它就报「找不到 startConsoleServer」）。
function main() {

const raw = fs.readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');
const code = blankCode(raw);

const at = code.search(new RegExp(`function\\s+${TARGET}\\b`));
if (at < 0) { console.error('找不到 ' + TARGET); process.exit(1); }
const openIdx = code.indexOf('{', code.indexOf('(', at));
const [bStart, bEnd] = matchBraces(code, openIdx);
if (bEnd < 0) { console.error('花括号配不上，放弃'); process.exit(1); }

const lineOf = (idx) => raw.slice(0, idx).split('\n').length;
const bodyCode = code.slice(bStart + 1, bEnd - 1);
const body = raw.slice(bStart + 1, bEnd - 1);

const { names: outer, ancestors } = visibleOuterNames(code, at);
const local = declaredInside(bodyCode);
for (const p of paramNames(code.slice(code.indexOf('(', at) + 1, openIdx))) local.add(p);

const counts = countRefs(bodyCode, outer);
const bodyStart = bStart + 1;
/** console 之外的代码；用来判断某个绑定的值会不会在运行中被换掉。 */
const outsideCode = code.slice(0, bStart) + code.slice(bEnd);

// ---- 自检：体内出现过、但既不在外层可见集合、也不是本地声明的名字。
// 如果这里有非 JS 内置的东西，就说明作用域分析漏了依赖 —— 搬迁会 ReferenceError。
const JS_GLOBALS = new Set([
  'globalThis', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Proxy', 'Reflect', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'console', 'process', 'structuredClone', 'fetch', 'AbortController', 'AbortSignal', 'Intl',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'eval', 'arguments', 'require', 'module', 'exports', '__dirname', '__filename',
  'NaN', 'Infinity', 'AggregateError', 'EvalError', 'ReferenceError', 'URIError', 'FinalizationRegistry',
  'WeakRef', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array',
  'Uint8ClampedArray', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Function', 'AsyncFunction', 'GeneratorFunction',
  'performance', 'atob', 'btoa', 'crypto', 'URLPattern', 'MessageChannel', 'BroadcastChannel',
  'EventTarget', 'Event', 'CustomEvent', 'AbortSignal', 'ReadableStream', 'WritableStream', 'TransformStream'
].map((s) => s));
// crypto 既是 Node 内置也是 import 进来的，按依赖算

const allIds = new Set();
for (const m of bodyCode.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) allIds.add(m[1]);
// 复用 countRefs 是为了排掉对象字面量的键（`{ ok: true }` 里的 ok 不是引用，
// 不过滤的话自检列表会被上百个键名淹没，根本看不出真漏了什么）。
const unresolved = [...countRefs(bodyCode, allIds).keys()]
  .filter((id) => !outer.has(id) && !local.has(id) && !KEYWORDS.has(id) && !JS_GLOBALS.has(id))
  .sort();

// 排查用：--why name1,name2 打印这些名字为什么进/没进依赖表。
{
  const arg = process.argv.find((a) => a === '--why' || a.startsWith('--why='));
  if (arg) {
    const i = process.argv.indexOf(arg);
    const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (process.argv[i + 1] || '');
    for (const nm of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const declAt = [...code.matchAll(new RegExp(`(?:const|let|var|function)\\s+${nm}\\b`, 'g'))]
        .map((m) => lineOf(m.index));
      console.log(
        `  ${nm.padEnd(22)} 外层可见=${outer.has(nm) ? 'Y' : 'n'} 本地=${local.has(nm) ? 'Y' : 'n'}` +
        ` 引用=${counts.get(nm) ?? 0} 体内出现=${allIds.has(nm) ? 'Y' : 'n'} 声明行=[${declAt.join(',')}]`
      );
    }
    process.exit(0);
  }
}

const deps = [...counts.entries()]
  .filter(([id]) => !local.has(id))
  .map(([name, count]) => {
    const inside = writeSitesOf(bodyCode, name);
    const outside = rebindSites(outsideCode, name);
    return {
      name,
      count,
      // 只要绑定是活的（console 里写、或 main 里写）就必须走访问器，不能传快照
      written: inside.length > 0 || outside.length > 0,
      writeLines: inside.map((off) => lineOf(bodyStart + off)),
      outsideWrites: outside.length
    };
  })
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

const report = {
  file: path.relative(ROOT, SRC),
  function: TARGET,
  ancestors,
  fromLine: lineOf(at),
  toLine: lineOf(bEnd - 1),
  bodyLines: body.split('\n').length,
  fileLines: raw.split('\n').length,
  scopeCandidates: outer.size,
  unresolved,
  deps,
  readOnly: deps.filter((d) => !d.written).map((d) => d.name),
  mutable: deps.filter((d) => d.written).map((d) => d.name)
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const r = report;
  console.log(`${r.function}   L${r.fromLine} – L${r.toLine}（${r.bodyLines} 行）`);
  console.log(`嵌套在: ${r.ancestors.join(' → ') || '(顶层)'}`);
  console.log(`bridge.js 共 ${r.fileLines} 行 → 搬走后剩约 ${r.fileLines - r.bodyLines} 行`);
  console.log(`外层可见名字 ${r.scopeCandidates} 个，真正用到 ${r.deps.length} 个：只读 ${r.readOnly.length}，可写 ${r.mutable.length}`);
  console.log('');
  console.log('  名字'.padEnd(34) + '引用  写入');
  for (const d of r.deps) console.log('  ' + d.name.padEnd(32) + String(d.count).padStart(4) + '  ' + (d.written ? '✍️ 是' : ''));
  console.log('');
  console.log('⚠️ 未解析标识符（应为空；非空说明作用域分析漏了依赖）:');
  console.log('  ' + (r.unresolved.join(', ') || '(空 ✅)'));
  console.log('');
  console.log('可写（需要 get/set 访问器）：');
  if (!r.mutable.length) console.log('  (无)');
  for (const d of r.deps.filter((x) => x.written)) {
    console.log(`  ${d.name}  —— 赋值点 ${d.writeLines.length} 处：L${d.writeLines.join(', L')}`);
  }
}

// ---------------------------------------------------------------- 搬迁

/** Node 内置模块：在 server.js 里直接 import，不走依赖注入。 */
const BUILTINS = new Set(['fs', 'path', 'http', 'crypto']);

if (process.argv.includes('--emit')) {
  const mutable = deps.filter((d) => d.written).map((d) => d.name);
  const injected = deps.map((d) => d.name).filter((n) => !BUILTINS.has(n) && !mutable.includes(n));

  // 安全检查：可写名字在函数体里不能有同名的局部声明，否则改写会误伤被遮蔽的引用。
  const shadowed = mutable.filter((n) => new RegExp(`(?:const|let|var|function)\\s+${n}\\b`).test(bodyCode));
  if (shadowed.length) {
    console.error('❌ 这些可写名字在函数体里有局部同名声明，改写会误伤：' + shadowed.join(', '));
    process.exit(1);
  }

  // ---- 生成 server.js 的函数体：只把 6 个可写名字改成 deps.X
  // 必须先把所有名字的位置**一次算完再统一替换**。按名字逐个替换会出错：
  // 第二个名字用的还是原始偏移，而文本已经因为第一个名字的替换变长了 ——
  // 结果就是把 `next.closedAgentPreset` 劈成两半。
  const allSites = [];
  for (const name of mutable) {
    for (const s of refSites(bodyCode, name)) allSites.push({ ...s, name });
  }
  allSites.sort((a, b) => b.start - a.start);

  let newBody = body;
  for (const s of allSites) {
    const rep = s.shorthand ? `${s.name}: deps.${s.name}` : `deps.${s.name}`;
    newBody = newBody.slice(0, s.start) + rep + newBody.slice(s.end);
  }
  const rewrites = allSites.length;
  const leftovers = mutable.map((n) => `${n}×${allSites.filter((s) => s.name === n).length}`);

  // 自检：改写完不该再有裸名字。`deps.X` 前有 `.`、简写留下的键后有 `:`，
  // 都会被 refSites 过滤掉，所以这里必须是空的。
  const residual = mutable.filter((n) => refSites(blankCode(newBody), n).length > 0);
  if (residual.length) {
    console.error('❌ 改写后仍有裸名字残留，放弃：' + residual.join(', '));
    process.exit(1);
  }

  // 从函数原缩进（2 空格）降到模块级
  const fnIndent = raw.slice(raw.lastIndexOf('\n', at) + 1, at).length;
  newBody = newBody.split('\n').map((l) => (l.startsWith(' '.repeat(fnIndent)) ? l.slice(fnIndent) : l)).join('\n');

  const header = `// 控制台 HTTP 服务 —— 从 bridge.js 搬出来的 3000 行。
//
// 为什么搬：这部分几乎从不改，却挡在每次读 bridge.js 的路上。搬走后 bridge.js
// 从约 8000 行降到约 5000 行，改 QQ 侧逻辑时不用再跨过它。
//
// 接口约定：bridge.js 把 main() 作用域里用到的名字打包成 deps 传进来，
// 函数正文保持原样。两类名字处理方式不同 ——
//   · 只读的 ${injected.length} 个：解构参数，裸名字直接用；
//   · 可写的 ${mutable.length} 个（${mutable.join(' / ')}）：写成 deps.X，bridge.js 侧用
//     get/set 访问器，所以读写都还是「活的」，不会读到过期副本。
//
// 这个文件由 scripts/split-console.mjs --emit 生成，改逻辑请直接改这里。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

export function startConsoleServer(deps) {
  const {
${injected.map((n) => '    ' + n + ',').join('\n')}
  } = deps;
`;

  const serverSrc = header + newBody + '}\n';

  // ---- 改写 bridge.js
  const lines = raw.split('\n');
  const fnStartLine = lineOf(at);          // 1-based，函数声明那行
  const fnEndLine = lineOf(bEnd - 1);      // 1-based，收尾的 `}`

  // (1) 删掉原函数，留一行指路
  const withoutFn = [
    ...lines.slice(0, fnStartLine - 1),
    `  // startConsoleServer 已搬到 src/console/server.js（由 scripts/split-console.mjs --emit 生成）。`,
    ...lines.slice(fnEndLine)
  ];

  // (2) 加 import
  let lastImport = -1;
  withoutFn.forEach((l, i) => { if (/^(?:import\s|\}\s*from\s)/.test(l)) lastImport = i; });
  withoutFn.splice(lastImport + 1, 0, `import { startConsoleServer } from './console/server.js';`);

  // (3) 调用点补上 deps
  const callIdx = withoutFn.findIndex((l) => /^\s*startConsoleServer\(\);?\s*$/.test(l));
  if (callIdx < 0) { console.error('❌ 找不到 startConsoleServer() 调用点'); process.exit(1); }
  const indent = withoutFn[callIdx].match(/^\s*/)[0];
  const accessors = mutable.map((n) =>
    `${indent}  get ${n}() { return ${n}; },\n${indent}  set ${n}(v) { ${n} = v; },`);
  const depsObj = [
    `${indent}startConsoleServer({`,
    ...injected.map((n) => `${indent}  ${n},`),
    ...accessors,
    `${indent}});`
  ];
  withoutFn.splice(callIdx, 1, ...depsObj);

  const newBridge = withoutFn.join('\n');

  fs.mkdirSync(path.join(ROOT, 'src', 'console'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', 'console', 'server.js'), serverSrc, 'utf8');
  fs.writeFileSync(OUT_BRIDGE, newBridge, 'utf8');

  console.log('✅ 已搬迁');
  console.log('  src/console/server.js   ' + serverSrc.split('\n').length + ' 行（新）');
  console.log('  src/bridge.js           ' + lines.length + ' → ' + newBridge.split('\n').length + ' 行');
  console.log('  解构注入 ' + injected.length + ' 个只读名字；可写名字改写 ' + rewrites + ' 处（' + leftovers.join(' ') + '）');
}

}   // ← 关闭 function main()

// 只有被直接当脚本跑时才执行；被 import 时保持安静。
if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  main();
}

