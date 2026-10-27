// 唤醒与定时器域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（11 个互相调用的函数）。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 4 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
import { isChatMuted } from '../core/mute.js';
import { followUpWindowMs } from '../core/wake.js';

export function createWakeModule(ctx) {
  const {
    armFollowUpV2,
    armPendingWakeLease,
    buildStickerContext,
    buildStickerStrategyHint,
    buildWakePrompt,
    cfg,
    clearRedPacketV2,
    collectors,
    decideWake,
    deliverPrompt,
    disarmPendingWakeLease,
    formatMemoryV2,
    formatParticipationV2,
    getSocialV2State,
    groupIdFromKey,
    isSessionAllowedInCurrentMode,
    log,
    pendingWakeKeys,
    promptQueues,
    // 「说说」那一行事实：由 qzone 域渲染（额度是本地账本算的），这里只做搬运。
    qzonePromptText,
    // 「你的说说下面有人评论了」那段：**读一次就清**（跟红包那条同一个套路）——
    // 所以只能在真要发提示词时取，提前取就等于把它吃掉。
    takeQzoneCommentNotice,
    readRoleState,
    redPacketStateV2,
    rememberRedPacketV2,
    resetPreSleepWait,
    saveSocialV2State,
    selfAliasesFor,
    setupSleepTimerV2,
    socialV2,
    state,
    v2TurnStartAt,
  } = ctx;


  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    // 判定链在 src/core/wake.js（有 23 条单测）；这里只取数据 + 处理"记住最近一次红包"这个副作用。
    const hit = decideWake({
      cfg,
      st,
      kind,
      event,
      textContent,
      plainContent,
      quoteTargetIsSelf,
      selfNickname: ctx.selfNickname,
      selfAliases: selfAliasesFor(event?.group_id),
      now: Date.now()
    });
    if (!hit) return null;
    if (hit.redPacket) rememberRedPacketV2(key, hit.redPacket);
    return hit.reason;
  }
  function buildWakePromptV2(key, reason) {
    // 组装 ctx：I/O、时钟、副作用全留在这里；纯渲染在 src/core/prompt.js（有 45 条单测）。
    // 原来这个函数是 134 行的 13 段字符串相加，现在只剩"取数据 + 交给纯函数"。
    const roleState = readRoleState();
    const selfAliases = [...selfAliasesFor(groupIdFromKey(key))].filter(Boolean);
    const st = getSocialV2State(key);
    const memoryText = formatMemoryV2(st, key);
    const participationText = formatParticipationV2(st);
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    // 表情策略段依赖 stickerEntries 这个模块级状态，所以由桥侧渲染好再传进去。
    const stickerText = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(ctx.stickerEntries, stickerCfg.promptMaxStickers ?? 8)}\n\n`
      : '';
    // 红包状态是内存态：读一次就清。副作用留在桥侧，模块保持纯函数。
    const redPacket = reason === 'redPacket' ? (redPacketStateV2(key) || { kind: 'fake', text: '' }) : null;
    if (reason === 'redPacket') clearRedPacketV2(key);
    // 空间评论也是"读一次就清"的内存态（见 ctx.takeQzoneCommentNotice 的注释）：
    // 只在这次唤醒就是因为评论时才取，别顺手把它吃掉。
    const qzoneComment = reason === 'qzoneComment' ? (takeQzoneCommentNotice?.() ?? null) : null;
    // 自刷视频这一轮要带：现在是不是「只刷不分享」窗口、凌晨攒了哪些视频、可以发到哪些群。
    // 数据都来自 bili-scroll 域（IO/状态在桥侧），这里只取一份快照交给纯渲染。
    const biliScroll = reason === 'biliScroll'
      ? {
        ...(typeof ctx.biliScrollMeta === 'function' ? ctx.biliScrollMeta(key) : {}),
        groups: typeof ctx.biliShareGroups === 'function' ? ctx.biliShareGroups() : []
      }
      : null;
    // 角色扮演（宠物等非小鲸鱼角色）：小鲸鱼专属的材料段一律不带——表情策略、说说额度、
    // B 站订阅这些她都用不了（工具也被白名单禁了），带上只会让她想"我能不能用"。
    const roleplay = !!String(roleState?.role ?? '').trim() && roleState.role !== '小鲸鱼';
    return buildWakePrompt({
      key,
      reason,
      now: Date.now(),
      roleState,
      selfAliases,
      st,
      memoryText: roleplay ? '' : memoryText,
      participationText,
      stickerText: roleplay ? '' : stickerText,
      // 说说那一行（额度 + 上一条）：关掉 / 没开提示时是空串。每轮都带，一行 ~100 字。
      qzoneText: roleplay ? '' : (qzonePromptText ? qzonePromptText() : ''),
      // B 站订阅那一行：关注了谁 + 最近播报了什么。播报是桥接直接发的、没进过她的上下文，
      // 不给这行她答不上「你关注的那几个游戏有新动态吗」。
      biliText: roleplay ? '' : (typeof ctx.biliPromptText === 'function' ? ctx.biliPromptText(key) : ''),
      qzoneComment: roleplay ? null : qzoneComment,
      inlineMax: cfg.socialV2?.context?.inlineMessages,
      // 沉睡前观察只在开关打开时才提；传 0 表示"别提这件事"（prompt 侧据此不再要求等待）。
      // 开关关着还让她先观察 2 分钟，既跟「收尾要快」打架，也白花一次工具调用的钱。
      preSleepMs: cfg.socialV2?.wake?.preSleepWaitEnabled === false
        ? 0
        : Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 120000),
      // A1.1 组装开启时：提示里的 context / memory / status 三段由**组装材料**负责，
      // 提示里就不再重复内联一遍（同一批信息发两遍，每遍都是按未命中单价算的）。
      assemblerOn: cfg.socialV2?.context?.assembler?.enabled === true,
      redPacket,
      biliScroll
    });
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    // 沉睡前观察只在开关打开时才要求（默认关）。开关关着还说"必须先观察"，
    // 就会跟每轮提示里的「收尾要快、别长时间等」自相矛盾，也白让她多花一次工具调用。
    const preSleepLine = cfg.socialV2?.wake?.preSleepWaitEnabled === false
      ? ''
      : `注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 120000)}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
    return `${roleLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。${preSleepLine}`;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (ctx.currentMode !== 'reserved2' || socialV2.paused) return;
    // 静默模式（「关闭聊天功能」）时群聊**连叫醒都停**：既不发话（send 闸门也拦），
    // 也不该让 DSH 白跑一轮 turn —— 那会照常烧 token（她在想，只是发不出去）。
    // **私聊照常叫醒**（判定见 src/core/mute.js）。
    if (isChatMuted(readRoleState().mode, key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：静默模式（关闭聊天功能）只对群聊生效`);
      return;
    }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    // 每次唤醒都是一个新回合：清空上一轮可能残留的“沉睡前已观察/已等待”标记，
    // 确保 AI 这一轮想再次潜水时，必须重新走 2 分钟沉睡前观察。
    resetPreSleepWait(st);
    saveSocialV2State();
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控。
    // 【关键】必须回的原因（@/叫名字/私聊）绝不能被普通配额挤掉——被跳过就等于"她没理人"，
    // 而 probability/question 这类可选唤醒被跳过无所谓。所以必须回的走一套宽松得多的独立硬顶。
    // 拍一拍不在名单里（2026-10-26 用户要求）：被戳烦了允许她不理/沉默/装死，@ 仍然必须回。
    // 降级后 poke 走普通唤醒路径：受普通配额与按会话静音约束，而且她本人在提示词层面也有权不回。
    const MUST_WAKE_REASONS = new Set(['atMention', 'nameMention', 'private', 'followUp', 'redPacket']);
    const mustWake = MUST_WAKE_REASONS.has(reason);
    // 按会话静音（/安静，群管理员也有权）：这个群里她已经"不说话了"，**定时器自己找上门的
    // 唤醒必须一起停**（主动冒泡 / 回复检查 / 潜水到期 / 概率…）——否则"关了聊天"她还会自己
    // 开口，那就成了关不掉的开关。必须回的那几类不受影响（它们在静音期间根本到不了这里：
    // incoming.js 在解析消息**之前**就把消息丢了，只留管理员指令通道）。
    if (st.muted === true && !mustWake) {
      log(`[reserved2] 跳过唤醒 ${key}（${reason}）：这个会话按了 /安静`);
      return;
    }
    const now = Date.now();
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if (mustWake) {
      const mustMinute = Number(cfg.socialV2?.wake?.maxMustWakePerMinute) || 12;
      const mustHour = Number(cfg.socialV2?.wake?.maxMustWakePerHour) || 200;
      if (recentMinute >= mustMinute || recentHour >= mustHour) {
        log(`[reserved2] 必须回唤醒触及硬顶（${recentMinute}/分 ${recentHour}/时），跳过 ${key}（${reason}）`);
        return;
      }
    } else {
      const maxPerMinute = Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0;
      const maxPerHour = Number(cfg.socialV2?.wake?.maxWakePerHour) || 0;
      if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
        log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}）`);
        return;
      }
    }
    if (reason === 'followUp' && st.followUp) {
      st.followUp.used = Number(st.followUp.used || 0) + 1;
    }
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText);
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || ctx.currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 新模式：不再"发完固定 30-45 秒后盲看一眼"（那 50 次唤醒大部分是白跑一趟）。
    // 改成武装一个跟进窗口：只有刚才跟她说话的人在窗口内继续说，才把她叫回来。
    // 窗口分钟数从配置推（别再手写在日志里——写过"5 分钟"，配置改成 2 分钟后日志就在说谎）。
    if (armFollowUpV2(st)) {
      saveSocialV2State();
      const winMin = Math.round(followUpWindowMs(cfg) / 60000);
      log(`[reserved2] 武装跟进窗口 ${key}（对象 ${(st.followUp?.speakers || []).length} 人，${winMin} 分钟）`);
      return;
    }
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.socialV2?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (sid) {
      // 保险（第二道防线）：回合开始超过 20 分钟仍标记为进行中，判定为残留并清掉。
      // 桥接在回合中途重启会留下这种残留，导致这条会话永久"繁忙"。
      const started = Number(v2TurnStartAt.get(sid)) || 0;
      if (started && Date.now() - started > 20 * 60 * 1000) {
        log(`[reserved2] ${key} 回合已持续 ${Math.round((Date.now() - started) / 60000)} 分钟，判定为残留，清理繁忙标记`);
        v2TurnStartAt.delete(sid);
        collectors.delete(sid);
      }
      if (v2TurnStartAt.has(sid) || collectors.has(sid)) return true;
    }
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    // 空间评论：不是群里的动静，但确实在等她的回应；比"主动机会"重要、比群里的回复检查轻。
    qzoneComment: 35,
    timeout: 30,
    // 聊天密度插话：和 proactiveCheck 一样是"她自己决定说不说的机会"，但**时效性强得多** ——
    // 热闹的窗口几十分钟就散了，而"群里安静"那个机会随时会再来。所以排在主动机会之上，
    // 排在她自己设的潜水闹钟（timeout）和"可能有人在等她回"（replyCheck）之下。
    densityWake: 25,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  function scheduleWakeV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusyV2(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}）`);
      return;
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason).catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }


  return { evaluateWakeTriggerV2, buildWakePromptV2, buildWakeReminderPromptV2, sendWakePromptV2, cancelReplyCheckV2, scheduleReplyCheckV2, isConversationBusyV2, wakePriorityV2, scheduleWakeV2, WAKE_PRIORITY };
}
