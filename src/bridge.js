// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import { inferSlangByRules } from './slang-rules.js';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector } from './dsh-client.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { safeFetchBuffer, validateFetchUrl, looksLikeImageBuffer } from './safe-fetch.js';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
import { readJsonSafe, atomicWriteJson, atomicWriteText, appendCappedLine } from './core/state-io.js';
// 锁的心跳间隔（见 core/lock-policy.js：PID 复用会把锁变成一个假活锁）。
import { LOCK_HEARTBEAT_MS } from './core/lock-policy.js';
import {
  groupIdFromKey, selfAliases, memberName, senderLabel,
  replyOwnershipOk, localReplyInfo
} from './core/identity.js';
import { detectRedPacket, groupStyleHint } from './core/redpacket.js';
import {
  isCjkLikeChar, convertExampleSpacesToComma,
  findCjkSpaceWarning, findSplitBoundaryWarning
} from './core/text.js';
import { buildWakePrompt } from './core/prompt.js';
import { createConversationRegistry } from './core/conversation-registry.js';
import { formatMemory, appendMemory } from './core/memory.js';
import {
  wakePolicy, mentionsOnly, allowedKeywordsRaw, allowedKeywords,
  armFollowUp, followUpState, mentionsAlias, isDirectedAtAi, decideWake
} from './core/wake.js';
import { planSocialTimeline as planTimeline, computeGaps } from './core/send.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';
import { startConsoleServer } from './console/server.js';
import { resetPreSleepWait, recentLimitOf, capList } from './core/social-state.js';
import { createStickerModule } from './domains/sticker.js';
import { createImageLibraryModule } from './domains/image-library.js';
import { createQzoneModule } from './domains/qzone.js';
import { createSlangModule } from './domains/slang.js';
import { createPumpModule } from './domains/pump.js';
import { createIncomingModule } from './domains/incoming.js';
import { createMediaModule } from './domains/media.js';
import { createVoiceModule } from './domains/voice.js';
import { createVoiceOutModule } from './domains/voice-out.js';
import { createWakeModule } from './domains/wake.js';
import { createTimersModule } from './domains/timers.js';
import { createSocialStateModule } from './domains/social-state.js';
import { relationTagOf } from './core/msg-line.js';
import { createSocialFlowModule } from './domains/social-flow.js';
import { createSocialLoopModule } from './domains/social-loop.js';
import { createRoleReplyModule } from './domains/role-reply.js';
import { createPokeGuard } from './core/poke-guard.js';
import { createContextShadowModule } from './domains/context-shadow.js';
import { createSocialLogModule } from './domains/social-log.js';
import { createSessionModule } from './domains/session.js';
import { createModeModule } from './domains/mode.js';
import { createSendPathModule } from './domains/send-path.js';
import { createWakePolicyModule } from './domains/wake-policy.js';
import { createPendingModule } from './domains/pending.js';
import { createWakeLeasesModule } from './domains/wake-leases.js';
import { createRedPacketStateModule } from './domains/redpacket-state.js';
import { createConfigModule } from './config.js';
import { createQqTextModule } from './qq-text.js';
import { createRuntimeModule } from './runtime.js';
import { createRolesModule } from './domains/roles.js';
import { createIdsModule } from './ids.js';
import { createDshWatchModule } from './domains/dsh-watch.js';
import { createPromptQueueModule } from './domains/prompt-queue.js';
import { createBilibiliModule } from './domains/bilibili.js';
import { createBiliLookModule } from './domains/bili-look.js';
import { createBiliScrollModule } from './domains/bili-scroll.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const EXPRESSION_FILE = path.join(STATE_DIR, 'expressions.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
const CONTEXT_SHADOW_FILE = path.join(STATE_DIR, 'context-shadow.json');   // A1.0 影子组装留档（只读旁路）
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
const runtimeMod = createRuntimeModule({
  ACTIVITY_LOG,
  BRIDGE_LOG,
  STATE_DIR,
  STATE_FILE,
  appendCappedLine,
  atomicWriteJson,
  atomicWriteText,
  crypto,
  fs,
  path,
  readJsonSafe,
  get LOCK_FILE() { return LOCK_FILE; },
  get redactSensitiveText() { return redactSensitiveText; },
  get state() { return state; },
  set state(v) { state = v; },
});
const {
  loadOrCreateConsoleToken,
  readActivityTail,
  appendActivity,
  loadState,
  saveState,
  acquireLock,
  releaseLock,
  refreshLock,
  log,
  withTimeout,
} = runtimeMod;
const rolesMod = createRolesModule({
  ROLE_STATE_FILE,
  ROOT,
  atomicWriteJson,
  fs,
  path,
  readJsonSafe,
});
const {
  listRoles,
  roleExists,
  readRoleState,
  writeRoleState,
  sanitizeRoleName,
} = rolesMod;

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
const qqTextMod = createQqTextModule({
  SENSITIVE_RE,
  forwardIdFromData,
  get KNOWN_AGENT_TOKENS() { return KNOWN_AGENT_TOKENS; },
  get SEND_TOOL_RE() { return SEND_TOOL_RE; },
});
const {
  isSilentMarker,
  isSendToolName,
  redactSensitiveText,
  escapeCqText,
  unquoteJsonString,
  segmentsToText,
  extractMediaFromSegments,
} = qqTextMod;

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();
const idsMod = createIdsModule({
});
const {
  normalizeOwnerQQ,
  normalizeIdList,
  allowed,
  canonicalV2Key,
} = idsMod;
const configMod = createConfigModule({
  ROOT,
  normalizeIdList,
  normalizeOwnerQQ,
  path,
  readJsonSafe,
});
const {
  loadConfig,
} = configMod;

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  // 可变标量状态（第 3 期 3b）：原来是 11 个 let + 72 行 getter/setter 注入，现在一个共享对象。
  // 模块拿 flags 引用、读写走字段——没有访问器对、没有 TDZ 包装、没有解构快照过期。
  const flags = {
    currentMode: 'reserved2', lastMode: 'reserved2', closedAgentPreset: 'router-standard',
    dshReady: false, dshCheckStarted: false, flushingQueue: false,
    sessionEpoch: 0, stickerSyncedAt: 0, lastForcedAgentStickerSync: 0,
    slangEntries: [], stickerEntries: [],
  };
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  acquireLock();
  // 锁的心跳：顶新锁文件 mtime，证明这个进程还活着。
  // 没有它，PID 复用会让别的进程"替我们"把锁续成一个假活锁（见 core/lock-policy.js）。
  // unref 掉，免得它拖住进程退出。
  const lockHeartbeat = setInterval(() => refreshLock(), LOCK_HEARTBEAT_MS);
  if (typeof lockHeartbeat.unref === 'function') lockHeartbeat.unref();
  loadState();

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  flags.slangEntries = loadSlang(SLANG_FILE);
  // 表达方式库（「什么场景 → 怎么说」）：手动学习、审核后注入材料。和黑话分开存。
  let expressions = (() => {
    try {
      const v = readJsonSafe(EXPRESSION_FILE, []);
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  })();
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  flags.stickerEntries = loadStickerStore(STICKER_FILE);
  flags.stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  flags.lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护
  // 本地图库（<项目根>\image）：管理员自己命名的梗图，按语境发。
  // 与表情包模块并列，但真相源是本地文件夹 + library.json（改完下一轮生效，不用重启）。
  const imageLibraryMod = createImageLibraryModule({
    ROOT,
    cfg,
    log,
    sleep,
    // 下面三个住在稍后才构造的模块里（const 没有提升，直接写名字会 TDZ）→ 包一层推迟查表。
    // 与本文件里 sticker 模块的写法一致（那处注释写得更细）。
    fetchFaceMedia: (...a) => fetchFaceMedia(...a),
    fetchOneBotImage: (...a) => fetchOneBotImage(...a),
    getSocialV2State: (...a) => getSocialV2State(...a),
    // 存群友的图时走 get_image（QQ 网关，比 URL 可靠）。bot 也是后面才连上的，同样用 getter。
    get bot() { return bot; },
    safeFetchBuffer,
    get randInt() { return randInt; },
    get sendChain() { return sendChain; },
    set sendChain(v) { sendChain = v; },
  });

  const stickerMod = createStickerModule({
    STICKER_FILE,
    applyStickerNote,
    cfg,
    // 这两个函数住在稍后才构造的 media 模块里。直接写名字会在构造 sticker 模块时
    // 撞上 TDZ（const 没有提升），所以包一层：**查表推迟到真正调用时**。
    // 行为不变 —— 调用时机和参数都一样，只是名字的解析晚了一点。
    fetchFaceMedia: (...a) => fetchFaceMedia(...a),
    fetchOneBotImage: (...a) => fetchOneBotImage(...a),
    findSticker,
    formatStickerList,
    // 它住在稍后才构造的 social-state 模块里 —— 包一层把查表推迟到调用时（const 没有提升）。
    getSocialV2State: (...a) => getSocialV2State(...a),
    log,
    markStickerUsed,
    mergeStickerLibrary,
    saveStickerStore,
    sleep,
    validateFetchUrl,
    get bot() { return bot; },
    get randInt() { return randInt; },
    get sendChain() { return sendChain; },
    set sendChain(v) { sendChain = v; },
    flags,
  });
  const {
    stickerEnabled,
    saveStickerStoreSafe,
    syncStickerLibrary,
    listStickersForV2,
    getStickerImageData,
    sendStickerV2,
    applyStickerNoteV2,
    setStickerRemarkV2,
    collectStickerV2,
  } = stickerMod;
  const {
    loadLibrary: loadImageLibrary,
    listImages: listLibraryImages,
    readImageData: getLibraryImageData,
    indexText: imageLibraryIndexText,
    sendLibraryImage,
    saveIncomingImage,
  } = imageLibraryMod;
  // QQ 空间说说（她自己发的那种"自言自语"）：账本在 state/qzone.json，判据在 core/qzone.js。
  // 这里只装配 —— 它不依赖任何后构造的东西，所以放得早没关系。
  const qzoneMod = createQzoneModule({
    ROOT,
    STATE_DIR,
    atomicWriteJson,
    cfg,
    log,
    // 说说配图从**同一个图库**取（名字就是它的意思），所以复用图库那套读取与校验：
    // 「不适合」的图、太大的图、名字不对，都在那一层就被拒。
    readLibraryImage: getLibraryImageData,
  });
  const {
    postMood,
    deleteMood,
    listMoods,
    getMoodComments,
    listFeeds: listQzoneFeeds,
    replyToComment,
    checkComments: checkQzoneComments,
    takeCommentNotice,
    startCommentWatch,
    promptText: qzonePromptText,
    status: qzoneStatus,
  } = qzoneMod;
  const slangMod = createSlangModule({
    EXPRESSION_FILE,
    SLANG_FILE,
    SLANG_SESSION_FILE,
    SLANG_STATUS,
    STATE_DIR,
    atomicWriteJson,
    buildExtractionPrompt,
    buildResearchPrompt,
    buildSlangContext,
    cfg,
    fs,
    inferSlangByRules,
    learnerCollectors,
    learnerSessions,
    learnerWaiters,
    log,
    parseExtractionJson,
    parseResearchJson,
    path,
    readJsonSafe,
    readRoleState,
    saveSlang,
    slangExtractionCooldowns,
    slangResearchingIds,
    slangSubmitTimes,
    slangWindows,
    unwrap,
    upsertSlangEntry,
    get api() { return api; },
    flags,
    get slangLearnerSessionId() { return slangLearnerSessionId; },
    set slangLearnerSessionId(v) { slangLearnerSessionId = v; },
    get slangTaskChain() { return slangTaskChain; },
    set slangTaskChain(v) { slangTaskChain = v; },
    get expressions() { return expressions; },
    set expressions(v) { expressions = v; },
    // 表达提取的兜底：学习窗口是内存态（重启就空），手动触发时可以退回该会话最近的群聊记录。
    // socialV2 在下面才定义，这里用 getter 延迟取值，避免 TDZ。
    get socialV2() { return socialV2; },
  });
  const {
    saveSlangStore,
    queueSlangTask,
    ensureSlangLearnerSession,
    invalidateSlangLearnerSession,
    waitLearnerTurn,
    runSlangExtraction,
    runSlangResearch,
    maybeQueueSlangExtraction,
    feedSlangWindow,
    allowSlangSubmit,
    publicSlangEntry,
    confirmedSlangListV2,
    withSlangContext,
    runExpressionExtraction,
    listExpressions,
    setExpressionStatus,
    deleteExpressionById,
    expressionContextFor,
  } = slangMod;
  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl);
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  const activeWaits = new Set(); // key：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序
  const wakeLeasesMod = createWakeLeasesModule({
    pendingWakeKeys,
    pendingWakeLeaseTimers,
  });
  const {
    armPendingWakeLease,
    disarmPendingWakeLease,
    clearAllPendingWakeLeases,
  } = wakeLeasesMod;

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  flags.dshReady = false;
  flags.dshCheckStarted = false;
  // 默认模式 = reserved2（一代 chat/reserved 已删除）。真正生效的模式由 DSH settings / state/mode.json 决定。
  flags.currentMode = 'reserved2'; // closed-agent | reserved2
  flags.lastMode = flags.currentMode;
  flags.closedAgentPreset = 'router-standard'; // closed-agent 模式使用的 DSH agent preset
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）
  const promptQueueMod = createPromptQueueModule({
    QUEUE_MAX,
    cfg,
    log,
    queueRetries,
    queued,
    flags,
    get deliverPrompt() { return deliverPrompt; },
    get modeAllowed() { return modeAllowed; },
  });
  const {
    enqueueForRetry,
    flushQueue,
  } = promptQueueMod;

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  // 一代（chat / reserved）已删除：只剩封闭 Agent（owner 私聊）与二代仿真（reserved2）。
  // 注意：一代的运行时本体（domains/social-flow.js、social-loop.js）还在但**不可达**
  //（它们的 isSocialEnabled() 要求的 'reserved' 不在这里了）—— 去留与理由见 social-loop.js 文件头。
  const VALID_MODES = ['closed-agent', 'reserved2'];
  const modeMod = createModeModule({
    STATE_DIR,
    VALID_MODES,
    allowed,
    api,
    // 手工补：extract-cluster 的依赖判定把「在 A 函数里是形参、在 B 函数里是自由变量」
    // 的名字误判成「簇内已声明」而漏掉，cfg 就是这种（L697 声明，非重赋值）。
    cfg,
    log,
    memberName,
    mentionsAlias,
    normalizeOwnerQQ,
    path,
    readJsonSafe,
    selfAliases,
    unwrap,
    get SELF_ALIAS_TTL_MS() { return SELF_ALIAS_TTL_MS; },
    get bot() { return bot; },
    flags,
    get selfAliasCache() { return selfAliasCache; },
    get selfNickname() { return selfNickname; },
    set selfNickname(v) { selfNickname = v; },
    get selfUserId() { return selfUserId; },
    set selfUserId(v) { selfUserId = v; },
    // 扮演时换预设（qq-roleplay：不带小鲸鱼速记/群三水设定），见 mode.js modePreset。
    // isPlayingRole 是函数声明（有提升），直接传引用即可，不需要 getter 包装（第 3 期）。
    isRoleplaying: isPlayingRole,
  });
  const {
    refreshMode,
    modeAllowed,
    modePreset,
    isSessionAllowedInCurrentMode,
    selfAliasesFor,
    textMentionsSelf,
    refreshSelfAliases,
    normalizeSpeakerIdsV2,
  } = modeMod;

  /** 当前模式是否允许该会话进入 */

  /** 当前模式下的会话预设 */

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */

  flags.flushingQueue = false;
  const dshWatchMod = createDshWatchModule({
    api,
    flushQueue,
    log,
    maybeQueueSlangExtraction,
    refreshMode,
    setupSleepTimerV2,
    slangWindows,
    get cleanupSocialForModeChange() { return cleanupSocialForModeChange; },
    get clearAllSocialV2Timers() { return clearAllSocialV2Timers; },
    flags,
    get drainAllPromptQueues() { return drainAllPromptQueues; },
    get scheduleProactiveCheckV2() { return scheduleProactiveCheckV2; },
    get socialV2() { return socialV2; },
  });
  const {
    checkDsh,
    startDshWatch,
  } = dshWatchMod;

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  // startConsoleServer 已搬到 src/console/server.js（由 scripts/split-console.mjs --emit 生成）。

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  flags.sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }
  const sendPathMod = createSendPathModule({
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
    get bot() { return bot; },
    flags,
    get randInt() { return randInt; },
    get sendChain() { return sendChain; },
    set sendChain(v) { sendChain = v; },
  });
  const {
    sendToQQ,
    planSocialTimeline,
    sendBurstToQQ,
    onebotSend,
    computeGapsV2,
    sendMessagesV2,
    shouldAuditKey,
    shouldBlockSilentReply,
    auditAndSend,
  } = sendPathMod;
  const mediaMod = createMediaModule({
    cfg,
    fs,
    // 它住在稍后才构造的 social-state 模块里 —— 包一层把查表推迟到调用时（const 没有提升）。
    getSocialV2State: (...a) => getSocialV2State(...a),
    log,
    looksLikeImageBuffer,
    path,
    safeFetchBuffer,
    get bot() { return bot; },
    flags,
    get messageMediaStore() { return messageMediaStore; },
    get socialV2() { return socialV2; },
  });
  // 语音转写域：record 段（SILK）→ 本地 SenseVoice → 文字。工具在 <root>/asr/，
  // 一条语音起一个进程（~1.9s）。失败/超时一律退回 [语音]，绝不阻塞消息。
  const voiceMod = createVoiceModule({
    cfg,
    log,
    // bot 在下面才构造（同 mediaMod 的写法）：只在真正转写时读，getter 推迟求值。
    get bot() { return bot; },
  });
  // 语音输出域：她的话 → 本机 TTS → QQ 语音消息。硬边界（群里不发/字数/间隔/日上限）在模块里。
  const voiceOutMod = createVoiceOutModule({
    cfg,
    log,
    // sendChain 是"发送顺序"的全局链，和文字/图片共用；用访问器读写，避免拿到快照。
    get sendChain() { return sendChain; },
    set sendChain(v) { sendChain = v; },
  });
  const {
    mimeFromBuffer,
    mimeFromUrl,
    getImageDimensions,
    base64FromMaybe,
    isSafeLocalMediaPath,
    isProbablySafeImageFileRef,
    fetchOneBotImage,
    fetchFaceMedia,
    resolveMediaList,
    fetchMediaData,
    mediaHintFor,
    findMessageMedia,
    MAX_MEDIA_COUNT,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    MAX_MEDIA_STORE_PER_KEY,
  } = mediaMod;

  // 视觉模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用 DeepSeek-V4-Flash-Vision-Exp + max 思考强度。
  const visionModelAppliedSessions = new Set();
  const sessionMod = createSessionModule({
    STATE_DIR,
    api,
    cfg,
    fs,
    log,
    modePreset,
    path,
    reverse,
    saveState,
    sessionPromises,
    sleep,
    state,
    unwrap,
    visionModelAppliedSessions,
    flags,
  });
  const {
    ensureVisionModel,
    ensureSession,
    startFreshSession,
  } = sessionMod;
  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别"被提到"用）
  let selfUserId = '';            // 机器人自己的 QQ 号

  // 机器人"别名"缓存：各群的群名片。用户可能把机器人的群名片改成任意名字，
  // 这时只靠账号昵称就认不出"被叫名字"了，所以把 card 一并纳入匹配。
  const selfAliasCache = new Map();          // groupId -> { names: Set<string>, ts }
  const SELF_ALIAS_TTL_MS = 5 * 60 * 1000;
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // ── 会话状态登记处（第 2 期）：per-key 清理责任在这里收敛 ────────────────
  // 以前重置一个会话要手抄 30 多个 delete（wipeConversation），DSH 断线时 pump 的
  // finally 再抄一组，模式切换 timers 再抄第三组；加一个 per-key Map = 多处必改。
  // 现在：声明处登记，清理走 disposeKey/disposeSession/clearSessions/clearStores。
  // 登记处不搬数据居住地，只接管删除责任；名单 = 旧三张手写清单的并集，一个 store 不多。
  const registry = createConversationRegistry();
  registry.register('session', 'collectors', collectors);
  registry.register('session', 'sendToolSucceededSessions', sendToolSucceededSessions);
  registry.register('session', 'pendingSendToolCalls', pendingSendToolCalls);
  registry.register('session', 'v2TurnStartAt', v2TurnStartAt);
  registry.register('session', 'toolCallNames', toolCallNames);
  registry.register('session', 'silentTurns', social.silentTurns);
  registry.register('session', 'exitingSessions', social.exitingSessions);
  registry.register('conv', 'pending', {
    has: (k) => pending.has(k),
    delete: (k) => {
      const pe = pending.get(k);
      if (pe) {
        clearTimeout(pe.timer);
        cancelPendingEntry(pe).catch(() => {});
      }
      pending.delete(k);
    },
  });
  registry.register('conv', 'queued', queued);
  registry.register('conv', 'queuedHintAt', queuedHintAt);
  registry.register('conv', 'sessionPromises', sessionPromises);
  registry.register('conv', 'recentMessages', social.recentMessages);
  registry.register('conv', 'messageMediaStore', messageMediaStore);
  registry.register('conv', 'pendingSummaries', social.pendingSummaries);
  registry.register('conv', 'states', social.states);
  registry.register('conv', 'silentContext', social.silentContext);
  registry.register('conv', 'slangWindows', slangWindows);
  registry.register('conv', 'slangExtractionCooldowns', slangExtractionCooldowns);
  registry.register('conv', 'slangSubmitTimes', slangSubmitTimes);
  registry.register('conv', 'pendingWakeKeys', pendingWakeKeys);
  registry.register('conv', 'wakeConfigUpdatedKeys', wakeConfigUpdatedKeys);
  registry.register('conv', 'markReadCalledKeys', markReadCalledKeys);
  registry.register('conv', 'wakeConfigMissCount', wakeConfigMissCount);
  registry.register('conv', 'conversations', socialV2.conversations);
  registry.register('conv', 'seenForwardIds', seenForwardIds);
  const wakePolicyMod = createWakePolicyModule({
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
    get EXPLICIT_END_RE() { return EXPLICIT_END_RE; },
    get saveSocialV2State() { return saveSocialV2State; },
  });
  const {
    wakePolicyV2,
    mentionsOnlyV2,
    allowedKeywordsRawV2,
    allowedKeywordsV2,
    defaultWakeConfigV2,
    refreshDefaultWakeConfigV2,
    refreshAllDefaultWakeConfigsV2,
    hasExplicitEndV2,
    isSleepingConfigV2,
    preSleepWaitBlockedV2,
    settleV2ReadState,
    computeWakeSafetyV2,
    ensureWakeableV2,
    armFollowUpV2,
    followUpStateV2,
  } = wakePolicyMod;

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。**默认关闭**（socialV2.wake.preSleepWaitEnabled）：
  // 打开时才会在收尾提醒/回复检查里要求她先 qq_wait_for_messages(timeoutMs=preSleepWaitMs) 观察一段；
  // 关着就不提这件事——每轮提示里的「收尾要快、别长时间等」才是常态口径（两套说法打架她只会更乱）。
  // 开关打开时的语义：
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;
  const socialStateMod = createSocialStateModule({
    KNOWN_AGENT_TOKENS,
    SOCIAL_V2_FILE,
    appendMemory,
    atomicWriteJson,
    canonicalV2Key,
    cfg,
    // 手工补：工具原先把 crypto 当全局丢掉，模块里就会落到不带 randomBytes 的 WebCrypto。
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
    get scheduleProactiveCheckV2() { return scheduleProactiveCheckV2; },
  });
  const {
    getSocialV2State,
    loadSocialV2State,
    saveSocialV2State,
    rememberPendingMentionV2,
    formatParticipationV2,
    suggestQuietMsV2,
    formatMemoryV2,
    appendMemoryV2,
    allConversationSnapshots,
    getMood,
    setMood,
    getPeople,
    setPersonRelation,
    setPersonTag,
    reloadMemory,
  } = socialStateMod;
  // A1.0 影子组装（只读旁路）：照常走长会话，另外留一份"新方案会给她看什么"。
  // 设计见 docs/上下文组装设计.md；开关在 cfg.socialV2.context.assembler。
  // **必须在 socialStateMod 之后构造**（要它的 getSocialV2State/formatMemoryV2，
  // 放前面会 TDZ：`Cannot access 'socialStateMod' before initialization` —— 启动直接失败）。
  const contextShadowMod = createContextShadowModule({
    CONTEXT_SHADOW_FILE,
    flags,
    atomicWriteJson,
    buildSlangContext,
    cfg,
    formatMemoryV2,
    getSocialV2State,
    // 表达方式块（「场景 → 怎么说」，手动学习+审核后的）。拼进 facts，不进独立块。
    getExpressionBlock: (key) => expressionContextFor(key, 3),
    // 群成员名（同步、惰性）：材料里"你订阅了 XXX"要写人名而不是 QQ 号——
    // 只写 QQ 她认不出是谁，被叫醒时就容易以为有人在 @ 她（真实事故）。
    // 注意用 thunk：groupMemberNameCache 在角色域（下面才构造）里，这里传引用会拿到 undefined。
    getMemberName: (groupId, qq) => {
      const hit = groupMemberNameCache?.get(`${groupId}:${qq}`);
      return String(hit?.name ?? '');
    },
    // 人格核心（roles/<角色>/core.md）：放进材料最前面的稳定块，每轮都在。
    // 退出角色扮演后的 12 小时内，最前面再补一句"你刚才在扮演 X"（见 roleSwitchNote）。
    getRoleCore: (key) => {
      const core = currentRoleHint(key);
      const note = roleSwitchNote();
      return note ? `${note}\n\n${core}` : core;
    },
    // 角色扮演期间：材料里不注入记忆/关系/心情（角色不该继承小鲸鱼的东西）
    // 按 key 判断（群聊看 groupRole，私聊看全局角色）——群宠物、私聊小鲸鱼可以并存。
    isRoleplay: (key) => isPlayingRole(key),
    // 心情（全局、跨群）：在别的群受的影响这里也带着 —— 渲染时不写别的群的名字。
    // 角色扮演期间不给她看心情：那是小鲸鱼的状态，不该被扮演的角色继承（2026-10-19）。
    getMood: () => (isPlayingRole() ? null : getMood()),
    // 人物表（全局，按 QQ）：关系五档跟人走 —— 材料里用它写【你和他们的关系】。
    getPeople: () => getPeople(),
    // 别的会话里记过的人物印象（只读、跨会话补料）：本会话提到"别处记过的人"时补一行。
    // 真实事故：三水在私聊里提"拾圆拾圆"，她回"拾圆拾圆又是谁啊"——人物印象是按会话存的。
    // 注意必须走 socialStateMod 的快照（bridge 的 state 对象里没有 conversations，写错过一次）。
    getOtherConversations: (exceptKey) => allConversationSnapshots(exceptKey),
    // 这个会话的"地方设定"（roles/<角色>/groups|private/<id>.md）——
    // 人格放 core.md（全局）、群文化放 overlay（按会话），改一个群不会碰到别的群。
    getOverlay: (key) => conversationOverlay(key),
    // 本地图库清单（facts 块）：她能发哪些图、名字即语义。
    imageLibraryIndexText,
    // 她最近看过的视频（自刷 + 分享）：懒引用 biliScrollMod（它在下面才构造），材料里补"你最近看过的视频"块。
    recentBiliNotes: (n) => (typeof biliScrollMod !== 'undefined' && biliScrollMod ? biliScrollMod.recentNotes(n) : []),
    log,
    readJsonSafe,
  });

  // loadSocialV2State() 不能放在这里：它内部会调用 ctx.scheduleProactiveCheckV2()，
  // 而这个函数住在 timers.js，timersMod 要到下面才构造（timers 又依赖 socialStateMod 的
  // getSocialV2State，所以 timersMod 不能提到前面来）。原先它在 main 里是函数声明（有提升），
  // 在哪儿调用都行；搬进模块后变成 const，丢了提升 —— 于是每次启动都
  // `读取 socialV2 状态失败: Cannot access 'scheduleProactiveCheckV2' before initialization`，
  // 整个 socialV2 状态加载被 catch 吞掉（会话与 agent 令牌都没恢复）。
  // 现在挪到 timersMod 解构之后调用。
  // 材料里消息行的关系档位标签（只给非默认档：讨厌 / 好朋友 / 家人）。
  // 三处渲染共用 core/msg-line.js 的 renderMessageLine，这里只负责把全局人物表接上。
  const relationTagFor = (userId) => relationTagOf(getPeople(), userId);
  const socialFlowMod = createSocialFlowModule({
    cfg,
    isDirectedAtAi,
    mediaHintFor,
    relationTagFor,
    messageMediaStore,
    promptQueues,
    randInt,
    social,
    textMentionsSelf,
    flags,
    get selfNickname() { return selfNickname; },
    set selfNickname(v) { selfNickname = v; },
  });
  const {
    socialState,
    isDirectAddress,
    enterActive,
    cancelSocialTimers,
    cancelAllSocialTimers,
    cleanupSocialForModeChange,
    leaveActive,
    buildContextBlock,
  } = socialFlowMod;
  const socialLoopMod = createSocialLoopModule({
    buildContextBlock,
    DIRECTION_HINT,
    QUEUE_MAX,
    SENSITIVE_RE,
    SILENT_MARKER,
    SPACE_SPLIT_HINT,
    api,
    auditAndSend,
    buildMaterialV2: contextShadowMod.buildMaterialV2,
    cancelSocialTimers,
    cfg,
    currentRoleHint,
    enqueueForRetry,
    ensureSession,
    enterActive,
    getSocialV2State,
    groupIdFromKey,
    leaveActive,
    log,
    mdToPlain,
    mediaHintFor,
    recordShadowAssembly: contextShadowMod.recordShadowAssembly,
    startFreshSession,
    promptQueues,
    queued,
    randInt,
    resolveMediaList,
    saveSocialV2State,
    sendToQQ,
    shouldAuditKey,
    social,
    socialState,
    state,
    withSlangContext,
    flags,
  });
  const {
    deliverPrompt,
    flushSummaries,
  } = socialLoopMod;
  // 第 5 期 5c：startSocialLoop() 的空转 interval 已删（isSocialEnabled 恒 false，
  // tick 第一行就 return；而 `|| cfg.social?.enabled !== false` 让它永远启动，纯噪音）。

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  // 按会话 key 取角色：群聊可能看 groupRole（群里宠物、私聊小鲸鱼），缓存也要带角色名。
  let roleHintCache = { key: '', hint: '' };
  function currentRoleHint(key) {
    try {
      const rs = readRoleState(key);
      if (!rs.role) return '';
      // 新结构：roles/<角色>/core.md（人格层）；旧结构 roles/<角色>.md 仍兼容。
      const coreFile = path.join(ROOT, 'roles', rs.role, 'core.md');
      const roleFile = fs.existsSync(coreFile) ? coreFile : path.join(ROOT, 'roles', rs.role + '.md');
      if (!fs.existsSync(roleFile)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      const cacheKey = `${rs.role}:${stateStat.mtimeMs}:${roleStat.mtimeMs}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.hint;
      let hint = fs.readFileSync(roleFile, 'utf8');
      if (hint.length > 24000) hint = hint.slice(0, 24000); // 人格核心里有"记忆/图库/情绪"等章节，截断线要留够（旧的 16000 会把后半本切掉）
      roleHintCache = { key: cacheKey, hint };
      return hint;
    } catch {
      return '';
    }
  }

  // 角色扮演切换提示：切回小鲸鱼之后的一小段时间里，材料最前面提醒一句「刚才那段是扮演」。
  // 记忆里带 [扮演:角色] 标记的条目也是那个角色说的，不是她（2026-10-19 主人要求：
  // 扮演说的话不能污染小鲸鱼，并且要让她知道刚才在演）。
  // 窗口只有 2 小时：24 小时会让它变成背景噪音，还可能让她把切回后的话也当成扮演。
  // 过了窗口，记忆里的 [扮演:X] 标记仍然是唯一凭据。
  const ROLE_SWITCH_NOTE_TTL_MS = 2 * 3600 * 1000;
  // 当前是不是在扮演别人（≠ 小鲸鱼）。记忆/心情隔离和切回提示都靠它。
  // 传 key：群聊看 groupRole（群里宠物、私聊小鲸鱼），不传则看全局角色。
  function isPlayingRole(key) {
    try {
      const rs = readRoleState(key);
      const r = String(rs?.role ?? '').trim();
      return Boolean(r && r !== '小鲸鱼');
    } catch {
      return false;
    }
  }
  function roleSwitchNote() {
    try {
      const rs = readRoleState();
      const prev = String(rs?.previous ?? '');
      const at = Number(rs?.switchedAt) || 0;
      if (!prev || prev === '小鲸鱼') return '';
      if (!(at > 0) || Date.now() - at > ROLE_SWITCH_NOTE_TTL_MS) return '';
      const cur = String(rs?.role ?? '');
      if (cur && cur !== '小鲸鱼') return '';   // 还在扮演，不用提示
      return `【刚才】你刚才在扮演「${prev}」。只有记忆里带 [扮演:${prev}] 标记的条目是那个角色说的，不是你的话；除此之外（包括你从现在起说的每一句）都是你自己。要是有人问你怎么还带着刚才那个口气，就说「刚才演得太入戏了，还没缓过来」，一句带过，不用细说。不用向谁解释这件事。`;
    } catch {
      return '';
    }
  }

  // 会话级"地方设定"：group:<群号> → roles/<角色>/groups/<群号>.md；private:<QQ> → roles/<角色>/private/<QQ>.md。
  // 为什么要按会话拆：人格是同一个（core.md），但每个群的氛围、熟人、规矩不一样；
  // 拆开之后改 A 群不会碰到 B 群，也不会碰到人格层（单一真相源）。
  const overlayCache = new Map(); // 文件路径 -> { key, text }
  function conversationOverlay(key) {
    try {
      const rs = readRoleState();
      if (!rs.role || !key) return '';
      const m = /^(group|private):(.+)$/.exec(String(key));
      if (!m) return '';
      const dir = m[1] === 'group' ? 'groups' : 'private';
      const file = path.join(ROOT, 'roles', rs.role, dir, `${m[2]}.md`);
      if (!fs.existsSync(file)) return '';
      const st = fs.statSync(file);
      const cacheKey = String(st.mtimeMs);
      const hit = overlayCache.get(file);
      if (hit && hit.key === cacheKey) return hit.text;
      const text = fs.readFileSync(file, 'utf8').trim();
      overlayCache.set(file, { key: cacheKey, text });
      return text;
    } catch {
      return '';
    }
  }

  // 人设速记（roles/<角色>.速记.md）：每轮唤醒都注入的浓缩版人设。
  // 动机：角色卡要靠 qq_get_prompt 主动拉，且会被 compaction 删掉——实测压缩后 37 轮没拉过一次，
  // 人设等于长期掉线。速记文件独立成文，改它不需要改代码、不需要重启。
  let roleDigestCache = { key: '', text: '' };
  const roleReplyMod = createRoleReplyModule({
    ROOT,
    convertExampleSpacesToComma,
    currentRoleHint,
    fs,
    localReplyInfo,
    log,
    memberName,
    path,
    readRoleState,
    replyOwnershipOk,
    segmentsToText,
    senderLabel,
    get bot() { return bot; },
    get roleDigestCache() { return roleDigestCache; },
    set roleDigestCache(v) { roleDigestCache = v; },
  });
  const {
    currentRoleDigest,
    currentRoleHintV2,
    pruneGroupMemberNameCache,
    prewarmGroupMemberNames,
    resolveGroupMemberName,
    pruneReplyInfoCache,
    resolveReplyInfo,
    resolveReplyTargetV2,
    isQuoteTargetSelf,
    groupMemberNameCache,
    GROUP_MEMBER_NAME_TTL_MS,
    replyInfoCache,
    REPLY_INFO_TTL_MS,
    REPLY_NEGATIVE_TTL_MS,
  } = roleReplyMod;
  const socialLogMod = createSocialLogModule({
    FEEDBACK_FILE,
    STATE_DIR,
    TOOL_LOG_FILE,
    appendCappedLine,
    atomicWriteJson,
    capList,
    cfg,
    fs,
    getSocialV2State,
    log,
    readJsonSafe,
    recentLimitOf,
    redactKnownTokensOnly,
    redactSensitiveText,
    resetPreSleepWait,
    sanitizeForwardId,
    saveSocialV2State,
    seenForwardIds,
  });
  const {
    appendSocialV2Message,
    appendSocialV2Poke,
    recordSentMessagesV2,
    readFeedbackEntries,
    appendFeedbackEntry,
    readToolLog,
    appendToolLog,
    redactSensitive,
    sanitizeToolArgs,
    SENSITIVE_ARG_KEYS,
  } = socialLogMod;
  // 红包识别（真 / 假）与群聊风格判断已抽到 src/core/redpacket.js（纯逻辑，有单测）。
  // 见文件头部的 import。此处只保留"最近一次红包"的内存态。

  // 最近一次红包（内存驻留，按会话）：唤醒 prompt 需要知道真假和留言。
  const redPacketPending = new Map();
  const redPacketStateMod = createRedPacketStateModule({
    redPacketPending,
  });
  const {
    rememberRedPacketV2,
    redPacketStateV2,
    clearRedPacketV2,
  } = redPacketStateMod;
  // B 站订阅模块在启动区才构造；这里先占名字，唤醒提示那行通过闭包延迟取（避免 TDZ）。
  let bilibiliMod = null;
  const wakeMod = createWakeModule({
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
    // 「说说」那一行事实（今天发过几条 / 上一条是什么 / 现在能不能发）—— 唤醒提示里要用。
    qzonePromptText,
    // B 站订阅那一行（关注了谁 + 最近播报）：播报是桥接直接发的，她不知道；给一行事实。
    biliPromptText: () => (bilibiliMod ? bilibiliMod.promptText() : ''),
    // 自刷视频那一轮的额外素材：是否凌晨「只刷不分享」、攒了哪些视频（biliScrollMod 在下面创建，
    // 这些函数只在真正唤醒时被调用，那时它已经初始化）。
    biliScrollMeta: () => biliScrollMod.shareMeta(),
    // 自刷视频可以分享到哪些群（白名单群；分享由她挑 1~2 个）。
    biliShareGroups: () => {
      const ids = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [];
      return ids.map((id) => ({ key: `group:${id}` }));
    },
    // 「你的说说下面有人评论了」那段（读一次就清，只在 qzoneComment 那次唤醒里取）。
    takeQzoneCommentNotice: takeCommentNotice,
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
    flags,
    get selfNickname() { return selfNickname; },
    set selfNickname(v) { selfNickname = v; },
  });
  const {
    evaluateWakeTriggerV2,
    buildWakePromptV2,
    buildWakeReminderPromptV2,
    sendWakePromptV2,
    cancelReplyCheckV2,
    scheduleReplyCheckV2,
    isConversationBusyV2,
    wakePriorityV2,
    scheduleWakeV2,
    WAKE_PRIORITY,
  } = wakeMod;
  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 2147483647;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }
  const timersMod = createTimersModule({
    cfg,
    registry,
    ensureWakeableV2,
    getSocialV2State,
    isConversationBusyV2,
    isSessionAllowedInCurrentMode,
    log,
    markReadCalledKeys,
    messageMediaStore,
    pendingWakeKeys,
    promptQueues,
    sendWakePromptV2,
    socialV2,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    flags,
  });
  const {
    cancelProactiveCheckV2,
    scheduleProactiveCheckV2,
    noteGroupDensityMessage,
    clearSocialV2Timers,
    clearAllSocialV2Timers,
    drainPromptQueue,
    drainAllPromptQueues,
  } = timersMod;
  loadSocialV2State();
  // 连续戳守卫（2026-10-28 防御方案）：默认 5 分钟窗口内第 3 次触发；观察后再调
  const pokeGuard = createPokeGuard();
  const incomingMod = createIncomingModule({
    DIRECTION_HINT,
    registry,
    KNOWN_AGENT_TOKENS,
  groupMemberNameCache,
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
    appendSocialV2Message,
    auditAndSend,
    // 挂起请求域已搬到 src/domains/pending.js，构造点在下面 —— 比这里晚。
    // 直接写裸名字会在构造时求值 → TDZ，所以包一层 thunk，把查表推迟到调用时。
    cancelPendingEntry: (...a) => cancelPendingEntry(...a),
    pokeGuard,
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
    handlePendingAnswer: (...a) => handlePendingAnswer(...a),  // 同上：pending 域构造点更晚
    isDirectAddress,
    isQuoteTargetSelf,
    log,
    markReadCalledKeys,
    mdToPlain,
    mediaHintFor,
    messageMediaStore,
    modeAllowed,
    // 聊天密度（densityWake）：群消息入库时记一个时间戳。实现住在 timersMod 里
    // （和它的周期判定同一个模块，省得两边各存一份状态）。
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
    v2TurnStartAt,
    voice: voiceMod,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    withSlangContext,
    writeRoleState,
    flags,
  });
  const {
    handleIncoming,
  } = incomingMod;
  const pendingMod = createPendingModule({
    pokeGuard,
    APPROVE_WORDS,
    REJECT_WORDS,
    api,
    appendActivity,
    appendSocialV2Poke,
    cfg,
    convKey,
    getSocialV2State,
    log,
    modeAllowed,
    pending,
    readRoleState,
    resolveGroupMemberName,
    saveSocialV2State,
    scheduleWakeV2,
    sendToQQ,
    socialV2,
    withTimeout,
    flags,
  });
  const {
    registerPending,
    cancelPendingEntry,
    handlePendingAnswer,
    handlePokeNotice,
  } = pendingMod;
  const pumpMod = createPumpModule({
    KNOWN_AGENT_TOKENS,
    registry,
    SENSITIVE_RE,
    SILENT_MARKER,
    SILENT_TURN_TIMEOUT_MS,
    api,
    appendActivity,
    appendToolLog,
    armPendingWakeLease,
    buildWakeReminderPromptV2,
    cfg,
    clearAllPendingWakeLeases,
    collectors,
    createTurnCollector,
    defaultWakeConfigV2,
    deliverPrompt,
    disarmPendingWakeLease,
    drainAllPromptQueues,
    ensureWakeableV2,
    getSocialV2State,
    isSendToolName,
    isSilentMarker,
    isSleepingConfigV2,
    learnerCollectors,
    learnerSessions,
    learnerWaiters,
    log,
    markReadCalledKeys,
    mdToPlain,
    pendingSendToolCalls,
    pendingWakeKeys,
    planSocialTimeline,
    registerPending,
    reverse,
    sanitizeToolArgs,
    saveSocialV2State,
    scheduleWakeV2,
    sendBurstToQQ,
    sendToQQ,
    sendToolSucceededSessions,
    settleV2ReadState,
    preSleepWaitBlockedV2,
    recordShadowAssembly: contextShadowMod.recordShadowAssembly,
    shouldAuditKey,
    shouldBlockSilentReply,
    sleep,
    social,
    socialState,
    toolCallNames,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    flags,
    get slangLearnerSessionId() { return slangLearnerSessionId; },
    set slangLearnerSessionId(v) { slangLearnerSessionId = v; },
  });
  const {
    pumpMux,
  } = pumpMod;
  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  bot.on('open', () => log(`SnowLuma 已连接：${cfg.snowluma.wsUrl}`));
  bot.on('close', (info) => log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`));
  bot.on('error', (error) => log('SnowLuma 错误:', error));

  await bot.connect();
  // 读取机器人昵称（用于社交模式"被提到"识别）
  try {
    const login = await bot.getLoginInfo();
    if (login?.nickname) {
      selfNickname = String(login.nickname).toLowerCase();
      log(`机器人昵称: ${login.nickname}`);
    }
    if (login?.user_id) selfUserId = String(login.user_id);
  } catch { /* 拿不到 login info 时 selfUserId 保持原值，启动流程继续 */ }
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热群成员名片：材料里「你订阅了…」要写名字而不是 QQ 号（失败不阻塞）。
  {
    const gids = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [];
    prewarmGroupMemberNames(gids)
      .then((n) => log(`预热群成员名片：${gids.length} 个群 / ${n} 人`))
      .catch((error) => log('预热群成员名片失败:', error?.message ?? error));
  }
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  startDshWatch();
  // QQ 空间评论监听（2026-10-13 主人问"有人评论她会回吗"→ 不会，因为**没有任何东西告诉她**）：
  //   · 只读轮询（纯 HTTP，不花模型钱），只有真发现新评论时才叫醒她一次；
  //   · 叫醒哪个会话？说说不属于任何群 —— 挑"最近有人说话的那个允许会话"（评论的人多半就在那个群），
  //     最近一小时谁都没说话就落到主人私聊（她的"家"）；
  //   · 叫不醒（会话忙 / 静默 / 频率超限）时通知**留在域里**，下一轮接着叫，不会丢。
  function qzoneCommentWakeKey() {
    let best = null;
    for (const [key, st] of socialV2.conversations) {
      if (!isSessionAllowedInCurrentMode(key)) continue;
      const at = Number(st?.lastIncomingAt || 0);
      if (!best || at > best.at) best = { key, at };
    }
    if (best && Date.now() - best.at < 3600000) return best.key;
    return `private:${cfg.ownerQQ}`;
  }
  startCommentWatch({
    onFound: async () => {
      const key = qzoneCommentWakeKey();
      // 角色扮演（宠物等）期间不处理空间评论：说说/空间是小鲸鱼的东西（2026-10-27 全线隔离）。
      // 按 key 判断：群聊角色是宠物时跳过，私聊小鲸鱼照常。
      if (isPlayingRole(key)) return;
      if (isConversationBusyV2(key, getSocialV2State(key))) {
        log(`[说说] 有新评论，但 ${key} 正忙 —— 通知留着，下一轮再叫`);
        return;
      }
      await sendWakePromptV2(key, 'qzoneComment');
    },
  });
  // B 站订阅播报：只读 HTTP 轮询投稿视频，有新款直接发群（不叫醒她、不花模型钱）。
  // 边界见 src/domains/bilibili.js 顶部注释；配置在 config.json 的 bilibili 段。
  bilibiliMod = createBilibiliModule({
    cfg,
    log,
    onebotSend,
    sendToQQ,
    readRoleState,
    stateDir: STATE_DIR,
    sleep,
  });
  bilibiliMod.startBilibiliWatch();
  // 看群友分享的 B 站视频：配额（每人每天一次）与分享者判定都在桥接侧。
  const biliLookMod = createBiliLookModule({
    cfg,
    log,
    stateDir: STATE_DIR,
    readJsonSafe,
    atomicWriteJson,
    getSocialV2State,
  });
  // 空闲时段自己刷 B 站：每小时最多叫醒一次；真正看视频走 qq_bili_scroll（配额在域里）。
  const biliScrollMod = createBiliScrollModule({
    cfg,
    log,
    stateDir: STATE_DIR,
    readJsonSafe,
    atomicWriteJson,
    biliLook: biliLookMod,
  });
  biliScrollMod.start({
    // 唤醒的是「坐镇会话」；分享可以跨群（prompt 里给她白名单群列表，她挑 1~2 个发）。
    // onWakeDelivered 在投递后清空待分享池：同一条视频不反复提（投递失败也清，最多丢一次分享机会）。
    onWake: async () => {
      // 角色扮演（宠物等）期间不自刷 B 站：学习和看视频是"小鲸鱼"的功能（2026-10-27 隔离）。
      const scrollKey = String(cfg.biliScroll?.groupKey || 'group:20000001');
      if (isPlayingRole(scrollKey)) return;
      await sendWakePromptV2(scrollKey, 'biliScroll');
      biliScrollMod.onWakeDelivered();
    },
  });
  // 晚绑定契约断言（第 3 期 3c）：上面若干 thunk/闭包的目标（media/socialState/pending/biliScroll
  // 域）构造点更晚，历史上靠 TDZ「没人碰就不炸」；现在在装配末尾显式断言——
  // 漏接线启动即失败，而不是运行时某条稀有路径才炸（3b 事故的教训：context-shadow 漏注入
  // 只丢了一次唤醒才发现）。重排构造顺序彻底删 thunk 的事挂到第 5 期（先补域测试再动顺序）。
  for (const [name, fn] of Object.entries({
    fetchFaceMedia, fetchOneBotImage, getSocialV2State, cancelPendingEntry, handlePendingAnswer,
  })) {
    if (typeof fn !== 'function') throw new Error(`装配不完整：晚绑定目标 ${name} 不是函数`);
  }
  if (typeof biliScrollMod?.shareMeta !== 'function') {
    throw new Error('装配不完整：biliScrollMod.shareMeta 缺失');
  }

  startConsoleServer({
    cfg,
    bilibili: bilibiliMod,
    biliLook: biliLookMod,
    biliScroll: biliScrollMod,
    log,
    getSocialV2State,
    saveSocialV2State,
    SLANG_STATUS,
    social,
    socialV2,
    saveSlangStore,
    modeAllowed,
    ROOT,
    appendActivity,
    atomicWriteJson,
    readJsonSafe,
    stickerEnabled,
    bot,
    formatMemoryV2,
    getMood,
    setMood,
    getPeople,
    setPersonRelation,
    setPersonTag,
    reloadMemory,
    readRoleState,
    recordSentMessagesV2,
    redactKnownTokensOnly,
    seenForwardIds,
    api,
    computeWakeSafetyV2,
    queueSlangTask,
    shouldBlockSilentReply,
    slangWindows,
    clearAllSocialV2Timers,
    scheduleReplyCheckV2,
    SENSITIVE_RE,
    syncStickerLibrary,
    activeWaits,
    collectors,
    drainAllPromptQueues,
    KNOWN_AGENT_TOKENS,
    markReadCalledKeys,
    pendingSendToolCalls,
    preSleepWaitBlockedV2,
    settleV2ReadState,
    readShadowAssemblies: contextShadowMod.readShadowAssemblies,
    publicSlangEntry,
    resolveReplyTargetV2,
    reverse,
    runSlangResearch,
    sendMessagesV2,
    sendToolSucceededSessions,
    sessionPromises,
    setupSleepTimerV2,
    slangExtractionCooldowns,
    slangSubmitTimes,
    STATE_DIR,
    toolCallNames,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    writeRoleState,
    allowed,
    applyStickerNoteV2,
    atomicWriteText,
    buildSlangContext,
    cancelPendingEntry,
    cancelReplyCheckV2,
    computeGapsV2,
    confirmedSlangListV2,
    createSlangEntry,
    deleteExpressionById,
    listExpressions,
    runExpressionExtraction,
    setExpressionStatus,
    feedbackTimes,
    fetchMediaData,
    findCjkSpaceWarning,
    findSplitBoundaryWarning,
    formatForwardResponse,
    formatStickerList,
    invalidateSlangLearnerSession,
    isSleepingConfigV2,
    messageMediaStore,
    mimeFromBuffer,
    pendingWakeKeys,
    queued,
    queuedHintAt,
    redactSensitiveText,
    runSlangExtraction,
    sanitizeRoleName,
    saveState,
    scheduleProactiveCheckV2,
    setStickerRemarkV2,
    sleep,
    unwrap,
    ACTIVITY_LOG,
    allowedKeywordsRawV2,
    allowedKeywordsV2,
    allowSlangSubmit,
    appendFeedbackEntry,
    appendMemoryV2,
    buildStickerContext,
    buildStickerStrategyHint,
    cancelAllSocialTimers,
    cancelSocialTimers,
    canonicalV2Key,
    cleanupSocialForModeChange,
    clearAllPendingWakeLeases,
    clearSocialV2Timers,
    collectStickerV2,
    currentRoleHint,
    currentRoleHintV2,
    deliverPrompt,
    drainPromptQueue,
    ensureSession,
    ensureWakeableV2,
    enterActive,
    escapeCqText,
    FEEDBACK_FILE,
    findMessageMedia,
    flushSummaries,
    formatParticipationV2,
    getImageDimensions,
    getStickerImageData,
    isSessionAllowedInCurrentMode,
    leaveActive,
    listRoles,
    roleExists,
    loadOrCreateConsoleToken,
    looksLikeUnfinished,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    mentionsOnlyV2,
    mergeEvidence,
    mimeFromUrl,
    normalizeOwnerQQ,
    normalizeSpeakerIdsV2,
    readActivityTail,
    readFeedbackEntries,
    readToolLog,
    refreshAllDefaultWakeConfigsV2,
    releaseLock,
    resolveReplyInfo,
    safeFetchBuffer,
    sendStickerV2,
    // 本地图库（image 域）：列表 / 取图预览 / 发图 / 注入材料用的紧凑清单
    loadImageLibrary,
    listLibraryImages,
    getLibraryImageData,
    imageLibraryIndexText,
    sendLibraryImage,
    saveIncomingImage,
    // 语音输出（voice-out 域）：本机 TTS 合成 + 发 record 段（边界在模块里）
    voiceOut: voiceOutMod,
    // QQ 空间说说（qzone 域）：发表 / 删除 / 读列表 / 读评论 / 回评论 / 好友动态 / 本地账本状态（面板用）
    postMood,
    deleteMood,
    listMoods,
    getMoodComments,
    listQzoneFeeds,
    replyToComment,
    checkQzoneComments,
    qzoneStatus,
    sendWakePromptV2,
    slangResearchingIds,
    SOCIAL_V2_FILE,
    suggestQuietMsV2,
    TOOL_LOG_FILE,
    unquoteJsonString,
    flags,
    get state() { return state; },
    set state(v) { state = v; },
    get pending() { return pending; },
    set pending(v) { pending = v; },
  });

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => log('未处理异常:', error?.message ?? error));
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
