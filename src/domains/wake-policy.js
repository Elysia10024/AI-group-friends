// 唤醒策略与睡眠/跟进域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（14 个互相调用的函数）。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 3 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
import { DEFAULT_MENTION_TTL_MS, pruneMentions } from '../core/mention-window.js';
export function createWakePolicyModule(ctx) {
  const {
    allowedKeywords,
    allowedKeywordsRaw,
    armFollowUp,
    cfg,
    followUpState,
    log,
    mentionsOnly,
    normalizeSpeakerIdsV2,
    setupSleepTimerV2,
    socialV2,
    wakePolicy,
  } = ctx;


  // ===== 常态潜水策略锁 =====
  // 目标：只认 @/被叫名字/拍一拍 + 白名单关键词。禁止她自己（或任何工具调用）把
  // probability / question / anyMessage 开回来——这三项是把"没事就看群"的钱烧掉的主因。
  // 唤醒策略与跟进窗口的纯逻辑已抽到 src/core/wake.js（有 23 条单测）。
  // 保留同名薄包装注入 cfg 与时钟，下面所有调用点一行都不用改。
  function wakePolicyV2() {
    return wakePolicy(cfg);
  }
  function mentionsOnlyV2() {
    return mentionsOnly(cfg);
  }
  function allowedKeywordsRawV2() {
    return allowedKeywordsRaw(cfg);
  }
  function allowedKeywordsV2() {
    return allowedKeywords(cfg);
  }

  // ===== 5 分钟跟进窗口 =====
  // 她发言后武装一个窗口：只有"刚才跟她说话的人"在窗口内继续说，才把她叫回来（每窗口最多 maxPerWindow 次）。
  // 替代原来"发完就不管有没有人接、固定 30-45 秒后盲看一眼"的 replyCheck——那 50 次唤醒大部分白跑。
  function armFollowUpV2(st) {
    return armFollowUp(st, cfg, Date.now());
  }
  function followUpStateV2(st) {
    return followUpState(st, cfg, Date.now());
  }
  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) ctx.saveSocialV2State();
    return changed;
  }

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return ctx.EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 120000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  /**
   * 桥侧接管"标记已读"：把原来她调 `qq_mark_read` 做的事挪到**回合收尾**时自动做。
   *
   * 为什么挪：那是每回合一次的**纯状态写入**（实测 1.03 次/回合、约四分之一成本），
   * 而它做的每件事桥侧本来就知道 —— 清未读水位线、记 lastActionAt、清 noActionCount、
   * 补 infinite（防"无定时器也无触发条件"的静默态）、ensureWakeableV2、写 confirmedBy
   * （让她的唤醒配置不被默认值刷新）、以及"本回合已收尾"这个信号。
   *
   * opts:
   *   · key           会话 key（ensureWakeableV2 用）
   *   · sleepConfirm  false = 只推进"已读"水位线，**不**确认唤醒配置。
   *                   沉睡前观察窗口内必须这样做：否则等于让她绕过观察窗口直接回潜水，
   *                   那种情况交给原来的"防遗忘提醒"流程（她会被提醒去补一次观察）。
   *   · by            写进 wakeConfig.confirmedBy 的值（保留旧值 'mark_read' 便于日志对照）
   *
   * 副作用只在传入的 st 上，**不落盘**：调用方自己 saveSocialV2State()。
   */
  function settleV2ReadState(st, opts = {}) {
    const wm = Number(st.deliveredSeq) || 0;
    let markedCount = st.unread.length;
    if (wm > 0) {
      // 只清"她这次确实能看到"的那批（水位线之前）；turn 期间新到的必须留在未读队列里，
      // 否则会被一起标已读、并被判定"已被本回合处理"而永久漏回。
      const keep = st.unread.filter((m) => m && Number(m.seq) > wm);
      markedCount = st.unread.length - keep.length;
      st.unread = keep;
      if (keep.length > 0) log(`[reserved2] 已读水位线保留 ${keep.length} 条新到的未读（seq>${wm}）`);
    } else {
      st.unread = [];
    }
    if (opts.sleepConfirm === false) return { markedCount, sleepConfirmed: false };
    // 销账：她这轮已经看过/回过的"待回应"必须清掉。
    // 以前只在"又来新 @"时顺带打扫，跨夜没人 @ 她 → 昨晚那条一直留着，次日被拍醒时
    // 材料又写"有人在找你"，于是同一条被回了第二遍（2026-10-02 真实事故）。
    if (Array.isArray(st.pendingMentions) && st.pendingMentions.length) {
      const before = st.pendingMentions.length;
      const ttlMs = Number(opts.mentionTtlMs) || DEFAULT_MENTION_TTL_MS;
      st.pendingMentions = pruneMentions(st.pendingMentions, { fetchedSeq: wm, now: Date.now(), ttlMs });
      const dropped = before - st.pendingMentions.length;
      if (dropped > 0) log(`[reserved2] 待回应销账 ${dropped} 条（已看过或超 ${Math.round(ttlMs / 60000)} 分钟）`);
    }
    st.lastActionAt = Date.now();
    st.wakeConfig.noActionCount = 0;
    // 防止"有限潜水被 timeout 唤醒后 sleepUntil 被清空、又没有触发条件"的静默态。
    if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) st.wakeConfig.infinite = true;
    ensureWakeableV2(st, { key: opts.key });
    st.wakeConfig.confirmedAt = Date.now();
    st.wakeConfig.confirmedBy = opts.by || 'auto-settle';
    return { markedCount, sleepConfirmed: true };
  }

  function computeWakeSafetyV2(wc) {    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) ctx.saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }


  return { wakePolicyV2, mentionsOnlyV2, allowedKeywordsRawV2, allowedKeywordsV2, defaultWakeConfigV2, refreshDefaultWakeConfigV2, refreshAllDefaultWakeConfigsV2, hasExplicitEndV2, isSleepingConfigV2, preSleepWaitBlockedV2, settleV2ReadState, computeWakeSafetyV2, ensureWakeableV2, armFollowUpV2, followUpStateV2 };
}
