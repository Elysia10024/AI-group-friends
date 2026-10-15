// 唤醒判定 —— 纯逻辑：给定状态与消息，决定"要不要叫醒她、以什么理由"。
//
// 从 bridge.js 的 main() 闭包里抽出来（R1' 第 4 步）。抽它的理由：
//   - 它是"每回合要不要花钱"的总闸门 —— 实测 followUp 一项就占 51% 的唤醒；
//   - 判定链有 8 个分支、顺序敏感（红包 > @ > 名字 > 关键词 > 跟进 > 提问 > 指定成员 > 概率），
//     改一处很容易踩到另一处；
//   - 原来它写在 6882 行、依赖闭包里的 cfg / selfNickname / 各种 V2 帮助函数，
//     没法离线验证，只能起桥等真实群消息。
//
// 时钟与随机数都从 ctx 注入，所以概率分支也能被确定性地测。
// 副作用（记住最近一次红包）不在这里，由调用方按返回的 redPacket 字段处理。

import { detectRedPacket } from './redpacket.js';

/** 政策锁：`cfg.socialV2.wake.policy`。空串 = 不锁。 */
export function wakePolicy(cfg) {
  return String(cfg?.socialV2?.wake?.policy ?? '').trim();
}

/** 是否处于「常态潜水」策略：只认 @ / 名字 / 拍一拍，不认关键词之外的自由发挥。 */
export function mentionsOnly(cfg) {
  return wakePolicy(cfg) === 'mentionsOnly';
}

/** 白名单关键词原始数组（保大小写）；非 mentionsOnly 或未配置时返回 null。 */
export function allowedKeywordsRaw(cfg) {
  if (!mentionsOnly(cfg)) return null;
  const raw = cfg?.socialV2?.wake?.allowedKeywords;
  if (!Array.isArray(raw)) return null;
  return raw.map((k) => String(k ?? '').trim()).filter(Boolean);
}

/** 白名单关键词的小写集合，用于匹配（写回时要用原始大小写）。 */
export function allowedKeywords(cfg) {
  const raw = allowedKeywordsRaw(cfg);
  if (!raw) return null;
  return new Set(raw.map((k) => k.toLowerCase()));
}

export function followUpConfig(cfg) {
  return cfg?.socialV2?.followUp ?? {};
}

/**
 * 跟进窗口 / 说话人回看的**唯一默认值来源**（3 分钟，2026-10-02 从 2 分钟放宽）。
 * 为什么放宽：实测群里接她的话常常落在"她说完 2 分 04 秒 / 2 分 16 秒"——
 * 刚好错过 2 分钟窗口，她那两条未读挂了 3 分半才被顺带看到（看起来像"她在却不接"）。
 * 窗口内次数上限见 armFollowUp + followUpState（maxPerWindow），所以放宽不会翻倍成本。
 * 配置里改短了、代码默认值没跟，新装的机器就会回到老行为而且没人看得出来，
 * 所以这里只留一份，日志里报的分钟数也从它推。
 */
export function followUpWindowMs(cfg) {
  return Math.max(60000, Number(followUpConfig(cfg).windowMs) || 180000);
}

export function followUpLookbackMs(cfg) {
  return Math.max(60000, Number(followUpConfig(cfg).speakerLookbackMs) || 120000);
}

/**
 * 武装跟进窗口：她发言后，只有「刚才跟她说话的人」在窗口内继续说才把她叫回来。
 * 就地修改 st。
 * @returns {boolean} 是否武装成功（配置禁用时 false）
 */
export function armFollowUp(st, cfg, now) {
  if (followUpConfig(cfg).enabled === false) return false;
  // 窗口从 5 分钟收紧到 2 分钟的理由：实测 followUp 一项就占唤醒量的 40% 左右，
  // 而"对方对着她说"的话由 @/名字/拍一拍/关键词各自独立唤醒、不受这个窗口影响
  // —— 缩短窗口砍掉的只是"她关注的人转去跟别人聊"那种旁听。
  const winMs = followUpWindowMs(cfg);
  const lookback = followUpLookbackMs(cfg);
  const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  const from = now - lookback;
  const speakers = [...new Set(
    recent
      .filter((m) => m && !m.isSelf && Number(m.time || 0) >= from)
      .map((m) => String(m.userId || m.user_id || ''))
      .filter(Boolean)
  )].slice(-6);
  // **窗口还活着就保留已经用掉的次数**，别每发一条就重置。
  // 真实事故（2026-10-02 观测）：她每发一条消息都重新武装窗口、`used` 归零 →
  // `maxPerWindow` 形同虚设，75 秒内被 followUp 叫醒 4 次、连发 5 条（8 分钟 11 次唤醒 ≈ ¥0.25）。
  const prev = st.followUp && typeof st.followUp === 'object' ? st.followUp : null;
  const stillLive = !!prev && now < Number(prev.until || 0);
  st.followUp = { until: now + winMs, speakers, used: stillLive ? Number(prev.used || 0) : 0, at: now };
  return true;
}

/** 跟进窗口是否仍然可用（未过期、未用完）。 */
export function followUpState(st, cfg, now) {
  const max = Math.max(0, Number(followUpConfig(cfg).maxPerWindow) || 1);
  const f = st.followUp;
  if (!f || typeof f !== 'object') return null;
  if (now >= Number(f.until || 0)) return null;
  if (Number(f.used || 0) >= max) return null;
  return f;
}

/**
 * 文本里是否出现了"机器人自己"。
 * @param {string} lowerText 已小写化的文本
 * @param {Iterable<string>} aliases 自己的名字（调用方保证已小写化）
 */
export function mentionsAlias(lowerText, aliases) {
  const text = String(lowerText ?? '');
  if (!text) return false;
  for (const n of aliases ?? []) {
    if (!n) continue;
    if (text.includes(n) || text.includes('@' + n)) return true;
  }
  return false;
}

/** 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促。 */
export function isDirectedAtAi(textContent) {
  const lower = String(textContent ?? '').toLowerCase();
  const aiMention = /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/.test(lower);
  const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
  const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
  if (aiMention && (question || challenge)) return true;
  // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
  if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
  if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
  // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
  if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
  // 追问/催促：AI 没回时的真人式催促
  if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
  return false;
}

/**
 * 唤醒判定链。顺序敏感，勿随意调整。
 *
 * @param {object} ctx
 * @param {object} ctx.cfg            全量配置
 * @param {object} ctx.st             二代社交状态
 * @param {'group'|'private'} ctx.kind
 * @param {object} ctx.event          OneBot 事件
 * @param {string} ctx.textContent    含引用上下文的文本
 * @param {string} ctx.plainContent   只含本条消息自身的文本
 * @param {boolean} ctx.quoteTargetIsSelf 引用的是不是她自己
 * @param {string} ctx.selfNickname   账号昵称（原始大小写）
 * @param {Iterable<string>} ctx.selfAliases 她在本群的名字（调用方保证已小写化）
 * @param {number} ctx.now            毫秒时间戳
 * @param {() => number} [ctx.random] 随机源，默认 Math.random（便于确定性测试）
 * @returns {null | { reason: string, redPacket?: object }}
 */
export function decideWake({
  cfg,
  st,
  kind,
  event,
  textContent,
  plainContent,
  quoteTargetIsSelf,
  selfNickname,
  selfAliases = [],
  now,
  random = Math.random
}) {
  if (kind === 'private') return { reason: 'private' };

  // 群里有红包（真的假的都算）一律唤醒：比 @ 还硬，不参与频率限制。
  const redPacketHit = detectRedPacket(event);
  if (redPacketHit) return { reason: 'redPacket', redPacket: redPacketHit };

  const tr = st.wakeConfig?.triggers ?? {};
  if (tr.anyMessage) return { reason: 'anyMessage' };

  if (tr.atMention) {
    const atSelf = Array.isArray(event?.message)
      && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
    if (atSelf || quoteTargetIsSelf) return { reason: 'atMention' };
  }

  if (tr.nameMention) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname.toLowerCase()) || lower.includes(selfNickname.toLowerCase()))) {
      return { reason: 'nameMention' };
    }
    // 群名片可能被改过：账号昵称匹配不上时，用"自己在群里的名片"再兜一层
    if (mentionsAlias(lower, selfAliases)) return { reason: 'nameMention' };
  }

  if (Array.isArray(tr.keywords) && tr.keywords.length) {
    const allowKw = allowedKeywords(cfg);
    const lower = String(plainContent ?? '').toLowerCase();
    for (const kw of tr.keywords) {
      const kwStr = String(kw ?? '').toLowerCase();
      if (!kwStr) continue;
      // 策略锁：常态潜水下只认白名单关键词（她往 keywords 里塞别的词也不生效）
      if (allowKw && !allowKw.has(kwStr)) continue;
      // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
      if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
        if (new RegExp(`\\b${kwStr}\\b`, 'i').test(lower)) return { reason: `keyword:${kw}` };
      } else if (lower.includes(kwStr)) {
        return { reason: `keyword:${kw}` };
      }
    }
  }

  // 5 分钟跟进窗口：刚才跟她说话的人在窗口内继续说 → 唤醒（每窗口最多 maxPerWindow 次）
  const fu = followUpState(st, cfg, now);
  if (fu) {
    const fuUid = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (fuUid && (fu.speakers || []).includes(fuUid)) return { reason: 'followUp' };
  }

  if (!mentionsOnly(cfg) && tr.question && isDirectedAtAi(plainContent)) return { reason: 'question' };

  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
    const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
    if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
      const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
      return { reason: `speaker:${senderLabel}` };
    }
  }

  if (!mentionsOnly(cfg) && Number(tr.probability) > 0 && random() < Number(tr.probability)) {
    return { reason: 'probability' };
  }
  return null;
}
