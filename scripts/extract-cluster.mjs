// extract-cluster.mjs —— 把 bridge.js 里 main() 的一个"簇"（一组互相调用的函数）
// 搬到独立模块。这是拆 main() 的通用工具，每搬一个簇就加一条 CLUSTERS 配置。
//
// ## 为什么要"簇"而不是一个一个函数
// main() 里的函数互相调用（sendStickerV2 调 syncStickerLibrary、调 getSocialV2State…），
// 单独搬一个会立刻需要搬第二个。按簇整体搬，簇内调用就地保留，只有跨簇的引用才注入。
//
// ## 接口：工厂 + ctx
//   export function createXxxModule(ctx) { const {...} = ctx; <正文逐字不动> return {...}; }
// 可写的、以及在簇**之后**才声明的名字不能解构：
//   · 可写的 —— 解构会拿到快照，模块永远看不到 main() 后来的更新；
//   · 后声明的 —— 函数声明会提升，`const`/`let` 不会，在 main() 顶部构造会 TDZ。
// 这两类一律走 `ctx.X` + get/set 访问器（懒求值），所以正文里要把裸名字改写成 ctx.X。
//
// ## 验证（不通过就拒绝写盘）
//   1. **逆变换逐字还原**：改写时记下每一处替换，事后反着替换回去，必须与原始簇文本
//      逐字节相同 —— 证明"除了这些机械改写，一个字符都没动"；
//   2. `node --check` 两个文件。
//
// 用法：
//   node scripts/extract-cluster.mjs --cluster sticker [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blankCode, matchBraces, functionSites, declaredInside, countRefs, collectIdentifiers, refSites, declsDirectIn
} from './split-console.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_TARGET = path.join(ROOT, 'src', 'bridge.js');

// ---------------------------------------------------------------- 簇配置

const CLUSTERS = {
  mcplib: {
    file: 'src/mcp-snowluma-safe.js',
    scope: 'module',
    functions: ['loadConfig', 'getConfig', 'getAccess', 'getOneBotConfig', 'isAllowed',
      'escapeCqText', 'unquoteJsonString', 'messageSegments', 'onebot', 'agentApiBase',
      'readConsoleToken', 'agentApi', 'authorizeRead'],
    module: 'src/mcp/snowluma-lib.js',
    factory: 'createSnowlumaLib',
    binding: 'mcpLib',
    title: 'MCP 工具面的公共层（配置/OneBot/agent API）'
  },
  promptqueue: {
    functions: ['enqueueForRetry', 'flushQueue'],
    module: 'src/domains/prompt-queue.js',
    factory: 'createPromptQueueModule',
    binding: 'promptQueueMod',
    title: '提示队列重试与排空'
  },
  dshwatch: {
    functions: ['checkDsh', 'startDshWatch'],
    module: 'src/domains/dsh-watch.js',
    factory: 'createDshWatchModule',
    binding: 'dshWatchMod',
    title: 'DSH 就绪监测'
  },
  ids: {
    scope: 'module',
    functions: ['normalizeOwnerQQ', 'normalizeIdList', 'allowed', 'canonicalV2Key'],
    module: 'src/ids.js',
    factory: 'createIdsModule',
    binding: 'idsMod',
    title: '标识与准入归一化'
  },
  roles: {
    scope: 'module',
    functions: ['listRoles', 'readRoleState', 'writeRoleState', 'sanitizeRoleName'],
    module: 'src/domains/roles.js',
    factory: 'createRolesModule',
    binding: 'rolesMod',
    title: '角色状态文件'
  },
  runtime: {
    scope: 'module',
    functions: ['loadOrCreateConsoleToken', 'readActivityTail', 'appendActivity', 'loadState',
      'saveState', 'acquireLock', 'releaseLock', 'log', 'withTimeout'],
    module: 'src/runtime.js',
    factory: 'createRuntimeModule',
    binding: 'runtimeMod',
    title: '运行时基础（锁/日志/状态文件）'
  },
  qqtext: {
    scope: 'module',
    functions: ['isSilentMarker', 'isSendToolName', 'redactSensitiveText', 'escapeCqText',
      'unquoteJsonString', 'segmentsToText', 'extractMediaFromSegments'],
    module: 'src/qq-text.js',
    factory: 'createQqTextModule',
    binding: 'qqTextMod',
    title: 'QQ 文本与媒体'
  },
  loadconfig: {
    scope: 'module',
    functions: ['loadConfig'],
    module: 'src/config.js',
    factory: 'createConfigModule',
    binding: 'configMod',
    title: '配置加载'
  },
  sticker: {
    functions: ['stickerEnabled', 'saveStickerStoreSafe', 'syncStickerLibrary', 'listStickersForV2',
      'getStickerImageData', 'sendStickerV2', 'applyStickerNoteV2', 'setStickerRemarkV2', 'collectStickerV2'],
    module: 'src/domains/sticker.js',
    factory: 'createStickerModule',
    binding: 'stickerMod',
    title: '表情包'
  },
  slang: {
    functions: ['saveSlangStore', 'queueSlangTask', 'ensureSlangLearnerSession', 'invalidateSlangLearnerSession',
      'waitLearnerTurn', 'runSlangExtraction', 'runSlangResearch', 'maybeQueueSlangExtraction',
      'feedSlangWindow', 'allowSlangSubmit', 'publicSlangEntry', 'confirmedSlangListV2', 'withSlangContext'],
    module: 'src/domains/slang.js',
    factory: 'createSlangModule',
    binding: 'slangMod',
    title: '黑话学习'
  },
  pump: {
    functions: ['pumpMux'],
    module: 'src/domains/pump.js',
    factory: 'createPumpModule',
    binding: 'pumpMod',
    title: 'DSH 事件泵'
  },
  incoming: {
    functions: ['handleIncoming'],
    module: 'src/domains/incoming.js',
    factory: 'createIncomingModule',
    binding: 'incomingMod',
    title: '入站消息处理'
  },
  media: {
    functions: ['mimeFromBuffer', 'mimeFromUrl', 'getImageDimensions', 'base64FromMaybe',
      'isSafeLocalMediaPath', 'isProbablySafeImageFileRef', 'fetchOneBotImage', 'fetchFaceMedia',
      'resolveMediaList', 'fetchMediaData', 'mediaHintFor', 'findMessageMedia'],
    module: 'src/domains/media.js',
    factory: 'createMediaModule',
    binding: 'mediaMod',
    title: '媒体处理'
  },
  wake: {
    // 注意这里**不含 setupSleepTimerV2**：早于本簇的 checkDsh（L981）会调用它，
    // 而 checkDsh 在 main 一层 L1037 就被调用了 —— 构造点 L2806 在它之后，
    // 搬走就是真 TDZ。它是函数声明，留在 main 里两边都能用（提升）。
    // 所以这个簇在 setupSleepTimerV2 处断开，后半段归 timers。
    functions: ['evaluateWakeTriggerV2', 'buildWakePromptV2', 'buildWakeReminderPromptV2', 'sendWakePromptV2',
      'rollbackWakeTime', 'restoreFiniteSleep', 'cancelReplyCheckV2', 'scheduleReplyCheckV2',
      'isConversationBusyV2', 'wakePriorityV2', 'scheduleWakeV2'],
    module: 'src/domains/wake.js',
    factory: 'createWakeModule',
    binding: 'wakeMod',
    title: '唤醒与定时器'
  },
  timers: {
    functions: ['cancelProactiveCheckV2', 'scheduleProactiveCheckV2', 'clearSocialV2Timers',
      'clearAllSocialV2Timers', 'drainPromptQueue', 'drainAllPromptQueues'],
    module: 'src/domains/timers.js',
    factory: 'createTimersModule',
    binding: 'timersMod',
    title: '社交定时器与队列排空'
  },
  socialstate: {
    // 这一段在 L1864 的 main 一层启动语句 `loadSocialV2State();` 处断开（守卫拦下的）——
    // 那是 main 的启动代码，不能随簇搬走。后半段归 socialflow。
    functions: ['getSocialV2State', 'loadSocialV2State', 'saveSocialV2State', 'rememberPendingMentionV2',
      'formatParticipationV2', 'suggestQuietMsV2', 'formatMemoryV2', 'appendMemoryV2'],
    module: 'src/domains/social-state.js',
    factory: 'createSocialStateModule',
    binding: 'socialStateMod',
    title: '二代会话状态与记忆'
  },
  socialflow: {
    functions: ['isSocialEnabled', 'socialState', 'isDirectAddress', 'isMustReplyText',
      'appendRecentMessage', 'appendSummary', 'buildContextBlock',
      'enterActive', 'cancelSocialTimers', 'cancelAllSocialTimers',
      'cleanupSocialForModeChange', 'leaveActive'],
    module: 'src/domains/social-flow.js',
    factory: 'createSocialFlowModule',
    binding: 'socialFlowMod',
    title: '会话活跃度与计时器'
  },
  socialloop: {
    functions: ['buildBatchPrompt', 'buildProbePrompt', 'buildActiveExitPrompt', 'triggerActiveDurationExit',
      'buildProactivePrompt', 'deliverPromptNow', 'deliverPrompt', 'processPromptQueue',
      'scheduleSocialReply', 'socialLoopTick', 'startSocialLoop', 'flushSummaries', 'popSilent'],
    module: 'src/domains/social-loop.js',
    factory: 'createSocialLoopModule',
    binding: 'socialLoopMod',
    title: '社交循环与投递'
  },
  rolereply: {
    // 不含 currentRoleHint：它后面紧跟着 main 一层的 `let roleDigestCache = {...}`
    // （可写状态，搬走会变成两份），守卫在这里断开。currentRoleHint 留在 main，
    // 本簇按普通依赖注入它。
    functions: ['currentRoleDigest', 'currentRoleHintV2',
      'pruneGroupMemberNameCache', 'resolveGroupMemberName', 'pruneReplyInfoCache',
      'resolveReplyInfo', 'resolveReplyTargetV2', 'isQuoteTargetSelf'],
    module: 'src/domains/role-reply.js',
    factory: 'createRoleReplyModule',
    binding: 'roleReplyMod',
    title: '角色提示与引用解析'
  },
  sociallog: {
    functions: ['appendSocialV2Message', 'appendSocialV2Poke', 'recordSentMessagesV2',
      'readFeedbackEntries', 'appendFeedbackEntry', 'readToolLog', 'appendToolLog',
      'redactSensitive', 'sanitizeToolArgs'],
    module: 'src/domains/social-log.js',
    factory: 'createSocialLogModule',
    binding: 'socialLogMod',
    title: '消息记录与工具日志'
  },
  session: {
    functions: ['ensureVisionModel', 'ensureSession'],
    module: 'src/domains/session.js',
    factory: 'createSessionModule',
    binding: 'sessionMod',
    title: 'DSH 会话建立'
  },
  mode: {
    functions: ['refreshMode', 'modeAllowed', 'modePreset', 'isSessionAllowedInCurrentMode',
      'selfAliasesFor', 'textMentionsSelf', 'refreshSelfAliases', 'normalizeSpeakerIdsV2'],
    module: 'src/domains/mode.js',
    factory: 'createModeModule',
    binding: 'modeMod',
    title: '模式与准入'
  },
  send: {
    functions: ['sendToQQ', 'planSocialTimeline', 'sendBurstToQQ', 'onebotSend', 'computeGapsV2',
      'sendMessagesV2', 'shouldAuditKey', 'shouldBlockSilentReply', 'auditAndSend'],
    module: 'src/domains/send-path.js',
    factory: 'createSendPathModule',
    binding: 'sendPathMod',
    title: '底层发送与 OneBot 适配'
  },
  wakepolicy: {
    functions: ['wakePolicyV2', 'mentionsOnlyV2', 'allowedKeywordsRawV2', 'allowedKeywordsV2',
      'defaultWakeConfigV2', 'refreshDefaultWakeConfigV2', 'refreshAllDefaultWakeConfigsV2',
      'hasExplicitEndV2', 'isSleepingConfigV2', 'preSleepWaitBlockedV2', 'computeWakeSafetyV2',
      'ensureWakeableV2', 'armFollowUpV2', 'followUpStateV2'],
    module: 'src/domains/wake-policy.js',
    factory: 'createWakePolicyModule',
    binding: 'wakePolicyMod',
    title: '唤醒策略与睡眠/跟进'
  },
  pending: {
    functions: ['registerPending', 'cancelPendingEntry', 'handlePendingAnswer', 'handlePokeNotice'],
    module: 'src/domains/pending.js',
    factory: 'createPendingModule',
    binding: 'pendingMod',
    title: '挂起请求与拍一拍应答'
  },
  leases: {
    functions: ['armPendingWakeLease', 'disarmPendingWakeLease', 'clearAllPendingWakeLeases'],
    module: 'src/domains/wake-leases.js',
    factory: 'createWakeLeasesModule',
    binding: 'wakeLeasesMod',
    title: '唤醒租约'
  },
  redpacket: {
    functions: ['rememberRedPacketV2', 'redPacketStateV2', 'clearRedPacketV2'],
    module: 'src/domains/redpacket-state.js',
    factory: 'createRedPacketStateModule',
    binding: 'redPacketStateMod',
    title: '红包状态（二代会话）'
  }
  // 剩下的 4 个顶层函数**故意不搬**：startDshWatch≈19 行、redactKnownTokensOnly 7 行、
  // currentRoleHint≈23 行、setupSleepTimerV2≈37 行，合计 ≈86 行，都是薄包装/状态助手。
  // 各自开模块要加 ~27 行骨架（import + 工厂 + 解构 + 头注释），4 个就是 ~110 行 ——
  // 净增行数，还多出 4 个单函数模块。它们被十几个模块当注入依赖用，留在装配层更顺。
  // 判断依据与最终形态记在 <项目目录>\docs\重构方案.md。
};

// ---------------------------------------------------------------- 工具

const KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
  'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'void',
  'yield', 'await', 'async', 'function', 'class', 'const', 'let', 'var', 'this', 'super', 'null',
  'undefined', 'true', 'false', 'static', 'get', 'set', 'export', 'import', 'from', 'as', 'extends'
]);
const GLOBALS = new Set([
  'globalThis', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder',
  'TextDecoder', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'queueMicrotask', 'console', 'process', 'structuredClone', 'fetch', 'AbortController', 'AbortSignal',
  'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'eval', 'arguments', 'require', 'module', 'exports', '__dirname',
  '__filename', 'NaN', 'Infinity', 'AggregateError', 'EvalError', 'ReferenceError', 'URIError',
  'FinalizationRegistry', 'WeakRef', 'Atomics', 'SharedArrayBuffer', 'ArrayBuffer', 'DataView',
  'Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Uint16Array', 'Int16Array', 'Uint32Array',
  'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Function',
  'performance', 'atob', 'btoa', 'crypto', 'MessageChannel', 'BroadcastChannel', 'EventTarget',
  'ReadableStream', 'WritableStream', 'TransformStream'
]);

/** 把注释整段删掉再去掉所有空白 —— 行为不变性的比对口径（blankCode 会把注释换成空格，不够用）。 */
function stripComments(text) {
  const out = [];
  const n = text.length;
  let i = 0;
  let prev = '';
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out.push(c); i += 1;
      while (i < n) {
        if (text[i] === '\\') { out.push(text[i], text[i + 1] ?? ''); i += 2; continue; }
        out.push(text[i]);
        const done = text[i] === q;
        i += 1;
        if (done) break;
      }
      prev = q; continue;
    }
    if (c === '/' && /[=(,:[!&|?{};+\-*%<>~^]|^$/.test(prev)) {
      out.push(c); i += 1;
      let inClass = false;
      while (i < n) {
        const d = text[i];
        if (d === '\\') { out.push(d, text[i + 1] ?? ''); i += 2; continue; }
        out.push(d);
        i += 1;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') break;
      }
      prev = '/'; continue;
    }
    if (!/\s/.test(c)) prev = c;
    out.push(c);
    i += 1;
  }
  return out.join('');
}
const codeOnly = (t) => stripComments(t).replace(/\s+/g, '');

// ---------------------------------------------------------------- 主流程

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
};
const clusterName = argOf('cluster');
const DRY = process.argv.includes('--dry');
const C = CLUSTERS[clusterName];
if (!C) {
  console.error(`用法：node scripts/extract-cluster.mjs --cluster <${Object.keys(CLUSTERS).join('|')}> [--dry]`);
  process.exit(1);
}
// 目标文件：默认 bridge.js；CLUSTERS 里写 file 换别的（例如 src/mcp-snowluma-safe.js）。
// 换文件时 scope 只能是 'module'（那个文件没有 main()）。
const BRIDGE = C.file ? path.join(ROOT, C.file) : DEFAULT_TARGET;
if (!fs.existsSync(BRIDGE)) { console.error(`❌ 目标文件不存在：${BRIDGE}`); process.exit(1); }

const src = fs.readFileSync(BRIDGE, 'utf8');
const code = blankCode(src);
const lineOf = (i) => src.slice(0, i).split('\n').length;

// scope：默认 'main'（拆单体 main()），也可以 'module'（拆 bridge.js 顶层的模块级函数）。
//
// 两者的差别只有"包围作用域"和"深度"：main 里的函数缩进 2 层、深度 1；
// 模块级的函数缩进 0、深度 0。把这两个量抽出来，后面的守卫、区间取法、
// 声明表全部复用同一套代码 —— 免得再写一个平行的工具、两边逻辑各自跑偏。
const SCOPE = C.scope === 'module' ? 'module' : 'main';
const mainAt = code.search(/\bfunction\s+main\b/);
const mainOpen = SCOPE === 'module' ? -1 : code.indexOf('{', code.indexOf('(', mainAt));
const mainEnd = SCOPE === 'module' ? code.length : matchBraces(code, mainOpen)[1];
// depthAt 是**相对**起算点的：它从包围作用域的第一个字符之后开始数括号，
// 而 bodyStart 在函数自己的 `{` 之后，所以"顶层函数"的深度恒为 1 —— 模块级和 main 里都一样。
// 真正的差别只有起算点（0 vs mainOpen+1）和"哪些名字可见"（缩进 0 vs 2）。
const LEVEL = 1;
const SCOPE_LABEL = SCOPE === 'module' ? '模块级' : 'main()';
// 模块级的名字必须缩进 0（import、`const X = require()`、`function foo()` 都在这一层）。
// 若把 main 里缩进 2 的解构也算成"模块级可见"，注入就会在模块顶层求值 → ReferenceError。
const WANT_INDENT = SCOPE === 'module' ? 0 : 2;

// 单位来自 functionSites —— 它**同时**认 `function` 声明和 `const X = … => {…}` 箭头常量
// （split-console.mjs 的 re2），后者会被标上 kind:'const'。
// 我一开始误以为"只认 function 声明、所以 flushQueue/checkDsh 找不到"，还照那个误解写了
// 一个 arrowUnits 去补 —— 结果是 allSites 里同一个名字有两份（functionSites 那份没有 kind），
// `find` 先拿到没 kind 的那份，分号就永远补不上。别再走这条路。
const allSites = functionSites(code).filter((s) => s.bodyStart > mainOpen && s.bodyEnd < mainEnd);
const mine = C.functions.map((n) => {
  const s = allSites.find((x) => x.name === n);
  if (!s) { console.error(`❌ ${SCOPE_LABEL}里找不到函数 ${n}`); process.exit(1); }
  return s;
});

// 区分**顶层函数**（直接挂在 main 一层，要导出）与**嵌套函数**（定义在别的函数体内）。
// 嵌套的会随父函数一起搬进模块，但**不在模块的顶层作用域**里 —— 把它们写进
// `return { ... }` 就是 "xxx is not defined"（实测：rollbackWakeTime / restoreFiniteSleep
// 是嵌套在 sendWakePromptV2 里的）。
const depthAt = (idx) => {
  let d = 0;
  for (let i = mainOpen + 1; i < idx; i += 1) {
    if (code[i] === '{') d += 1;
    else if (code[i] === '}') d -= 1;
  }
  return d;
};
const nested = mine.filter((s) => depthAt(s.bodyStart) !== LEVEL);
const topLevel = mine.filter((s) => depthAt(s.bodyStart) === LEVEL);
if (nested.length) {
  console.log(`  ℹ️ ${nested.length} 个是**嵌套函数**，随父函数一起搬、不单独导出：${nested.map((s) => s.name).join(', ')}`);
}
if (!topLevel.length) { console.error(`❌ 簇里没有${SCOPE_LABEL}顶层函数可导出`); process.exit(1); }
const allLines = src.split('\n');

// 每个顶层函数**各自一个区间**（非连续）。
//
// main 里现在是"函数 与 状态声明严格交错"（几乎每个函数后面都跟着一句 let/const）。
// 按"一个连续大区间"切会把这些语句一起卷走 —— 那是语义改变：可写状态会被劈成两份
// （模块里一份、main 里一份），症状是"改了没生效"。守卫也确实会拦。
// 所以逐个函数取区间，中间的东西留在 main，需要的话按普通依赖注入。
//
// 附带好处：区间内的函数一定是我们列出的，**不再可能"顺带搬走未列出的函数"**
// （旧模型有那个隐患：区间里的函数会被一起搬走，但不在导出清单里 → main 调用找不到）。
const ranges = topLevel.map((fn) => {
  let startLine = lineOf(fn.bodyStart) - 1;
  while (startLine > 0 && /^\s*(\/\/.*)?$/.test(allLines[startLine - 1])) startLine -= 1;
  const start = allLines.slice(0, startLine).join('\n').length + (startLine > 0 ? 1 : 0);
  let end = fn.bodyEnd + 1;
  // 箭头常量是**语句**：`const X = ... => {...};` —— 区间必须把结尾的分号一起带走，
  // 否则拼出来的模块里会变成 `}function nextOne() {`（实测直接 SyntaxError）。
  // 函数声明没有分号，不吃这一步。
  if (fn.kind === 'const' && src[end] === ';') end += 1;
  while (src[end] === ' ' || src[end] === '\r') end += 1;
  if (src[end] === '\n') end += 1;
  return { start, end, name: fn.name };
}).sort((x, y) => x.start - y.start);

const from = ranges[0].start;
const to = ranges[ranges.length - 1].end;
// 区间起点必须落在"声明头部"上。函数声明的头部（`function name(...)`）和函数体总在同一行起算，
// 但**箭头常量的签名可能跨行** —— 那样区间就会从语句中间开始，写出来是语法错误。
// 与其等 node --check 去发现，不如在这里当场报出来。
for (const fn of topLevel) {
  const r = ranges.find((x) => x.name === fn.name);
  const prefix = src.slice(r.start, fn.bodyStart);
  // 前缀里可以有空行（区间会连空行一起收进来）和注释行 —— 两者都要允许，
  // 否则这个检查会对合法区间误报（第一版只允许注释行，enqueueForRetry 就被误拦了）。
  if (!/^(?:[ \t]*(?:\/\/[^\n]*)?\n)*[ \t]*(?:(?:async\s+)?function|const|let)\s/.test(prefix)) {
    console.error(`❌ 区间起点没覆盖到声明头部（${fn.name}）：${JSON.stringify(prefix.slice(0, 60))}`);
    console.error('   多半是签名跨了行 —— 区间只会从 bodyStart 那一行起算。需要手工收窄这个函数。');
    process.exit(1);
  }
}
const covered = ranges.reduce((acc, r) => acc + (lineOf(r.end - 1) - lineOf(r.start) + 1), 0);
console.log(`簇 ${clusterName}：${ranges.length} 个区间（非连续），L${lineOf(from)}–L${lineOf(to)}，实际搬走 ${covered} 行，${topLevel.length} 个顶层函数`);

// ---- 依赖分析
//
// 必须**按顶层函数分别算自由变量**再取并集。
// 整簇一起算 `declaredInside` 会把「在 A 函数里是形参、在 B 函数里是自由变量」的名字
// 误判成"簇内已声明"而漏掉：实测 cfg 同时是 modeAllowed/modePreset 的形参和
// refreshMode / isSessionAllowedInCurrentMode 的自由变量 —— 漏注入后启动即
// `未处理异常: cfg is not defined`。而"逆变换逐字还原"守卫只证明没改字，抓不到这种漏。
const clusterText = ranges.map((r) => src.slice(r.start, r.end)).join('');
const bodyCode = blankCode(clusterText);
const clusterNames = new Set(topLevel.map((x) => x.name));
const externalsRaw = [...new Set(ranges.flatMap((r) => {
  const rc = blankCode(src.slice(r.start, r.end));
  const rlocals = declaredInside(rc);
  return [...countRefs(rc, collectIdentifiers(rc)).keys()].filter((n) => !rlocals.has(n));
}))]
  // 这里**不能**过滤 GLOBALS：bridge.js 顶部可能自己声明了同名名字
  // （`const crypto = require('crypto')`），而 Node 同时提供同名全局（WebCrypto 的
  // globalThis.crypto 没有 randomBytes）。全局 vs 作用域内声明，一律以**作用域**为准，
  // 所以 GLOBALS 只在后面的白名单里、对"作用域里也没有"的名字生效。
  .filter((n) => !clusterNames.has(n) && !KEYWORDS.has(n)).sort();

// main 一层声明：名字 → { line, kind }
const mainBodyOffset = mainOpen + 1;
const decls = new Map();
{
  const re = /(?:^|\n)([ \t]*)(?:async\s+)?(const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(code.slice(mainBodyOffset, mainEnd - 1)))) {
    if (m[1].length !== WANT_INDENT) continue;
    const abs = mainBodyOffset + m.index;
    if (!decls.has(m[3])) decls.set(m[3], { line: lineOf(abs + m[1].length + 1), kind: m[2] });
  }
}
// 解构声明：`const { a, b } = mod;` —— 已搬走的模块就是这么把函数取回 main 的。
// 上面的正则只认 `const NAME =`，漏掉解构会让白名单误杀这些真名字。
// **行号必须记实际位置**（不是 0）：模块提供的名字要按它所在构造点的先后判"晚不晚"，
// 记 0 会让"来自更后面构造的模块"的名字被当成早就存在 —— 于是它们被当普通依赖注入，
// 构造时就 TDZ（实测 `scheduleProactiveCheckV2` 就是这样把桥弄崩的）。
// 缩进必须与簇所在的层一致：模块级是 0，main 里是 2。不做这个过滤，模块级的簇会把
// main 内部（缩进 4/6）的解构也当成"可见名字"，注入到模块顶层就是 ReferenceError。
for (const m of code.slice(mainBodyOffset, mainEnd - 1).matchAll(/(?:^|\n)([ \t]*)(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)) {
  if (m[1].length !== WANT_INDENT) continue;
  const ln = lineOf(mainBodyOffset + m.index + (m[0][0] === '\n' ? 1 : 0) + m[1].length);
  for (const p of m[2].split(',')) {
    const t = p.trim().split(':').pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t) && !decls.has(t)) decls.set(t, { line: ln, kind: 'const' });
  }
}

// ---- 白名单过滤：只保留**确实存在于作用域里**的名字。
//
// 词法分析会从"没被正确识别的正则字面量"里漏出垃圾名（例如 `return /a\wb/` 里的 `w`），
// 这些名字在作用域里根本不存在，注进去就是启动即 ReferenceError。
// 与其把词法器修到完美（正则字面量 vs 除号是 JS 词法的老大难），不如加一道白名单：
// **模块级声明 ∪ import ∪ main 一层声明**，不在里面的直接丢掉并打印出来。
const scopeNames = new Set();
for (const n of declsDirectIn(code)) scopeNames.add(n);
// import 必须**跨行**匹配：bridge.js 的具名导入是多行的
// （`import {\n  a,\n  b\n} from '...'`），按单行抓会漏掉一大批，白名单就会误杀真名字。
for (const m of code.matchAll(/\bimport\s*\{([\s\S]*?)\}\s*from\b/g)) {
  for (const p of m[1].split(',')) {
    const t = p.trim().split(/\s+as\s+/).pop().trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t)) scopeNames.add(t);
  }
}
for (const m of code.matchAll(/^import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/gm)) scopeNames.add(m[1]);
for (const m of code.matchAll(/^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/gm)) scopeNames.add(m[1]);
for (const n of decls.keys()) scopeNames.add(n);
const dropped = externalsRaw.filter((n) => !scopeNames.has(n));
const externals = externalsRaw.filter((n) => scopeNames.has(n));
// 丢弃的要分两类报：真全局（Math/JSON/setTimeout…）是**正常**的，不该喊狼来了；
// 只有"既不在作用域、也不是全局"的名字才可疑（典型是从没被正确识别的正则/数字字面量里
// 漏出来的垃圾）。混在一起报会让人习惯性忽略警告 —— 而漏依赖正是被这么放过去的。
const droppedGlobals = dropped.filter((n) => GLOBALS.has(n));
const droppedUnknown = dropped.filter((n) => !GLOBALS.has(n));
if (droppedUnknown.length) {
  console.log(`  ⚠️ 丢弃 ${droppedUnknown.length} 个"作用域里也不存在、也不是全局"的名字（多半是从正则/数字字面量里漏出来的）：${droppedUnknown.join(', ')}`);
}
if (droppedGlobals.length) {
  console.log(`  · 按全局处理（未注入，正常）：${droppedGlobals.join(', ')}`);
}

const clusterStartLine = lineOf(from);
/** 夹在簇中间的顶层 const（纯常量），随簇一起搬走、模块转出、main 解构回来。 */
const movedConsts = [];

// ---- 守卫：簇的范围里只允许有**函数声明**和**顶层 `const`**（外加注释/空行）。
//
// 顶层 `const` 可以随簇搬走（纯常量，没有状态），模块会把它一起转出、main 里解构回来。
// 但 **`let`/`var` 不行**：那是可写状态，搬走等于把它劈成两份 —— 模块里改一份、
// main 里还是另一份，症状是"改了没生效"。这类必须留在 main，靠 get/set 访问器注入。
{
  const blankSpan = blankCode(clusterText).split('\n');
  const rawSpan = clusterText.split('\n');
  let depth = 0;
  const stray = [];
  blankSpan.forEach((l, i) => {
    const atStart = depth;
    for (const ch of l) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; }
    if (atStart !== 0 || !l.trim()) return;
    if (/^\s*(?:async\s+)?function\b/.test(l)) return;
    const c = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=/.exec(l);
    if (c) { movedConsts.push(c[1]); return; }
    stray.push({ line: clusterStartLine + i, text: rawSpan[i].trim() });
  });
  if (stray.length) {
    console.error(`❌ 簇的范围里夹着 ${stray.length} 条不能随簇搬走的语句 —— 那是 main 一层的代码：`);
    for (const s of stray.slice(0, 5)) console.error(`   L${s.line}: ${s.text.slice(0, 90)}`);
    console.error('   函数声明和顶层 const 可以搬；let/var（可写状态）和别的语句不行 ——');
    console.error('   把簇的函数列表缩小到不跨越它们，或先单独处理那几条语句。');
    process.exit(1);
  }
  console.log(`  ✅ 守卫：范围内只有函数声明与顶层 const${movedConsts.length ? `（随簇搬走 ${movedConsts.length} 个：${movedConsts.join(', ')}）` : ''}`);
}

const plain = [];
const accessor = [];   // { name, mutable }
for (const n of externals) {
  const d = decls.get(n);
  // 函数/类声明**会提升**，在簇的位置已经可用；`const`/`let`/`var` 不会 → 后声明就 TDZ。
  const hoisted = d && (d.kind === 'function' || d.kind === 'class');
  const late = d && d.line > clusterStartLine && !hoisted;
  const mutable = d && (d.kind === 'let' || d.kind === 'var');
  if (late || mutable) accessor.push({ name: n, late: !!late, mutable: !!mutable });
  else plain.push(n);
}
console.log(`  外部依赖 ${externals.length} 个：直接注入 ${plain.length}，走访问器 ${accessor.length}`);

// ---- 守卫 2：**簇里的函数不能在构造点之前被"同步求值"**
//
// 原来是 `function xxx()` 声明 → 提升，main 里随处可调；搬出去之后变成
// `const { xxx } = mod;` → 只能在这行之后用，早引用会 TDZ。
//
// 但**不能只做"文本上在前面"的判断**：延迟求值的引用是安全的，典型是
//   `otherMod = createOther({ fn: (...a) => fn(...a) })`   // 包一层，调用时才解析
// 这种写法正是为了绕开顺序问题。所以只统计「**不在任何函数体内**」的引用 ——
// 那些才是 main() 同步执行到构造点之前就会求值的。
//
// 判据用 functionSites 给出的**函数体区间**，不用手搓的花括号深度计数器：
// 后者对"没被正确识别的正则字面量"里的 `{`/`}` 会漂移，于是函数体内的引用被误判成
// main 一层（实测 `ensureWakeableV2` 里的 `saveSocialV2State()` 就这样误报过一次）。
{
  const names = new Set([...topLevel.map((x) => x.name), ...movedConsts]);
  const before = code.slice(mainOpen + 1, from);
  const fnSpans = allSites
    // 必须排除 main 自己：它的区间覆盖整个函数体，留着的话"在函数体内"永远为真，
    // 守卫 2 就形同虚设（第一版就是这么写的）。
    .filter((s) => s.name !== 'main' && s.bodyStart > mainOpen && s.bodyEnd < mainEnd)
    .map((s) => [s.bodyStart, s.bodyEnd]);
  const insideFn = (off) => fnSpans.some(([a, b]) => off > a && off < b);

  const hitsByName = new Map();
  const re = /([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(before))) {
    const w = m[1];
    if (!names.has(w)) continue;
    const i = m.index;
    if (i > 0 && /[\w$]/.test(before[i - 1])) continue;        // 更长 token 的一部分
    if (insideFn(mainOpen + 1 + i)) continue;                  // 在函数体内 → 调用时才算
    const nextCh = (before.slice(i + w.length).match(/^\s*(\S)/) || [])[1] || '';
    if (nextCh === ':') continue;                              // 对象键不是引用
    const lineStart = before.lastIndexOf('\n', i) + 1;
    if (before.slice(lineStart, i).includes('=>')) continue;   // 简写箭头体，延迟求值
    if (!hitsByName.has(w)) hitsByName.set(w, []);
    hitsByName.get(w).push(lineOf(mainOpen + 1 + i));
  }

  const bad = [...hitsByName.entries()].map(([n, ls]) => `${n}（L${ls.join(', L')}）`);
  if (bad.length) {
    console.error(`❌ 这些名字在构造点之前就被**同步求值**了，搬出去会 TDZ：${bad.join('、')}`);
    console.error('   处理办法：把构造点提前；或者在早于构造点的那个构造处包一层 thunk');
    console.error('   （`name: (...a) => name(...a)`），把查表推迟到调用时。');
    process.exit(1);
  }
  console.log('  ✅ 守卫 2：没有在构造点之前被同步求值的引用');
}

for (const a of accessor) console.log(`    访问器 ${a.name.padEnd(24)} ${a.late ? '簇之后声明 ' : ''}${a.mutable ? '可写' : ''}`);

// ---- 改写成 ctx.X（记录每一处替换，供逆变换验证）
let moduleBody = clusterText;
const rewrites = [];   // { start, end, before, after }
for (const a of accessor.map((x) => x.name)) {
  const sites = refSites(blankCode(moduleBody), a).sort((x, y) => y.start - x.start);
  for (const s of sites) {
    const before = moduleBody.slice(s.start, s.end);
    const after = s.shorthand ? `${a}: ctx.${a}` : `ctx.${a}`;
    rewrites.push({ start: s.start, end: s.end, before, after });
    moduleBody = moduleBody.slice(0, s.start) + after + moduleBody.slice(s.end);
  }
}
console.log(`  改写 ${rewrites.length} 处（裸名字 → ctx.X）`);

// ---- 逆变换验证：反着替换回去，必须与原文逐字节相同
//
// 必须按**应用的相反顺序**撤销，不能按偏移排序：每个名字的偏移只对它被改写那一刻的
// 文本有效（我们是逐个名字重新 refSites 的，"一"的偏移在"二"改写后就不成立了）。
// 逆序撤销时，每一步的文本正好是该次改写刚完成的状态，偏移必然对得上。
{
  let back = moduleBody;
  for (const r of rewrites.slice().reverse()) {
    const start = r.start;
    const end = start + r.after.length;
    if (back.slice(start, end) !== r.after) {
      console.error(`❌ 逆变换失败：偏移 ${start} 处期望「${r.after}」，实得「${back.slice(start, end)}」`);
      process.exit(1);
    }
    back = back.slice(0, start) + r.before + back.slice(end);
  }
  if (back !== clusterText) {
    console.error('❌ 逆变换后与原始簇文本不一致 —— 说明改写不止 ctx.X 这一种，拒绝写盘');
    for (let i = 0; i < Math.max(back.length, clusterText.length); i++) {
      if (back[i] !== clusterText[i]) {
        console.error(`   首处差异 @${i}: 还原「${back.slice(Math.max(0, i - 40), i + 40)}」 原文「${clusterText.slice(Math.max(0, i - 40), i + 40)}」`);
        break;
      }
    }
    process.exit(1);
  }
  if (codeOnly(moduleBody).length === 0) { console.error('❌ 模块正文为空'); process.exit(1); }
  console.log('  ✅ 逆变换逐字还原原文（除 ctx.X 改写外一个字符未动）');
}

// ---- 生成模块
const MOD = path.join(ROOT, C.module);
fs.mkdirSync(path.dirname(MOD), { recursive: true });
const importPath = './' + path.relative(path.dirname(BRIDGE), MOD).replace(/\\/g, '/');
const moduleSrc = `// ${C.title}域：从 bridge.js 的${SCOPE_LABEL}整体搬出来的${mine.length === 1 ? '单个函数' : `一个"簇"（${mine.length} 个互相调用的函数）`}。
//
// 搬出来的理由：bridge.js 是个巨型文件（main() 曾占 86%），想读这一段得跨过整个文件。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且**在构造点之前**声明的名字走解构；
//   · **可写的**和**在构造点之后才声明的**名字走 \`ctx.X\` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）；
//   · 被更早的构造点引用的名字，在那个更早的构造处要包 thunk（\`name: (...a) => name(...a)\`）。
//
// 正文与搬迁前**逐字相同**，只有上述 ${rewrites.length} 处裸名字被改写成 \`ctx.X\`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
export function ${C.factory}(ctx) {
  const {
${plain.map((n) => '    ' + n + ',').join('\n')}
  } = ctx;

${moduleBody}

  return { ${[...new Set([...topLevel.map((x) => x.name), ...movedConsts])].join(', ')} };
}
`;

// ---- 改写 bridge.js
// 构造块的缩进跟着簇所在层走：模块级是 0，main 里是 2。
// 注意要容忍 `async function`（只匹配 `function` 会漏），漏了就错误地退回两空格缩进。
const indent = src.slice(from, to).match(/\n([ \t]*)(?:async\s+)?function/)?.[1] ?? (SCOPE === 'module' ? '' : '  ');
const accessorLines = accessor.flatMap((a) => {
  const get = `${indent}  get ${a.name}() { return ${a.name}; },`;
  return a.mutable ? [get, `${indent}  set ${a.name}(v) { ${a.name} = v; },`] : [get];
});
const construct = [
  `${indent}const ${C.binding} = ${C.factory}({`,
  ...plain.map((n) => `${indent}  ${n},`),
  ...accessorLines,
  `${indent}});`,
  `${indent}const {`,
  ...[...new Set([...topLevel.map((x) => x.name), ...movedConsts])].map((n) => `${indent}  ${n},`),
  `${indent}} = ${C.binding};`
].join('\n');

let out = src;
for (const r of ranges.slice().sort((x, y) => y.start - x.start)) out = out.slice(0, r.start) + out.slice(r.end);
out = out.slice(0, ranges[0].start) + construct + '\n' + out.slice(ranges[0].start);

// 加 import
{
  const lines = out.split('\n');
  let lastImport = -1;
  lines.forEach((l, i) => { if (/^(?:import\s|\}\s*from\s)/.test(l)) lastImport = i; });
  lines.splice(lastImport + 1, 0, `import { ${C.factory} } from '${importPath}';`);
  out = lines.join('\n');
}

console.log(`\n  模块 ${C.module}：${moduleSrc.split('\n').length} 行`);
console.log(`  ${path.relative(ROOT, BRIDGE)}：${src.split('\n').length} → ${out.split('\n').length} 行`);
console.log(`  替换处：构造 ${construct.split('\n').length} 行 + 解构 1 行`);

if (DRY) {
  console.log('\n（--dry：未写入）');
} else {
  fs.writeFileSync(MOD, moduleSrc, 'utf8');
  fs.writeFileSync(BRIDGE, out, 'utf8');
  console.log(`\n✅ 已写入 ${C.module} 与 ${path.relative(ROOT, BRIDGE)}`);
}
