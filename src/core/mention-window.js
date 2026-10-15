// 「有人在找你」的存活判定 + 消息时间戳格式化。
//
// 为什么抽成纯函数：这两件事要在**三处**用同一套判据——材料渲染（context-shadow）、
// 回合收尾销账（wake-policy）、状态加载清理（social-state）。三处各写一遍就是三个真相，
// 迟早走偏（真实事故：材料侧完全没判，把 13 小时前、她已经回过的 @ 又投给她，于是又回了一遍）。
//
// 判据两条（缺一不可）：
//   1) 她还没看过：`seq > lastFetchedSeq`（水位线越过 = 已读）；
//   2) 还没过期：记录时间距今 < TTL（默认 2 小时，可配 socialV2.context.mentionTtlMs）。
// 只满足一条都不算"有人在找你"。

/** 默认 TTL：2 小时（与 prompt.js 的 MENTION_TTL_MS 一致）。 */
export const DEFAULT_MENTION_TTL_MS = 2 * 3600000;

/**
 * 这条"待回应"还该不该让她看见。
 * @param {{seq?:number, at?:number}} m
 * @param {{fetchedSeq?:number, now?:number, ttlMs?:number}} opts
 */
export function isMentionLive(m, { fetchedSeq = 0, now = Date.now(), ttlMs = DEFAULT_MENTION_TTL_MS } = {}) {
  if (!m) return false;
  const seq = Number(m.seq) || 0;
  const at = Number(m.at) || 0;
  if (!at) return false;
  if (seq && seq <= Number(fetchedSeq || 0)) return false;
  return now - at < ttlMs;
}

/** 过滤出一批"还活着"的待回应（保持原有顺序）。 */
export function liveMentions(list, opts = {}) {
  return (Array.isArray(list) ? list : []).filter((m) => isMentionLive(m, opts));
}

/** 丢掉"已经看过或已过期"的待回应（就地返回新数组，调用方负责落盘）。 */
export function pruneMentions(list, opts = {}) {
  return liveMentions(list, opts);
}

/**
 * 消息时间戳：今天 `[14:03]`、昨天 `[昨天 22:10]`、更早 `[10/1 22:10]`。
 * 为什么要它：材料里的群聊原文以前没有任何时间，13 小时前的 @ 和 2 分钟前的长得一模一样，
 * 她就会"定位到昨晚十点的那条"再回一遍。
 */
export function fmtClock(ts, now = Date.now()) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = new Date(t);
  const n = new Date(now);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return `${hm}`;
  const y = new Date(now - 24 * 3600000);
  const isYesterday = d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate();
  if (isYesterday) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
