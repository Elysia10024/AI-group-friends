// 控制台 HTTP 服务 —— 从 bridge.js 搬出来的 3000 行。
//
// 为什么搬：这部分几乎从不改，却挡在每次读 bridge.js 的路上。搬走后 bridge.js
// 从约 8000 行降到约 5000 行，改 QQ 侧逻辑时不用再跨过它。
//
// 接口约定：bridge.js 把 main() 作用域里用到的名字打包成 deps 传进来，
// 函数正文保持原样。两类名字处理方式不同 ——
//   · 只读的 137 个：解构参数，裸名字直接用；
//   · 可写的 11 个（currentMode / slangEntries / state / pending / stickerEntries / sessionEpoch / stickerSyncedAt / closedAgentPreset / dshReady / lastForcedAgentStickerSync / lastMode）：写成 deps.X，bridge.js 侧用
//     get/set 访问器，所以读写都还是「活的」，不会读到过期副本。
//
// 这个文件由 scripts/split-console.mjs --emit 生成，改逻辑请直接改这里。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { rateLimitCheck, reserveSlots, rollbackSlots, RATE_LIMIT_ERROR, hourCapFor } from '../core/ratelimit.js';
import { resetPreSleepWait, markAiSpoke, recentLimitOf, capList } from '../core/social-state.js';
import { isChatMuted } from '../core/mute.js';
import { handleAdmin1, handleAdmin2, handleAdmin3, handleAdmin4, handleAdmin5 } from './routes/admin.js';
import { handleRole1 } from './routes/role.js';
import { handleSlang1, handleSlang2 } from './routes/slang.js';
import { handleSocialV21, handleSocialV22, handleSocialV23, handleSocialV24 } from './routes/socialV2.js';
import { handleSend1, handleSend2, handleSend3, handleSend4 } from './routes/send.js';
import { handleSticker1, handleSticker2 } from './routes/sticker.js';
import { handleMedia1, handleMedia2 } from './routes/media.js';
import { handleMemory1 } from './routes/memory.js';
import { handleQzone1 } from './routes/qzone.js';

export function startConsoleServer(deps) {
  const {
    cfg,
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
    setMood,
    getMood,
    getPeople,
    setPersonRelation,
    setPersonTag,
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
    sendWakePromptV2,
    slangResearchingIds,
    SOCIAL_V2_FILE,
    suggestQuietMsV2,
    TOOL_LOG_FILE,
    unquoteJsonString,
  } = deps;

  const port = cfg.consolePort ?? 3100;
  // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
  // 使用 let 以便控制台内手动修改令牌后热更新。
  const configuredToken = String(cfg.consoleToken ?? '').trim();
  const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
  let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
  if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
  if (!configuredToken) log(`控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
  // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
  // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
  //
  // **owner 控制面**：管理员私聊会话（private:<ownerQQ>）的 agentToken 额外算作"owner 级令牌"，
  // 可以操作**其它**会话 —— 这是"私聊里交代、她在群里执行"的前提（在那之前她只能在私聊里
  // 干着急：拿私聊令牌去打群一律 agent token 无效）。
  // 四条约束：
  //   ① 只有这一个私聊会话的令牌有这个待遇，群友会话的令牌照旧只对自己有效；
  //   ② 目标仍必须过白名单 + 当前模式准入（各路由另外查 v2SessionAllowed，这里没放松）；
  //   ③ 每次使用都留痕，但同一目标 60 秒内只记一条，免得刷屏；
  //   ④ `config.json` 的 `socialV2.ownerTokenScope: false` 可整体关掉。
  const ownerConvKey = `private:${cfg.ownerQQ}`;
  const ownerScopeEnabled = cfg.socialV2?.ownerTokenScope !== false;
  const ownerScopeLoggedAt = new Map();
  const agentTokenOk = (key, token) => {
    const canonical = canonicalV2Key(key);
    const target = canonical ?? key;
    const st = socialV2.conversations.get(target);
    if (st && st.agentToken && token === st.agentToken) return true;
    if (!ownerScopeEnabled || !token) return false;
    const ownerSt = socialV2.conversations.get(ownerConvKey);
    if (!ownerSt?.agentToken || token !== ownerSt.agentToken) return false;
    if (target !== ownerConvKey) {
      const now = Date.now();
      if ((ownerScopeLoggedAt.get(target) ?? 0) + 60_000 < now) {
        ownerScopeLoggedAt.set(target, now);
        log(`[owner-scope] 管理员私聊令牌操作 ${target}`);
      }
    }
    return true;
  };
  // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
  // 另外：静默模式（「关闭聊天功能」，只静默群聊）下**群会话一律不许再被工具碰** ——
  // 用户要求"除了管理员指令外什么都不读取"。这一句是所有 v2 路由的公共闸门，
  // 所以 POST 类（key 在 body 里、上面那道查 query 的检查看不到）也一并被拦下。
  const v2SessionAllowed = (key) => isSessionAllowedInCurrentMode(key) && !isChatMuted(readRoleState().mode, key);
  const v2ToolEnabled = (flag) => cfg.socialV2?.tools?.[flag] !== false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const SECURITY_HEADERS = {
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    const sendJson = (obj, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      res.end(JSON.stringify(obj, null, 2));
    };
    const readBody = () => new Promise((resolve, reject) => {
      const MAX_BODY_BYTES = 1_000_000;
      const chunks = [];
      let total = 0;
      let settled = false;
      let bodyTimer = null;
      const fail = (status, message) => {
        if (settled) return;
        settled = true;
        if (bodyTimer) clearTimeout(bodyTimer);
        const err = new Error(message);
        err.statusCode = status;
        reject(err);
      };
      const done = (val) => {
        if (settled) return;
        settled = true;
        if (bodyTimer) clearTimeout(bodyTimer);
        resolve(val);
      };
      // 提前按 Content-Length 拒绝超限请求体
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        fail(413, '请求体过大（超过 1MB）');
        return;
      }
      bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
      req.on('data', (c) => {
        if (settled) return;
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
        total += buf.length;
        if (total > MAX_BODY_BYTES) {
          req.pause();
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        chunks.push(buf);
      });
      req.on('end', () => {
        if (settled) return;
        const data = Buffer.concat(chunks).toString('utf8');
        if (!data.trim()) { done({}); return; }
        let parsed;
        try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail(400, '请求体必须是 JSON 对象');
          return;
        }
        done(parsed);
      });
      // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
      req.on('error', () => fail(400, '请求体读取失败'));
      req.on('aborted', () => fail(400, '请求体读取中断'));
    });
    /**
     * reserved2 发送类路由的公共闸门：send-burst / send-message / send-sticker
     * 原本各自内联了逐字相同的 11 行校验（agent token → 模式准入 → 工具开关 →
     * reserved2 门禁 → key 格式 → modeAllowed）。
     *
     * **顺序不能动**：多个条件同时不满足时，先命中的那条决定返回哪条 403 文案，
     * 而 MCP 工具的错误提示依赖这个顺序。
     * 不通过时已经 sendJson 过，返回 null，调用方 `if (!gate) return;`。
     *
     * 到此为止 —— 之后各路由还有自己的校验（send-message / send-sticker 多一句
     * `kind === 'private' && atUserId`，send-burst 没有），那些留在原地。
     *
     * send-poke 的闸门顺序不同（也不查 agentTokenOk），/api/send/* 是控制台内部通道 ——
     * 这两条各只有一份，没有重复可去，故意保持原样。
     */
    const gateSendTool = (key, tool, label) => {
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return null; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return null; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled(tool)) { sendJson({ ok: false, error: label }, 403); return null; }
      if (deps.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return null; }
      if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return null; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return null; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return null;
      }
      return { kind, id };
    };

    // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
    // **例外：控制台自己的两个静态资源**（/console.css、/console.js）。浏览器加载 `<link>`/`<script>`
    // 时不会带自定义请求头，而页面脚本本身还负责把 `?token=` 引导进 localStorage（鸡生蛋）——
    // 不放行的话，页面能打开但样式与脚本全 401，看起来就像"UI 没了"。
    // 它们不含任何机密（没有令牌、没有数据），放行无风险；所有 /api/* 仍然要令牌。
    const PUBLIC_ASSETS = new Set(['/console.css', '/console.js']);
    const suppliedToken = url.searchParams.get('token') ?? req.headers['x-console-token'];
    const isPublicAsset = req.method === 'GET' && PUBLIC_ASSETS.has(url.pathname);
    if (consoleToken && suppliedToken !== consoleToken && !isPublicAsset) {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
        res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
      } else {
        sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
      }
      return;
    }
    // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
    // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
    // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
    if (req.method !== 'GET') {
      const ctype = String(req.headers['content-type'] ?? '');
      if (!ctype.toLowerCase().includes('application/json')) {
        sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
        return;
      }
      const origin = req.headers['origin'];
      if (origin) {
        let originHost = '';
        try { originHost = new URL(String(origin)).host; } catch { /* Origin 不是合法 URL 就当没有 Origin：下面按 host 白名单校验，取不到即拒绝跨站 */ }
        if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(originHost)) {
          sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
          return;
        }
      }
    }
    try {
      // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
      if (req.headers['x-agent-token'] === '') {
        sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
        return;
      }
      // 静默模式（「关闭聊天功能」，只静默群聊）：带 agent token 的 v2 调用一律不许碰群会话 ——
      // 用户要求"除了管理员指令外什么都不读取"，这是省 token 的另一半（入站那一半在 incoming.js）。
      // 管理员指令由桥侧硬执行、不经过这些路由，所以关了之后仍能再开。
      if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/')) {
        const qKey = String(url.searchParams.get('key') ?? '');
        if (qKey && isChatMuted(readRoleState().mode, qKey)) {
          sendJson({ ok: false, error: '静默模式已开启（关闭聊天功能）：群聊不再读取' }, 403);
          return;
        }
      }
      // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
      if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
        sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
        return;
      }
      // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
      if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
        sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
        return;
      }
      // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
      if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && deps.currentMode !== 'reserved2') {
        sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
        return;
      }
      // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
      const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake'];
      if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
      if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
        sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
        return;
      }
      // 注意：拆路由时这几个名字漏了传递 —— 路由模块从 ctx 解构，而这里没给，
      // 于是 /api/socialV2/send-* /api/send/* /api/media/* 全都挂在
      // `rateLimitCheck is not a function`（发送通道整体不可用）。
      const ctx = Object.assign(Object.create(deps), { req, res, url, sendJson, readBody, gateSendTool, deps, fs, path, http, crypto, SECURITY_HEADERS, agentTokenOk, v2SessionAllowed, v2ToolEnabled, consoleToken, port, rateLimitCheck, reserveSlots, rollbackSlots, RATE_LIMIT_ERROR, hourCapFor, resetPreSleepWait, markAiSpoke, recentLimitOf, capList });
      if (await handleAdmin1(ctx)) return;
      if (await handleRole1(ctx)) return;
      if (await handleSlang1(ctx)) return;
      if (await handleAdmin2(ctx)) return;
      if (await handleSocialV21(ctx)) return;
      if (await handleAdmin3(ctx)) return;
      if (await handleSend1(ctx)) return;
      if (await handleSticker1(ctx)) return;
      if (await handleSend2(ctx)) return;
      if (await handleSticker2(ctx)) return;
      if (await handleSend3(ctx)) return;
      if (await handleSocialV22(ctx)) return;
      if (await handleSend4(ctx)) return;
      if (await handleSocialV23(ctx)) return;
      if (await handleMedia1(ctx)) return;
      if (await handleSocialV24(ctx)) return;
      if (await handleMemory1(ctx)) return;
      // QQ 空间说说：发表 / 删除 / 读列表（带 agent token）＋ 本地账本只读（面板用）
      if (await handleQzone1(ctx)) return;
      if (await handleSlang2(ctx)) return;
      if (await handleAdmin4(ctx)) return;
      if (await handleMedia2(ctx)) return;
      if (await handleAdmin5(ctx)) return;
      sendJson({ ok: false, error: 'not found' }, 404);
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      sendJson({ ok: false, error: error?.message ?? String(error) }, status);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    log(`本地控制台已启动：http://127.0.0.1:${port}`);
  });
  // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
  server.on('error', (error) => {
    log(`控制台服务错误: ${error?.message ?? error}`);
    if (error?.code === 'EADDRINUSE') {
      console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
      process.exit(2);
    }
    process.exit(1);
  });
  return server;
}
