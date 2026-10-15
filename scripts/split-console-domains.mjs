// 把 src/console/server.js 的路由链按域拆成 src/console/routes/*.js —— **顺序不变**。
//
// ## 为什么不按域重排（上一版就是这么错的）
// 链里并不全是精确匹配路由：L580 有一条正则兜底
//   `url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/)`
// 同时兜住 /api/slang/:id、/api/slang/:id/confirm、/api/slang/:id/reject；
// /api/send/ 那条也不是 `===`。这类路由**依赖自己在链里的位置**，重排就会截胡。
//
// 所以：链被切成若干**连续段**，每段整体搬进一个函数，分发器按**原始顺序**调用。
// 段的边界只落在路由块之间；夹在块之间的非块代码（上面那条正则路由就是）
// 跟着**前一段**走，保证「段的范围首尾相接、覆盖整条链」。
//
// ## return 是唯一的行为风险
// 块里的 `return;` 原本退出整个请求处理器；包进函数后必须变成 `return true;`，
// 分发器才知道"已处理"。嵌套函数里的 return 不能动。
// 实测：335 个顶层 return、1 个嵌套的（forward-message）。
//
// ## 三道断言（任一不过就拒绝写盘）
//   1. 不许有重复 (method, path)；
//   2. 段的范围必须首尾相接覆盖整条链；
//   3. **不许有跨段绑定**：某段声明的名字不能被后面的段当自由变量用
//      （否则搬出去就是 ReferenceError）。
import fs from 'node:fs';
import path from 'node:path';
import {
  blankCode, matchBraces, declaredInside, countRefs, collectIdentifiers
} from './split-console.mjs';

const SERVER = 'E:/ai群友/qq-bridge-main/src/console/server.js';
const ROUTE_DIR = 'E:/ai群友/qq-bridge-main/src/console/routes';
const DRY = process.argv.includes('--dry');

// ---------------------------------------------------------------- 域划分
function domainOf(p) {
  if (p.startsWith('/api/socialV2/')) {
    const seg = p.slice('/api/socialV2/'.length).split('/')[0].split('?')[0];
    if (['send-burst', 'send-message', 'send-poke', 'send-sticker', 'wait', 'check-send', 'record-sent'].includes(seg)) return 'send';
    if (['sticker-image', 'self-image', 'sticker-note', 'sticker-remark', 'collect-sticker', 'sticker-list'].includes(seg)) return 'sticker';
    if (['memory', 'memory-append', 'memory-update', 'memory-remove', 'memory-clear'].includes(seg)) return 'memory';
    if (seg === 'slang') return 'slang';
    if (['forward-message', 'forward-media'].includes(seg)) return 'media';
    if (['config', 'activity', 'reset', 'states', 'wake'].includes(seg)) return 'admin';
    return 'socialV2';
  }
  if (p.startsWith('/api/stickers')) return 'sticker';
  if (p.startsWith('/api/slang')) return 'slang';
  if (p.startsWith('/api/images/')) return 'media';
  if (['/api/status', '/api/presets', '/api/mode', '/api/role', '/api/role-mode', '/api/roles', '/api/roles/create'].includes(p)) return 'role';
  return 'admin';
}
const EXPORT = {
  admin: 'handleAdmin', role: 'handleRole', slang: 'handleSlang', send: 'handleSend',
  sticker: 'handleSticker', memory: 'handleMemory', media: 'handleMedia', socialV2: 'handleSocialV2'
};
const CTX_LOCALS = new Set(['req', 'res', 'url', 'sendJson', 'readBody', 'gateSendTool', 'deps']);

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'void',
  'yield', 'await', 'async', 'function', 'class', 'const', 'let', 'var', 'this', 'super', 'null',
  'undefined', 'true', 'false', 'static', 'get', 'set', 'export', 'import', 'from', 'as', 'extends'
]);
const JS_GLOBALS = new Set([
  'globalThis', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'queueMicrotask', 'console', 'process', 'structuredClone', 'fetch', 'AbortController', 'AbortSignal',
  'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'eval', 'arguments', 'require', 'module', 'exports', '__dirname',
  '__filename', 'NaN', 'Infinity', 'AggregateError', 'EvalError', 'ReferenceError', 'URIError',
  'FinalizationRegistry', 'WeakRef', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView',
  'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Uint16Array', 'Int16Array', 'Uint32Array',
  'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Function',
  'performance', 'atob', 'btoa', 'crypto', 'MessageChannel', 'BroadcastChannel', 'EventTarget',
  'ReadableStream', 'WritableStream', 'TransformStream'
]);

// ---------------------------------------------------------------- 读 + 定位
const raw = fs.readFileSync(SERVER, 'utf8');
const code = blankCode(raw);
const lineOf = (idx) => raw.slice(0, idx).split('\n').length;

const handlerAt = code.indexOf('http.createServer(async (req, res) => {');
if (handlerAt < 0) { console.error('❌ 找不到请求处理器'); process.exit(1); }
const hOpen = code.indexOf('{', code.indexOf('=>', handlerAt));
const [, hEnd] = matchBraces(code, hOpen);

const ROUTE_RE = /^(\s*)if \(req\.method === '(\w+)' && url\.pathname === '([^']+)'\) \{/gm;
const candidates = [];
let m;
while ((m = ROUTE_RE.exec(raw))) {
  const bOpen = code.indexOf('{', m.index + m[0].length - 1);
  const [, bEnd] = matchBraces(code, bOpen);
  if (bEnd < 0 || bEnd > hEnd) continue;
  candidates.push({ method: m[2], path: m[3], start: m.index, end: bEnd });
}

// 链 = 那个装着绝大多数路由块的 try 块（鉴权守卫里也有个 GET /，判据用这个排除）
const trySpans = [];
{
  const tryRe = /(?<![.\w$])try\s*\{/g;
  let tm;
  while ((tm = tryRe.exec(code))) {
    if (tm.index < hOpen || tm.index > hEnd) continue;
    const open = code.indexOf('{', tm.index);
    const [, end] = matchBraces(code, open);
    if (end > 0) trySpans.push({ open, end });
  }
}
const inSpan = (idx, s) => idx > s.open && idx < s.end;
trySpans.sort((a, b) => candidates.filter((c) => inSpan(c.start, b)).length - candidates.filter((c) => inSpan(c.start, a)).length);
const chain = trySpans[0];
const blocks = candidates.filter((b) => inSpan(b.start, chain)).sort((a, b) => a.start - b.start);
console.log(`路由块 ${blocks.length} 条（排掉链外 ${candidates.length - blocks.length} 条）`);

// ---- 断言 1：无重复 (method, path)
{
  const seen = new Map();
  let dup = 0;
  for (const b of blocks) {
    const k = `${b.method} ${b.path}`;
    if (seen.has(k)) { console.error(`❌ 重复路由 ${k}（L${lineOf(seen.get(k))} / L${lineOf(b.start)}）`); dup += 1; }
    seen.set(k, b.start);
  }
  if (dup) { console.error('断言 1 失败，拒绝执行。'); process.exit(1); }
  console.log('✅ 断言 1：无重复 (method, path)');
}

// ---------------------------------------------------------------- 切段
// 段 = 连续的同域路由块。段的范围 = [本段第一块.start, 下一段第一块.start)，
// 最后一段到链尾。这样段的范围首尾相接、覆盖整条链，夹在块之间的非块代码
// （那条正则兜底路由）自然跟着前一段走。
const runs = [];
for (const b of blocks) {
  const d = domainOf(b.path);
  const last = runs[runs.length - 1];
  if (last && last.domain === d) last.blocks.push(b);
  else runs.push({ domain: d, blocks: [b] });
}
const chainEnd = blocks[blocks.length - 1].end + 1;
runs.forEach((r, i) => {
  r.from = r.blocks[0].start;
  r.to = i + 1 < runs.length ? runs[i + 1].blocks[0].start : chainEnd;
});

// ---- 断言 2：范围首尾相接
{
  let bad = 0;
  for (let i = 0; i < runs.length - 1; i++) {
    if (runs[i].to !== runs[i + 1].from) { console.error(`❌ 段 ${i + 1} 与段 ${i + 2} 范围不相接`); bad += 1; }
  }
  if (runs[0].from < chain.open || runs[runs.length - 1].to > chain.end) { console.error('❌ 段范围超出 try 块'); bad += 1; }
  if (bad) { console.error('断言 2 失败，拒绝执行。'); process.exit(1); }
  console.log(`✅ 断言 2：${runs.length} 段范围首尾相接，覆盖 L${lineOf(runs[0].from)}–L${lineOf(runs[runs.length - 1].to)}`);
}

// ---------------------------------------------------------------- 工具
function convertReturns(text) {
  const blank = blankCode(text);
  const hits = [];
  let i = 0, fnDepth = 0, pendingFn = false;
  const stack = [];
  while (i < blank.length) {
    const c = blank[i];
    if (c === '=' && blank[i + 1] === '>') { let j = i + 2; while (j < blank.length && /\s/.test(blank[j])) j++; if (blank[j] === '{') pendingFn = true; i += 2; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const w = /^[A-Za-z_$][\w$]*/.exec(blank.slice(i))[0];
      if (w === 'return') { const ws = blank.slice(i + 6).match(/^\s*/)[0]; if (blank[i + 6 + ws.length] === ';' && fnDepth === 0) hits.push(i); i += 6; continue; }
      if (w === 'function') pendingFn = true;
      i += w.length; continue;
    }
    if (c === '{') { if (pendingFn) fnDepth += 1; stack.push(pendingFn); pendingFn = false; i += 1; continue; }
    if (c === '}') { if (stack.pop()) fnDepth -= 1; i += 1; continue; }
    i += 1;
  }
  let out = text;
  for (const off of hits.slice().sort((a, b) => b - a)) out = out.slice(0, off) + 'return true;' + out.slice(off + 'return;'.length);
  return [out, hits.length];
}

function freeNames(text) {
  const blank = blankCode(text);
  const locals = declaredInside(blank);
  // 必须用 collectIdentifiers 而不是 `(?<![.\w$])` —— 后者会把展开语法 `...X` 的 X 也排掉
  const ids = collectIdentifiers(blank);
  return {
    locals,
    free: [...countRefs(blank, ids).keys()].filter((n) => !locals.has(n) && !KEYWORDS.has(n) && !JS_GLOBALS.has(n)).sort()
  };
}

// ---------------------------------------------------------------- 逐段生成
const segs = [];
const counters = {};
let totalConverted = 0;
for (const r of runs) {
  counters[r.domain] = (counters[r.domain] ?? 0) + 1;
  const name = `${EXPORT[r.domain]}${counters[r.domain]}`;
  const text = raw.slice(r.from, r.to).replace(/\s+$/, '');
  const dedented = text.split('\n').map((l) => {
    if (!l.trim()) return '';
    let k = 0;
    while (k < 6 && l[k] === ' ') k += 1;
    return '  '.repeat(Math.max(0, 2 + (k - 6))) + l.slice(k);
  }).join('\n');
  const [converted, n] = convertReturns(dedented);
  totalConverted += n;
  const { locals, free } = freeNames(converted);
  segs.push({ name, domain: r.domain, from: r.from, to: r.to, routes: r.blocks.length, converted, count: n, locals, free });
}

// ---- 断言 3：不许跨段绑定
{
  let bad = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const leaked = [...segs[i].locals].filter((n) => segs[j].free.includes(n));
      if (leaked.length) {
        console.error(`❌ 段 ${i + 1}(${segs[i].name}) 声明的 ${leaked.join(', ')} 被段 ${j + 1}(${segs[j].name}) 使用`);
        bad += 1;
      }
    }
  }
  if (bad) { console.error('断言 3 失败（跨段绑定），拒绝执行。文件未改动。'); process.exit(1); }
  console.log('✅ 断言 3：无跨段绑定');
}

// ---- 断言 4：逆变换必须还原出原文
// 每段只做了两件事：缩进 6→2、顶层 `return;`→`return true;`。
// 把段文本按白空格归一化、并把 `return true;` 还原成 `return;` 后，必须与原文对应切片逐字一致。
// 这能证明「除了这两处机械改动，一个字符都没动」。
{
  const norm = (t) => t.replace(/return true;/g, 'return;').replace(/\s+/g, ' ').trim();
  let bad = 0;
  for (const s of segs) {
    const orig = norm(raw.slice(s.from, s.to));
    const mine = norm(s.converted);
    if (orig !== mine) {
      console.error(`❌ 段 ${s.name}（L${lineOf(s.from)}–L${lineOf(s.to)}）逆变换后与原文不一致`);
      for (let i = 0; i < Math.max(orig.length, mine.length); i++) {
        if (orig[i] !== mine[i]) {
          console.error(`   第一处差异在第 ${i} 字符：`);
          console.error(`   原文: …${orig.slice(Math.max(0, i - 40), i + 60)}…`);
          console.error(`   现在: …${mine.slice(Math.max(0, i - 40), i + 60)}…`);
          break;
        }
      }
      bad += 1;
    }
  }
  // 原文链里本来就有 1 个 `return true;`（嵌套在回调里，我们不碰它）。
  // 所以逆变换对这个 token 是有歧义的 —— 但它两边同时被归一化，不影响其余内容的比对。
  // 精确性靠计数补上：转换后的 `return true;` 总数必须 == 原有的 + 我们转换的。
  const preexisting = (raw.slice(runs[0].from, chainEnd).match(/return true;/g) || []).length;
  const after = segs.reduce((a, s) => a + (s.converted.match(/return true;/g) || []).length, 0);
  if (after !== preexisting + totalConverted) {
    console.error(`❌ return true; 计数不符：转换后 ${after}，应为原有的 ${preexisting} + 转换的 ${totalConverted}`);
    bad += 1;
  } else {
    console.log(`   计数校验：原有 return true; ${preexisting} 个 + 本次转换 ${totalConverted} 个 = ${after} ✅`);
  }
  if (bad) { console.error('断言 4 失败，拒绝执行。文件未改动。'); process.exit(1); }
  console.log('✅ 断言 4：21 段逆变换后逐字还原原文（除缩进与 return 转换外一字未改）');
}

console.log(`\n${segs.length} 个段：`);
for (const s of segs) console.log(`  ${s.name.padEnd(14)} ${s.domain.padEnd(9)} ${String(s.routes).padStart(2)} 条  L${lineOf(s.from)}–L${lineOf(s.to)}  转 return ${String(s.count).padStart(3)}  注入 ${s.free.filter((n) => !CTX_LOCALS.has(n)).length}`);
console.log(`\n合计转换 return ${totalConverted} 处`);

// ---------------------------------------------------------------- 按域成文件
const byDomain = new Map();
for (const s of segs) {
  if (!byDomain.has(s.domain)) byDomain.set(s.domain, []);
  byDomain.get(s.domain).push(s);
}

if (!DRY) fs.mkdirSync(ROUTE_DIR, { recursive: true });
const emitted = [];
for (const [domain, list] of byDomain) {
  const parts = list.map((s) => {
    // 注意：这里**不能**把 req / res / url / sendJson / readBody / gateSendTool / deps 排除掉。
    // 它们确实在 ctx 上，但路由正文是用**裸名字**写的（`req.method` 而不是 `ctx.req`），
    // 所以必须一起解构出来。第一版把它们过滤掉了，结果每条路由都 `req is not defined`。
    const destructured = s.free;
    return `/**
 * 覆盖 ${s.routes} 条路由，原 L${lineOf(s.from)}–L${lineOf(s.to)}
 */
export async function ${s.name}(ctx) {
  const {
${destructured.map((n) => '    ' + n + ',').join('\n')}
  } = ctx;

${s.converted}

  return false;
}`;
  });
  const src = `// 控制台路由：${domain} 域（${list.length} 段，共 ${list.reduce((a, b) => a + b.routes, 0)} 条路由）。
//
// 由 scripts 里的按域拆分脚本从 src/console/server.js 切出来。函数正文与原实现逐字相同，
// 只有两处机械改动：
//   1. 路由块里退出请求处理器的 \`return;\` → \`return true;\`（告诉分发器"已处理"）；
//   2. 整体缩进从 6 格降到 2 格。
//
// **段与段的调用顺序不能动**：链里有正则兜底路由（/api/slang/:id(/confirm|/reject)?），
// 它依赖自己在链里的位置。server.js 里按原始顺序依次调用这些段函数。
//
// ctx 来自 server.js：
//   Object.assign(Object.create(deps), { req, res, url, sendJson, readBody, gateSendTool })
// 用 Object.create(deps) 而不是展开，是为了让 deps 上的 get/set 访问器继续生效。

${parts.join('\n\n')}
`;
  if (!DRY) fs.writeFileSync(path.join(ROUTE_DIR, `${domain}.js`), src, 'utf8');
  emitted.push({ domain, segs: list.length, routes: list.reduce((a, b) => a + b.routes, 0), lines: src.split('\n').length });
}

// ---------------------------------------------------------------- 改写 server.js
const edits = segs.map((s, i) => ({
  start: s.from,
  end: s.to,
  text: `      if (await ${s.name}(ctx)) return;\n`
}));
// ctx 构造插在第一个分发器之前。
//
// **只显式列"确定在 startConsoleServer 作用域里"的名字**，其余全部走 deps 原型链。
//
// 第一版是把「所有段用到的名字全集」都列进来 —— 那是错的：`text` 就是反例。
// 它在 server.js L843 是作为**函数**调用的（`text(safeMessage)`），说明它是 deps 注入的，
// 在 startConsoleServer 里根本没有这个绑定；显式列出来 → 构造 ctx 时 ReferenceError →
// **每条路由都 500**。所以判据必须是「server.js 里有没有这个绑定」，而不是「段里用没用」。
{
  const allFree = new Set();
  for (const s of segs) for (const n of s.free) allFree.add(n);
  if (!allFree.has('deps')) { console.error('❌ 段里没人用 deps，可疑'); process.exit(1); }

  // 请求处理器 / startConsoleServer 作用域里的绑定：函数参数 + 模块级 import + 局部量
  const CTX_EXPLICIT = [
    'req', 'res', 'url', 'sendJson', 'readBody', 'gateSendTool', 'deps',
    'fs', 'path', 'http', 'crypto', 'SECURITY_HEADERS',
    'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled',
    'consoleToken', 'port'
  ];
  const viaDeps = [...allFree].filter((n) => !CTX_EXPLICIT.includes(n)).sort();
  console.log(`\nctx 显式列 ${CTX_EXPLICIT.length} 个作用域内绑定；其余 ${viaDeps.length} 个走 deps 原型链`);
  console.log('  走原型链的名字：' + viaDeps.join(', '));
  edits[0].text = `      const ctx = Object.assign(Object.create(deps), { ${CTX_EXPLICIT.join(', ')} });\n` + edits[0].text;
}
edits.sort((a, b) => b.start - a.start);
let out = raw;
for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

{
  const lines = out.split('\n');
  let lastImport = -1;
  lines.forEach((l, i) => { if (/^(?:import\s|\}\s*from\s)/.test(l)) lastImport = i; });
  const importLines = [];
  for (const [domain, list] of byDomain) {
    importLines.push(`import { ${list.map((s) => s.name).join(', ')} } from './routes/${domain}.js';`);
  }
  lines.splice(lastImport + 1, 0, ...importLines);
  out = lines.join('\n');
}

console.log('\n生成的文件：');
for (const e of emitted) console.log(`  routes/${e.domain}.js`.padEnd(24) + `${e.segs} 段 ${e.routes} 条  ${e.lines} 行`);
console.log(`\nserver.js ${raw.split('\n').length} → ${out.split('\n').length} 行`);

if (DRY) {
  console.log('\n（--dry：未写入任何文件）');
} else {
  fs.writeFileSync(SERVER, out, 'utf8');
  console.log(`\n✅ 已写入 ${SERVER} 与 ${byDomain.size} 个路由文件`);
}
