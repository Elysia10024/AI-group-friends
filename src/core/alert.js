// 故障告警闸门（纯逻辑，可单测）。
//
// 要解决的问题（用户 2026-10-03 提的）：她因为 key 失效 / 余额不足 / 网络抖动而
// **连续多轮调不通**时，桥原来的行为是"每一轮失败都私聊告诉主人一句"——
// key 一挂就是十几条一模一样的 ⚠️，看两遍就免疫了；而更糟的是**恢复时没人告诉你**
// （你不知道她什么时候又能说话了）。
//
// 这门的四个规矩：
//   1. **第一次失败立刻报**（信息不延迟，保持原有价值）；
//   2. 之后同一场故障**最多每 repeatIntervalMs 报一次**，并写明"连续第 N 轮"；
//   3. **恢复时报一声**（"已恢复，刚刚那 N 轮是故障"）—— 这才叫闭环；
//   4. 中止（aborted，用户主动停）不算故障，不参与计数。
//
// 纯函数：不碰时间也不发消息，now 由调用方传，发消息由调用方做。
const DEFAULT_REPEAT_MS = 30 * 60 * 1000;

/**
 * 建一个告警闸门。一个进程一个（故障是全局的：key/余额/网络，不分会话）。
 * @param {object} [opts]
 * @param {number} [opts.repeatIntervalMs] 同一场故障重复提醒的最小间隔
 */
export function createAlertGate({ repeatIntervalMs = DEFAULT_REPEAT_MS } = {}) {
  const gap = Math.max(0, Number(repeatIntervalMs) || DEFAULT_REPEAT_MS);
  let count = 0;          // 本场故障已经连续失败几轮
  let alertedAt = 0;      // 上次报出去的时刻（0 = 本场还没报过）
  let lastReason = '';
  let keys = [];          // 本场故障涉及过哪些会话（最多记 3 个）

  return {
    /** 当前是不是在故障中（连续失败 ≥1 且还没恢复）。 */
    get failing() { return count > 0; },
    get count() { return count; },

    /**
     * 记一次失败。
     * @returns {{fire: boolean, first?: boolean, repeat?: boolean, count: number, gapMs?: number}}
     */
    failure({ reason = '', key = '', now = Date.now() } = {}) {
      count += 1;
      const r = String(reason ?? '').trim();
      if (r) lastReason = r.length > 160 ? `${r.slice(0, 160)}…` : r;
      const k = String(key ?? '').trim();
      if (k && !keys.includes(k)) keys = [...keys, k].slice(-3);
      if (alertedAt === 0) {
        alertedAt = now;
        return { fire: true, first: true, count };
      }
      const waited = now - alertedAt;
      if (waited >= gap) {
        alertedAt = now;
        return { fire: true, repeat: true, count, gapMs: waited };
      }
      return { fire: false, count };
    },

    /**
     * 记一次成功（回合正常跑完）。只有"之前报过故障"才返回 fire。
     * @returns {{fire: boolean, recovered?: boolean, count: number}}
     */
    success() {
      const wasFailing = count > 0;
      const hadAlerted = alertedAt !== 0;
      const n = count;
      count = 0;
      alertedAt = 0;
      keys = [];
      if (wasFailing && hadAlerted) return { fire: true, recovered: true, count: n };
      return { fire: false, count: n };
    },

    /** 给文案用：本场故障最近一次原因 / 涉及会话。 */
    snapshot() { return { count, lastReason, keys: [...keys] }; },
  };
}

/**
 * 故障告警文案（纯函数，方便单测）。**只发给主人私聊**，群里一个字都不提
 * （与她的人设一致：群里她要么说话要么不说话，不出现系统字样）。
 */
export function alertText({ count = 1, reason = '', keys = [], repeat = false, repeatMs = DEFAULT_REPEAT_MS } = {}) {
  const where = keys.length ? `\n涉及会话：${keys.join('、')}` : '';
  const why = reason ? `\n最近错误：${reason}` : '';
  const mins = Math.max(1, Math.round(repeatMs / 60000));
  if (repeat) {
    return `⚠️ 小鲸鱼还没好：已经连续 ${count} 轮调不通。${why}${where}\n（这条每 ${mins} 分钟最多提醒一次；修好后我会再发一条。）`;
  }
  return `⚠️ 小鲸鱼这轮调不通了（连续第 ${count} 轮）。${why}${where}\n常见原因：API key 失效/被换、余额不足、模型不可用、网络。\n（这是系统告警，不用回我；后面同一场故障每 ${mins} 分钟最多再提醒一次，恢复了我会告诉你。）`;
}

/** 恢复文案。 */
export function recoveredText({ count = 1 } = {}) {
  return `✅ 小鲸鱼恢复了（刚才连续 ${count} 轮调不通，现在正常）。`;
}

export const ALERT_DEFAULT_REPEAT_MS = DEFAULT_REPEAT_MS;
