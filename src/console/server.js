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
import { isRoleplayRole, roleplayToolAllowed } from '../core/role-tools.js';
import { checkConsoleAuth } from '../core/console-auth.js';
import { checkAgentAccess } from '../core/agent-access.js';
import { checkSendToolAccess } from '../core/send-tool-gate.js';
import { handleConsoleHome, handleAdminConfigSecurity, handleAdminStateInspect, handleAuthorizeRead, handleAdminDestructive } from './routes/admin.js';
import { handleRoleModeRoutes } from './routes/role.js';
import { handleSlangAdminRoutes, handleSlangAiAndExpressionRoutes } from './routes/slang.js';
import { handleSocialV2ReadWrite, handleSocialV2LogsFeedback, handleSocialV2MessageDetail, handleSocialV2ActiveMembers } from './routes/socialV2.js';
import { handleSendCore, handleSendRich, handleSendCheckWait, handleSendRecordSentInternal } from './routes/send.js';
import { handleStickerImageRoutes, handleStickerCollectRoutes } from './routes/sticker.js';
import { handleForwardMedia, handleImageMessageAndLegacySend } from './routes/media.js';
import { handlePeopleMemoryRoutes } from './routes/memory.js';
import { handleQzone1 } from './routes/qzone.js';
import { handleBilibili } from './routes/bilibili.js';
import { handleBiliLook } from './routes/bili-look.js';
import { handleBiliScroll } from './routes/bili-scroll.js';

// 控制台路由链（第 4 期 4b）：**顺序即协议**——有的路由靠正则/兜底匹配吃请求，
// 位置决定谁先命中；调顺序前必须先弄清路由间的重叠。
// check-route-inventory 拿「这张表 vs routes/*.js 导出」双向对账（漏调 = 404，多调 = 死代码）。
const ROUTE_CHAIN = [
  handleConsoleHome,            // 控制台首页与静态资源
  handleRoleModeRoutes,         // 角色 / 模式 / 预设
  handleSlangAdminRoutes,       // 黑话管理面板（CRUD / 批量 / 配置）
  handleAdminConfigSecurity,    // 配置 / 安全 / 白名单 / token / 测试发送 / 后台提醒
  handleSocialV2ReadWrite,      // v2 读写主通道（state/unread/recent/mark-read/wake-config/shadow）
  handleAdminStateInspect,      // states / wake 检视
  handleSendCore,               // v2 发送三件（poke/message/burst）
  handleStickerImageRoutes,     // 表情包与图库取用
  handleSendRich,               // 语音/图片/表情发送 + reload-memory
  handleStickerCollectRoutes,   // 表情收藏与 QQ 收藏表情管理
  handleSendCheckWait,          // 发送预检与长轮询等待
  handleSocialV2LogsFeedback,   // 工具日志 / 反馈 / 我的最近
  handleSendRecordSentInternal, // 内部记账接口（恒 403，第 5 期清理）
  handleSocialV2MessageDetail,  // 单条消息详情
  handleForwardMedia,           // 合并转发取件
  handleSocialV2ActiveMembers,  // 活跃成员
  handlePeopleMemoryRoutes,     // 人物表与记忆读写
  handleQzone1,                 // QQ 空间说说（发表/删除/读/评论）
  handleBilibili,               // B 站订阅管理（控制台）
  handleBiliLook,               // 看群友分享的视频（v2 工具）
  handleBiliScroll,             // 空闲自刷 B 站（v2 工具）
  handleSlangAiAndExpressionRoutes, // 黑话 AI 提交/查询 + 表达方式
  handleAuthorizeRead,          // 只读授权预检
  handleImageMessageAndLegacySend,  // 取图与一代发送路由
  handleAdminDestructive,       // 最危险三件：session reset / workspace reset / restart
];

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
    // 发送工具闸门：判据抽到 core/send-tool-gate.js（9 条单测），这里只做取数与响应落地。
    const gateSendTool = (key, tool, label) => {
      const gate = checkSendToolAccess({
        agentToken: req.headers['x-agent-token'],
        key,
        tool,
        label,
        currentMode: deps.flags.currentMode,
        cfg,
        agentTokenOk,
        v2SessionAllowed,
        v2ToolEnabled,
        modeAllowed,
      });
      if (gate.action === 'json') {
        sendJson({ ok: false, error: gate.error }, gate.status);
        return null;
      }
      return gate.gate;
    };

    // 控制台鉴权 + CSRF：判据抽到 core/console-auth.js（有 9 条单测），这里只负责响应落地。
    // 两层语义与抽离前逐字一致：
    //   · 令牌（配了 consoleToken 才校验；/console.css 与 /console.js 例外——浏览器加载静态资源
    //     不带自定义头，而页面脚本还负责把 ?token= 引导进 localStorage，不放行就"UI 没了"）；
    //   · CSRF（写操作必须 application/json；带 Origin 时必须来自本机页面）。
    const auth = checkConsoleAuth({
      method: req.method,
      pathname: url.pathname,
      suppliedToken: url.searchParams.get('token') ?? req.headers['x-console-token'],
      consoleToken,
      headers: req.headers,
      port,
    });
    if (auth.action === 'html401') {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
      return;
    }
    if (auth.action === 'json') {
      sendJson({ ok: false, error: auth.error }, auth.status);
      return;
    }
    try {
      // try 内七道访问闸门（第 4 期 4c-1）：原来是七段并行 if，现收进单个具名函数；
      // 顺序与语义逐字未变。返回 true = 已响应（分发器 return），false = 放行给路由链。
      // 注：token 鉴权与 CSRF 两道闸门在 try **外**（历史如此）——搬进 try 会把它们的
      // 抛错语义从「连接断开」变成「500」，属行为变更，故留在原位。
      function applyAccessGates() {
        // 判据抽到 core/agent-access.js（9 条单测）：七道闸门的顺序与每条消息逐条钉死。
        // 这里只负责取数（带 token 才读角色状态，与抽离前一样省掉无谓的文件读）与响应落地。
        const hasAgent = Boolean(req.headers['x-agent-token']);
        const gate = checkAgentAccess({
          headers: req.headers,
          pathname: url.pathname,
          method: req.method,
          queryKey: url.searchParams.get('key'),
          mode: hasAgent ? readRoleState().mode : '',
          role: hasAgent ? readRoleState(String(url.searchParams.get('key') ?? '').trim())?.role : undefined,
          paused: socialV2.paused,
          socialV2EnabledOff: cfg.socialV2?.enabled === false,
          currentMode: deps.flags.currentMode,
          isChatMuted,
          isRoleplayRole,
          roleplayToolAllowed,
        });
        if (gate.action === 'json') {
          sendJson({ ok: false, error: gate.error }, gate.status);
          return true;
        }
        return false;
      }
      if (applyAccessGates()) return;
      const ctx = Object.assign(Object.create(deps), { req, res, url, sendJson, readBody, gateSendTool, deps, fs, path, http, crypto, SECURITY_HEADERS, agentTokenOk, v2SessionAllowed, v2ToolEnabled, consoleToken, setConsoleToken: (t) => { consoleToken = t; }, port, rateLimitCheck, reserveSlots, rollbackSlots, RATE_LIMIT_ERROR, hourCapFor, resetPreSleepWait, markAiSpoke, recentLimitOf, capList });
      // 路由分发（第 4 期 4b）：28 行散 if 收成具名链表的循环；顺序与语义逐字未变。
      for (const route of ROUTE_CHAIN) {
        if (await route(ctx)) return;
      }
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
