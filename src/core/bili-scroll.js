// 「空闲时间自己刷 B 站」的纯逻辑：挑候选、配额判定。
//
// 规则（2026-10-23 用户定）：
//   · 只在「梁文谷空闲时段」刷（见 core/idle-time.js）；
//   · 每小时最多一次；
//   · 每天有上限（成本闸门，默认 6 次）。
// 候选来自 B 站综合热门；优先她可能感兴趣的分区，再随机挑一条 ≤5 分钟的。

export const BILI_SCROLL_DEFAULTS = {
  enabled: true,
  intervalMs: 3600000,
  maxPerDay: 6,
  maxWakePerDay: 6,
  maxDurationSec: 300,
  withFrames: true,
  groupKey: 'group:20000001'
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
 * 能否再刷一次：同一天不超过 maxPerDay，且距上次 ≥ intervalMs。
 * @param {{day?:string,count?:number,lastAt?:number}|null|undefined} record
 * @param {number} now
 * @param {string} day 本地日
 * @param {{maxPerDay?:number,intervalMs?:number}} [opts]
 * @returns {{ok:boolean, reason?:'daily-cap'|'interval'}}
 */
export function scrollQuota(record, now, day, opts = {}) {
  const interval = Math.max(60000, Number(opts.intervalMs) || BILI_SCROLL_DEFAULTS.intervalMs);
  const cap = Math.max(1, Number(opts.maxPerDay) || BILI_SCROLL_DEFAULTS.maxPerDay);
  if (record && record.day === day && Math.max(0, Number(record.count) || 0) >= cap) {
    return { ok: false, reason: 'daily-cap' };
  }
  if (record && Number(record.lastAt) > 0 && now - Number(record.lastAt) < interval) {
    return { ok: false, reason: 'interval' };
  }
  return { ok: true };
}
