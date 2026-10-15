// 发送限额（滑动窗口）—— 从 console/server.js 里复制了 5 份的那段逻辑抽出来。
//
// 抽出前的样子：send-burst / send-message / send-poke / send-sticker / /api/send/*
// 各自内联了一段几乎逐字相同的代码，包括「预占额度 → 发送 → 失败回滚」这套两步舞。
// 差异只有三处：一次预占几条（messages.length 还是 1）、报错文案、以及用哪个数组
// （sendTimes 还是 stickerCollectTimes）。
//
// 为什么这种重复值得修：回滚那几步是**很难写对又很难发现写错**的地方 ——
// `indexOf(now)` 删掉的是第一个等于 now 的记录，而同一个 now 会被 push 进多条；
// 五份各写一遍，早晚有一份漏了 cap 或者漏了回滚，症状是「偶尔莫名其妙发不出去」。
//
// 全部做成**纯函数**（不改入参、返回新数组），这样离线就能测：
//   node --test src/core/ratelimit.test.js
//
// 语义必须和原实现逐字对齐，几条容易搞错的：
//   · max 为 0（或非法值）表示**不限**，不是「禁止」；
//   · 判断的是 max > 0 且 已用 + 本次 > max，即「发完这批会不会超」；
//   · 预占和回滚都按 500 条封顶，回滚虽然只会变短，也照样走一次封顶以保持一致。

export const WINDOW_MINUTE_MS = 60_000;
export const WINDOW_HOUR_MS = 3_600_000;
export const TIMES_CAP = 500;

/** 超限时的统一文案。抽出来是为了五条发送路径不会各写一份稍微不同的说法。 */
export const RATE_LIMIT_ERROR = '发送频率超限，请稍后再试';

/**
 * 「她正在回话」的唤醒原因：这些回合里她是被叫到才开口的，不是在主动插话。
 * 和 src/domains/wake.js 的 MUST_WAKE_REASONS 必须保持一致。
 */
export const DIRECT_REPLY_REASONS = new Set(['atMention', 'nameMention', 'poke', 'private', 'followUp', 'redPacket']);

/**
 * 额外「回复额度」：被直接叫到之后的一段时间内，允许在每小时上限之外多用几条。
 *
 * 为什么需要它（真实事故，2026-09-19 13:57）：她在群里跟人对线，`maxSendPerHour: 80`
 * 被她自己上半天的闲聊一起烧完了 —— 第 80 条之后每一次回复都被 429 拒掉。
 * 群里看到的是"对方骂到一半，她突然哑了"，其实她一直在回。
 * 刷屏保护该拦的是"主动插话刷屏"，不该变成"被骂时不许还嘴"。
 *
 * @returns {number} 可额外使用的条数（0 = 没有额外额度）
 */
export function replyBudgetExtra(st, sendCfg = {}, now = Date.now()) {
  const extra = Math.max(0, Number(sendCfg.replyBudgetPerHour) || 0);
  if (!extra) return 0;
  if (!DIRECT_REPLY_REASONS.has(String(st?.lastWakeReason ?? ''))) return 0;
  const at = Number(st?.wakeConfig?.lastWakeAt || 0);
  if (!at) return 0;
  const windowMs = Math.max(60_000, Number(sendCfg.replyBudgetWindowMs) || 600_000);
  if (now - at > windowMs || now < at) return 0;
  return extra;
}

/**
 * 本小时实际可用的条数上限 = 基础上限 + 回复额度。
 * `maxSendPerHour <= 0` 语义是**不限**（见文件头），此时绝不能叠加，否则反而给它加上限。
 */
export function hourCapFor(st, sendCfg = {}, now = Date.now()) {
  const base = Number(sendCfg.maxSendPerHour) || 0;
  if (base <= 0) return 0;
  return base + replyBudgetExtra(st, sendCfg, now);
}

/** 一分钟后 / 一小时内已经发了多少条。 */
export function countRecent(times, now) {
  const list = Array.isArray(times) ? times : [];
  let minute = 0;
  let hour = 0;
  for (const t of list) {
    const age = now - t;
    if (age < WINDOW_HOUR_MS) {
      hour += 1;
      if (age < WINDOW_MINUTE_MS) minute += 1;
    }
  }
  return { minute, hour };
}

/**
 * 还能不能再发 `count` 条。
 * @returns {{ok: boolean, minute: number, hour: number, overMinute: boolean, overHour: boolean}}
 */
export function rateLimitCheck(times, { maxPerMinute = 0, maxPerHour = 0, count = 1, now }) {
  const { minute, hour } = countRecent(times, now);
  const perMinute = Number(maxPerMinute) || 0;
  const perHour = Number(maxPerHour) || 0;
  const overMinute = perMinute > 0 && minute + count > perMinute;
  const overHour = perHour > 0 && hour + count > perHour;
  return { ok: !overMinute && !overHour, minute, hour, overMinute, overHour };
}

/** 预占 count 个额度，返回新数组（先占后发，避免并发绕过限频）。 */
export function reserveSlots(times, { count = 1, now, cap = TIMES_CAP }) {
  const list = Array.isArray(times) ? times : [];
  const next = list.slice();
  for (let i = 0; i < count; i++) next.push(now);
  return next.length > cap ? next.slice(-cap) : next;
}

/**
 * 回滚最多 count 个额度（发送失败时把预占的还回去，避免假 429）。
 * 每次删掉**第一个**等于 now 的记录 —— 与原来各处的 indexOf + splice 行为一致。
 */
export function rollbackSlots(times, { count = 1, now, cap = TIMES_CAP }) {
  const next = Array.isArray(times) ? times.slice() : [];
  for (let i = 0; i < count; i++) {
    const idx = next.indexOf(now);
    if (idx >= 0) next.splice(idx, 1);
  }
  return next.length > cap ? next.slice(-cap) : next;
}
