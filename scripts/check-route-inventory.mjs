// check-route-inventory —— 控制台路由清单守卫（2026-10-28 第 4 期 4a）。
//
// 背景：99 处 `if (url.pathname === ...)` 手写分发、26 段 handler 靠 server.js 里
// 一条调用链的顺序当路由表。这种结构下最容易静默出两类错：
//   ① 某个 handler 导出了但链里没调（路由 404，没人发现）；
//   ② 同一个 (path) 被两个 handler 都判（谁生效取决于链顺序，改顺序即改行为）。
// 本守卫把路由清单从"26 行的位置"变成"可断言的数据"：
//   · routes/*.js 导出的 handler 集合 == server.js 调用链引用的集合（双向）；
//   · 每个 path 字面量只允许出现在一个 handler 里（同 handler 内 GET/POST 复用同路径不算）。
//
// 用法：node scripts/check-route-inventory.mjs   退出码 0 = 通过
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES_DIR = path.join(ROOT, 'src', 'console', 'routes');
const SERVER = path.join(ROOT, 'src', 'console', 'server.js');

// 1) 每个 handler 覆盖的 path 字面量
const handlerPaths = new Map(); // name -> Set(paths)
for (const f of fs.readdirSync(ROUTES_DIR).filter((n) => n.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8');
  const blocks = src.split(/export async function (?=\w+)/);
  for (const block of blocks.slice(1)) {
    const name = block.match(/^(\w+)/)?.[1];
    if (!name) continue;
    const paths = new Set();
    for (const m of block.matchAll(/pathname\s*(?:===|!==)\s*'([^']+)'|pathname\.startsWith\('([^']+)'\)/g)) {
      paths.add(m[1] ?? m[2]);
    }
    handlerPaths.set(name, paths);
  }
}

// 2) server.js 的 ROUTE_CHAIN 路由链引用了哪些 handler（第 4 期 4b 起路由表是具名数组）
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const chainBlock = serverSrc.match(/const ROUTE_CHAIN = \[([\s\S]*?)\];/);
if (!chainBlock) {
  console.error('❌ check-route-inventory: server.js 里找不到 ROUTE_CHAIN 数组');
  process.exit(1);
}
const referenced = new Set([...chainBlock[1].matchAll(/\bhandle\w+/g)].map((m) => m[0]));

const problems = [];
for (const name of handlerPaths.keys()) {
  if (!referenced.has(name)) problems.push(`handler 导出了但 server.js 链里没调：${name}（路由会 404）`);
}
for (const name of referenced) {
  if (!handlerPaths.has(name)) problems.push(`server.js 链里调了但不存在该导出：${name}`);
}

// 3) 跨 handler 的 path 冲突
const owner = new Map(); // path -> handler name
for (const [name, paths] of handlerPaths) {
  for (const p of paths) {
    if (owner.has(p) && owner.get(p) !== name) {
      problems.push(`path 被两个 handler 同时判定：${p}（${owner.get(p)} vs ${name}，生效者取决于链顺序）`);
    } else {
      owner.set(p, name);
    }
  }
}

if (problems.length) {
  console.error('❌ check-route-inventory:');
  for (const p of problems) console.error('   ' + p);
  process.exit(1);
}
console.log(`✅ 路由清单一致：${handlerPaths.size} 个 handler、${owner.size} 条 path 字面量，导出与调用链双向对账通过`);
