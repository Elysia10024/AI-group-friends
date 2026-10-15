// 模块 ctx 一致性自检：**模块里解构了、但构造时没接进去**的名字。
//
// 为什么需要：这类 bug 已经犯过至少四次 —— `cfg`（配置）、`crypto`（randomBytes 落成 WebCrypto）、
// `rateLimitCheck`/`markAiSpoke`（控制台发送 500）、`preSleepWaitBlockedV2`（事件流每回合被异常打断，
// 而且**症状是静默的**：自动标已读与影子组装都没跑，只有一行"事件流中断"）。
// `audit:console` 只覆盖控制台路由，覆盖不到这些域模块；这里补上。
//
// 判据：`createXModule({...})` 里提供的键（含 `get x()` 访问器） ⊇ 模块自己 `const { … } = ctx` 解构的名字。
// 只报"缺的"，不报"多给的"（多给不致命，而且经过 ctx 的访问器常常是故意多传的）。
//
// 用法：node scripts/check-module-ctx.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const bridge = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

// 1) 从 import 里建立 createXModule → 文件路径 的映射
const factories = new Map();
for (const m of bridge.matchAll(/import\s*\{\s*([^}]+)\}\s*from\s*'([^']+)'/g)) {
  for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    if (/^create\w+Module$/.test(name)) factories.set(name, m[2]);
  }
}

const braceMatch = (text, open) => {
  let d = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') d += 1;
    else if (text[i] === '}') { d -= 1; if (d === 0) return i; }
  }
  return -1;
};

// 取对象字面量的**顶层**键（跳过嵌套对象/函数体）
const topLevelKeys = (body) => {
  const keys = [];
  let depth = 0;
  let line = '';
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (depth === 0 && ch === ',') {
      const t = line.trim();
      const m = /^(?:get\s+)?([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(t);
      if (m) keys.push(m[1]);
      line = '';
      continue;
    }
    if (depth === 0 || true) line += ch;
  }
  return keys;
};

let problems = 0;
let checked = 0;
for (const [factory, rel] of factories) {
  const file = path.join(ROOT, 'src', rel.replace(/^\.\//, ''));
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const decl = new RegExp(`const\\s+\\w+\\s*=\\s*${factory}\\(\\s*\\{`).exec(bridge);
  if (!decl) continue;
  const open = bridge.indexOf('{', decl.index + decl[0].length - 1);
  const close = braceMatch(bridge, open);
  if (close < 0) continue;
  const rawBody = bridge.slice(open + 1, close)
    .replace(/\/\/[^\n]*/g, '')          // 注释里出现的名字会造成漏判（`// 手工补：… crypto` 这种）
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const provided = new Set(topLevelKeys(rawBody));

  const destr = /export function \w+\(ctx\)\s*\{\s*const\s*\{([\s\S]*?)\}\s*=\s*ctx;/.exec(src);
  if (!destr) continue;
  const wanted = destr[1].split(',')
    .map((s) => s.replace(/\/\/.*$/gm, '').trim())
    .map((s) => s.split(':')[0].trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));

  const missing = wanted.filter((n) => !provided.has(n));
  checked += 1;
  if (missing.length) {
    problems += 1;
    console.log(`❌ ${factory}（src/${rel.replace(/^\.\//, '')}）缺 ${missing.length} 个：${missing.join(', ')}`);
  }
}

console.log(`\n检查了 ${checked} 个模块的 ctx`);
console.log(problems ? `❌ ${problems} 个模块有"用了但没接"的名字（运行时表现为 xxx is not a function）` : '✅ 所有模块解构的 ctx 名字都已接入');
process.exit(problems ? 1 : 0);
