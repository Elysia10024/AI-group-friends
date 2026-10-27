// gen-route-index —— 生成控制台路由表（第 4 期 4d 的可读那一半，2026-10-28 第 23 轮）。
//
// 为什么做：分发是 ROUTE_CHAIN 里 21 个 handler、每个 handler 内部又是 if 链（101 条 path 字面量）。
// 「某个 API 到底在哪个文件」只能 grep；而真正的显式路由表（Map<method+path,handler>）重构风险大
// （订单依赖、正则兜底、鉴权顺序）。先给一张**可对账的索引**：顺序 = ROUTE_CHAIN 顺序，
// 每条 route 的方法/路径/文件行号由静态扫描得出，改路由忘了同步索引就红。
//
// 用法：node scripts/gen-route-index.mjs          # 写 src/console/ROUTES.md
//       node scripts/gen-route-index.mjs --check  # 比对，不一致退出 1
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './lib/paths.mjs';

const OUT = path.join(PROJECT_ROOT, 'src', 'console', 'ROUTES.md');
const ROUTES_DIR = path.join(PROJECT_ROOT, 'src', 'console', 'routes');
const SERVER = path.join(PROJECT_ROOT, 'src', 'console', 'server.js');
const CHECK = process.argv.includes('--check');

// 1) ROUTE_CHAIN 顺序
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const chainBlock = serverSrc.match(/const ROUTE_CHAIN = \[([\s\S]*?)\n\];/);
if (!chainBlock) {
  console.error('❌ 找不到 server.js 里的 ROUTE_CHAIN 数组');
  process.exit(1);
}
const chain = [...chainBlock[1].matchAll(/(\w+),/g)].map((m) => m[1]);

// 2) 每个路由文件：export 函数 → 该函数内的路由行
const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
const routesByHandler = new Map(); // handler → [{method, path, file, line, note}]
let currentHandler = null;
for (const file of files) {
  const rel = `src/console/routes/${file}`;
  const lines = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf8').split('\n');
  currentHandler = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fn = /^export (?:async )?function (\w+)\(/.exec(line);
    if (fn) { currentHandler = fn[1]; continue; }
    if (!currentHandler) continue;
    // 排除式路由：if (req.method !== 'X' || url.pathname !== 'P') return false;
    const exclusion = /req\.method !== '(\w+)'[^)]*?url\.pathname !== '([^']+)'/.exec(line);
    if (exclusion) {
      routesByHandler.get(currentHandler) ?? routesByHandler.set(currentHandler, []);
      routesByHandler.get(currentHandler).push({ method: exclusion[1], path: exclusion[2], file: rel, line: i + 1, note: '排除式' });
      continue;
    }
    // 方法 + path 字面量（同一行）；一行多个 path 时全部展开
    const paths = [...line.matchAll(/url\.pathname === '([^']+)'/g)].map((m) => m[1]);
    // pathname.startsWith 前缀路由（如 /api/stickers/）单独标注，避免死板对差值
    const prefixes = [...line.matchAll(/url\.pathname\.startsWith\('([^']+)'\)/g)].map((m) => m[1] + '*');
    if (!paths.length && !prefixes.length) {
      // 正则兜底路由：/^\/api\/xxx/ 形式
      const regexFallback = /\/\^\\\/(api\/[\w-]+)/.exec(line);
      if (regexFallback) {
        routesByHandler.get(currentHandler) ?? routesByHandler.set(currentHandler, []);
        routesByHandler.get(currentHandler).push({ method: 'ANY', path: `正则兜底 ^/${regexFallback[1]}`, file: rel, line: i + 1 });
      }
      continue;
    }
    const methodOnLine = /req\.method === '(\w+)'/.exec(line);
    const method = methodOnLine ? methodOnLine[1] : guessMethod(line);
    routesByHandler.get(currentHandler) ?? routesByHandler.set(currentHandler, []);
    for (const p of [...paths, ...prefixes]) {
      routesByHandler.get(currentHandler).push({ method, path: p, file: rel, line: i + 1 });
    }
  }
}

function guessMethod(line) {
  // 没有显式 method 的行：看同一行的判断里是否隐含 GET（如 /api/pending 那类只读路由）
  if (/readBody/.test(line)) return 'POST';
  return 'GET';
}

// 3) 输出
const out = [];
out.push('# 控制台路由表（自动生成，勿手改）');
out.push('');
out.push('> 由 `node scripts/gen-route-index.mjs` 生成；顺序 = `server.js` 的 `ROUTE_CHAIN` 顺序，');
out.push('> 即真实分发顺序（前面的 handler 先拿到请求）。`ANY` = 该行未显式判断方法（多为只读）。');
out.push('> 守卫：`check:route-index`（selfcheck 里跑），路由改了忘了重新生成就红。');
out.push('');
let total = 0;
for (const handler of chain) {
  const rows = routesByHandler.get(handler) ?? [];
  out.push(`## ${handler}（${rows.length} 条）`);
  out.push('');
  if (!rows.length) {
    out.push('_（该 handler 暂无静态可识别的 path 字面量）_');
    out.push('');
    continue;
  }
  out.push('| 方法 | 路径 | 文件:行 |');
  out.push('|---|---|---|');
  for (const r of rows) {
    total += 1;
    out.push(`| ${r.method}${r.note ? `（${r.note}）` : ''} | \`${r.path}\` | ${r.file}:${r.line} |`);
  }
  out.push('');
}
const unlisted = [...routesByHandler.keys()].filter((h) => !chain.includes(h));
out.push(`总计：${chain.length} 个 handler、${total} 条路由。`);
if (unlisted.length) out.push(`\n> 注意：以下函数有路由但不在 ROUTE_CHAIN 里（死路由？）：${unlisted.join(', ')}`);
const text = out.join('\n');

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== text) {
    console.error('❌ src/console/ROUTES.md 已过期（跑 node scripts/gen-route-index.mjs 重新生成）');
    process.exit(1);
  }
  console.log(`✅ 路由表是最新的（${chain.length} 个 handler、${total} 条）`);
  process.exit(0);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, text, 'utf8');
console.log(`已写 src/console/ROUTES.md（${chain.length} 个 handler、${total} 条）`);
