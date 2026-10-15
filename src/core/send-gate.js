// 发送频率闸门 —— 从 console/routes/send.js 抽出来，动机和 core/ratelimit.js 一样：
// 同一个判断散在五条发送路径里，早晚有一份写漏，而"漏"的表现是**静默拒绝**。
//
// 它承担的不只是"检查"：
//   1. **超限必须留日志**。原来各处都是 `sendJson(429)` 之后直接 return，日志里一个字都没有 ——
//      2026-09-19 13:57 她跟群友对线时额度被闲聊烧完，之后每条还嘴都被静默拒掉，
//      群里看到的是"她被骂到哑口无言"，事后从日志完全查不出来。响亮失败，不许静默。
//   2. **上限要用 hourCapFor**，不是 raw maxSendPerHour：被直接叫醒的回合可以动用
//      "回复额度"，否则就是"上半天闲聊把额度烧完 = 被骂时不许还嘴"（见 core/ratelimit.js）。
//   3. 429 里带上**可执行的出路**：这条没发出去、合并成一条、别重试 ——
//      否则模型只会反复重试，把剩下的额度也烧光。
//
// 依赖全部由调用方注入（log / sendJson / rateLimitCheck / hourCapFor），所以离线可测。
import { RATE_LIMIT_ERROR } from './ratelimit.js';

/**
 * @param {object} p
 * @param {object} p.st              会话状态（读 sendTimes / lastWakeReason / wakeConfig）
 * @param {object} p.sendCfg         cfg.socialV2.send
 * @param {number} p.count           本次要发几条
 * @param {number} p.now             毫秒时间戳
 * @param {string} p.key             会话键（写进日志）
 * @param {string} [p.tag]           日志前缀，默认 '[reserved2]'
 * @param {(msg: string) => void} [p.log]
 * @param {(body: object, status: number) => void} p.sendJson 已超限时由本函数调用
 * @param {Function} p.rateLimitCheck
 * @param {Function} p.hourCapFor
 * @returns {boolean} true = 可以发；false = 已回 429（调用方直接 return true）
 */
export function gateSendRate({
  st,
  sendCfg = {},
  count = 1,
  now,
  key,
  tag = '[reserved2]',
  log = () => {},
  sendJson,
  rateLimitCheck,
  hourCapFor
}) {
  const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
  const basePerHour = Number(sendCfg.maxSendPerHour) || 0;
  const maxPerHour = hourCapFor(st, sendCfg, now);
  const check = rateLimitCheck(st.sendTimes, { maxPerMinute, maxPerHour, count, now });
  if (check.ok) return true;

  const why = [
    check.overMinute ? `分钟 ${check.minute}+${count} > ${maxPerMinute}` : '',
    check.overHour ? `小时 ${check.hour}+${count} > ${maxPerHour}` : ''
  ].filter(Boolean).join('，');
  log(`${tag} 发送频率超限被拒 ${key}：${why}（额度是她"还能不能说话"的硬闸门，不许静默）`);
  sendJson({
    ok: false,
    error: RATE_LIMIT_ERROR,
    hint: '这条没有发出去。把想说的合并成一条再发，或等 1~2 分钟；不要反复重试。',
    rateLimit: {
      minute: check.minute,
      hour: check.hour,
      maxPerMinute,
      maxPerHour,
      replyExtra: Math.max(0, maxPerHour - basePerHour)
    }
  }, 429);
  return false;
}
