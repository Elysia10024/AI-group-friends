// 控制台路由：send 域（4 段，共 7 条路由）。
//
// 由 scripts/split-console-domains.mjs从 src/console/server.js 切出来。函数正文与原实现逐字相同，
// 只有两处机械改动：
//   1. 路由块里退出请求处理器的 `return;` → `return true;`（告诉分发器"已处理"）；
//   2. 整体缩进从 6 格降到 2 格。
//
// **段与段的调用顺序不能动**：链里有正则兜底路由（/api/slang/:id(/confirm|/reject)?），
// 它依赖自己在链里的位置。server.js 里按原始顺序依次调用这些段函数。
//
// ctx 来自 server.js：
//   Object.assign(Object.create(deps), { req, res, url, sendJson, readBody, gateSendTool })
// 用 Object.create(deps) 而不是展开，是为了让 deps 上的 get/set 访问器继续生效。
import { gateSendRate } from '../../core/send-gate.js';
import { withSendQuota } from '../../core/send-quota.js';

/**
 * 覆盖 3 条路由，原 L1613–L1928
 */
export async function handleSendCore(ctx) {
  const {
    SENSITIVE_RE,
    agentTokenOk,
    appendActivity,
    bot,
    capList,
    cfg,
    computeGapsV2,
    deps,
    findCjkSpaceWarning,
    findSplitBoundaryWarning,
    gateSendTool,
    getSocialV2State,
    hourCapFor,
    log,
    markAiSpoke,
    modeAllowed,
    rateLimitCheck,
    readBody,
    recentLimitOf,
    recordSentMessagesV2,
    redactSensitiveText,
    req,
    reserveSlots,
    resetPreSleepWait,
    resolveReplyTargetV2,
    rollbackSlots,
    saveSocialV2State,
    scheduleReplyCheckV2,
    sendJson,
    sendMessagesV2,
    shouldBlockSilentReply,
    socialV2,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

    if (await routeSendBurst()) return true;
    if (await routeSendMessage()) return true;
    if (await routeSendPoke()) return true;

  return false;

  async function routeSendPoke() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (deps.flags.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return true; }
      if (!agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return true; }
      if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.flags.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
        return true;
      }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return true; }
      if (kind === 'group' && !targetUserId) {
        sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
        return true;
      }
      if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
        sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
        return true;
      }
      const st = getSocialV2State(key);
      const sendCfg = cfg.socialV2?.send ?? {};
      const now = Date.now();
      if (!gateSendRate({ st, sendCfg, count: 1, now, key, log, sendJson, rateLimitCheck, hourCapFor })) return true;
      st.sendTimes = reserveSlots(st.sendTimes, { count: 1, now });
      try {
        if (kind === 'group') {
          await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
        } else {
          // 私聊拍一拍：send_poke 自动路由到当前私聊对象
          await bot.raw('send_poke', { user_id: id });
        }
        st.lastActionAt = now;
        st.lastAiReplyAt = now;
        st.wakeConfig.noActionCount = 0;
        const pokeText = kind === 'group'
          ? `[拍一拍] 我拍了拍 ${targetUserId}`
          : '[拍一拍] 我拍了拍你';
        st.recentMessages.push({
          messageId: null,
          sender: '我',
          text: pokeText,
          plain: pokeText,
          tail: pokeText,
          kind: 'poke',
          quoteTargetIsSelf: false,
          isOwner: true,
          ownerLabel: '我',
          isSelf: true,
          media: [],
          hasMedia: false,
          forwardIds: [],
          hasForward: false,
          poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
          time: Date.now()
        });
        const recentLimit = recentLimitOf(cfg);
        capList(st.recentMessages, recentLimit);
        resetPreSleepWait(st);
        saveSocialV2State();
        log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
        appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
        sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
      } catch (error) {
        st.sendTimes = rollbackSlots(st.sendTimes, { count: 1, now });
        log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
        sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeSendMessage() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      let rawMessages = body.messages;
      if (typeof rawMessages === 'string') {
        const trimmed = rawMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch { /* 同上（另一条发送路由的同一段兼容逻辑） */ }
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') rawMessages = parsed;
            else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch { /* 同上：兼容被序列化成 JSON 字符串的单条消息 */ }
        }
      }
      const isRawString = typeof rawMessages === 'string';
      const messages = Array.isArray(rawMessages)
        ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
        : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      // 二代不再按空格自动分条：字符串就是一条消息；数组模式原样使用调用方间隔。
      const gapMode = (isRawString && messages.length > 1) ? 'auto' : (body.gapMode === 'fixed' || body.gapMode === 'byLength' ? body.gapMode : 'auto');
      const gapMs = Number(body.gapMs);
      const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
      if (!key || !messages.length) {
        sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
        return true;
      }
      const sendCfgBurst = cfg.socialV2?.send ?? {};
      if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
        sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
        return true;
      }
      const gate = gateSendTool(key, 'sendMessage', '工具未启用：qq_send_message');
      if (!gate) return true;
      const { kind, id } = gate;
      if (kind === 'private' && atUserId) {
        sendJson({ ok: false, error: '私聊不需要 @' }, 400);
        return true;
      }
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return true;
      }
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
        sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return true;
      }
      const sendCfg = cfg.socialV2?.send ?? {};
      const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (messages.length > maxMsgs) {
        sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
        return true;
      }
      for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].length > maxChars) {
          sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
          return true;
        }
        // 只对命中的片段打码，不再整条 403：正常聊天里出现「密码/口令/secret」等词时
        // 整句被拦会把对话卡死（实测「我的密码是多少来着」也会被误拦）。
        // 打码同样不会把真正敏感的内容发出去。
        if (SENSITIVE_RE.test(messages[i])) messages[i] = redactSensitiveText(messages[i]);
      }
      const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
      // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
      const st = getSocialV2State(key);
      const now = Date.now();
      if (!gateSendRate({ st, sendCfg, count: messages.length, now, key, log, sendJson, rateLimitCheck, hourCapFor })) return true;
      // 先预占发送额度，避免并发绕过限频
      st.sendTimes = reserveSlots(st.sendTimes, { count: messages.length, now });
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          // 引用解析失败：回滚已预占的发送额度
          st.sendTimes = rollbackSlots(st.sendTimes, { count: messages.length, now });
          saveSocialV2State();
          sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
          return true;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      try {
        const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
        recordSentMessagesV2(key, sentMessages);
        markAiSpoke(st, now);
        saveSocialV2State();
        log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
        appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
        if (sentMessages.length > 0) scheduleReplyCheckV2(key);
        const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
        const spaceWarn = findCjkSpaceWarning(messages);
        const splitWarn = findSplitBoundaryWarning(messages);
        sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
      } catch (error) {
        if (error?.sent?.length) {
          recordSentMessagesV2(key, error.sent);
          log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
        }
        // 失败/未发出的消息回滚预占的发送额度，避免假 429。
        const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
        const failedCount = Math.max(0, messages.length - sentCount);
        st.sendTimes = rollbackSlots(st.sendTimes, { count: failedCount, now });
        saveSocialV2State();
        sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeSendBurst() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      let rawMessages = body.messages;
      if (typeof rawMessages === 'string') {
        const trimmed = rawMessages.trim();
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch { /* 不是 JSON 数组就按原样处理 —— 兼容分支，不是异常 */ }
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') rawMessages = parsed;
            else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
          } catch { /* 同上：兼容被序列化成 JSON 字符串的单条消息 */ }
        }
      }
      const messages = Array.isArray(rawMessages)
        ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
        : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
      const replyToMessageId = body.replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
        return true;
      }
      if (!key || !messages.length) {
        sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
        return true;
      }
      const sendCfgBurst = cfg.socialV2?.send ?? {};
      if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
        sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
        return true;
      }
      const gate = gateSendTool(key, 'sendBurst', '工具未启用：qq_send_burst');
      if (!gate) return true;
      const { kind, id } = gate;
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return true;
      }
      const sendCfg = cfg.socialV2?.send ?? {};
      const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (messages.length > maxMsgs) {
        sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
        return true;
      }
      for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].length > maxChars) {
          sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
          return true;
        }
        // 只对命中的片段打码，不再整条 403：正常聊天里出现「密码/口令/secret」等词时
        // 整句被拦会把对话卡死（实测「我的密码是多少来着」也会被误拦）。
        // 打码同样不会把真正敏感的内容发出去。
        if (SENSITIVE_RE.test(messages[i])) messages[i] = redactSensitiveText(messages[i]);
      }
      // 第 17 轮：预占/回滚三步舞收敛到 core/send-quota.js（D-01 那类 bug 的根治点）。
      const st = getSocialV2State(key);
      const now = Date.now();
      const quota = await withSendQuota({
        st,
        count: messages.length,
        now,
        reserveSlots,
        rollbackSlots,
        gate: () => gateSendRate({ st, sendCfg, count: messages.length, now, key, log, sendJson, rateLimitCheck, hourCapFor }),
        run: async () => {
          const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
          return sendMessagesV2(key, messages, delays);
        },
      });
      if (quota.gateFailed) return true;
      if (!quota.ok) {
        const error = quota.error;
        if (error?.sent?.length) {
          recordSentMessagesV2(key, error.sent);
          log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
        }
        if (quota.rolledBack) {
          try {
            saveSocialV2State();
          } catch (saveError) {
            log(`[reserved2] 回滚后落盘失败 (${key}):`, saveError?.message ?? saveError);
          }
        }
        if (quota.rollbackError) log(`[reserved2] 回滚发送额度失败 (${key}):`, quota.rollbackError?.message ?? quota.rollbackError);
        sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
        return true;
      }
      const sentMessages = quota.value;
      recordSentMessagesV2(key, sentMessages);
      markAiSpoke(st, now);
      saveSocialV2State();
      log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
      appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
      if (sentMessages.length > 0) scheduleReplyCheckV2(key);
      const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
      const spaceWarn = findCjkSpaceWarning(messages);
      const splitWarn = findSplitBoundaryWarning(messages);
      sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 1 条路由，原 L2016–L2106
 */
export async function handleSendRich(ctx) {
  const {
    appendActivity,
    capList,
    cfg,
    gateSendTool,
    getSocialV2State,
    hourCapFor,
    reloadMemory,
    log,
    markAiSpoke,
    rateLimitCheck,
    readBody,
    recentLimitOf,
    req,
    reserveSlots,
    resetPreSleepWait,
    resolveReplyTargetV2,
    rollbackSlots,
    saveSocialV2State,
    scheduleReplyCheckV2,
    sendJson,
    sendLibraryImage,
    sendStickerV2,
    shouldBlockSilentReply,
    stickerEnabled,
    url,
    voiceOut,
    v2ToolEnabled,
  } = ctx;

    if (await routeSendSticker()) return true;
    if (await routeSendImage()) return true;
    if (await routeSendVoice()) return true;
    if (await routeReloadMemory()) return true;

  return false;

  /**
   * 热重载记忆（2026-10-20）：外部脚本改完 state/memory/*.json 后调用一次，不用重启桥接。
   * 只覆盖记忆字段（印象/话题/想法），不动最近消息与计时器。
   */
  async function routeReloadMemory() {
    if (!(req.method === 'POST' && url.pathname === '/api/socialV2/reload-memory')) return false;
    try {
      if (typeof reloadMemory !== 'function') { sendJson({ ok: false, error: '重载未接线' }, 500); return true; }
      const r = reloadMemory();
      sendJson({ ok: true, ...r });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 500);
    }
    return true;
  }

  /**
   * 发语音（她自己的声音）。硬边界在 domains/voice-out.js 里兜：单条字数上限、最小间隔、
   * 每日上限，群里再紧一档（10 分钟、每天 4 条；`allowGroups` 关掉就整块不发）；
   * **语音永远单独发** —— 带引用的语音 QQ 播不出来，所以这里直接把带引用的调用拒掉。
   * 这里只负责鉴权/白名单/限流与记账。
   */
  async function routeSendVoice() {
    if (!(req.method === 'POST' && url.pathname === '/api/socialV2/send-voice')) return false;
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const text = String(body.text ?? body.message ?? '').trim();
    const replyToMessageId = body.replyToMessageId;
    if (!key || !text) { sendJson({ ok: false, error: 'key 和 text 不能为空' }, 400); return true; }
    if (v2ToolEnabled && !v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return true; }
    const gate = gateSendTool(key, 'sendVoice', '工具未启用：qq_send_voice');
    if (!gate) return true;
    const { kind, id } = gate;
    if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
    // 语音不能带引用：QQ 客户端播不出"引用 + 语音"的消息（2026-10-06 群里实测，那条语音谁都听不见）。
    // 这里提前拒，别白合成一条；域模块里也有一份同样的拒绝（双保险）。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      sendJson({ ok: false, error: '语音要单独发（不能带引用）：QQ 的"引用 + 语音"消息对方听不见。要指向某条消息，先用 qq_send_message 带引用发一句文字，再单独发语音。' }, 400);
      return true;
    }
    if (!voiceOut) { sendJson({ ok: false, error: '语音模块未接线' }, 500); return true; }

    const sendCfg = cfg.socialV2?.send ?? {};
    const now = Date.now();
    try {
      const st = getSocialV2State(key);
      // 语音在 QQ 里的"重量"比文字大，占两个发送额度（她说一条语音相当于多说一句）
      if (!gateSendRate({ st, sendCfg, count: 2, now, key, log, sendJson, rateLimitCheck, hourCapFor })) return true;
      const sent = await voiceOut.sendVoice(key, text);
      if (!sent.ok) {
        sendJson({ ok: false, error: sent.error }, 400);
        return true;
      }
      st.sendTimes = reserveSlots(st.sendTimes, { count: 2, now });
      const label = `[语音]${text.slice(0, 40)}`;
      st.recentMessages.push({
        messageId: sent.messageId ? String(sent.messageId) : null,
        sender: '我',
        text: label.slice(0, 200),
        plain: label.slice(0, 200),
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        media: [],
        hasMedia: false,
        forwardIds: [],
        hasForward: false,
        voice: { seconds: sent.seconds ?? null, wav: sent.wav ?? '' },
        time: Date.now()
      });
      capList(st.recentMessages, recentLimitOf(cfg));
      markAiSpoke(st, now);
      resetPreSleepWait(st);
      saveSocialV2State();
      scheduleReplyCheckV2(key);
      log(`[语音] 工具发送语音 ${key}：${text.slice(0, 30)}`);
      appendActivity(`${key} [语音] 工具发送语音：${text.slice(0, 30)}`);
      sendJson({ ok: true, key, kind, seconds: sent.seconds ?? null, notes: sent.notes ?? [], sent: 1, failed: 0 });
    } catch (error) {
      log(`[语音] 工具发送语音失败 ${key}: ${error?.message ?? error}`);
      sendJson({ ok: false, error: `发送语音失败：${error?.message ?? error}` }, 500);
    }
    return true;
  }

  /**
   * 本地图库发图（POST /api/socialV2/send-image）。
   *
   * 与 send-sticker 的关系：表情包走 QQ 云端的收藏表情库；这条走本地文件夹
   * （<项目根>\image，library.json 是唯一真相源）。两者共用同一套发送闸门与记录逻辑 ——
   * 因为对她来说都是"发一张图"，没必要两套限额、两套记录。
   */
  async function routeSendImage() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-image') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const name = String(body.name ?? body.image ?? '').trim();
      const caption = String(body.message ?? body.caption ?? '').trim();
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      if (!key || !name) { sendJson({ ok: false, error: 'key 和 name 不能为空' }, 400); return true; }
      if (caption) {
        sendJson({ ok: false, error: '图片消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独发图' }, 400);
        return true;
      }
      // 与表情包共用"表情包体系"总开关（图库是同一个能力族）
      const gate = gateSendTool(key, 'sendSticker', '工具未启用：qq_send_image');
      if (!gate) return true;
      const { kind, id } = gate;
      if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
        sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return true;
      }
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const stForReply = getSocialV2State(key);
        const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话' }, 400);
          return true;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      const sendCfg = cfg.socialV2?.send ?? {};
      const now = Date.now();
      // 第 17 轮：预占/回滚收敛到 withSendQuota（原 catch 里重取 st、无条件回滚的那份写法）。
      const st = getSocialV2State(key);
      const quota = await withSendQuota({
        st,
        count: 1,
        now,
        reserveSlots,
        rollbackSlots,
        gate: () => gateSendRate({ st, sendCfg, count: 1, now, key, log, sendJson, rateLimitCheck, hourCapFor }),
        run: () => sendLibraryImage(key, name, { replyToMessageId: actualReplyToMessageId, atUserId }),
      });
      if (quota.gateFailed) return true;
      if (!quota.ok) {
        if (quota.rolledBack) saveSocialV2State();
        if (quota.rollbackError) log(`[图库] 回滚发送额度失败 (${key}):`, quota.rollbackError?.message ?? quota.rollbackError);
        log(`[图库] 工具发送图片失败 ${key}: ${quota.error?.message ?? quota.error}`);
        sendJson({ ok: false, error: `发送图片失败：${quota.error?.message ?? quota.error}` }, 500);
        return true;
      }
      const sent = quota.value;
      const label = sent.image?.name || name;
      const text = `[图片:${label}]`;
      st.recentMessages.push({
        messageId: sent.messageId ? String(sent.messageId) : null,
        sender: '我',
        text: text.slice(0, 200),
        plain: text.slice(0, 200),
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        media: [],
        hasMedia: false,
        forwardIds: [],
        hasForward: false,
        libraryImage: { name: label, file: sent.image?.file || '' },
        time: Date.now()
      });
      capList(st.recentMessages, recentLimitOf(cfg));
      markAiSpoke(st, now);
      resetPreSleepWait(st);
      saveSocialV2State();
      scheduleReplyCheckV2(key);
      log(`[图库] 工具发送图片 ${key}: ${label}`);
      appendActivity(`${key} [图库] 工具发送图片：${label}`);
      sendJson({ ok: true, key, image: { name: label, file: sent.image?.file || '', verdict: sent.image?.verdict || '' }, sent: 1, failed: 0, quoted: quotedInfo });
      return true;
    }
    return false;
  }

  async function routeSendSticker() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      const caption = String(body.message ?? body.caption ?? '').trim();
      const replyToMessageId = body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
      // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
      if (caption) {
        sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
        return true;
      }
      const gate = gateSendTool(key, 'sendSticker', '工具未启用：qq_send_sticker');
      if (!gate) return true;
      const { kind, id } = gate;
      if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
      if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return true; }
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
        sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
        return true;
      }
      let quotedInfo = null;
      let actualReplyToMessageId = replyToMessageId;
      if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
        const stForReply = getSocialV2State(key);
        const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
        if (!resolved) {
          sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
          return true;
        }
        quotedInfo = resolved.info;
        actualReplyToMessageId = resolved.messageId;
      }
      const sendCfg = cfg.socialV2?.send ?? {};
      const now = Date.now();
      // 第 17 轮：预占/回滚收敛到 withSendQuota（原 catch 里重取 st、无条件回滚的那份写法）。
      const st = getSocialV2State(key);
      const quota = await withSendQuota({
        st,
        count: 1,
        now,
        reserveSlots,
        rollbackSlots,
        gate: () => gateSendRate({ st, sendCfg, count: 1, now, key, log, sendJson, rateLimitCheck, hourCapFor }),
        run: () => sendStickerV2(key, stickerId, { replyToMessageId: actualReplyToMessageId, atUserId }),
      });
      if (quota.gateFailed) return true;
      if (!quota.ok) {
        if (quota.rolledBack) saveSocialV2State();
        if (quota.rollbackError) log(`[sticker] 回滚发送额度失败 (${key}):`, quota.rollbackError?.message ?? quota.rollbackError);
        log(`[sticker] 工具发送表情失败 ${key}: ${quota.error?.message ?? quota.error}`);
        sendJson({ ok: false, error: `发送表情失败：${quota.error?.message ?? quota.error}` }, 500);
        return true;
      }
      const sent = quota.value;
      // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
      const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
      const text = `[表情包:${label}]`;
      st.recentMessages.push({
        messageId: sent.messageId ? String(sent.messageId) : null,
        sender: '我',
        text: text.slice(0, 200),
        plain: text.slice(0, 200),
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        media: [],
        hasMedia: false,
        forwardIds: [],
        hasForward: false,
        sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
        time: Date.now()
      });
      const recentLimit = recentLimitOf(cfg);
      capList(st.recentMessages, recentLimit);
      markAiSpoke(st, now);
      resetPreSleepWait(st);
      saveSocialV2State();
      scheduleReplyCheckV2(key);
      log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
      appendActivity(`${key} [sticker] 工具发送表情：${label}`);
      sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 2 条路由，原 L2221–L2371
 */
export async function handleSendCheckWait(ctx) {
  const {
    activeWaits,
    agentTokenOk,
    cancelReplyCheckV2,
    cfg,
    getSocialV2State,
    looksLikeUnfinished,
    preSleepWaitBlockedV2,
    readBody,
    req,
    saveSocialV2State,
    sendJson,
    sleep,
    socialV2,
    suggestQuietMsV2,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

    if (await routeWaitMessages()) return true;
    if (await routeCheckSend()) return true;

  return false;

  async function routeCheckSend() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const tool = String(body.tool ?? '').trim();
      const token = String(body.token ?? '').trim();
      if (!key || !tool || !token) {
        sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
        return true;
      }
      if (!agentTokenOk(key, token)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return true;
      }
      if (!v2SessionAllowed(key)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return true;
      }
      const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
      const flag = flagMap[tool];
      if (!flag) {
        sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
        return true;
      }
      if (!v2ToolEnabled(flag)) {
        sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
        return true;
      }
      sendJson({ ok: true, key, tool });
      return true;
    }
    return false;
  }

  async function routeWaitMessages() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return true; }
      if (socialV2.paused) {
        const st = getSocialV2State(key);
        sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], unreadCount: st.unread.length });
        return true;
      }
      const waitCfg = cfg.socialV2?.wait ?? {};
      const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
      const defaultMs = Number(waitCfg.defaultMs) || 30000;
      const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
      const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
      const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
      const st = getSocialV2State(key);
      // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
      if (activeWaits.has(key)) {
        sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
        return true;
      }
      activeWaits.add(key);
      const finishWait = () => activeWaits.delete(key);
      req.on('close', finishWait);
      const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
      const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
      const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
      // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
      // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
      // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
      const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
      const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
      const baseline = st.lastUnreadSeq || 0;
      const start = Date.now();
      let arrived = false;
      let lastNewAt = 0;
      let aborted = false;
      req.on('close', () => { aborted = true; });
      while (Date.now() - start < timeoutMs && !aborted) {
        let nowSeq = st.lastUnreadSeq || 0;
        if (nowSeq - baseline >= minNew) {
          arrived = true;
          lastNewAt = Date.now();
          // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
          // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
          while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
            if ((st.lastUnreadSeq || 0) > nowSeq) {
              nowSeq = st.lastUnreadSeq || 0;
              lastNewAt = Date.now();
            }
            await sleep(200);
          }
          break;
        }
        await sleep(300);
      }
      const waitedMs = Date.now() - start;
      const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 120000);
      const preSleepRemainingMs = preSleepWaitBlockedV2(st)
        ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
        : 0;
      const quiet = arrived && quietMs > 0 && (Date.now() - lastNewAt >= quietMs);
      // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 2 分钟）。
      // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
      const preSleepAttempt = timeoutMs >= preSleepWaitMs;
      // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
      // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
      const preSleepSatisfiedNow = !arrived
        ? waitedMs >= preSleepWaitMs
        : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs);
      if (preSleepSatisfiedNow) {
        st.preSleepWaitSatisfiedAt = Date.now();
        st.preSleepWaitObservedAt = 0;
        st.preSleepWaitAccumMs = 0;
      } else if (!arrived) {
        // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
        st.preSleepWaitAccumMs = 0;
      } else {
        // 等待期间有新消息：
        // - 如果这是一次 2 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
        // - 否则只清空累计，不算完成沉睡前观察。
        if (preSleepAttempt) {
          st.preSleepWaitObservedAt = Date.now();
        }
        st.preSleepWaitAccumMs = 0;
      }
      saveSocialV2State();
      const newMessages = arrived ? (Array.isArray(st.recentMessages) ? st.recentMessages : []).filter((m) => m && !m.isSelf && (m.seq || 0) > baseline) : [];
      const lastNew = newMessages.length ? newMessages[newMessages.length - 1] : null;
      const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
      finishWait();
      sendJson({
        ok: true,
        key,
        arrived,
        quiet,
        quietMs,
        suggestedQuietMs,
        speakerLikelyDone: quiet,
        lastMessageUnfinished,
        timeout: !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
        waitedMs,
        preSleepWaitSatisfied: preSleepSatisfiedNow,
        preSleepWaitObserved: !!st.preSleepWaitObservedAt,
        preSleepWaitMs,
        preSleepWaitRemainingMs: preSleepRemainingMs,
        newMessages,
        unreadCount: st.unread.length
      });
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 1 条路由，原 L2438–L2443
 */
export async function handleSendRecordSentInternal(ctx) {
  const {
    req,
    sendJson,
    url,
  } = ctx;

    if (routeRecordSent()) return true;

  return false;

  function routeRecordSent() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
      // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
      sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
      return true;
    }
    return false;
  }
}
