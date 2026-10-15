// 底层发送与 OneBot 适配域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（9 个互相调用的函数）。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 20 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
import { isChatMuted } from '../core/mute.js';

export function createSendPathModule(ctx) {
  const {
    KNOWN_AGENT_TOKENS,
    SEND_TIMEOUT_MS,
    SENSITIVE_RE,
    appendActivity,
    cfg,
    computeGaps,
    escapeCqText,
    log,
    planTimeline,
    readRoleState,
    redactKnownTokensOnly,
    redactSensitiveText,
    sleep,
    splitForQQ,
    text,
    withTimeout,
  } = ctx;


  function sendToQQ(key, msg) {
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    for (const part of parts) {
      ctx.sendChain = ctx.sendChain
        .then(async () => {
          if (kind === 'private') await withTimeout(ctx.bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(ctx.bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => log(`QQ 发送失败 (${key}):`, error?.message ?? error))
        .then(() => sleep(cfg.sendDelayMs));
    }
    return ctx.sendChain;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  // 文本切分（singleLineForQQ / splitLongSegment / isCjkChar / splitByCjkSpaces）与
  // planSocialTimeline 的纯逻辑已抽到 src/core/send.js（有 27 条单测）。
  function planSocialTimeline(text, socialCfg) {
    return planTimeline(text, socialCfg);
  }
  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      ctx.sendChain = ctx.sendChain
        .then(async () => {
          if (kind === 'private') await withTimeout(ctx.bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(ctx.bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => log(`QQ 发送失败 (${key}):`, error?.message ?? error));
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? ctx.randInt(longMin, longMax) : ctx.randInt(min, max);
        ctx.sendChain = ctx.sendChain.then(() => sleep(delay));
      }
    }
    return ctx.sendChain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }
  // 间隔计算的纯逻辑已抽到 src/core/send.js（clampGap 也随之搬走，这里不再需要它）。
  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    return computeGaps(messages, gapMode, gapMs, gaps, sendCfg);
  }
  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      ctx.sendChain = ctx.sendChain
        .then(async () => {
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        ctx.sendChain = ctx.sendChain.then(() => sleep(d));
      }
    }
    return ctx.sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (ctx.currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 静默模式（「关闭聊天功能」）：**只拦群聊发言**，私聊照旧（判定见 src/core/mute.js）。
  // 用户要求：关了之后群里谁的话都不回（包括 owner 在群里的闲聊），但**私聊不受影响** ——
  // 你随时能在私聊里找她说话、也能在那里下指令。
  // 这里同时是 send / media 路由与泵的自动转发的共同闸门，所以拦这里就够了。
  function shouldBlockSilentReply(key) {
    return isChatMuted(readRoleState().mode, key);
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      // 改为"只给命中片段打码"而不是整条拦掉：原策略下句子里出现敏感词就发不出去，
      // 正常聊天被误伤。打码既保住对话，也照样不会把路径/凭据/令牌发出去。
      const masked = redactSensitiveText(text);
      log(`⚠️ 回复中的敏感片段已打码 (${key})${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复敏感片段已打码${hasKnownToken ? '（含会话令牌）' : ''}：${masked.slice(0, 120)}`);
      await sendToQQ(key, masked);
      return true;
    }
    await sendToQQ(key, text);
    return true;
  }


  return { sendToQQ, planSocialTimeline, sendBurstToQQ, onebotSend, computeGapsV2, sendMessagesV2, shouldAuditKey, shouldBlockSilentReply, auditAndSend };
}
