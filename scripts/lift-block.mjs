// 从一个长函数里把一段内聚代码**抬成同工厂内的子函数**。
//
// 和 extract-cluster.mjs 的区别：那边搬的是"整个函数声明"，这边是"函数体里的一段语句"。
// 做法是纯机械的：
//   · 块文本**逐字**进新函数（不重新缩进 —— 块的缩进如果和"工厂层函数体"的缩进相同，
//     就一个字符都不用动；不同也只是难看，不改语义）；
//   · 块里引用的**外层函数局部名**变成新函数的参数（调用处原样传回，名字不变）；
//   · 工厂作用域里的名字（ctx 解构出来的那批）不用传，天然可见。
//
// 三道守卫（不做就等着出静默 bug）：
//   ① 块里声明的名字不能在块之后还被引用（否则要返回它们 —— 这种情况拒绝，人工处理）；
//   ② 块里的 `return` 必须是**裸 return、且不在嵌套函数里**；有 return 时按"处理器"处理：
//      逐处 `return;` → `return true;`，末尾补 `return false;`，调用处写成
//      `if (await f(...)) return;` —— 语义等价（原来 return 是"这条消息处理完了"）。
//   ③ 块的自由变量必须要么来自工厂作用域、要么来自外层函数（→ 参数）；否则报错。
//
// 用法：
//   node scripts/lift-block.mjs --file src/domains/incoming.js --in handleIncoming \
//        --lines 122-135 --name recordRedbagMiss [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { blankCode, functionSites, declaredInside, collectIdentifiers, declsDirectIn } from './split-console.mjs';

const arg = (n) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : null; };
const FILE = arg('file');
const IN_FN = arg('in');
const STMT = arg('stmt');          // 只给一行，自动扩成"完整的整条语句"（推荐用这个）
// --find <子串>：按**内容**定位那一行（要求全文件唯一），不用记行号。
// 加它是因为我踩过：抬完一批之后行号全变了，再用旧行号就把片段插到了别的函数里。
const FIND = arg('find');
const LINES = arg('lines');
const NAME = arg('name');
const RETURNS = arg('returns');   // 有返回值模式：块顶层声明了这个名字，块之后还要用
// --inside：把新函数插进**外层函数体内**（而不是插成它的兄弟）。
// 好处：新函数是外层函数的闭包，外层的局部/解构名天然可见 → **一个参数都不用传**。
// 适合"一个 handler 里串了十几个端点"这种场景（console 路由），抬完 handler 只剩分派。
const INSIDE = process.argv.includes('--inside');
// 显式声明"来自外层作用域、但静态看不见"的名字：console 路由的 ctx 是
// `Object.assign(Object.create(deps), {...})`，像 crypto/fs/path 是继承来的，
// 文本扫描看不到，于是会被当成"既不在工厂作用域也不在外层函数里"而拒绝。
// 用法：--outer crypto,fs,path
const OUTER = new Set(String(arg('outer') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
// 放行块内的 break/continue（它们多半属于块内嵌套的循环，会跟着一起搬走）。
// 不静态判定，直接押给"写盘后 node --check 不过就回滚"这道闸：真属于外层循环，
// 抬出去就是 SyntaxError，回滚并报错，不会留下坏文件。
const ALLOW_LOOPS = process.argv.includes('--allow-loops');
const DRY = process.argv.includes('--dry');
if (!FILE || !IN_FN || (!LINES && !STMT && !FIND) || !NAME) {
  console.error('用法：--file <路径> --in <外层函数名> (--find <唯一子串> | --stmt <行号> | --lines <a-b>) --name <新函数名>');
  console.error('        [--inside] [--outer <逗号分隔的名字>] [--returns <名字>] [--allow-loops] [--dry]');
  console.error('  推荐 --find：按内容定位，不怕行号漂移（抬完一批之后行号必然变）。');
  process.exit(1);
}
const [A0, B0] = LINES ? LINES.split('-').map(Number) : [0, 0];

const ROOT = path.resolve(import.meta.dirname, '..');
const full = path.join(ROOT, FILE);
const src = fs.readFileSync(full, 'utf8');
const code = blankCode(src);
const lines = src.split('\n');
const lineOf = (i) => src.slice(0, i).split('\n').length;

// --stmt：从给定行自动扩成"完整的整条语句"。做法：该行往后第一个 '{' 与它配对；
// 没有 '{' 就找该行里的 ';'。这样就不会出现"只取了分支体、把 else 留成悬空"的情况。
let A = A0;
let B = B0;
// --find → 先定位行号，再走 --stmt 的自动扩张
const STMT_LINE = FIND
  ? (() => {
    const hits = lines.map((l, i) => (l.includes(FIND) ? i + 1 : 0)).filter(Boolean);
    if (hits.length !== 1) {
      console.error(`❌ --find ${JSON.stringify(FIND)} 命中 ${hits.length} 处（要求唯一）：${hits.join(', ')}`);
      process.exit(1);
    }
    return hits[0];
  })()
  : (STMT ? Number(STMT) : null);
if (STMT_LINE) {
  const lineIdx = STMT_LINE - 1;
  const startOff = lines.slice(0, lineIdx).join('\n').length + (lineIdx > 0 ? 1 : 0);
  const lineEnd = startOff + lines[lineIdx].length;
  const braceAt = code.indexOf('{', startOff);
  if (braceAt >= 0 && braceAt <= lineEnd + 200) {
    const matchClose = (open) => {
      let d = 0;
      for (let i = open; i < code.length; i += 1) {
        if (code[i] === '{') d += 1;
        else if (code[i] === '}') { d -= 1; if (d === 0) return i; }
      }
      return -1;
    };
    let close = matchClose(braceAt);
    if (close < 0) { console.error('❌ --stmt：花括号不配对'); process.exit(1); }
    // `if (A) { … } else if (B) { … } else { … }` 是**一条**语句：then 块的收尾不是语句收尾。
    // 这里继续往后把 else 分支吃掉（踩过：不收尾就会停在语句中间，⓪ 守卫会拒，净增一个 {）。
    for (;;) {
      const mElse = /^\s*else\b/.exec(code.slice(close + 1));
      if (!mElse) break;
      const nextOpen = code.indexOf('{', close + 1 + mElse[0].length - 1);
      if (nextOpen < 0) break;                     // else 后面不是块（如 else return;）→ 交给守卫判定
      const nc = matchClose(nextOpen);
      if (nc < 0) break;
      close = nc;
    }
    A = STMT_LINE;
    B = lineOf(close);
  } else {
    const semi = src.indexOf(';', startOff);
    if (semi < 0) { console.error('❌ --stmt：这一行既没有 { 也没有 ;'); process.exit(1); }
    A = STMT_LINE;
    B = lineOf(semi);
  }
  console.log(`${FIND ? `--find ${JSON.stringify(FIND)} → L${STMT_LINE}` : `--stmt L${STMT_LINE}`} → 自动扩成 L${A}-L${B}（完整的整条语句）`);
}

// 找外层函数
const sites = functionSites(code);
const outer = sites.find((s) => s.name === IN_FN);
if (!outer) { console.error(`❌ 找不到函数 ${IN_FN}`); process.exit(1); }
if (A < lineOf(outer.bodyStart) || B > lineOf(outer.bodyEnd)) { console.error(`❌ 区间不在 ${IN_FN} 体内`); process.exit(1); }

// 吸收紧贴块上方的整行注释（`// ── xxx ──` 之类的段落路标）。
// 原因：抬块只搬"语句"，上方的注释会被落下 —— 原函数里留一行指向空气的路标，
// 新函数里反而没有说明。这个坑踩过两次（send.js 的"工具调用日志"、media.js 的"清除上下文"）。
// 只吸**紧贴**的连续 `//` 行（中间隔了空行就不吸），且不能越过外层函数的 `{`。
if (!process.argv.includes('--keep-comments')) {
  const bodyStartLine = lineOf(outer.bodyStart);
  let i = A - 2;
  let n = 0;
  while (i >= bodyStartLine - 1 && i >= 0 && lines[i].trim().startsWith('//')) { i -= 1; n += 1; }
  if (n > 0) {
    console.log(`   连带搬走上方 ${n} 行注释（段落路标归块所有，别落下）`);
    A -= n;
  }
}

const blockText = lines.slice(A - 1, B).join('\n');
const blockBlank = blankCode(blockText);
if (!blockText.trim()) { console.error('❌ 空块'); process.exit(1); }

const blockLocals = declaredInside(blockBlank);
const blockIds = [...collectIdentifiers(blockBlank)];

// ① 逃逸的局部名：块里**顶层**声明、且块之后还真的用到
//
// 只算顶层声明：块若是 `if (...) { const x = 1; }` 这种整条语句，里面的 const 作用域就在
// 那对花括号里，块之后根本看不见 → 不会逃逸。（第一版用 declaredInside 把内层声明也算上，
// `sender`/`st` 被误报。）
// 再用"之后是否又声明了一次"兜一层：后面重新声明说明那些引用绑到的是**新的**那个
// （JS 里同作用域重复声明是语法错误，所以必然是嵌套作用域遮蔽）。
const afterText = lines.slice(B, lineOf(outer.bodyEnd)).join('\n');
const afterBlank = blankCode(afterText);
const afterDecls = declaredInside(afterBlank);
const blockTopDecls = declsDirectIn(blockBlank);
if (RETURNS && !blockTopDecls.has(RETURNS)) {
  console.error(`❌ --returns ${RETURNS}：块顶层没有声明这个名字`);
  process.exit(1);
}
// ⓪ 完整语句序列检查放在下面（要用 blockStartOffset）
// 逃逸检查在下面 innerDecls 之后（它要用 innerDecls 判"外层是否已有同名"）

// ② 块里的 return：必须是裸 return 且不在嵌套函数里
const blockStartOffset = lines.slice(0, A - 1).join('\n').length + (A > 1 ? 1 : 0);
const nestedSpans = [];
for (const s of sites) if (s.bodyStart > outer.bodyStart && s.bodyEnd < outer.bodyEnd) nestedSpans.push([s.bodyStart, s.bodyEnd]);
for (const m of blockBlank.matchAll(/=>\s*\{/g)) {
  const open = m.index + m[0].length - 1;
  let d = 0;
  for (let i = open; i < blockBlank.length; i += 1) {
    if (blockBlank[i] === '{') d += 1;
    // 注意坐标：blockBlank 的偏移是**块内相对**的，必须加上 blockStartOffset 才能和下面
    // 绝对坐标的 abs 比。踩过：漏加 → "箭头里 return 值"被当成"块顶层非裸 return"而拒抬。
    else if (blockBlank[i] === '}') { d -= 1; if (d === 0) { nestedSpans.push([open + blockStartOffset, i + blockStartOffset]); break; } }
  }
}

// ⓪ 区间必须是**完整语句序列**：起点的括号深度必须等于终点深度。
// 反例（真实踩过）：区间取在 `if (完成) { … } else if (出错) { … }` 前一条分支的**体内**，
// 起点比终点深一层 —— 抬走后 `else if` 悬空。node --check 能抓，但那是写盘之后的事。
{
  const depthAt = (off) => {
    let d = 0;
    for (let i = 0; i < off; i += 1) {
      if (code[i] === '{') d += 1;
      else if (code[i] === '}') d -= 1;
    }
    return d;
  };
  const dStart = depthAt(blockStartOffset);
  const dEnd = depthAt(blockStartOffset + blockText.length);
  if (dStart !== dEnd) {
    console.error(`❌ 区间不是完整语句序列：起点深度 ${dStart} ≠ 终点深度 ${dEnd}`);
    console.error('   多半是取在了某个 if/for/函数的**体内**（抬走会把 else/收尾括号留成悬空）。');
    console.error('   处理办法：把区间扩到包含那条语句的起止（含它自己的 if (...) { 与收尾 }）。');
    process.exit(1);
  }
}
// 块顶层的"退出语句"：return 或 continue。抬成函数后它们都变成 `return true;`
// （调用处再用 `if (f(...)) return;` / `if (f(...)) continue;` 还原退出语义）。
// 一个块里**只能有一种**：一个布尔表达不了"这次循环跳过"和"整个函数结束"两种意思。
// break 会退出整个循环，语义更重，本工具不处理。
const exits = [];
for (const m of blockBlank.matchAll(/\b(return|continue|break)\b/g)) {
  const abs = blockStartOffset + m.index;
  if (nestedSpans.some(([s, e]) => abs > s && abs < e)) continue;   // 嵌套函数里的，不动
  const kind = m[1];
  const tail = blockText.slice(m.index, m.index + 24);
  if (kind === 'break') {
    // 块内**嵌套循环**的 break 是正常的（循环跟着块一起搬走）；只有属于**外层循环**的 break
    // 才不能抬。静态分不清时用 --allow-loops 放行 —— 靠"写盘后 node --check 不过就自动回滚"兜底：
    // 真要是外层循环的 break，抬出去就是 SyntaxError，当场回滚。
    if (ALLOW_LOOPS) continue;
    console.error('❌ 块顶层有 break（退出整个循环），本工具不处理（若它属于块内嵌套循环，加 --allow-loops）');
    process.exit(1);
  }
  if (kind === 'continue' && ALLOW_LOOPS) continue;
  // `return true;` 也算一种退出：上一级抬块把 continue;/return; 改写成了它。
  // 抬出去后调用处写 `if (f(...)) return true;`，语义不变。
  const mTrue = /^return\s+true\s*;/.exec(tail);
  if (kind === 'return' && mTrue) { exits.push({ off: m.index, kind: 'returntrue', len: mTrue[0].length }); continue; }
  if (!new RegExp(`^${kind}\\s*;`).test(tail)) {
    console.error(`❌ 有非裸 ${kind}（${JSON.stringify(tail)}），本工具不处理（只认 裸return; / 裸continue; / return true;）`);
    process.exit(1);
  }
  exits.push({ off: m.index, kind, len: kind.length + 1 });
}
const exitKinds = [...new Set(exits.map((e) => e.kind))];
if (exitKinds.length > 1) {
  console.error(`❌ 块顶层同时有 ${exitKinds.join(' 和 ')}，一个布尔表达不了两种退出，本工具不处理`);
  process.exit(1);
}
const exitKind = exitKinds[0] ?? null;
const returns = exits.map((e) => e.off);

// ③ 自由变量 → 参数
const KEYWORDS = new Set(['return', 'if', 'else', 'const', 'let', 'var', 'function', 'async', 'await', 'try',
  'catch', 'throw', 'new', 'typeof', 'in', 'of', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
  'default', 'class', 'extends', 'super', 'this', 'null', 'undefined', 'true', 'false', 'delete', 'void', 'yield']);
const GLOBALS = new Set(['JSON', 'Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'Error',
  'Promise', 'Set', 'Map', 'RegExp', 'WeakMap', 'Symbol', 'BigInt', 'fetch', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask', 'console',
  'process', 'Buffer', 'URL', 'URLSearchParams', 'TextDecoder', 'TextEncoder', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'structuredClone', 'Intl', 'globalThis']);

// 外层函数体内的名字（**含参数** —— 参数在 bodyStart 之前，必须单独加进来）+ 外层函数之前（工厂作用域）的名字
const innerDecls = declaredInside(blankCode(src.slice(outer.bodyStart, blockStartOffset - 1)));
for (const p of (outer.params || '').split(',')) {
  const t = p.trim().split('=')[0].trim();
  if (/^[A-Za-z_$][\w$]*$/.test(t)) innerDecls.add(t);
}

// ① 逃逸检查放在这里（要用 innerDecls 判"外层是否已有同名"；放前面会 TDZ）。
// 只算块的**顶层**声明：块若是 `if (...) { const x = 1; }` 这种整条语句，里面 const 的作用域
// 就在那对花括号里，块之后根本看不见 → 不会逃逸（第一版用 declaredInside 把内层也算上，误报过）。
// 再用"之后是否又声明了一次"兜一层：后声明说明引用绑到的是新的那个（同作用域重复声明是语法错误，
// 所以必然是嵌套遮蔽）。
const escaped = [...blockTopDecls].filter((n) => n !== RETURNS && !innerDecls.has(n) && !afterDecls.has(n)
  && new RegExp(`(^|[^\\w$.])${n}\\b`).test(afterBlank));
if (escaped.length) {
  console.error(`❌ 这些名字在块顶层声明、块之后还被用到，抬出去就得返回它们：${escaped.join(', ')}`);
  console.error('   处理办法：用 --returns <名字>（块顶层声明了它），或把区间收窄到不含这些声明。');
  process.exit(1);
}
// 外层可见名字，必须**精确**：模块级声明/导入 + 工厂的 `const { … } = ctx;` 那批。
// 用"外层函数之前所有声明"去近似会把**别的函数体内**的声明也算成可见 ——
// 那会让一个其实不在作用域的名字不被当成参数，抬出去就是 ReferenceError。
const outerDecls = new Set(declsDirectIn(src));
{
  // 工厂（包住外层函数的那一层）的**参数**也要算外层可见 —— 例如 `createXModule(ctx)` 里的 `ctx`。
  const factory = sites
    .filter((s) => s.bodyStart < outer.bodyStart && outer.bodyEnd < s.bodyEnd)
    .sort((a, b) => (a.bodyEnd - a.bodyStart) - (b.bodyEnd - b.bodyStart))[0];
  if (factory?.params) {
    for (const p of factory.params.split(',')) {
      const t = p.trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) outerDecls.add(t);
    }
  }
  // 工厂的 `const { … } = ctx;` —— 取外层函数之前**最后一个**这样的解构
  const head = src.slice(0, outer.bodyStart);
  const all = head.match(/const\s*\{([\s\S]*?)\}\s*=\s*ctx\s*;/g);
  if (all) {
    const last = all[all.length - 1].replace(/^const\s*\{/, '').replace(/\}\s*=\s*ctx\s*;$/, '');
    for (const p of last.split(',')) {
      const t = p.trim().split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) outerDecls.add(t);
    }
  }
}
// 只当"对象字面量的键"（`{ t: … }`）或"属性访问"（`event.message` 里的 message）用的名字，
// 不算引用。判据：**每一处**出现要么前面是 `.`、要么后面紧跟 `:`。
// 只要有一处两者都不满足，就保留 —— 宁可多要一个参数，也不要漏掉一个真依赖。
const onlyNonRefs = (n) => {
  const re = new RegExp(`\\b${n}\\b`, 'g');
  let seen = false;
  for (const m of blockBlank.matchAll(re)) {
    seen = true;
    const isProp = m.index > 0 && blockBlank[m.index - 1] === '.';
    const isKey = /^\s*:/.test(blockBlank.slice(m.index + n.length));
    if (!isProp && !isKey) return false;
  }
  return seen;
};
for (const n of OUTER) outerDecls.add(n);

const free = blockIds.filter((n) => !blockLocals.has(n) && !KEYWORDS.has(n) && !GLOBALS.has(n) && !onlyNonRefs(n));
// --inside 时不传参：闭包覆盖了外层作用域；但必须保证这些名字在**块之前**就已经存在
// （块之后才声明的 const 会是 TDZ —— 那时函数虽然被提升，调用点却早于声明）。
const params = INSIDE ? [] : free.filter((n) => innerDecls.has(n)).sort();
const unresolved = free.filter((n) => !innerDecls.has(n) && !outerDecls.has(n));
if (unresolved.length) { console.error(`❌ 这些名字既不在工厂作用域、也不在外层函数里：${unresolved.join(', ')}`); process.exit(1); }

const isAsync = /\bawait\b/.test(blockBlank);
const handled = returns.length > 0;
if (RETURNS && handled) { console.error('❌ --returns 与"块里有裸 return"不能同时用，二选一'); process.exit(1); }

console.log(`块 L${A}-L${B}（${B - A + 1} 行）→ 子函数 ${NAME}()`);
console.log(`  参数（来自 ${IN_FN} 的局部/参数）：${params.join(', ') || '(无)'}`);
console.log(`  ${RETURNS ? `有返回模式：末尾补 return ${RETURNS};，调用处 const ${RETURNS} = …`
  : handled ? `处理器模式：${returns.length} 处 ${exitKind === 'continue' ? 'continue;' : exitKind === 'returntrue' ? 'return true;' : 'return;'} 退出 → 调用处 ${exitKind === 'continue' ? 'continue' : exitKind === 'returntrue' ? 'return true' : 'return'}，末尾补 return false;`
    : '普通模式：块里没有退出语句'}`);
console.log(`  ${isAsync ? 'async（块里有 await）' : '同步'}`);

// 构造新函数体：按位置倒序把退出语句替换成 `return true;`
let body = blockText;
for (const e of [...exits].sort((x, y) => y.off - x.off)) {
  body = body.slice(0, e.off) + 'return true;' + body.slice(e.off + e.len);
}
if (handled) body += '\n' + ' '.repeat(4) + 'return false;';
if (RETURNS) body += '\n' + ' '.repeat(4) + `return ${RETURNS};`;

const fnSrc = `\n  ${isAsync ? 'async ' : ''}function ${NAME}(${params.join(', ')}) {\n${body}\n  }\n`;
const CALL_TAIL = { continue: 'continue', returntrue: 'return true', return: 'return' };
const callSrc = RETURNS
  ? `const ${RETURNS} = ${isAsync ? 'await ' : ''}${NAME}(${params.join(', ')});`
  : handled
    ? `${isAsync ? 'if (await ' : 'if ('}${NAME}(${params.join(', ')})) ${CALL_TAIL[exitKind] ?? 'return'};`
    : `${isAsync ? 'await ' : ''}${NAME}(${params.join(', ')});`;

if (DRY) {
  console.log('\n--- 新函数 ---\n' + fnSrc);
  console.log('--- 调用处 ---\n' + ' '.repeat(4) + callSrc);
  process.exit(0);
}

// 写入：① 把块换成调用 ② 在工厂内、外层函数之后插入新函数
const lineStarts = [0];
for (let i = 0; i < lines.length; i += 1) lineStarts.push(lineStarts[i] + lines[i].length + 1);
const from = lineStarts[A - 1];
const to = lineStarts[B] ?? src.length;
const indent = (lines[A - 1].match(/^[ \t]*/) || [''])[0];
let out = src.slice(0, from) + indent + callSrc + '\n' + src.slice(to);
// 插入点：默认插在**外层函数之后**（兄弟）；--inside 插在外层函数体**末尾**（闭包）。
// --inside 特意插末尾而不是开头：插开头会把后面所有行号推下去，
// 破坏"从下往上抬"（那是我抬一整个 handler 的十几个端点时的做法）。
const delta = out.length - src.length;
const insertAt = INSIDE
  ? outer.bodyEnd + delta
  : (lineStarts[lineOf(outer.bodyEnd)] ?? src.length) + delta;
out = out.slice(0, insertAt) + fnSrc + out.slice(insertAt);
// 证明通过**才**写盘（先写后证的话，证不过就留下坏文件 —— 踩过一次）。
// 证明对象是**构造出来的函数体** `body`：把退出语句按位置还原回去，必须逐字等于原块。
// （早先是"从写好的文件里重新抽函数体再比"，但那个抽取靠花括号计数，块里有模板串/
//   字符串时会被带偏 → 抽出半截 → 假失败。直接用 body 更可靠，且照样能抓出改写逻辑的错。）
let inverse = body;
if (handled) inverse = inverse.replace(/\n[ \t]*return false;$/, '');
if (RETURNS) inverse = inverse.replace(new RegExp(`\\n[ \\t]*return ${RETURNS};$`), '');
const RESTORE = { continue: 'continue;', returntrue: 'return true;', return: 'return;' };
if (handled) {
  // 按**位置**还原。别用 `inverse.split('return true;')`：块里的**嵌套函数**（如
  // `.filter((e) => { … return true; … })`）本来就有 `return true;`，split 会连它们一起换掉 →
  // 假失败。（真实踩过：/api/socialV2/slang/query 因此抬不动。）
  // 偏移直接用**原块里的偏移**：每还原一个，`inverse` 的前缀就与原文对齐了，所以下一个退出语句
  // 又回到了它在 blockText 里的原位置。（曾经在这里累加过长度差，两版符号都不对 —— 多退出点
  // 且退出词不是 12 字符时定位就偏，反变换证明当场抓住。）
  // 断言该位置上确实是我们写的 `return true;`：正向改错位置会被这一步抓住，所以不是自证。
  for (const e of [...exits].sort((x, y) => x.off - y.off)) {
    const pos = e.off;
    if (inverse.slice(pos, pos + 12) !== 'return true;') {
      console.error(`❌ 反变换定位失败：块内偏移 ${pos} 处不是 return true;（${JSON.stringify(inverse.slice(pos, pos + 24))}）`);
      process.exit(1);
    }
    const orig = blockText.slice(e.off, e.off + e.len) || RESTORE[e.kind] || 'return;';
    inverse = inverse.slice(0, pos) + orig + inverse.slice(pos + 12);
  }
}
if (inverse !== blockText) {
  console.error('❌ 反变换后与原块不一致 —— **未写入**，文件保持原样');
  const il = inverse.split('\n');
  const ol = blockText.split('\n');
  for (let i = 0; i < Math.max(il.length, ol.length); i += 1) {
    if (il[i] !== ol[i]) {
      console.error(`   第一处不同 @块内第 ${i + 1} 行`);
      console.error(`     原: ${JSON.stringify(ol[i])}`);
      console.error(`     新: ${JSON.stringify(il[i])}`);
      break;
    }
  }
  process.exit(1);
}
fs.writeFileSync(full, out);
// 写完立刻做语法检查；不过就**自动回滚**到原内容，绝不留坏文件。
try {
  execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
} catch (err) {
  fs.writeFileSync(full, src);
  console.error('❌ 写出来的文件语法不过 —— 已自动回滚到原内容');
  console.error(String(err.stderr || err.message).split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
console.log(`\n✅ 已写入 ${FILE}`);
console.log(`   ${IN_FN} 从 ${lineOf(outer.bodyEnd) - lineOf(outer.bodyStart) + 1} 行 → ${(lineOf(outer.bodyEnd) - lineOf(outer.bodyStart) + 1) - (B - A + 1) + 1} 行左右`);
console.log(`   逐字证明：新函数体反变换（return true; → return; 去掉末尾 return false;）与原块完全一致`);
