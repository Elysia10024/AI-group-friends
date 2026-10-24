// 「梁文谷空闲时段」判断（纯逻辑，可单测）。
//
// 用户定义（2026-10-23）：
//   北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00 为**高峰**；
//   其余时段，包括周末及中国法定节假日全天，均为**空闲**。
// 调休上班日（周末但国务院安排上班）按工作日算高峰。
//
// 2026 年表来自国务院办公厅通知（国办发明电〔2025〕7号）。
// 跨年需要更新；未知年份没有节假日表时只按周末判断（宁可把节假日当高峰，少花冤枉钱）。

function range(start, end) {
  const out = [];
  const cur = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export const CN_HOLIDAYS_2026 = [
  ...range('2026-01-01', '2026-01-03'), // 元旦
  ...range('2026-02-15', '2026-02-23'), // 春节
  ...range('2026-04-04', '2026-04-06'), // 清明
  ...range('2026-05-01', '2026-05-05'), // 劳动节
  ...range('2026-06-19', '2026-06-21'), // 端午
  ...range('2026-09-25', '2026-09-27'), // 中秋
  ...range('2026-10-01', '2026-10-07')  // 国庆
];

export const CN_MAKEUP_WORKDAYS_2026 = [
  '2026-01-04', // 元旦调休
  '2026-02-14', '2026-02-28', // 春节调休
  '2026-05-09', // 劳动节调休
  '2026-09-20', '2026-10-10' // 国庆调休
];

const DEFAULT_HOLIDAYS = new Set(CN_HOLIDAYS_2026);
const DEFAULT_MAKEUP = new Set(CN_MAKEUP_WORKDAYS_2026);

/**
 * 北京时间这一刻是不是空闲时段。
 * @param {number} [now] 毫秒时间戳
 * @param {{timezoneOffsetMinutes?:number, holidays?:Iterable<string>, makeupWorkdays?:Iterable<string>}} [opts]
 * @returns {{idle:boolean, reason:'holiday'|'weekend'|'peak'|'off-peak', day:string, hour:number, minute:number}}
 */
export function isIdleTime(now = Date.now(), opts = {}) {
  const offsetMin = Number.isFinite(Number(opts.timezoneOffsetMinutes))
    ? Number(opts.timezoneOffsetMinutes)
    : 480;
  // 平移到目标时区后只用 UTC 字段，避免宿主时区影响。
  const d = new Date(Number(now) + offsetMin * 60 * 1000);
  const day = d.toISOString().slice(0, 10);
  const weekday = d.getUTCDay(); // 0=周日
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();

  const holidays = opts.holidays ? new Set(opts.holidays) : DEFAULT_HOLIDAYS;
  const makeup = opts.makeupWorkdays ? new Set(opts.makeupWorkdays) : DEFAULT_MAKEUP;

  if (holidays.has(day)) return { idle: true, reason: 'holiday', day, hour, minute };
  const weekend = weekday === 0 || weekday === 6;
  if (weekend && !makeup.has(day)) return { idle: true, reason: 'weekend', day, hour, minute };

  // 工作日：9–12、14–18 是高峰，其余空闲。
  const peak = (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
  return { idle: !peak, reason: peak ? 'peak' : 'off-peak', day, hour, minute };
}

/**
 * 这一天有多少个"空闲小时"（2026-10-24 用户定：自刷配额按时间算，每小时 1 条）。
 * 逐小时判断，工作日 17、周末/节假日 24（调休上班日按工作日算 17）。
 * @param {number} [now]
 * @param {object} [opts] 与 isIdleTime 相同（timezoneOffsetMinutes/holidays/makeupWorkdays）
 * @returns {number} 0–24
 */
export function idleHoursOnDay(now = Date.now(), opts = {}) {
  const offsetMin = Number.isFinite(Number(opts.timezoneOffsetMinutes))
    ? Number(opts.timezoneOffsetMinutes)
    : 480;
  const d = new Date(Number(now) + offsetMin * 60 * 1000);
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth();
  const da = d.getUTCDate();
  let hours = 0;
  for (let h = 0; h < 24; h++) {
    const ts = Date.UTC(y, mo, da, h, 0, 0) - offsetMin * 60 * 1000;
    if (isIdleTime(ts, opts).idle) hours++;
  }
  return hours;
}
