// 关系/标签的**抽样审计**（只读）：她的关系判断没法单测（那是感受，不是函数），
// 所以用"可观察"代替 —— 把她的改动和理由列出来给人看，判断合不合理由主人肉眼定。
//
// 用法：
//   node scripts/audit/stance-settle.mjs            # 当前状态 + 全部改动记录
//   node scripts/audit/stance-settle.mjs --tail 20  # 只看最近 20 条改动记录
//
// 数据来源（都是现成的，不另建存储）：
//   · state/memory/people.json —— 当前档位/标签 + relationAt/tagAt（**带完整日期**）
//   · state/bridge.log         —— 改动轨迹（`[关系]` / `[标签]` 行；注意日志只有时分秒、没有日期，
//                                 所以"什么时候改的"以 people.json 的时间戳为准）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PEOPLE = path.join(ROOT, 'state', 'memory', 'people.json');
const LOG = path.join(ROOT, 'state', 'bridge.log');

const argv = process.argv.slice(2);
const tailArg = argv.indexOf('--tail');
const TAIL = tailArg >= 0 ? Math.max(1, Number(argv[tailArg + 1]) || 20) : 0;

const ORDER = ['家人', '好朋友', '熟人', '认识但不太熟', '路人', '讨厌', ''];
const fmtDate = (ms) => {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const people = (() => {
  try { return JSON.parse(fs.readFileSync(PEOPLE, 'utf8')); } catch { return {}; }
})();

const rows = Object.entries(people).map(([qq, rec]) => ({
  qq,
  name: Object.values(rec?.names ?? {}).filter(Boolean)[0] ?? qq,
  relation: String(rec?.relation ?? ''),
  relationAt: Number(rec?.relationAt) || 0,
  relationNote: String(rec?.relationNote ?? ''),
  tag: String(rec?.tag ?? ''),
  tagAt: Number(rec?.tagAt) || 0
}));
rows.sort((a, b) => {
  const d = ORDER.indexOf(a.relation) - ORDER.indexOf(b.relation);
  return d !== 0 ? d : Math.max(b.relationAt, b.tagAt) - Math.max(a.relationAt, a.tagAt);
});

console.log('=== 当前关系与标签（按档位由近到远）===');
if (!rows.length) console.log('  （还没有任何记录）');
for (const r of rows) {
  if (!r.relation && !r.tag) continue;   // 只有名字、还没定档的人不占用篇幅
  const bits = [];
  if (r.relation) bits.push(`关系=${r.relation}（${fmtDate(r.relationAt)}）`);
  if (r.tag) bits.push(`标签=${r.tag}（${fmtDate(r.tagAt)}）`);
  console.log(`  ${r.name}（${r.qq}） ${bits.join('  ')}`);
  if (r.relationNote) console.log(`      最近影响关系的话：${r.relationNote}`);
}

console.log('\n=== 改动轨迹（来自 bridge.log，只有时分秒）===');
let lines = [];
try {
  lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter((l) => /\[(关系|标签)\]/.test(l));
} catch { lines = []; }
const shown = TAIL > 0 ? lines.slice(-TAIL) : lines;
if (!shown.length) console.log('  （日志里还没有改动记录）');
for (const l of shown) console.log('  ' + l.replace(/^\d{2}:\d{2}:\d{2} \[bridge\] /, '').trim());
console.log(`\n共 ${lines.length} 条改动记录${TAIL > 0 ? `（只显示最近 ${shown.length} 条）` : ''}。`);

// 图库：管理员命名的那批 vs 她自己存进来的（by 字段见 core/image-library.js）。
// 她存图的能力是 2026-10-12 才加的，这里主要是让主人看得见她有没有在用、存了些什么。
try {
  const lib = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'image', 'library.json'), 'utf8'));
  const all = Array.isArray(lib?.images) ? lib.images : [];
  const hers = all.filter((i) => i?.by === 'her');
  console.log(`\n=== 图库：管理员命名 ${all.length - hers.length} 张 ／ 小鲸鱼自己存的 ${hers.length} 张 ===`);
  for (const i of hers.slice(-10)) console.log(`  ${i.name}（${(i.tags ?? []).join('/')}）${i.desc ? '：' + i.desc : ''}`);
  if (!hers.length) console.log('  （她还没存过图 —— 要么还没遇到想留的，要么 qq_save_image 没被调用，回头翻 tool-calls.jsonl 就知道）');
} catch { /* 图库读不到就不显示这段 */ }
console.log('提醒：这条审计只负责"把她的判断摆出来"，判得合不合理由你自己看；');
console.log('      不合理的可以直接让她改（她调 qq_memory_append 带 extra.relation/extra.tag），');
console.log('      或者管理员在控制台处理 —— 审计脚本本身**只读**，不会改任何东西。');
