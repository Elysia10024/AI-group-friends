// 她的发言占比（关系健康度的一个硬指标）。
//
// 为什么单独立一个审计：2026-09-19 群里最近 150 条里她说了 63 条（42%），
// 而她自己的记忆里也留着「群三水评了句『看来还有瑕疵』——我怀疑是我话太密」。
// 讨论"傲娇要不要去掉"时，真正有数据支撑的问题其实是这个 —— 所以它需要能随时被量出来，
// 而不是靠感觉。阈值与 src/core/participation.js 保持一致（那里是给模型的刹车提示）。
//
// 用法：
//   npm run audit:share
//   npm run audit:share -- --window 60      # 只看最近 60 条
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { participationStats, OVER_PARTICIPATION_SHARE, OVER_PARTICIPATION_MIN_TOTAL } from '../../src/core/participation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.resolve(HERE, '../../state/social-v2.json');

const argv = process.argv.slice(2);
const wIdx = argv.indexOf('--window');
const WINDOW = wIdx >= 0 ? Number(argv[wIdx + 1]) || 60 : 60;

const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const rows = [];
for (const [key, conv] of Object.entries(st.conversations || {})) {
  const recent = Array.isArray(conv.recentMessages) ? conv.recentMessages : [];
  const tail = recent.slice(-WINDOW);
  const s = participationStats(tail, { now: Date.now(), windowMs: 365 * 24 * 3600 * 1000, sample: WINDOW });
  rows.push({ key, ...s, retained: recent.length });
}
rows.sort((a, b) => b.share - a.share);

console.log(`她的发言占比（窗口 = 最近 ${WINDOW} 条；阈值 ${Math.round(OVER_PARTICIPATION_SHARE * 100)}%，样本 >= ${OVER_PARTICIPATION_MIN_TOTAL} 条才判定）\n`);
console.log('会话'.padEnd(22) + '占比'.padEnd(8) + '她说'.padEnd(8) + '别人'.padEnd(8) + '人数'.padEnd(6) + '保留条数  判定');
for (const r of rows) {
  const pct = `${Math.round(r.share * 100)}%`;
  const verdict = r.total < OVER_PARTICIPATION_MIN_TOTAL
    ? '样本太小'
    : (r.senders < 3 ? '1v1/人少，正常' : (r.share >= OVER_PARTICIPATION_SHARE ? '⚠️ 偏密' : '正常'));
  console.log(
    r.key.padEnd(20) + pct.padEnd(8) + String(r.selfN).padEnd(8) + String(r.otherN).padEnd(8)
    + String(r.senders).padEnd(6) + String(r.retained).padEnd(10) + verdict
  );
}
console.log('\n注：只看"人多且她仍占大半"才是问题；1v1 时她占一半属于正常聊天。');
