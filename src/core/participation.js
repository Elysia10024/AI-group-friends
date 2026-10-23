// 「她是不是说得太多了」——纯统计，零 I/O。
//
// 为什么需要它（2026-09-19 实测）：群里最近 150 条里她说了 63 条（**42%**），
// 而她自己的记忆里留着一条「群三水评了句『看来还有瑕疵』——我怀疑是我话太密」。
// 更麻烦的是：原有的【参与度参考】段**每一句都在催她说话** ——
// “别只当观众”“别让话头掉地上”“保持这个热度”“想说就说”，没有一句是让她收着的。
// 一个只会踩油门的段落，等于把她往话密的方向推。
//
// 判据刻意保守：样本太小不下结论；只有一两个人在聊时她占一半很正常（那是 1v1），
// 所以要求窗口里至少有 3 个不同的人，才认为"人多、而她还是占了大半"。

/** 参与度统计。窗口 = 最近 windowMs 内的消息，再取末尾 sample 条。 */
export function participationStats(recent, { now = Date.now(), windowMs = 3_600_000, sample = 60 } = {}) {
  const list = (Array.isArray(recent) ? recent : [])
    .filter((m) => m && now - (Number(m.time) || 0) < windowMs);
  const tail = list.slice(-Math.max(1, sample));
  const selfN = tail.filter((m) => m && m.isSelf).length;
  const others = tail.filter((m) => m && !m.isSelf);
  const senders = new Set(others.map((m) => String(m.sender ?? m.user_id ?? '?'))).size;
  const total = tail.length;
  return {
    total,
    selfN,
    otherN: others.length,
    senders,
    share: total ? selfN / total : 0
  };
}

/** 认为"占比偏高"的阈值。 */
export const OVER_PARTICIPATION_SHARE = 0.4;
/** 少于这么多条消息就不下结论（样本太小，比例没有意义）。 */
export const OVER_PARTICIPATION_MIN_TOTAL = 24;
/** 至少这么多人在一起聊，她占 40% 才叫偏密（1v1 时她占一半很正常）。 */
export const OVER_PARTICIPATION_MIN_SENDERS = 3;

/**
 * 发言占比过高时的收敛提示；不需要提醒时返回空串。
 * @param {object} st 二代会话状态
 * @returns {string}
 */
export function overParticipationHint(st, opts = {}) {
  const s = participationStats(st?.recentMessages, opts);
  if (s.total < OVER_PARTICIPATION_MIN_TOTAL) return '';
  if (s.senders < OVER_PARTICIPATION_MIN_SENDERS) return '';
  if (s.share < OVER_PARTICIPATION_SHARE) return '';
  const pct = Math.round(s.share * 100);
  return `最近 ${s.total} 条里你说了 ${s.selfN} 条（${pct}%），${s.senders} 个人在聊——**偏密了**：这轮只接一句，或者干脆不接，把场子留给他们。`;
}
