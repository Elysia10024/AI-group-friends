// 「她学到的东西」：从看过的视频里提炼的要点（纯逻辑，零 I/O）。
// 2026-11-11 主人要求：小鲸鱼从刷到的视频里学习。
// 分工：bili-notes 存客观内容（标题/简介/热评）；这里存**她自己的收获**（一句话要点）；
// 她的态度/看法仍走 qq_memory_append。三份别混。
export const LEARNING_DEFAULTS = { maxItems: 200, maxSummary: 120 };

/** 规范化一条学习记录；bv 或 summary 不合法返回 null。 */
export function makeLearning({ bv, title, summary, key, source, at } = {}) {
  const b = String(bv ?? '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(b)) return null;
  const text = String(summary ?? '').replace(/\s+/g, ' ').trim().slice(0, LEARNING_DEFAULTS.maxSummary);
  if (!text) return null;
  return {
    bv: b,
    title: String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    summary: text,
    key: String(key ?? '').trim().slice(0, 40),
    source: source === 'share' ? 'share' : 'self',
    at: Number(at) || Date.now()
  };
}

/** 追加：同一个 bv 只留最新一条，超出上限留最近。 */
export function appendLearning(items, learn, max = LEARNING_DEFAULTS.maxItems) {
  if (!learn || !learn.bv) return Array.isArray(items) ? items : [];
  const list = (Array.isArray(items) ? items : []).filter((x) => x && String(x.bv ?? '') !== learn.bv);
  list.push(learn);
  return list.slice(-Math.max(1, Number(max) || LEARNING_DEFAULTS.maxItems));
}

/** 材料块：最近 N 条，旧→新，只给标题（截短）+ 要点。 */
export function formatLearningsBlock(items, { limit = 3 } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .filter((x) => x && x.summary)
    .slice(-Math.max(1, Math.min(10, Number(limit) || 3)));
  if (!list.length) return '';
  const lines = list.map((x) => {
    const d = new Date(Number(x.at) || Date.now());
    const stamp = `${d.getMonth() + 1}-${d.getDate()}`;
    const title = String(x.title ?? '').slice(0, 24);
    return `- ${stamp}《${title}》：${x.summary}`;
  });
  return `【你最近学到的东西】（从看过的视频里记下的）\n${lines.join('\n')}`;
}
