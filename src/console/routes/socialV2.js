// 控制台路由：socialV2 域（4 段，共 14 条路由）。
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

// "有人在找你"那一行的标签（拍了一拍你 / 拍了别人）——与材料、提示词共用同一个纯函数，
// 免得三处各写一遍、还写歪（真实事故：别人拍别人，控制台和材料都显示"拍了一拍你"）。
import { mentionLabel } from '../../core/mention-label.js';

/**
 * 覆盖 6 条路由，原 L1214–L1571
 */
export async function handleSocialV2ReadWrite(ctx) {
  const {
    agentTokenOk,
    allowedKeywordsRawV2,
    allowedKeywordsV2,
    buildSlangContext,
    buildStickerContext,
    buildStickerStrategyHint,
    cancelReplyCheckV2,
    cfg,
    computeWakeSafetyV2,
    confirmedSlangListV2,
    currentRoleHint,
    currentRoleHintV2,
    deps,
    ensureWakeableV2,
    formatMemoryV2,
    formatParticipationV2,
    getSocialV2State,
    isSleepingConfigV2,
    log,
    markReadCalledKeys,
    mentionsOnlyV2,
    normalizeSpeakerIdsV2,
    preSleepWaitBlockedV2,
    readBody,
    readRoleState,
    readShadowAssemblies,
    req,
    resetPreSleepWait,
    saveSocialV2State,
    sendJson,
    settleV2ReadState,
    setupSleepTimerV2,
    stickerEnabled,
    syncStickerLibrary,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
  } = ctx;

    if (routeSocialState()) return true;
    if (await routeSocialPrompt()) return true;
    if (routeSocialUnread()) return true;
    if (routeSocialRecent()) return true;
    if (await routeSocialMarkRead()) return true;
    if (await routeSocialWakeConfig()) return true;
    if (routeContextShadow()) return true;

  return false;

  // A1.0 影子组装留档（只读）：控制台用来看"如果按新方案组装，这一回合她会看到什么"。
  // 写不写由 cfg.socialV2.context.assembler.shadow 决定；这里只读 state/context-shadow.json。
  function routeContextShadow() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/context-shadow') {
      const limit = Number(url.searchParams.get('limit')) || 3;
      sendJson({ ok: true, ...readShadowAssemblies(limit) });
      return true;
    }
    return false;
  }

  function routeSocialState() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/state') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      const st = getSocialV2State(key);
      sendJson({
        ok: true,
        key,
        wakeConfig: st.wakeConfig,
        wakeSafety: computeWakeSafetyV2(st.wakeConfig),
        unreadCount: st.unread.length,
        recentCount: st.recentMessages.length,
        lastWakeReason: st.lastWakeReason,
        lastAiReplyAt: st.lastAiReplyAt
      });
      return true;
    }
    return false;
  }

  async function routeSocialPrompt() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/prompt') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return true; }
      const st = getSocialV2State(key);
      // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
      if (cfg.socialV2?.sticker?.enabled !== false) {
        try { await syncStickerLibrary(false); } catch { /* 表情库同步失败不阻塞 prompt 生成：它只让 prompt 里的表情摘要更新鲜 */ }
      }
      const roleState = readRoleState();
      const toolMap = {
        getPrompt: 'qq_get_prompt',
        getRecent: 'qq_get_recent_messages',
        sendGroup: 'qq_send_group_message',
        sendPrivate: 'qq_send_private_message',
        reply: 'qq_reply',
        sendBurst: 'qq_send_burst',
        sendMessage: 'qq_send_message',
        waitMessages: 'qq_wait_for_messages',
        feedback: 'qq_report_feedback',
        getMyRecent: 'qq_get_my_recent_messages',
        getMessageDetail: 'qq_get_message_detail',
        getActiveMembers: 'qq_get_active_members',
        setWakeConfig: 'qq_set_wake_config',
        memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
        slangQuery: 'qq_slang_query',
        slangSubmit: 'qq_slang_submit',
        getImages: 'qq_get_message_images',
        getForwardMsg: 'qq_get_forward_msg',
        sendPoke: 'qq_send_poke',
        listStickers: 'qq_list_stickers',
        getStickerImage: 'qq_get_sticker_image',
        sendSticker: 'qq_send_sticker',
        setStickerRemark: 'qq_set_sticker_remark',
        stickerNote: 'qq_sticker_note',
        collectSticker: 'qq_collect_sticker',
        getSelfImage: 'qq_get_self_image',
        sendVoice: 'qq_send_voice',
        // 说说（QQ 空间）：这张表是 qq_get_prompt 回给她的"可用工具"清单 ——
        // 漏了这里她就会以为"我没这个工具"，工具挂上了也永远不用（静默失效）。
        // 与 CONFIG_DEFAULTS.socialV2.tools 的一致性由 scripts/check-tool-flags.mjs 盯着。
        postMood: 'qq_post_mood',
        deleteMood: 'qq_delete_mood',
        listMoods: 'qq_list_moods',
        moodComments: 'qq_mood_comments',
        commentMood: 'qq_comment_mood',
        qzoneFeeds: 'qq_list_feeds'
      };
      const tools = cfg.socialV2?.tools ?? {};
      const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
      const enabledTools = [];
      for (const [flag, name] of Object.entries(toolMap)) {
        if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
      }
      sendJson({
        ok: true,
        key,
        time: new Date().toISOString(),
        role: { name: roleState.role ?? null, hint: deps.flags.currentMode === 'reserved2' ? currentRoleHintV2() : currentRoleHint() },
        recommended: cfg.socialV2?.provideRecommendations === false ? null : {
          wake: cfg.socialV2?.wake ?? {},
          send: cfg.socialV2?.send ?? {},
          wait: cfg.socialV2?.wait ?? {},
          proactive: cfg.socialV2?.proactive ?? {}
        },
        enabledTools,
        unreadCount: st.unread.length,
        recentCount: st.recentMessages.length,
        currentWakeConfig: st.wakeConfig,
        wakeSafety: computeWakeSafetyV2(st.wakeConfig),
        memory: formatMemoryV2(st, key),
        participation: formatParticipationV2(st),
        slang: {
          enabled: cfg.slang?.enabled !== false,
          entries: confirmedSlangListV2(),
          block: buildSlangContext(deps.flags.slangEntries, cfg.slang?.injectMax ?? 8)
        },
        stickers: {
          enabled: cfg.socialV2?.sticker?.enabled !== false,
          total: deps.flags.stickerEntries.length,
          context: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerContext(deps.flags.stickerEntries, cfg.socialV2?.sticker?.promptMaxStickers ?? 8) : '',
          strategy: cfg.socialV2?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : ''
        }
      });
      return true;
    }
    return false;
  }

  function routeSocialUnread() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/unread') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      const st = getSocialV2State(key);
      // 她主动查了未读 —— 说明这些她看过了，水位线前移
      try {
        st.deliveredSeq = Number(st.lastUnreadSeq) || 0;
        st.deliveredAt = Date.now();
        // 只有这里才代表"她真的看过内容"——唤醒提示只给条数、不给正文，不能算看过。
        st.lastFetchedSeq = Math.max(Number(st.lastFetchedSeq) || 0, Number(st.lastUnreadSeq) || 0);
        saveSocialV2State();
      } catch { /* 水位线写入失败不影响这次「查未读」的返回 */ }
      sendJson({ ok: true, key, unreadCount: st.unread.length, messages: st.unread.slice(-limit) });
      return true;
    }
    return false;
  }

  function routeSocialRecent() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/recent') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return true; }
      const st = getSocialV2State(key);
      const start = Math.max(0, st.recentMessages.length - offset - limit);
      const end = Math.max(0, st.recentMessages.length - offset);
      sendJson({ ok: true, key, messages: st.recentMessages.slice(start, end) });
      return true;
    }
    return false;
  }

  async function routeSocialMarkRead() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/mark-read') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      const st = getSocialV2State(key);
      // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
      // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
      if (isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st)) {
        const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 120000);
        const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
        const remainMin = Math.ceil(remaining / 60000);
        sendJson({
          ok: false,
          error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
          preSleepWaitMs: preSleepMs,
          preSleepWaitRemainingMs: remaining
        }, 400);
        return true;
      }
      // 防"没看就清"：这批未读里有 @/名字/拍一拍 找她、而她这次压根没查过未读时，
      // 直接放行就等于把那条 @ 吞掉（她只看到"未读 N 条"就全清了）。
      // 第一次拦下来把原文喂给她，nudged 之后放行——避免把回合卡死。
      {
        const fetched = Number(st.lastFetchedSeq) || 0;
        const unSeen = (Array.isArray(st.pendingMentions) ? st.pendingMentions : [])
          .filter((m) => m && Number(m.seq) > fetched && Date.now() - (Number(m.at) || 0) < 2 * 3600000);
        const unNudged = unSeen.filter((m) => !m.nudged);
        if (unNudged.length) {
          for (const m of unSeen) m.nudged = true;
          saveSocialV2State();
          const lines = unNudged.slice(-3).map((m) => `- ${m.sender} ${m.kind === 'poke' ? '拍了一拍你' : (m.kind === 'atMention' ? '@ 了你' : '叫了你的名字')}：「${m.text}」`).join('\n');
          log(`[reserved2] mark_read 被拦下：有 ${unNudged.length} 条找她的消息她还没看过`);
          sendJson({
            ok: false,
            error: `先别收尾——这批未读里有 ${unNudged.length} 条是直接找你的，而你这次没有真的看过内容：\n${lines}\n\n请先 qq_get_recent_messages 看完再决定：回就用 qq_send_message，确实不想回再重新 qq_mark_read。`,
            pendingMentions: unNudged
          }, 400);
          return true;
        }
      }
      // 只清"她这次确实能看到"的那批（水位线之前）。她 turn 期间新到的消息
      // 必须留在未读队列里，否则会被一起标记已读、并被判定"已被当前回合处理"而永久漏回。
      // 具体做什么见 wake-policy.js 的 settleV2ReadState —— 回合收尾时桥侧走的是同一个函数。
      const { markedCount } = settleV2ReadState(st, { key, by: 'mark_read' });
      markReadCalledKeys.add(key);
      saveSocialV2State();
      log(`[reserved2] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
      sendJson({ ok: true, key, markedCount, wakeGuaranteed: computeWakeSafetyV2(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafetyV2(st.wakeConfig), wakeConfig: st.wakeConfig });
      return true;
    }
    return false;
  }

  async function routeSocialWakeConfig() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/wake-config') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return true; }
      const st = getSocialV2State(key);
      const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
      const current = st.wakeConfig;
      const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
      const normalizeTriggerBool = (name, fallback) => {
        if (name in inputTriggers) return inputTriggers[name] === true;
        return fallback;
      };
      const rawKeywords = inputTriggers.keywords;
      const nextKeywords = rawKeywords !== undefined
        ? (Array.isArray(rawKeywords)
            ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
            : [])
        : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
      const next = {
        ...current,
        mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
        infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
        sleepUntil: current.sleepUntil,
        triggers: {
          ...current.triggers,
          ...inputTriggers,
          atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
          nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
          question: normalizeTriggerBool('question', current.triggers.question === true),
          anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
          poke: normalizeTriggerBool('poke', current.triggers.poke === true),
          keywords: nextKeywords
        },
        batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
          ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
          : current.batchWindowMs
      };
      // 策略锁（常态潜水）：她通过 qq_set_wake_config 想把 probability/question/anyMessage
      // 开回来是不生效的——否则"只看 @"的成本策略会被一次工具调用推翻。
      if (mentionsOnlyV2()) {
        next.mode = 'diving';
        next.triggers.anyMessage = false;
        next.triggers.question = false;
        next.triggers.probability = 0;
        // 注意：speakerIds（订阅某人发言）**故意不锁**——用户定它为她正当的能力：
        // 她自己可以加/取消，管理员也能在私聊里用 /订阅、/取消订阅 直接管
        // （见 src/domains/admin-commands.js + src/core/subscribe.js）。
        // 成本语义记着：订阅一个人 = 他说任何话都唤醒她（老群实测订阅 3 人 = 该群 36% 唤醒量）。
        const allow = allowedKeywordsV2();
        // 关键词强制为白名单本身，而不是取交集——取交集时她随便报几个词就会把
        // 整个 keywords 清空（连"大肥鱼"一起丢），策略该是"只认这些"而不是"你可以删"。
        const allowRaw = allowedKeywordsRawV2();
        if (allowRaw) next.triggers.keywords = [...allowRaw];
      }
      // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
      if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
        next.triggers.anyMessage = false;
      }
      if (next.mode === 'active') {
        next.infinite = true;
        next.sleepUntil = null;
        next.triggers.anyMessage = true;
      }
      if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
      if (next.infinite) {
        next.sleepUntil = null;
      } else if (input.sleepUntil) {
        const d = new Date(String(input.sleepUntil));
        if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
      } else if (Number.isFinite(Number(input.sleepMs))) {
        let ms = Math.max(0, Math.round(Number(input.sleepMs)));
        const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
        const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
        if (ms < minMs) ms = minMs;
        if (maxMs > 0 && ms > maxMs) ms = maxMs;
        next.sleepUntil = new Date(Date.now() + ms).toISOString();
      } else if (!next.sleepUntil && !next.infinite) {
        // 既没有无限也没有时间：使用推荐默认有限时长
        const recMin = Number(cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
        const recMax = Number(cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
        const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
        next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
      }
      // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
      if (!next.infinite && next.sleepUntil) {
        const maxMs = Number(cfg.socialV2?.wake?.sleepMaxMs) || 0;
        const minMs = Math.max(0, Number(cfg.socialV2?.wake?.sleepMinMs) || 0);
        let until = Date.parse(next.sleepUntil);
        if (Number.isFinite(until)) {
          if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
          if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
          next.sleepUntil = new Date(until).toISOString();
        }
      }
      // 归一化概率
      if (next.triggers.probability !== undefined) {
        next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
      }
      // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
      if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
        next.triggers.poke = input.triggers.poke === true;
      }
      // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
      // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
      next.triggers.speakerIds = normalizeSpeakerIdsV2(next.triggers.speakerIds);
      // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
      if (key.startsWith('private:')) {
        next.triggers.speakerIds = [];
      }
      // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
      if (next.infinite) {
        const tr = next.triggers ?? {};
        const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
        if (!hasTrigger) {
          sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
          return true;
        }
      }
      // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
      if (isSleepingConfigV2(next) && preSleepWaitBlockedV2(st)) {
        const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 120000);
        const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
        const remainMin = Math.ceil(remaining / 60000);
        sendJson({
          ok: false,
          error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
          preSleepWaitMs: preSleepMs,
          preSleepWaitRemainingMs: remaining
        }, 400);
        return true;
      }
      st.wakeConfig = next;
      st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
      st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
      st.wakeConfig.noActionCount = 0;
      st.wakeConfig.confirmedAt = Date.now();
      st.wakeConfig.confirmedBy = 'set_wake_config';
      st.lastActionAt = Date.now();
      // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 2 分钟观察。
      resetPreSleepWait(st);
      saveSocialV2State();
      wakeConfigUpdatedKeys.add(key);
      wakeConfigMissCount.delete(key);
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      cancelReplyCheckV2(key); // AI 已主动设置新的唤醒配置，取消回复检查
      setupSleepTimerV2(key);
      log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
      sendJson({ ok: true, key, wakeConfig: next, wakeSafety: computeWakeSafetyV2(next) });
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 6 条路由，原 L2371–L2438
 */
export async function handleSocialV2LogsFeedback(ctx) {
  const {
    FEEDBACK_FILE,
    TOOL_LOG_FILE,
    agentTokenOk,
    appendActivity,
    appendFeedbackEntry,
    atomicWriteJson,
    cfg,
    feedbackTimes,
    fs,
    getSocialV2State,
    log,
    readBody,
    readFeedbackEntries,
    readToolLog,
    req,
    sendJson,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

    if (routeToolLog()) return true;
    if (routeToolLogClear()) return true;
    if (routeFeedbackGet()) return true;
    if (routeFeedbackClear()) return true;
    if (await routeFeedbackPost()) return true;
    if (routeMyRecent()) return true;

  return false;

  function routeToolLog() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/tool-log') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
      sendJson({ ok: true, entries: readToolLog(limit) });
      return true;
    }
    return false;
  }

  function routeToolLogClear() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/tool-log/clear') {
      if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
      try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch { /* 清空工具调用日志是维护动作，失败不影响接口返回 */ }
      log('控制台：工具调用日志已清空');
      sendJson({ ok: true });
      return true;
    }
    return false;
  }

  function routeFeedbackGet() {
    // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/socialV2/feedback') {
      sendJson({ ok: true, entries: readFeedbackEntries() });
      return true;
    }
    return false;
  }

  function routeFeedbackClear() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback-clear') {
      if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return true; }
      atomicWriteJson(FEEDBACK_FILE, []);
      log('控制台：清空 AI 反馈');
      sendJson({ ok: true });
      return true;
    }
    return false;
  }

  async function routeFeedbackPost() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
      const rawMessage = String(body.message ?? '').trim();
      if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return true; }
      // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
      const fNow = Date.now();
      const fTimes = feedbackTimes.get(key) || [];
      const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
      const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
      if (fRecentMinute >= 5 || fRecentHour >= 20) {
        sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
        return true;
      }
      fTimes.push(fNow);
      feedbackTimes.set(key, fTimes.slice(-100));
      const maxLength = Math.max(1, Number(cfg.socialV2?.feedback?.maxLength) || 500);
      const message = rawMessage.slice(0, maxLength);
      appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
      log(`[reserved2] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
      appendActivity(`${key} [reserved2] AI 反馈 [${level}]：${message.slice(0, 80)}`);
      if (cfg.socialV2?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
        log(`[reserved2] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
      }
      sendJson({ ok: true, key, level, message });
      return true;
    }
    return false;
  }

  function routeMyRecent() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/my-recent') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return true; }
      const st = getSocialV2State(key);
      const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
      sendJson({ ok: true, key, messages: mine });
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 1 条路由，原 L2443–L2492
 */
export async function handleSocialV2MessageDetail(ctx) {
  const {
    agentTokenOk,
    getSocialV2State,
    req,
    resolveReplyInfo,
    sendJson,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

    if (await routeMessageDetail()) return true;

  return false;

  async function routeMessageDetail() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/message-detail') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const messageId = String(url.searchParams.get('messageId') ?? '').trim();
      if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      try {
        const st = getSocialV2State(key);
        const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
        const forwardFields = found ? {
          forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
          hasForward: !!found.hasForward
        } : {};
        let info = null;
        // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
        if (found && found.messageId && String(found.messageId) !== messageId) {
          info = {
            sender: String(found.sender || ''),
            text: String(found.text || found.plain || '').slice(0, 1200),
            userId: found.userId ? String(found.userId) : null,
            messageId: String(found.messageId),
            seq: found.seq
          };
        } else {
          info = await resolveReplyInfo(kind, id, messageId);
          if (!info && found) {
            info = {
              sender: String(found.sender || ''),
              text: String(found.text || found.plain || '').slice(0, 1200),
              userId: found.userId ? String(found.userId) : null,
              messageId: found.messageId ? String(found.messageId) : null,
              seq: found.seq
            };
          }
        }
        // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
        if (info && found) Object.assign(info, forwardFields);
        sendJson({ ok: true, key, messageId, info });
      } catch (error) {
        sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 1 条路由，原 L2603–L2627
 */
export async function handleSocialV2ActiveMembers(ctx) {
  const {
    agentTokenOk,
    getSocialV2State,
    req,
    sendJson,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

    if (routeActiveMembers()) return true;

  return false;

  function routeActiveMembers() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/active-members') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return true; }
      const st = getSocialV2State(key);
      const map = new Map();
      for (const m of st.recentMessages) {
        if (!m || m.isSelf) continue;
        const uid = m.userId ? String(m.userId) : '';
        const key2 = uid || String(m.sender || '未知');
        const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
        if (!cur.userId && uid) cur.userId = uid;
        cur.count += 1;
        if (m.time > cur.lastTime) cur.lastTime = m.time;
        if (m.isOwner) cur.isOwner = true;
        map.set(key2, cur);
      }
      const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
      sendJson({ ok: true, key, members });
      return true;
    }
    return false;
  }
}
