// 「我发言了」之后的记账 —— 原先散在 5 条发送路由和 recordSentMessagesV2 里的重复小块。
//
// 抽出前的重复情况（2026-09-18 实测）：
//   · 沉睡前等待状态复位三连（satisfiedAt / observedAt / accumMs = 0）：**7 处**
//     （bridge.js 4 处、console/server.js 3 处）
//   · AI 发言三连（lastAiReplyAt / lastActionAt / wakeConfig.noActionCount = 0）：**4 处**
//   · recentMessages 的保留上限默认值 Number(cfg.socialV2?.context?.recentLimit) || 100：**5 处**
//   · 「超过上限就裁掉最旧的」这行：**5 处**
//
// 为什么值得抽：这些是小块，但属于**同一份语义**（「我参与了这轮对话」意味着什么）。
// 哪天要加一个新字段（比如再记一个冷却时间戳），散着写就得改 7 处，漏一处就是
// 「她发了消息但唤醒状态没更新」这种只在特定路径上出现的不一致。
//
// 全部是就地改 st 的纯变更函数（没有 I/O，不落盘）—— 所以可以离线测。
// 落盘仍由调用方 saveSocialV2State() 负责，保持原来的调用时序不变。
//
// 刻意**没有**合并的技巧：poke 路径只写 lastAiReplyAt + noActionCount（少一个
// lastActionAt），那是它自己的行为，不在这里统一 —— 统一就等于改变行为。
//
//   node --test src/core/social-state.test.js

export const DEFAULT_RECENT_LIMIT = 100;

/**
 * 复位「沉睡前已等待/已观察」三件套。
 * 有新消息进来、或我发言/参与之后调用 —— 之前累积的等待作废，下次想睡要重新等。
 */
export function resetPreSleepWait(st) {
  st.preSleepWaitSatisfiedAt = 0;
  st.preSleepWaitObservedAt = 0;
  st.preSleepWaitAccumMs = 0;
  return st;
}

/**
 * 我发言了：刷新活跃时间，并清零「连续不动作」计数。
 * 注意顺序与原实现一致（先 lastAiReplyAt，再 lastActionAt，最后 noActionCount）。
 */
export function markAiSpoke(st, now) {
  st.lastAiReplyAt = now;
  st.lastActionAt = now;
  st.wakeConfig.noActionCount = 0;
  return st;
}

/** recentMessages 的保留条数上限（配置缺省 100）。 */
export function recentLimitOf(cfg) {
  return Number(cfg.socialV2?.context?.recentLimit) || DEFAULT_RECENT_LIMIT;
}

/**
 * 就地裁掉超出上限的旧元素，保留最新的 limit 条。
 * 与原写法 `if (list.length > limit) list.splice(0, list.length - limit)` 等价。
 */
export function capList(list, limit) {
  if (Array.isArray(list) && list.length > limit) list.splice(0, list.length - limit);
  return list;
}
