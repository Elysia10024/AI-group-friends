// 「空闲时间自己刷 B 站」的纯逻辑：挑候选、配额判定、分享时段、待分享池。
//
// 规则（2026-10-24 用户定，替代 10-23 的「每天 6 次」）：
//   · 只在「梁文谷空闲时段」刷（见 core/idle-time.js）；
//   · 每小时最多 1 条；每天配额 = 当天空闲小时数（工作日 17、周末/节假日 24）；
//   · 凌晨 1:00–8:00 只刷不分享：刷到的先进待分享池，8 点后挑着分享；
//   · 分享不绑定群：她从候选群里挑 1–2 个群说自己的看法（调用方把群列表给她）；
//   · 群友让她看（bili-look）是另一条链路：配额按群算，互不占用。
import { idleHoursOnDay } from './idle-time.js';

export const BILI_SCROLL_DEFAULTS = {
  enabled: true,
  intervalMs: 3600000,
  maxPerDay: 0,        // 0 = 按当天空闲小时数自动（工作日 17 / 周末与节假日 24）
  maxWakePerDay: 0,    // 同上；显式给正数才作为硬顶
  maxDurationSec: 300,
  withFrames: true,
  shareQuietStart: 1,  // 「不分享」窗口 [start, end)，默认北京时间 1:00–8:00
  shareQuietEnd: 8,
  groupKey: 'group:20000001' // 只决定「叫醒哪个会话」，分享可以跨群
};

const PREFERRED_TNAMES = ['游戏', '单机游戏', '手机游戏', '网络游戏', '鬼畜', '搞笑', '动画', '影视剪辑'];

/**
 * 从热门列表里挑一条 ≤maxDurationSec 的视频：先按偏好分区，再随机。
 * @param {Array} list
 * @param {{maxDurationSec?:number, random?:()=>number, preferred?:string[]}} [opts]
 */
export function pickCandidate(list, opts = {}) {
  const maxDuration = Math.max(1, Number(opts.maxDurationSec) || 300);
  const random = typeof opts.random === 'function' ? opts.random : Math.random;
  const preferred = Array.isArray(opts.preferred) ? opts.preferred : PREFERRED_TNAMES;
  const pool = (Array.isArray(list) ? list : []).filter((v) => {
    const d = Number(v?.duration);
    return v && v.bvid && Number.isFinite(d) && d > 0 && d <= maxDuration;
  });
  const pickedPool = pool.filter((v) => preferred.some((p) => String(v?.tname ?? '').includes(p)));
  const src = pickedPool.length ? pickedPool : pool;
  if (!src.length) return null;
  const i = Math.min(src.length - 1, Math.max(0, Math.floor(random() * src.length)));
  return src[i];
}

/**
 * 当天自刷配额：配置显式给了正数就用它（留给手动刹车），否则按空闲小时数。
 * @param {object} [opts] biliScroll 配置
 * @param {number} [now]
 * @returns {number}
 */
export function scrollDailyCap(opts = {}, now = Date.now()) {
  const explicit = Number(opts.maxPerDay);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return idleHoursOnDay(now);
}

/**
 * 这一刻是否在「只刷不分享」窗口（默认北京时间 1:00–8:00）。
 * 注意：这只约束**主动分享视频内容**这一次动作，不影响聊天/回复/被 @。
 * @param {number} [now]
 * @param {{shareQuietStart?:number, shareQuietEnd?:number, timezoneOffsetMinutes?:number}} [opts]
 * @returns {boolean}
 */
export function inShareQuietHours(now = Date.now(), opts = {}) {
  const offsetMin = Number.isFinite(Number(opts.timezoneOffsetMinutes))
    ? Number(opts.timezoneOffsetMinutes)
    : 480;
  const hour = new Date(Number(now) + offsetMin * 60 * 1000).getUTCHours();
  const start = Math.min(23, Math.max(0, Number(opts.shareQuietStart ?? BILI_SCROLL_DEFAULTS.shareQuietStart) || 0));
  const end = Math.min(24, Math.max(0, Number(opts.shareQuietEnd ?? BILI_SCROLL_DEFAULTS.shareQuietEnd) || 0));
  if (start === end) return false;
  return start < end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

/**
 * 能否再刷一次：同一天不超过当日配额（默认=空闲小时数），且距上次 ≥ intervalMs。
 * @param {{day?:string,count?:number,lastAt?:number}|null|undefined} record
 * @param {number} now
 * @param {string} day 本地日
 * @param {{maxPerDay?:number,intervalMs?:number,now?:number}} [opts]
 * @returns {{ok:boolean, reason?:'daily-cap'|'interval'}}
 */
export function scrollQuota(record, now, day, opts = {}) {
  const interval = Math.max(60000, Number(opts.intervalMs) || BILI_SCROLL_DEFAULTS.intervalMs);
  const cap = scrollDailyCap(opts, now);
  if (record && record.day === day && Math.max(0, Number(record.count) || 0) >= cap) {
    return { ok: false, reason: 'daily-cap' };
  }
  if (record && Number(record.lastAt) > 0 && now - Number(record.lastAt) < interval) {
    return { ok: false, reason: 'interval' };
  }
  return { ok: true };
}

/**
 * 待分享池：同一 bv 只留一条，最多 max 条（旧的在前面）。
 * @param {Array} pool
 * @param {{bv:string,title?:string,at?:number}} item
 * @param {number} [max]
 * @returns {Array}
 */
export function appendShareItem(pool, item, max = 30) {
  const bv = String(item?.bv ?? '').trim();
  if (!bv) return Array.isArray(pool) ? pool : [];
  const list = (Array.isArray(pool) ? pool : []).filter((x) => x && String(x.bv ?? '') !== bv);
  list.push({ bv, title: String(item?.title ?? '').slice(0, 120), at: Number(item?.at) || Date.now() });
  return list.slice(-Math.max(1, Number(max) || 30));
}
