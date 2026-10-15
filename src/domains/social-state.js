import fs from 'node:fs';
import path from 'node:path';
// 二代会话状态与记忆域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（8 个互相调用的函数）。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 2 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
// ── 落盘字段表 ──────────────────────────────────────────────────────────────
// 注意（2026-10-02 拆记忆）：**记忆三件套（activeTopics / pendingThoughts / memberImpressions）
// 不在这个表里** —— 它们落在"每会话一个文件"的 state/memory/<group|private>-<id>.json 里
// （见 src/core/memory-files.js），这样不同群的记忆天然不混淆，单文件也小得多。
// 这张表只管**运行时状态**：唤醒配置、未读、水位线、令牌……
// **加一个持久化字段 = 这里加一行 + hydrateConversationV2 里加一行**（测试会盯着两处都改：
// src/core/social-state-io.test.js 会比对"hydrate 产出的字段"与这张表，不一致就红）。
//
// 以前写侧是把 22 个字段在 saveSocialV2State 里手抄一遍，读侧再写一遍，两边各自带兜底和截断；
// 加字段漏改一边就静默丢数据（读侧有、写侧没有 = 重启后消失）。
// 顺序 = 写进 JSON 的顺序，**是历史顺序，别按字母重排**（否则整份 state 文件的 diff 全变）。
export { MEMORY_V2_FIELDS };

export const PERSISTED_V2_FIELDS = [
  ['wakeConfig'],
  ['recentMessages', { cap: 200 }],
  ['unread', { cap: 100 }],
  ['lastWakeReason'],
  ['lastAiReplyAt'],
  ['lastActionAt'],
  ['agentToken'],
  ['bootstrapSent'],
  ['muted'],   // 按会话静音（群管理员 /安静、/恢复）；与全局静默无关
  ['wakeTimes', { cap: 200 }],
  ['sendTimes', { cap: 500 }],
  ['stickerCollectTimes', { cap: 500 }],
  ['lastIncomingAt', { zero: true }],
  ['preSleepWaitSatisfiedAt', { zero: true }],
  ['preSleepWaitObservedAt', { zero: true }],
  ['preSleepWaitAccumMs', { zero: true }],
  ['lastUnreadSeq', { zero: true }],
  ['deliveredSeq', { zero: true }],   // she-has-seen-up-to watermark: mark_read only clears up to here
  ['lastFetchedSeq', { zero: true }], // 她【真的查过】未读到哪：只有 qq_get_unread_messages 会推进它
  ['pendingMentions', { cap: 20 }],
];

/** 只在内存里活着的字段（落盘时跳过；hydrate 时置空）。 */
export const RUNTIME_ONLY_V2_FIELDS = ['pendingWakeTimer', 'sleepTimer', 'replyCheckTimer', 'proactiveTimer'];

// 参与度统计（纯函数，有 8 条单测）：用来给"话太密"踩刹车，见 formatParticipationV2。
import { overParticipationHint } from '../core/participation.js';
// 句尾挂钩频率（9 条单测）：给"傲要隐形"当雷达，见 formatParticipationV2 的口癖提醒。
import { hookFrequencyHint } from '../core/hook-frequency.js';

import { MEMORY_FIELDS as MEMORY_V2_FIELDS, applyMemory, isMemoryEmpty, memoryFilePath, pickMemory } from '../core/memory-files.js';

export function createSocialStateModule(ctx) {
  const {
    KNOWN_AGENT_TOKENS,
    SOCIAL_V2_FILE,
    appendMemory,
    atomicWriteJson,
    canonicalV2Key,
    cfg,
    // 必须显式解构 node:crypto：bridge.js 顶部的 `crypto` 才是带 randomBytes 的那个。
    // 漏了它就会落到 Node 的全局 WebCrypto（只有 getRandomValues），
    // 于是 agentToken 生成抛 `crypto.randomBytes is not a function`，
    // /api/socialV2/state 返回 500。（工具原先把 crypto 当全局丢了。）
    crypto,
    defaultWakeConfigV2,
    ensureWakeableV2,
    formatMemory,
    isDirectedAtAi,
    log,
    looksLikeUnfinished,
    normalizeSpeakerIdsV2,
    readJsonSafe,
    redactKnownTokensOnly,
    refreshDefaultWakeConfigV2,
    sanitizeForwardId,
    seenForwardIds,
    senderLabel,
    setupSleepTimerV2,
    socialV2,
  } = ctx;


  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {}
      };
      KNOWN_AGENT_TOKENS.add(st.agentToken);
      socialV2.conversations.set(key, st);
      ctx.scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          hydrateConversationV2(key, seenTokens, val);
        }
        // 记忆三件套不在会话状态文件里了（落在 state/memory/<key>.json）——读回来。
        // 顺序很关键：必须在 hydrate 之后、save 之前，否则会把空记忆写回运行时文件。
        loadConversationMemoryFiles();
        // 人物表（全局，按 QQ）：关系跟人走，不跟群走。
        try {
          const raw3 = readJsonSafe(PEOPLE_FILE, null);
          peopleState = raw3 && typeof raw3 === 'object' ? raw3 : {};
        } catch { peopleState = {}; }
        refreshPeopleNames();
        // 心情是全局的（跨群串联）：单独一个小文件，读一次放内存。
        try {
          const raw2 = readJsonSafe(MOOD_FILE, null);
          moodState = raw2 && typeof raw2 === 'object' ? raw2 : null;
        } catch { moodState = null; }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        saveSocialV2State();
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  // 会话记忆文件：每会话一个（state/memory/<group|private>-<id>.json）。
  // 首次运行（文件还不存在、而 social-v2.json 里还留着记忆）→ **自动拆分**：写文件 + 备份整个 state。
  const MEMORY_DIR = ctx.MEMORY_DIR || path.join(path.dirname(SOCIAL_V2_FILE), 'memory');
  let memorySplitBackedUp = false;
  function loadConversationMemoryFiles() {
    let legacyFound = false;
    for (const [key, st] of socialV2.conversations) {
      const file = memoryFilePath(MEMORY_DIR, key);
      if (!file) continue;
      const onDisk = readJsonSafe(file, null);
      if (onDisk) {
        applyMemory(st, onDisk);
        continue;
      }
      if (isMemoryEmpty(st)) continue;
      legacyFound = true;                       // social-v2.json 里还有记忆 → 这次是"拆分"
      try {
        (ctx.fs?.mkdirSync ?? fs.mkdirSync)(MEMORY_DIR, { recursive: true });
        atomicWriteJson(file, pickMemory(st));
      } catch (error) {
        log('拆分会话记忆失败（继续用内存里的）:', error?.message ?? error);
      }
    }
    if (legacyFound && !memorySplitBackedUp) {
      memorySplitBackedUp = true;
      try {
        const bk = `${SOCIAL_V2_FILE}.before-memory-split-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.bak`;
        (ctx.fs?.copyFileSync ?? fs.copyFileSync)(SOCIAL_V2_FILE, bk);
        log(`记忆已拆分到 state/memory/（原文件备份：${bk}）`);
      } catch { /* 备份失败不阻塞 */ }
    }
  }

  function hydrateConversationV2(key, seenTokens, val) {
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            muted: val.muted === true,   // 按会话静音：她在这个群先不说话
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            deliveredSeq: Number(val.deliveredSeq) || 0,
            lastFetchedSeq: Number(val.lastFetchedSeq) || 0,
            pendingMentions: Array.isArray(val.pendingMentions) ? val.pendingMentions.slice(-20) : [],
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          KNOWN_AGENT_TOKENS.add(st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          ctx.scheduleProactiveCheckV2(key);
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        const conv = {};
        // 按 PERSISTED_V2_FIELDS 逐字段取值：表里没有的字段**不写**（st 上万一挂了临时对象，
        // 不会漏进状态文件），undefined 交给 JSON.stringify 自己丢（与旧实现一致）。
        for (const [field, spec] of PERSISTED_V2_FIELDS) {
          const v = st[field];
          if (spec?.cap) conv[field] = Array.isArray(v) ? v.slice(-spec.cap) : [];
          else if (spec?.zero) conv[field] = v || 0;
          else if (spec?.obj) conv[field] = v && typeof v === 'object' ? v : {};
          else conv[field] = v;
        }
        // seenForwardIds 不在 st 上（按会话 key 存在模块级 Map 里），单独取。
        conv.seenForwardIds = Array.from(seenForwardIds.get(key) || []).slice(-1000);
        obj.conversations[key] = conv;
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
      // 记忆走单独文件（每会话一个）：不同群的记忆不混在一个文件里，也不会被运行时状态写坏。
      try {
        (ctx.fs?.mkdirSync ?? fs.mkdirSync)(MEMORY_DIR, { recursive: true });
        for (const [key, st] of socialV2.conversations) {
          const file = memoryFilePath(MEMORY_DIR, key);
          if (!file) continue;
          if (isMemoryEmpty(st)) continue;
          atomicWriteJson(file, pickMemory(st));
        }
      } catch (error) {
        log('保存会话记忆失败:', error?.message ?? error);
      }
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  // 记录"有人在找她"的必须回事件（@/叫名字/拍一拍）。
  // 关键：这个记录会落盘，所以即使本次唤醒被限流跳过、或者她后面不看未读就直接 mark_read，
  // 下一次唤醒依然会告诉她"有人在找你"。清掉的条件是她真的查过未读（lastFetchedSeq 越过它）或超时。
  function rememberPendingMentionV2(st, kind, event, textContent, extra = {}) {
    if (!Array.isArray(st.pendingMentions)) st.pendingMentions = [];
    const fetched = Number(st.lastFetchedSeq) || 0;
    const now = Date.now();
    // 先清理：已经查过的不留、超过 2 小时的不留
    st.pendingMentions = st.pendingMentions.filter((m) => m && Number(m.seq) > fetched && now - (Number(m.at) || 0) < 2 * 3600000);
    const seq = Number(st.lastUnreadSeq) || 0;
    const sender = senderLabel(event?.sender, event?.user_id, '有人');
    const text = String(textContent || '').slice(0, 200);
    if (st.pendingMentions.some((m) => m && m.seq === seq && m.kind === kind)) return;
    // 拍一拍要记下**拍的是谁**：材料里会照着它写"拍了一拍你 / 拍了别人"。
    // 不记的话渲染层只能猜，猜错的代价很大（真实事故：别人拍别人，她以为拍她，回手拍了管理员）。
    const entry = { seq, kind, sender, text, at: now };
    if (kind === 'poke' && typeof extra.targetIsSelf === 'boolean') entry.pokeTargetIsSelf = extra.targetIsSelf;
    st.pendingMentions.push(entry);
    if (st.pendingMentions.length > 20) st.pendingMentions = st.pendingMentions.slice(-20);
    log(`[reserved2] 记下待回应：${kind} seq${seq} 来自 ${sender}`);
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    // 反向闸门：这一段以前**每一句都在催她说话**（"别只当观众""别让话头掉地上""想说就说"），
    // 没有一句让她收着。实测群里 150 条里她占 42%，而她自己的记忆里也留着
    // 「群友甲评了句『看来还有瑕疵』——我怀疑是我话太密」。只会踩油门的段落要把刹车补上。
    const overHint = overParticipationHint(st, { now });
    let hint = '';
    if (directUnread > 0) {
      hint = overHint
        ? '有人直接找你，必须回——但你最近发言偏密，这条回短一点、别展开。'
        : '有人直接找你——热情点接住，别只丢一个字就完事。';
    } else if (overHint) {
      hint = overHint;
    } else if (recentAi2m >= 2) {
      hint = '你刚连说了几句，节奏挺好；接着聊就行，不用刻意收着。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，顺着往下聊；有人接你的话就自然往下走。';
    } else if (aiCount >= 5) {
      hint = '你最近发言不少，想说就说——但注意别一个人把场子占满。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊）——挑你感兴趣的一两句接，别只当观众。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群里聊得挺热闹，你要是有想说的就直接插一句。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，你可以主动带一句，别让话头掉地上。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    // 口癖雷达：她最近几条是不是都在句尾补刀（"记我账上""别……""本小姐不稀罕"）。
    // 管理员反馈"傲的占比还是偏高"，而扫过她发过的消息后，最高频的傲就是**句尾那一刀**。
    const hookHint = hookFrequencyHint(recent);
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}${hookHint ? `\n【口癖提醒】${hookHint}` : ''}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  // 记忆的读写纯逻辑已抽到 src/core/memory.js（有 22 条单测）。
  // 这里保留同名薄包装，注入时钟与脱敏函数，这样下面 13 个调用点一行都不用改。
  function formatMemoryV2(st) {
    return formatMemory(st, {
      now: Date.now(),
      memoryMaxMembers: cfg.socialV2?.context?.memoryMaxMembers,
      memoryMaxTraits: cfg.socialV2?.context?.memoryMaxTraits,
      memoryTraitChars: cfg.socialV2?.context?.memoryTraitChars
    });
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    // 返回 true 才落盘 —— 与原实现「非法 target 直接 return、不落盘」的行为对齐。
    const shouldSave = appendMemory(st, {
      category,
      content,
      extra,
      now: Date.now(),
      redact: redactKnownTokensOnly
    });
    if (shouldSave) saveSocialV2State();
  }


  /**
   * 人物表（全局，按 QQ）：名字刷新靠会话消息派生，**关系（五档）是持久化的**。
   * 用户决定：关系跟人走、不跟群走；也明确不把好感数值化。
   */
  const PEOPLE_FILE = path.join(MEMORY_DIR, 'people.json');
  let peopleState = {};
  function getPeople() { return peopleState; }
  /**
   * 写关系（用户 2026-10-12：**她的判断是权威**，升能升、降能降）。
   * `note` = "最近影响关系的那句话"，材料（`relationLines`）和控制面板读的都是它。
   * 两条硬边界（主人恒为家人、家人只能由主人指定）在 core/relation.js 的
   * `resolveRelationWrite` 里裁决，这里只落盘。
   */
  function setPersonRelation(qq, relation, note) {
    const id = String(qq ?? '').trim();
    if (!id || !relation) return peopleState;
    const now = Date.now();
    const rec = { ...(peopleState[id] ?? {}), relation: String(relation), relationAt: now };
    const text = String(note ?? '').replace(/\s+/g, ' ').trim();
    if (text) { rec.relationNote = text.slice(0, 200); rec.relationNoteAt = now; }
    peopleState[id] = rec;
    savePeople();
    return peopleState;
  }

  /**
   * 写「小标签」（用户 2026-10-12 要求：给每个群友一句**简短**的概括，看法变了就跟着改）。
   * 语义是**只留最新一条**（不是历史），所以每次覆盖；历史留给印象（traits，带时间戳）。
   * 上限 40 字（她要"简短"）；传空串等于清掉这个标签。
   */
  function setPersonTag(qq, tag) {
    const id = String(qq ?? '').trim();
    if (!id) return peopleState;
    const now = Date.now();
    const rec = { ...(peopleState[id] ?? {}) };
    const text = String(tag ?? '').replace(/\s+/g, ' ').trim();
    if (text) { rec.tag = text.slice(0, 40); rec.tagAt = now; }
    else { delete rec.tag; delete rec.tagAt; }
    peopleState[id] = rec;
    savePeople();
    return peopleState;
  }
  function savePeople() {
    try {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      atomicWriteJson(PEOPLE_FILE, peopleState);
    } catch (error) {
      log('保存人物表失败:', error?.message ?? error);
    }
  }
  /** 用各会话最近消息刷新"QQ ↔ 哪些群叫什么"（关系字段不动）。 */
  function refreshPeopleNames() {
    for (const [key, st] of socialV2.conversations) {
      if (!key.startsWith('group:')) continue;
      for (const m of Array.isArray(st?.recentMessages) ? st.recentMessages : []) {
        if (!m || m.isSelf) continue;
        const qq = String(m.userId ?? m.user_id ?? '').trim();
        const name = String(m.sender ?? '').trim();
        if (!qq || !name) continue;
        peopleState[qq] = { ...(peopleState[qq] ?? {}), names: { ...(peopleState[qq]?.names ?? {}), [key]: name } };
      }
    }
  }

  /**
   * 心情（**跨会话的全局状态**）：存在 state/memory/mood.json。
   * 为什么独立于会话：用户要求"她被不同群的信息影响心情"——在 A 群受的影响到 B 群还在，
   * 但她对外**不说别的群的名字**（渲染规则见 core/mood.js）。
   */
  const MOOD_FILE = path.join(MEMORY_DIR, 'mood.json');
  let moodState = null;
  function getMood() { return moodState; }
  function setMood(next) {
    moodState = next && typeof next === 'object' ? next : null;
    try {
      fs.mkdirSync(MEMORY_DIR, { recursive: true });
      if (moodState) atomicWriteJson(MOOD_FILE, moodState);
      else if (fs.existsSync(MOOD_FILE)) fs.rmSync(MOOD_FILE);
    } catch (error) {
      log('保存心情失败:', error?.message ?? error);
    }
    return moodState;
  }

  /**
   * 列出**全部会话**的记忆与最近消息（只读）：跨群补料要用它。
   * 为什么必须从这里取：bridge 里那次 thunk 曾经读运行时 state 对象（那里根本没有 conversations），
   * 于是"别处记过的人 / 跨群同一个人"两块一直是空的 —— 静默失效，2026-10-02 查出来并修。
   */
  function allConversationSnapshots(exceptKey = '') {
    return [...socialV2.conversations.entries()]
      .filter(([k]) => k !== exceptKey)
      .map(([key, st]) => ({
        key,
        memberImpressions: st?.memberImpressions ?? {},
        recentMessages: Array.isArray(st?.recentMessages) ? st.recentMessages : []
      }));
  }

  return { getSocialV2State, loadSocialV2State, saveSocialV2State, allConversationSnapshots, getPeople, setPersonRelation, setPersonTag, refreshPeopleNames, savePeople, getMood, setMood, rememberPendingMentionV2, formatParticipationV2, suggestQuietMsV2, formatMemoryV2, appendMemoryV2 };
}
