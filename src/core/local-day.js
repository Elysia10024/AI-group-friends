// 「本地日」切口 —— 一个共享判据，只写一遍。
//
// 为什么单独一个文件（2026-10-12）：一天一条上限的功能（每日额度/每日次数）都要回答
// "现在还算不算同一天"。以前各处各写一句，写法是
//     new Date().toISOString().slice(0, 10)
// —— 那是 **UTC 日**：本地时间每天早上 08:00 才翻页。于是"每天最多 N 条"变成
// "每个 UTC 日最多 N 条"，额度在早上八点偷偷刷新一次；夜里 00:30 发过一条，
// 08:01 再发就又"从零开始"了（domains/voice-out.js 的 dayKey 原本就是这么写的）。
//
// 这里统一按**本地日**（默认 UTC+8）切：先按偏移量把时间戳搬到本地墙上时钟，
// 再取 ISO 日。返回 'YYYY-MM-DD'，只用来做相等比较和日志，不做算术。
export const DEFAULT_TZ_OFFSET_MINUTES = 480;   // UTC+8（Asia/Shanghai）

/**
 * 时间戳落在哪一天（本地日）。
 * @param {number} now 毫秒时间戳
 * @param {number} tzOffsetMinutes 相对 UTC 的分钟偏移（+480 = 东八区）
 * @returns {string} 'YYYY-MM-DD'
 */
export function localDayKey(now = Date.now(), tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  const t = Number(now);
  const off = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : DEFAULT_TZ_OFFSET_MINUTES;
  const shifted = new Date((Number.isFinite(t) ? t : Date.now()) + off * 60000);
  return shifted.toISOString().slice(0, 10);
}

/** 两个时间戳是不是同一个本地日。 */
export function isSameLocalDay(a, b, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  return localDayKey(a, tzOffsetMinutes) === localDayKey(b, tzOffsetMinutes);
}

/** 下一个本地日零点的时间戳（用来算"还要等多久才翻页"）。 */
export function nextLocalMidnight(now = Date.now(), tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  const off = Number(tzOffsetMinutes) || 0;
  const shifted = new Date(Number(now) + off * 60000);
  shifted.setUTCHours(24, 0, 0, 0);          // 墙上时钟的下一个零点（UTC 字段 = 本地字段）
  return shifted.getTime() - off * 60000;
}

// ── 往材料里写时间用的两个渲染器（2026-10-14 加）───────────────────────────────
// 加在这里而不是新开文件：它们和上面三个函数是同一件事 —— "把时间戳翻译成**本地**人话"。
// 起因是真实 bug：她 23:00 被唤醒后问"早八上完没" —— 材料里没有"现在"，记忆里的
// "白天有早八"又是几天前记的（没有时间坐标），两件事叠在一起，她把几天前的话茬当成了现在。

/** 本地墙上时钟的当天零点。 */
function localDayStart(ms, tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  const off = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : DEFAULT_TZ_OFFSET_MINUTES;
  const d = new Date(Number(ms) + off * 60000);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - off * 60000;
}

/** 星期名（下标与 `Date.getDay()` 对齐）。 */
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 材料里【现在】那一行用的本地时刻：`2026-10-14 周三 23:07`。
 *
 * 为什么带**星期**：她的事大半是工作日概念（"早八""周一会很忙""周末"），只给日期她算不出周几，
 * 于是"明天有早八"和"两天后的早八"在她眼里长得一样。
 * 为什么带**年份**：材料里的消息行只写 `10/12 02:49`（见 mention-window.js 的 fmtClock），
 * 跨年时那种写法会和去年同一天混淆。
 */
export function fmtLocalNow(now = Date.now(), tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  const t = Number(now);
  const off = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : DEFAULT_TZ_OFFSET_MINUTES;
  const d = new Date((Number.isFinite(t) ? t : Date.now()) + off * 60000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} `
    + `${WEEKDAY_NAMES[d.getUTCDay()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** relativeDayLabel 的**默认**门限：日历天差 ≥ 2（印象用这个；消息行显式传 1，见函数注释）。 */
export const RELATIVE_DAY_MIN_DAYS = 2;

/**
 * 人话相对时间：这条时间戳是"多久以前"的（`'昨天'` / `'前天'` / `'3 天前'` / `'1 个月前'` / 不显示时 `''`）。
 *
 * 口径四条，都是刻意的：
 *   ① 时间戳为 0 / 无效 → 返回 `''`。**老印象的时间戳就是 0**（写 meta 之前的遗留），
 *      这时什么都不显示 —— 不兜底成"较早时候""1970 年"，那等于替她编一个时间。
 *   ② 门限由 `minDays` 给，两处**故意不同**：
 *      · 印象（core/memory.js）用默认 2 —— 长期事实，昨天刚说的事不必标；
 *      · 消息行（domains/context-shadow.js 的 recent/未读）用 1 —— 那块的名字叫"最近"，
 *        最容易把昨天/前天的话误导成"现在"（真实事故：材料里 `[10/12 02:49] …白天还有早八`
 *        躺在"最近群聊"里，她 10/14 深夜把它当成了当晚的话）。
 *      两处共用这一个函数、同一套文案，只是门限不同 —— 日期逻辑只写一遍。
 *   ③ 按**日历天**算，不按 24 小时算：印象块是组装器的**稳定前缀块**（参与 prefixHash），
 *      24 小时口径会让每条印象在各自的时刻翻新 —— 同一天里这个块可能变好几次，前缀缓存反复失效；
 *      日历口径在本地午夜统一 +1，一天最多变一次。
 *   ④ 文案是口语（昨天 / 前天），不是"1 天前 / 2 天前"：这是中文 QQ 群，人不会那么说话。
 *
 * @param {number} lastAt 这条时间戳
 * @param {number} now 当前时间戳（注入，便于测试）
 * @param {number} tzOffsetMinutes 时区偏移
 * @param {number} minDays 日历天差达到几天才显示（默认 2；消息行传 1）
 */
export function relativeDayLabel(lastAt, now = Date.now(), tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES, minDays = RELATIVE_DAY_MIN_DAYS) {
  const t = Number(lastAt);
  if (!Number.isFinite(t) || t <= 0) return '';
  const n = Number(now);
  const nowMs = Number.isFinite(n) ? n : Date.now();
  const days = Math.round((localDayStart(nowMs, tzOffsetMinutes) - localDayStart(t, tzOffsetMinutes)) / 86400000);
  // 门限非法（0 / NaN / 负数 / 非数）时落回默认值：0 不解释成"全天都显示"（那会每行都挂标记，
  // 纯噪音），负数也没意义 —— 宁可回到稳妥的默认，也不要让一个手滑的参数改变整块材料的噪音量。
  const rawFloor = Number(minDays);
  const floor = Number.isFinite(rawFloor) && rawFloor >= 1 ? Math.floor(rawFloor) : RELATIVE_DAY_MIN_DAYS;
  if (!(days >= floor)) return '';
  if (days === 1) return '昨天';
  if (days === 2) return '前天';
  // 一个月按 30 天粗略算：这里只是"给她一个大概"，精确到天反而更吵。
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}
