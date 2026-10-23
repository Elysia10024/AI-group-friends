// 入站消息处理域：从 bridge.js 的 main() 里整体搬出来的单个函数。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 6 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
//
// 管理指令的**匹配**已抽成纯函数（`src/core/commands.js`，带单测）：斜杠写法与
// 自然语言写法都在那张表里。这里只负责"要不要接管 / 权限 / 执行"。
import { checkGroupAdminCommand, isGroupAdmin } from '../core/group-admin.js';
import { createAdminCommandsModule } from './admin-commands.js';
import { isChatMuted } from '../core/mute.js';
import { isCommandAddressed } from '../core/commands.js';
import { isIgnoredUser } from '../core/ignore-users.js';
import { isTakeoverOn, startTakeover, stopTakeover, appendOwnerMessage } from '../core/takeover.js';

export function createIncomingModule(ctx) {
  const {
    DIRECTION_HINT,
    KNOWN_AGENT_TOKENS,
    MAX_MEDIA_STORE_PER_KEY,
    QUEUE_HINT_COOLDOWN_MS,
    QUEUE_MAX,
    ROOT,
    SENSITIVE_RE,
    SILENT_MARKER,
    SPACE_SPLIT_HINT,
    STATE_DIR,
    allowed,
    api,
    appendActivity,
    appendRecentMessage,
    appendSocialV2Message,
    appendSummary,
    auditAndSend,
    buildContextBlock,
    cancelPendingEntry,
    cancelSocialTimers,
    clearSocialV2Timers,
    collectors,
    convKey,
    currentRoleHint,
    deliverPrompt,
    drainPromptQueue,
    enqueueForRetry,
    ensureSession,
    enterActive,
    evaluateWakeTriggerV2,
    extractForwardIds,
    extractMediaFromSegments,
    feedSlangWindow,
    fs,
    getSocialV2State,
    groupMemberNameCache,
    handlePendingAnswer,
    isDirectAddress,
    isQuoteTargetSelf,
    isSocialEnabled,
    log,
    markReadCalledKeys,
    mdToPlain,
    mediaHintFor,
    messageMediaStore,
    modeAllowed,
    noteGroupDensityMessage,
    path,
    pending,
    pendingSendToolCalls,
    pendingWakeKeys,
    queued,
    queuedHintAt,
    readRoleState,
    refreshSelfAliases,
    rememberPendingMentionV2,
    resolveGroupMemberName,
    resolveMediaList,
    resolveReplyInfo,
    reverse,
    sanitizeRoleName,
    saveSocialV2State,
    saveState,
    scheduleSocialReply,
    scheduleWakeV2,
    seenForwardIds,
    segmentsToText,
    sendToQQ,
    sendToolSucceededSessions,
    senderLabel,
    sessionPromises,
    shouldAuditKey,
    slangExtractionCooldowns,
    slangSubmitTimes,
    slangWindows,
    social,
    socialState,
    socialV2,
    state,
    toolCallNames,
    triggerActiveDurationExit,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    withSlangContext,
    writeRoleState,
  } = ctx;


  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    // ── 接管模式（2026-10-22 主人后门）：主人私聊的暗号和消息不进她的会话 ──
    // 「妈妈接管」= 打开接管（之后主人私聊消息交给 mom-bot → headless 的我处理）；
    // 「妈妈下线」= 关闭接管。群和其他人的私聊完全不受影响。
    if (kind === 'private' && String(event.user_id ?? '') === String(cfg.ownerQQ ?? '')) {
      const takeoverText = await segmentsToText(event.message ?? [], { includeReply: false, selfId: event.self_id });
      if (isTakeoverOn(ROOT)) {
        if (takeoverText.includes('妈妈下线')) {
          stopTakeover(ROOT);
          log('接管模式：关闭（妈妈下线）');
          await sendToQQ(key, '我下线了，让鲸鱼陪你吧。');
          return;
        }
        appendOwnerMessage(takeoverText, ROOT);
        log(`接管模式：主人消息存起来了（不投递给她）：${takeoverText.slice(0, 40)}`);
        return;
      }
      if (takeoverText.includes('妈妈接管')) {
        startTakeover(ROOT);
        log('接管模式：开启（妈妈接管）');
        await sendToQQ(key, '妈妈接管了。直接说，我在。');
        return;
      }
    }
    // 「不理某人」名单（socialV2.ignoreUsers，2026-10-12 主人要求：把骂过她的那个人拉黑）：
    // 名单里的 QQ 号在群里说什么都**不读、不记账、不唤醒**。位置与下面几条闸门同级 ——
    // 必须在任何解析/记录之前，否则"不读"就是空话。判定见 src/core/ignore-users.js（带单测）。
    if (isIgnoredUser(cfg.socialV2?.ignoreUsers, event.user_id)) {
      log(`忽略名单：丢掉 ${key} 里 ${event.user_id} 的消息（socialV2.ignoreUsers）`);
      return;
    }
    if (!modeAllowed(key, kind, id, cfg, ctx.currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${ctx.currentMode}，来自 ${event.user_id}）`);
      return;
    }
    // 「关闭聊天功能」（静默模式）= **只静默群聊**（判定见 src/core/mute.js，带单测）：
    //   · 群里谁的话都不读、不回 —— 不解析、不入库、不记账；"不再读取群里的聊天"就是这么
    //     省下 token 的（群消息连 segmentsToText 都不做）；
    //   · 群里留一条通道：**管理员的指令**（@她即可），否则关了就没法再开；
    //   · **私聊完全不受影响** —— 你随时能在私聊里找她说话、下指令。
    // 位置很关键：必须在**任何解析/记录之前**，否则"不读取"就是空话。
    // 按会话静音（群管理员 /安静、/恢复）：只静默这一个会话。
    // 注意管理员通道要留着，否则没人能再把它开回来。
    const mutedHere = (() => {
      try { return getSocialV2State(key)?.muted === true; } catch { return false; }
    })();
    if (mutedHere) {
      const speaker0 = String(event.user_id ?? '');
      const isOwner0 = speaker0 === String(cfg.ownerQQ ?? '');
      const isGroupAdmin0 = isGroupAdmin(cfg, key, speaker0);
      if (!isOwner0 && !isGroupAdmin0) {
        log(`按会话静音：忽略 ${key} 的消息（执行者 ${speaker0}）`);
        return;
      }
      const commandText0 = await segmentsToText(event.message ?? [], { includeReply: false, selfId: event.self_id });
      // ⚠️ 这里必须传 isOwner0，不能写死 true：写死 = 被委派的群管理员在这个群里拿到
      // owner 权限（/role、/reset、/silent… 全放行），是一条真实的越权路径。
      const handled0 = await runAdminCommands(cfg, id, isOwner0, key, kind, commandText0, readRoleState(), true, speaker0);
      log(`按会话静音：${isOwner0 ? '主人' : '群管理员'}消息${handled0 ? '作为指令执行' : '忽略'} (${key})`);
      return;
    }
    if (isChatMuted(readRoleState().mode, key)) {
      const isOwnerEarly = String(event.user_id) === String(cfg.ownerQQ ?? '');
      if (!isOwnerEarly) {
        log(`静默模式（关闭聊天功能）：忽略群 ${key} 的消息（不读取、不回复）`);
        return;
      }
      const commandText = await segmentsToText(event.message ?? [], { includeReply: false, selfId: event.self_id });
      const handled = await runAdminCommands(cfg, id, true, key, kind, commandText, readRoleState(), true, String(event.user_id ?? ''));
      log(`静默模式（关闭聊天功能）：管理员群消息${handled ? '作为指令执行' : '忽略'} (${key})`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // 语音：record 段交给本地转写（domains/voice.js），转不出来就退回 [语音]。
    // 同一条语音按文件名缓存，所以下面几次调用只会真的转一次。
    const resolveRecord = (file) => ctx.voice?.resolveRecord?.(file) ?? null;
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    // 红包「漏解」安全网（原来这里是分析红包用的临时抓取块，已收窄）。
    // QQ 的兜底文案「请使用新版手机QQ查收红包。」只会出现在"是真红包、但 SnowLuma
    // 没解出来"的情况下——正常解码后消息里是 redbag 段，不会再有这句话。
    // 真出现就落一条原始事件：这种情况下她会把真红包误判成手打的假红包去嘲讽，
    // 属于最难自己发现的回归，必须留痕。
    recordRedbagMiss(event);
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply, resolveRecord, selfId: event.self_id });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false, resolveRecord, selfId: event.self_id });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    rememberMessageMedia(key, mediaList, refsToStore);
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    const roleState = readRoleState();
    // 群成员名片缓存预热：每条群消息都带着发送者名片，顺手把 `群号:QQ -> 名字` 记下来。
    // 不记的话，材料里的「你订阅了…」永远只有 QQ 号（那张缓存原本只在解析 @ 时才被动填充，
    // 而订阅唤醒恰恰是"没 @ 她"的情况，永远填不上 → 她只能看到一串数字）。
    if (kind === 'group' && event.user_id && groupMemberNameCache) {
      const qq = String(event.user_id);
      const nm = senderLabel(event.sender, event.user_id);
      if (nm && nm !== qq) {
        groupMemberNameCache.set(`${String(event.group_id ?? id)}:${qq}`, { name: nm, ts: Date.now() });
      }
    }

    if (await answerPendingIfAny(isOwner, key, plainContent)) return;
    if (await rejectRoleControlByNonOwner(isOwner, key, plainContent)) return;
    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）。
    // 群里的"算不算对她说"由纯函数判定（私聊一律算；群里要真点名或句首 @提及）——
    // 只影响**自然语言**写法；斜杠写法不受影响。
    const addressedToSelf = isCommandAddressed({
      kind,
      plainContent,
      directAddress: isDirectAddress(plainContent, event, kind),
      quoteTargetIsSelf,
    });
    if (await runAdminCommands(cfg, id, isOwner, key, kind, plainContent, roleState, addressedToSelf, String(event.user_id ?? ''))) return;
    if (await handleReserved2Message(event, isOwner, key, kind, mediaList, plainContent, quoteTargetIsSelf, textContent)) return;

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      const selfId = String(event.self_id ?? '');
      feedSlangWindow(key, senderLabel(event.sender, event.user_id), plainContent, Boolean(selfId) && String(event.user_id) === selfId);
    }

    const promptText = buildIncomingPrompt(event, isOwner, key, kind, mediaList, messageRef, textContent);

    if (await handleSocialModeMessage(cfg, event, isOwner, key, kind, mediaList, messageRef, plainContent, quoteTargetIsSelf, textContent)) return;

    if (await queueWhenDshDown(key, mediaList, promptText)) return;

    if (await deliverIncomingToDsh(cfg, key, mediaList, promptText)) return;
  }

  async function deliverIncomingToDsh(cfg, key, mediaList, promptText) {
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return true;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText) }, ...imageParts];
    }
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      await sendToQQ(key, `⚠️ 消息未被接受：${safeErrText}`);
      return true;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return true;
    }
    if (cfg.ackMessage && ctx.currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
    return false;
  }

  function buildIncomingPrompt(event, isOwner, key, kind, mediaList, messageRef, textContent) {
    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${senderLabel(event.sender, event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);
    return promptText;
  }

  async function handleReserved2Message(event, isOwner, key, kind, mediaList, plainContent, quoteTargetIsSelf, textContent) {
    // 二代仿真模式（reserved2）：唤醒调度
    if (ctx.currentMode === 'reserved2') {
      const sender = kind === 'group' ? senderLabel(event.sender, event.user_id) : '私聊';
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 聊天密度（densityWake）：只记"普通群消息"的时间戳，供 timers.js 判定最近够不够热闹。
      // 位置贴着入库：忽略名单、未授权会话、静音、管理指令在上面都已经 return 了，能走到这儿的
      // 就是真正的群聊内容；私聊不记（插话只发生在群里）。
      if (kind === 'group') noteGroupDensityMessage(key);
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return true;
      }
      const st = getSocialV2State(key);
      // 刷新"机器人自己的群名片"缓存（群名片可能被改过），供"被叫名字"识别使用
      if (kind === 'group') { try { await refreshSelfAliases(event.group_id); } catch { /* 刷新自己的群名片缓存是尽力而为：失败只是「被叫名字」少一种写法 */ } }
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          // @/叫名字/拍一拍：落盘记下来。被限流跳过、或她没看未读就 mark_read，下次唤醒仍会提醒她。
          if (reason === 'atMention' || reason === 'nameMention' || reason === 'poke') {
            // 拍一拍要把"拍的是谁"一起记下（渲染层据此写"拍了一拍你/拍了别人"）
            const pokeTargetIsSelf = reason !== 'poke'
              ? undefined
              : (event?.target_id != null && event?.self_id != null && String(event.target_id) === String(event.self_id));
            rememberPendingMentionV2(st, reason, event, textContent, { targetIsSelf: pokeTargetIsSelf });
            saveSocialV2State();
          }
          scheduleWakeV2(key, reason);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 200)}`);
      return true;
    }
    return false;
  }

  async function handleSocialModeMessage(cfg, event, isOwner, key, kind, mediaList, messageRef, plainContent, quoteTargetIsSelf, textContent) {
    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? senderLabel(event.sender, event.user_id) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return true;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return true;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return true;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return true;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return true;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return true;
    }
    return false;
  }

  async function queueWhenDshDown(key, mediaList, promptText) {
    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!ctx.dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return true;
    }
    return false;
  }

  function recordRedbagMiss(event) {
    try {
      const segs = Array.isArray(event.message) ? event.message : [];
      const hasRedbag = segs.some((s) => s && s.type === 'redbag');
      const flatText = segs.filter((s) => s && s.type === 'text').map((s) => String(s.data?.text ?? '')).join('');
      if (!hasRedbag && flatText.includes('请使用新版手机QQ')) {
        fs.appendFileSync(path.join(STATE_DIR, 'raw-events.jsonl'), JSON.stringify({
          t: Date.now(),
          why: 'redbag-miss',
          types: segs.map((s) => s && s.type),
          message: segs
        }) + '\n');
        log(`[redbag] 疑似漏解的真红包（会被误判成假红包），已落 raw-events.jsonl：${flatText.slice(0, 80)}`);
      }
    } catch { /* 落 raw-events.jsonl 是排查用的旁路，写失败不能影响红包处理 */ }
  }

  function rememberMessageMedia(key, mediaList, refsToStore) {
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
  }

  async function answerPendingIfAny(isOwner, key, plainContent) {
    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return true;
    }
    return false;
  }

  async function rejectRoleControlByNonOwner(isOwner, key, plainContent) {
    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截。
    // 2026-10-19：补上「角色扮演：X」这个写法（主人在私聊里用的就是它），
    // 否则非 owner 说这句会直接进模型、被当成普通聊天。
    if (!isOwner && /(进入|开始|退出|关闭|开启|切换)角色扮演|角色扮演\s*[:：]|切换角色|设置角色|改角色|换角色/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return true;
    }
    return false;
  }
  const adminCommandsMod = createAdminCommandsModule({
    KNOWN_AGENT_TOKENS,
    ROOT,
    allowed,
    cancelPendingEntry,
    cancelSocialTimers,
    clearSocialV2Timers,
    collectors,
    ctx,
    drainPromptQueue,
    fs,
    getSocialV2State,
    groupMemberNameCache,
    log,
    markReadCalledKeys,
    messageMediaStore,
    path,
    pending,
    pendingSendToolCalls,
    pendingWakeKeys,
    queued,
    queuedHintAt,
    readRoleState,
    reverse,
    sanitizeRoleName,
    saveSocialV2State,
    saveState,
    seenForwardIds,
    sendToQQ,
    sendToolSucceededSessions,
    sessionPromises,
    slangExtractionCooldowns,
    slangSubmitTimes,
    slangWindows,
    social,
    socialV2,
    state,
    toolCallNames,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    writeRoleState,
  });
  const { runAdminCommands } = adminCommandsMod;

  return { handleIncoming };
}
