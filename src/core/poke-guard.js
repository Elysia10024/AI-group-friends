// 连续戳守卫（2026-10-28 防御方案）：同一会话里短时间连续「只戳不说话」，
// 第 N 次起改由桥接层固定回一句「在呢」，不再叫醒模型（零 token）。
//
// 纯函数、无 IO、时钟可注入，便于单测。
// 规则（方案默认）：5 分钟窗口内第 3 次触发；收到任何文字消息时 reset。
// 阈值/窗口可调：等群里观察后再改 bridge 里的实例化参数。

export function createPokeGuard({ threshold = 3, windowMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
  const buckets = new Map(); // key -> number[]（窗口内的拍一拍时间戳，升序）

  function prune(key, t) {
    const arr = buckets.get(key);
    if (!arr || arr.length === 0) return [];
    const kept = arr.filter((ts) => t - ts < windowMs);
    if (kept.length === 0) buckets.delete(key);
    else buckets.set(key, kept);
    return kept;
  }

  /** 记一次拍一拍；返回窗口内次数与是否达到阈值（触发后仍继续计数）。 */
  function note(key) {
    const t = now();
    const arr = prune(key, t);
    arr.push(t);
    buckets.set(key, arr);
    return { count: arr.length, trigger: arr.length >= threshold };
  }

  /** 有人在这个会话里说话了：计数清零。 */
  function reset(key) {
    buckets.delete(key);
  }

  /** 只查不改（不推进窗口计数）。 */
  function peek(key) {
    const arr = prune(key, now());
    return arr.length;
  }

  return { note, reset, peek };
}
