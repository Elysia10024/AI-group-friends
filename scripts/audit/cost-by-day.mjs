// audit:cost —— 每天花了多少钱（她的运行 vs 黑话学习 vs 我的测试）
//
// 数据源：DSH 内核的 session_projcache.json（每个会话的 token 用量都在里面）。
// 口径：未命中输入 $0.30/1M、缓存命中读取 $0.006/1M、输出 $1.2/1M，汇率 7.1 → 人民币。
// 跑法：npm run audit:cost        最近 14 天
//       npm run audit:cost -- 30  最近 30 天
import fs from 'node:fs';

const ROOT = 'E:/ai群友';
const DAYS = Number(process.argv[2]) || 14;
const P = { miss: 0.30, hit: 0.006, out: 1.2 };
const CNY = 7.1;

const cacheFile = `${ROOT}/dsh-home-legacy/storages/session_projcache.json`;
if (!fs.existsSync(cacheFile)) {
  console.log(`找不到 ${cacheFile}（内核没跑过或路径变了）`);
  process.exit(1);
}
const pc = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
const sessions = pc.tables?.sessions ?? {};

const byDay = new Map();
for (const [, rec] of Object.entries(sessions)) {
  const t = rec?.rows?.tokenUsage?.val?.totals;
  const created = Number(rec?.identity?.createdAt ?? 0);
  if (!t || !created) continue;
  const cwd = String(rec?.identity?.cwd ?? '?');
  const d = new Date(created);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cny = ((Number(t.uncachedInputTokens ?? 0) / 1e6) * P.miss
    + (Number(t.cacheReadTokens ?? 0) / 1e6) * P.hit
    + (Number(t.outputTokens ?? 0) / 1e6) * P.out) * CNY;
  const g = byDay.get(key) ?? { her: 0, slang: 0, mine: 0, sessions: 0, tokens: 0 };
  g.sessions += 1;
  g.tokens += Number(t.uncachedInputTokens ?? 0) + Number(t.cacheReadTokens ?? 0) + Number(t.outputTokens ?? 0);
  if (/state[\\/]slang-agent/.test(cwd)) g.slang += cny;
  else if (/state[\\/]agents/.test(cwd)) g.her += cny;
  else g.mine += cny;
  byDay.set(key, g);
}

const rows = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, DAYS);
const money = (n) => `¥${n.toFixed(2).padStart(6, ' ')}`;
console.log('日期         她(运行)  黑话学习  我的测试    当天合计  会话数   token');
for (const [day, g] of rows) {
  console.log(`${day}  ${money(g.her)}  ${money(g.slang)}  ${money(g.mine)}  ${money(g.her + g.slang + g.mine)}  ${String(g.sessions).padStart(5, ' ')}  ${(g.tokens / 1e6).toFixed(2)}M`);
}
const sum = rows.reduce((a, [, g]) => ({ her: a.her + g.her, slang: a.slang + g.slang, mine: a.mine + g.mine, sessions: a.sessions + g.sessions }), { her: 0, slang: 0, mine: 0, sessions: 0 });
const n = rows.length || 1;
console.log(`\n近 ${n} 天：她 ${money(sum.her)} / 黑话 ${money(sum.slang)} / 测试 ${money(sum.mine)}`);
console.log(`日均：她 ${(sum.her / n).toFixed(2)} 元、合计 ${((sum.her + sum.slang + sum.mine) / n).toFixed(2)} 元、${(sum.sessions / n).toFixed(0)} 个会话/天`);
console.log('（口径：未命中 $0.30/1M、命中 $0.006/1M、输出 $1.2/1M，汇率 7.1；"她" = 桥接运行产生的新会话）');
