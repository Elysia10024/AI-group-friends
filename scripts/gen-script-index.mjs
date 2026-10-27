// gen-script-index —— 给 scripts/ 生成一张索引表（第 6 期 6c，2026-10-28）。
//
// 为什么需要：审计时最大的一句吐槽是「想找『换 key 该跑哪个』要在 93 个文件里翻，
// 而线索是三个月前的聊天记录」。挪文件（分 ops/guards/oneoff 三档）会动 69 条 npm script、
// selfcheck 24 步和脚本间相对 import 的深度——风险大于收益，所以改成**只生成索引**：
// 每个脚本取首行注释当用途，标出是否被 npm script / selfcheck 接线，按目录分组。
//
// 用法：node scripts/gen-script-index.mjs          # 写 scripts/README.md
//       node scripts/gen-script-index.mjs --check  # 只比对，不一致退出 1（可接 selfcheck）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT } from './lib/paths.mjs';

const SCRIPTS_DIR = path.join(PROJECT_ROOT, 'scripts');
const OUT = path.join(SCRIPTS_DIR, 'README.md');
const CHECK = process.argv.includes('--check');

function firstComment(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 6);
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#!')) continue;
    if (t.startsWith('//')) {
      const body = t.replace(/^\/\/\s*/, '').trim();
      if (body) return body.slice(0, 60);
    }
    if (t && !t.startsWith('/*') && !t.startsWith('*')) break;
  }
  return '';
}

// 接线情况：package.json 的 scripts 指向的路径 + selfcheck 里 node 调用的脚本
const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const wiredByNpm = new Set();
for (const cmd of Object.values(pkg.scripts ?? {})) {
  for (const m of String(cmd).matchAll(/scripts\/([\w/.-]+\.mjs)/g)) wiredByNpm.add(m[1]);
}
const selfcheckSrc = fs.readFileSync(path.join(SCRIPTS_DIR, 'selfcheck.mjs'), 'utf8');
const wiredBySelfcheck = new Set([...selfcheckSrc.matchAll(/scripts\/([\w/.-]+\.mjs)/g)].map((m) => m[1]));

const groups = new Map(); // 目录 → 条目[]
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(SCRIPTS_DIR, p).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (rel === 'lib') continue; // 锚模块不是"该跑的脚本"
      walk(p);
    } else if (e.name.endsWith('.mjs') && rel !== 'selfcheck.mjs') {
      const group = rel.includes('/') ? rel.split('/')[0] + '/' : '（根目录）';
      if (!groups.has(group)) groups.set(group, []);
      const npmTags = [...wiredByNpm].filter((w) => w === rel).length ? 'npm' : '';
      const scTags = wiredBySelfcheck.has(rel) ? 'selfcheck' : '';
      groups.get(group).push({ name: e.name, purpose: firstComment(p), wired: [npmTags, scTags].filter(Boolean).join('+') });
    }
  }
})(SCRIPTS_DIR);

const out = [];
out.push('# scripts 索引（自动生成，勿手改）');
out.push('');
out.push('> 由 `node scripts/gen-script-index.mjs` 生成；首行注释即用途。');
out.push('> 「接线」列的 `npm` = 有 npm script 指向它；`selfcheck` = 在每日守卫链里跑。');
out.push('> 没接线的不等于没用：一次性排障/审计脚本本来就该按需手动跑。');
out.push('');
for (const [group, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  out.push(`## ${group}`);
  out.push('');
  out.push('| 脚本 | 用途 | 接线 |');
  out.push('|---|---|---|');
  for (const it of items.sort((a, b) => a.name.localeCompare(b.name))) {
    const purpose = (it.purpose || '（无首行注释）').replace(/\|/g, '/');
    out.push(`| \`${it.name}\` | ${purpose} | ${it.wired || '—'} |`);
  }
  out.push('');
}
const text = out.join('\n');
const count = [...groups.values()].reduce((n, xs) => n + xs.length, 0);

if (CHECK) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== text) {
    console.error('❌ scripts/README.md 已过期（跑 node scripts/gen-script-index.mjs 重新生成）');
    process.exit(1);
  }
  console.log(`✅ scripts 索引是最新的（${count} 个脚本）`);
  process.exit(0);
}
fs.writeFileSync(OUT, text, 'utf8');
console.log(`已写 scripts/README.md（${count} 个脚本，${groups.size} 组）`);
