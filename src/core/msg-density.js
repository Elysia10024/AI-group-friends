// 聊天密度触发插话（densityWake）：**群里正热闹**时给她一次插话机会的纯判定。
//
// 为什么单独一个机制，而不是复用 socialV2.proactive：
//   · 她的唤醒策略是 mentionsOnly —— 只有被 @ / 叫名字 / 拍一拍 / 命中关键词才醒；
//   · proactive 的判据是「群里安静 ≥ idleThresholdMs（默认 15 分钟）」，那是"没人说话，她自己找话"；
//   · 主人要的时机**恰好相反**：群里正热闹时插一句 —— 这时话题新鲜、有人接得住，
//     而不是一个人对着冷掉的群自言自语。
// 所以这里用「最近 windowMs 内有多少条消息」当"热闹"的度量，达标后再过四道闸门
// （允许时段 → 冷却 → 当天次数 → 掷骰子）。
//
// 为什么默认值是这些数（每一道都对应一个真实代价）：
//   · minMessages 25 / 10 分钟 ≈ 每分钟 2.5 条：这是"确实在聊"，不是"偶尔飘过两句"；
//     定得更低就会在她插不上话的碎聊里也叫她一次（白花一轮模型调用）。
//   · cooldownMs 30 分钟 + dailyCap 6：**每次唤醒都是一整轮模型调用（真金白银）**。
//     不设闸门的话，一个热闹的群能把她一天的成本烧在"插话"上；6 次也够覆盖一天里的几波高潮。
//   · probability 0.5：达标只是"有机会说话"，说不说仍看她自己 —— 达标必开口就成了刷屏机器人。
//   · activeHourStart 9 / activeHourEnd 24：凌晨群里再热闹也别叫她（半夜插话最容易出事）。
//
// 为什么判据抽成纯函数（和 mention-window.js 同样的理由）：时间（now / hour）、随机数（random）
// 都从参数进来，单测才能把每条分支都钉住；**这个文件里不允许出现 new Date() / Math.random() 的
// 隐藏时钟**（random 缺省那一次是唯一的例外，见下），否则只能靠等真实时间来测。

export const DENSITY_DEFAULTS = {
  enabled: true,
  windowMs: 10 * 60 * 1000,     // 观察窗口：最近 10 分钟
  minMessages: 25,              // 窗口内至少这么多条消息才算"热闹"
  cooldownMs: 30 * 60 * 1000,   // 触发一次后至少隔这么久才能再触发
  dailyCap: 6,                  // 每天最多触发几次（成本闸门）
  activeHourStart: 9,           // 允许触发的时段（本地小时，含头）
  activeHourEnd: 24,            // 不含尾；24 表示到当天结束
  probability: 0.5,             // 达标后再掷一次骰子
  maxKeep: 300,                 // 每个会话最多记多少个时间戳（防内存无限涨）
};

/** 把小时数收回 0..23（24 → 0 表示"当天结束"；负数也绕回来）。 */
function normalizeHour(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const m = Math.floor(n) % 24;
  return m < 0 ? m + 24 : m;
}

/**
 * 现在算不算"允许插话的时段"。**跨午夜要正确处理**：activeHourStart=9 / End=2 表示
 * 9:00~23:59 与 00:00~01:59 都允许（主人夜里两点前也能被插话，而白天从九点开始）。
 * @param {number} hour 调用方传进来的本地小时（0-23）。不传就一律不算允许 —— 宁可静默，
 *   也不要在这里偷偷 new Date() 拿机器时钟（那样单测和线上就是两个真相）。
 * @param {number} start 允许时段的起点（含头）
 * @param {number} end 允许时段的终点（不含尾；归一化后 24 → 0）
 */
export function inActiveHours(hour, start = DENSITY_DEFAULTS.activeHourStart, end = DENSITY_DEFAULTS.activeHourEnd) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const hh = ((Math.floor(h) % 24) + 24) % 24;
  const s = normalizeHour(start, DENSITY_DEFAULTS.activeHourStart);
  const e = normalizeHour(end, DENSITY_DEFAULTS.activeHourEnd);
  if (s === e) return true;              // 起止归一化后同点（含 0→24 这种"整天"写法）
  if (s < e) return hh >= s && hh < e;   // 普通区间，如 9→18
  return hh >= s || hh < e;              // 跨午夜，如 9→2：晚上 9 点到凌晨 2 点
}

/**
 * 往窗口里记一条消息时间戳，裁掉过期的和超上限的。
 * 返回**新数组**，不改入参（调用方手里的旧数组可能正被别处读）。
 * @param {number[]} stamps 现有时间戳（升序，旧 → 新）
 * @param {number} now 这条消息的时间戳
 * @param {{windowMs?:number, maxKeep?:number}} opts
 */
export function pushStamp(stamps, now, { windowMs, maxKeep } = DENSITY_DEFAULTS) {
  const list = Array.isArray(stamps) ? stamps : [];
  const t = Number(now);
  // 时间戳是脏的（NaN/Infinity）就只复制一份：宁可漏记这一条，也别把 NaN 灌进窗口让后面全算不数
  if (!Number.isFinite(t)) return list.slice();
  const win = Math.max(0, Number(windowMs) || 0);
  // maxKeep 填 0 / NaN / 非数 = "没配"，回落默认值（本仓既有约定：0 不当成"一个都不留"，
  // 否则一个手滑的 0 会让这个会话永远攒不出密度，而且静默无声）。
  const keep = Math.max(1, Math.floor(Number(maxKeep) || DENSITY_DEFAULTS.maxKeep));
  const from = t - win;
  // 判据用 `> from`（即 now - stamp < windowMs）：正好卡在窗口边界上的那条算过期。
  // 顺手丢掉"未来"的时间戳（系统时钟被往回调过时会留下这种脏数据）。
  const out = list.filter((s) => {
    const v = Number(s);
    return Number.isFinite(v) && v > from && v <= t;
  });
  out.push(t);
  // 只留最新的一批：窗口本身已经限了时间，但一个刷屏的群 10 分钟能灌进几千条，
  // maxKeep 是内存的第二道保险（map 里每个会话都留一份）。
  return out.length > keep ? out.slice(out.length - keep) : out;
}

/**
 * 纯判定：现在该不该因为"群里热闹"叫醒她一次。
 * @param {object} p
 * @param {number[]} p.stamps 窗口时间戳（pushStamp 的产物）
 * @param {number} p.now 当前时间戳
 * @param {object} p.cfg densityWake 配置（缺的键回落 DENSITY_DEFAULTS）
 * @param {number} p.lastTriggerAt 上次触发时间戳（0/缺省 = 还没触发过）
 * @param {number} p.triggeredToday 本地当天已触发次数
 * @param {number} p.hour 本地小时（0-23）
 * @param {number} [p.random] 骰子 [0,1)；不传就用 Math.random()
 * @returns {{wake:boolean, reason:string}}
 *   reason ∈ disabled | quiet-hours | too-few | cooldown | daily-cap | dice | ok
 */
export function densityDecision({ stamps, now, cfg, lastTriggerAt, triggeredToday, hour, random } = {}) {
  const c = { ...DENSITY_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  // 顺序是有意的：先问"这个机制开没开"，再问"现在是不是时候"，最后才是"攒够了没、额度还剩没"。
  // 这样日志里的 reason 直接说明"卡在哪一道"，排障不用猜（关掉时也绝不会误报成 too-few）。
  if (c.enabled === false) return { wake: false, reason: 'disabled' };
  if (!inActiveHours(hour, c.activeHourStart, c.activeHourEnd)) return { wake: false, reason: 'quiet-hours' };

  const t = Number(now);
  const win = Math.max(0, Number(windowMsOf(c)) || 0);
  const list = Array.isArray(stamps) ? stamps : [];
  // 这里再按窗口过滤一遍（而不是信 pushStamp）：调用方可能很久没记账，
  // 手里那份数组早过期了；判定自己算出来的数才是"现在热闹不热闹"。
  const count = list.filter((s) => {
    const v = Number(s);
    return Number.isFinite(v) && v <= t && t - v < win;
  }).length;
  // minMessages 填 0/脏值 = "没配"，回落默认值（和 maxKeep 同一个约定）。
  // 否则一个手滑的 0 会把这道闸门抹掉：一有消息就算"热闹"，全靠冷却与当日上限兜着。
  const minMsgs = Number(c.minMessages);
  const need = Number.isFinite(minMsgs) && minMsgs > 0 ? Math.floor(minMsgs) : DENSITY_DEFAULTS.minMessages;
  if (count < need) return { wake: false, reason: 'too-few' };

  const last = Number(lastTriggerAt) || 0;
  const cooldown = Math.max(0, Number(c.cooldownMs) || 0);
  if (last > 0 && t - last < cooldown) return { wake: false, reason: 'cooldown' };

  const cap = Number(c.dailyCap);
  const used = Math.max(0, Math.floor(Number(triggeredToday) || 0));
  if (Number.isFinite(cap) && cap >= 0 && used >= cap) return { wake: false, reason: 'daily-cap' };

  const prob = Math.min(1, Math.max(0, Number.isFinite(Number(c.probability)) ? Number(c.probability) : 0));
  const dice = Number.isFinite(Number(random)) ? Number(random) : Math.random();
  if (!(dice < prob)) return { wake: false, reason: 'dice' };

  return { wake: true, reason: 'ok' };
}

/** 小工具：把 windowMs 读出来（配置里可能是字符串或 0）。 */
function windowMsOf(c) {
  const w = Number(c.windowMs);
  return Number.isFinite(w) ? w : DENSITY_DEFAULTS.windowMs;
}
