// 控制台路由：media 域（2 段，共 3 条路由）。
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
 * 覆盖 2 条路由，原 L2492–L2603
 */
export async function handleForwardMedia(ctx) {
  const {
    agentTokenOk,
    bot,
    cfg,
    deps,
    fetchMediaData,
    formatForwardResponse,
    getSocialV2State,
    log,
    modeAllowed,
    readBody,
    req,
    seenForwardIds,
    sendJson,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

    if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const id = String(url.searchParams.get('id') ?? '').trim();
      const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return true; }
      if (deps.flags.currentMode !== 'reserved2') {
        sendJson({ ok: false, error: '合并转发查看仅 reserved2 模式可用' }, 403);
        return true;
      }
      if (!agentToken) {
        sendJson({ ok: false, error: 'reserved2 模式读取合并转发必须携带 agent token' }, 403);
        return true;
      }
      if (!agentTokenOk(key, agentToken)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return true;
      }
      const kind = keyMatch[1];
      const num = Number(keyMatch[2]);
      if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, deps.flags.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return true;
      }
      if (!v2ToolEnabled('getForwardMsg')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
        return true;
      }
      // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
      const st = getSocialV2State(key);
      const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
      const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
      const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
      if (!seenInRecent && !seenInUnread && !seenInMemory) {
        sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
        return true;
      }
      try {
        const data = await bot.raw('get_forward_msg', { id });
        const formatted = formatForwardResponse(data);
        const remember = (fid) => {
          if (!fid) return;
          let set = seenForwardIds.get(key);
          if (!set) {
            set = new Set();
            seenForwardIds.set(key, set);
          }
          set.add(fid);
          if (set.size > 1000) {
            for (const old of set) {
              set.delete(old);
              if (set.size <= 1000) break;
            }
          }
        };
        // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
        for (const m of formatted.messages || []) {
          for (const fid of m.nestedForwardIds || []) remember(fid);
        }
        // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
        const nestedPreviews = [];
        const nestedIds = [];
        const seenNested = new Set();
        for (const m of formatted.messages || []) {
          for (const fid of m.nestedForwardIds || []) {
            if (!seenNested.has(fid) && nestedIds.length < 5) {
              seenNested.add(fid);
              nestedIds.push(fid);
            }
          }
        }
        for (const fid of nestedIds) {
          try {
            const ndata = await bot.raw('get_forward_msg', { id: fid });
            const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
            for (const nm of nfmt.messages || []) {
              for (const nfid of nm.nestedForwardIds || []) remember(nfid);
            }
            nestedPreviews.push({ id: fid, ...nfmt });
          } catch (error) {
            log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
            nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
          }
        }
        sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
      } catch (error) {
        log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/socialV2/forward-media') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const media = Array.isArray(body.media) ? body.media : [];
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return true; }
      if (deps.flags.currentMode !== 'reserved2') { sendJson({ ok: false, error: '转发媒体读取仅 reserved2 模式可用' }, 403); return true; }
      if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return true; }
      try {
        const images = await fetchMediaData(media);
        sendJson({ ok: true, key, media, images });
      } catch (error) {
        log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
        sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }

  return false;
}

/**
 * 覆盖 1 条路由，原 L2868–L3015
 */
export async function handleImageMessageAndLegacySend(ctx) {
  const {
    SENSITIVE_RE,
    agentTokenOk,
    appendActivity,
    cfg,
    deps,
    fetchMediaData,
    findMessageMedia,
    getSocialV2State,
    hourCapFor,
    log,
    markAiSpoke,
    modeAllowed,
    rateLimitCheck,
    readBody,
    recordSentMessagesV2,
    req,
    reserveSlots,
    resolveReplyTargetV2,
    rollbackSlots,
    saveSocialV2State,
    scheduleReplyCheckV2,
    sendJson,
    sendMessagesV2,
    shouldBlockSilentReply,
    socialV2,
    unquoteJsonString,
    url,
    v2ToolEnabled,
  } = ctx;

    if (await routeMessageImages()) return true;

    if (await routeSendUnified()) return true;

  return false;

  async function routeMessageImages() {
    if (req.method === 'GET' && url.pathname === '/api/images/message') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const messageId = String(url.searchParams.get('messageId') ?? '').trim();
      const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return true; }
      if (deps.flags.currentMode === 'reserved2' && !agentToken) {
        sendJson({ ok: false, error: 'reserved2 模式读取图片必须携带 agent token' }, 403);
        return true;
      }
      if (agentToken && !agentTokenOk(key, agentToken)) {
        sendJson({ ok: false, error: 'agent token 无效' }, 403);
        return true;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.flags.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return true;
      }
      if (agentToken && !v2ToolEnabled('getImages')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
        return true;
      }
      if (!agentToken && deps.flags.currentMode === 'closed-agent' && !v2ToolEnabled('getImages')) {
        sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
        return true;
      }
      const media = findMessageMedia(key, messageId);
      if (!media.length) {
        sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
        return true;
      }
      try {
        // full=1：主人/群友明确要"看原图"——不缩放、取原料的上限也放宽。
        // 默认（不传 full）会把大图自动缩到视觉友好尺寸，这样群里的手机原图她也看得到。
        const full = /^(1|true|yes)$/i.test(String(url.searchParams.get('full') ?? ''));
        const images = await fetchMediaData(media, { full });
        sendJson({ ok: true, messageId, media, images });
      } catch (error) {
        log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeSendUnified() {
    // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
    if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
      const body = await readBody();
      const token = String(body.token ?? '').trim();
      const isPrivate = url.pathname === '/api/send/private';
      const isReply = url.pathname === '/api/send/reply';
      const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
      const message = unquoteJsonString(String(body.message ?? '').trim());
      const replyToMessageId = isReply ? body.replyToMessageId : body.replyToMessageId;
      const atUserId = body.atUserId ?? null;
      const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
      // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用。
      // （原来还有一代 chat/reserved 的 403 分支：那两个模式已删除，只剩这两种允许的模式。）
      if (socialV2.paused && token) {
        sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
        return true;
      }
      if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return true; }
      if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return true; }
      if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
        sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
        return true;
      }
      if (deps.flags.currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return true; }
      if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
      if (token && !v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return true; }
      if (shouldBlockSilentReply(key)) {
        sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
        return true;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.flags.currentMode)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return true;
      }
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
      const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
      if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return true; }
      if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
      // 第 17 轮：预占/回滚收敛到 withSendQuota（原有 reserved 门控版本一并迁移，行为对齐）。
      const st = getSocialV2State(key);
      const now = Date.now();
      const quota = await withSendQuota({
        st,
        count: 1,
        now,
        reserveSlots,
        rollbackSlots,
        gate: () => gateSendRate({ st, sendCfg, count: 1, now, key, tag: '[send]', log, sendJson, rateLimitCheck, hourCapFor }),
        run: () => sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId),
      });
      if (quota.gateFailed) return true;
      if (!quota.ok) {
        const error = quota.error;
        if (error?.sent?.length) {
          recordSentMessagesV2(key, error.sent);
          log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
        }
        if (quota.rolledBack) saveSocialV2State();
        if (quota.rollbackError) log(`[send] 回滚发送额度失败 (${key}):`, quota.rollbackError?.message ?? quota.rollbackError);
        sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
        return true;
      }
      const sentMessages = quota.value;
      recordSentMessagesV2(key, sentMessages);
      markAiSpoke(st, now);
      saveSocialV2State();
      log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
      appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
      if (sentMessages.length > 0) scheduleReplyCheckV2(key);
      sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
      return true;
    }
    return false;
  }
}
