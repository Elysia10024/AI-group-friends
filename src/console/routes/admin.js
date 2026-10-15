import { normalizeByDefaults } from '../../core/config-normalize.js';
import { CONFIG_DEFAULTS, CONFIG_RANGES, CONFIG_ENUMS } from '../../config.js';

// 控制台路由：admin 域（5 段，共 25 条路由）。
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

/**
 * 覆盖 1 条路由，原 L340–L349
 */
export async function handleAdmin1(ctx) {
  const {
    ROOT,
    SECURITY_HEADERS,
    fs,
    path,
    req,
    res,
    url,
  } = ctx;

    if (routeIndexHtml()) return true;
    if (routeConsoleAsset()) return true;

  return false;

  // 控制台的两个静态资源（拆文件之后才有）。**白名单制**：路径直接查表，不做任何拼接，
  // 所以不存在路径穿越；名单外的路径一律不处理，交给后面的路由。
  // 缓存头由 SECURITY_HEADERS 统一给（no-store）：这页面是拿来手工调参的，缓存住会让人以为"改了没生效"。
  function routeConsoleAsset() {
    const assets = {
      '/console.css': ['public/console.css', 'text/css; charset=utf-8'],
      '/console.js': ['public/console.js', 'text/javascript; charset=utf-8']
    };
    const hit = req.method === 'GET' && assets[url.pathname];
    if (!hit) return false;
    try {
      res.writeHead(200, { 'content-type': hit[1], ...SECURITY_HEADERS });
      res.end(fs.readFileSync(path.join(ROOT, hit[0]), 'utf8'));
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end(`资源缺失：qq-bridge/${hit[0]}`);
    }
    return true;
  }

  function routeIndexHtml() {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      try {
        res.end(withAssetFingerprint(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8')));
      } catch {
        res.end('控制台页面缺失：qq-bridge/public/console.html');
      }
      return true;
    }
    return false;
  }

  // 给外链样式/脚本加上**内容指纹**（?v=<大小>-<mtime>）：
  // 起因是一次真实事故 —— 拆文件后 /console.js 一度返回 401，浏览器把那个响应缓存住，
  // 修好之后脚本仍然不执行（页面看着正常、按钮全无反应）。加了指纹后只要文件一变 URL 就变，
  // 浏览器必然重新取；没变则继续命中缓存（no-store 之外多一层保险）。
  function withAssetFingerprint(html) {
    const stamp = (name) => {
      try {
        const st = fs.statSync(path.join(ROOT, 'public', name));
        return `${st.size}-${Math.round(st.mtimeMs)}`;
      } catch {
        return '0';
      }
    };
    return html
      .replace('/console.css"', `/console.css?v=${stamp('console.css')}"`)
      .replace('/console.js"', `/console.js?v=${stamp('console.js')}"`);
  }
}

/**
 * 覆盖 18 条路由，原 L714–L1214
 */
export async function handleAdmin2(ctx) {
  const {
    KNOWN_AGENT_TOKENS,
    ROOT,
    SENSITIVE_RE,
    SOCIAL_V2_FILE,
    STATE_DIR,
    allowed,
    appendActivity,
    atomicWriteJson,
    atomicWriteText,
    bot,
    cfg,
    clearAllPendingWakeLeases,
    clearAllSocialV2Timers,
    collectors,
    consoleToken,
    deliverPrompt,
    deps,
    drainAllPromptQueues,
    ensureSession,
    escapeCqText,
    getSocialV2State,
    log,
    markReadCalledKeys,
    modeAllowed,
    normalizeOwnerQQ,
    path,
    pendingSendToolCalls,
    pendingWakeKeys,
    readBody,
    readJsonSafe,
    readRoleState,
    redactKnownTokensOnly,
    refreshAllDefaultWakeConfigsV2,
    req,
    reverse,
    saveSocialV2State,
    scheduleProactiveCheckV2,
    seenForwardIds,
    sendJson,
    sendToolSucceededSessions,
    sessionPromises,
    setupSleepTimerV2,
    social,
    socialV2,
    // `text` 原来解构在这儿，但桥里既没有这个函数也没注入过它 —— 唯一的用处是
    // BUG-004 那行误写的 `text(safeMessage)`；那行已改成直发 safeMessage，
    // 于是这个解构成了死名字（审计脚本 scripts/console-ctx-audit.mjs 会报它）。
    toolCallNames,
    url,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
  } = ctx;

    if (routeSessionsGet()) return true;
    // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
    if (routePendingGet()) return true;
    // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
    if (routeWhitelistGet()) return true;
    if (await routeWhitelistPost()) return true;

    // ── 安全拦截通知设置 ─────────────────────────────────────────────────
    if (routeSecurityGet()) return true;
    if (await routeSecurityPost()) return true;
    // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
    if (await routeConsoleTokenPost()) return true;
    // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
    if (await routeTestSend()) return true;
    // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
    // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
    if (await routeConsoleNotifyAi()) return true;
    // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
    if (routeSocialV2ConfigGet()) return true;
    if (await routeSocialV2ConfigPost()) return true;
    if (routeSocialV2ActivityGet()) return true;
    if (await routeSocialV2ActivityPost()) return true;
    if (routeSocialV2Reset()) return true;

  return false;

  function routeSocialV2Reset() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/reset') {
      deps.sessionEpoch++;
      sessionPromises.clear();
      clearAllSocialV2Timers();
      drainAllPromptQueues('二代状态已重置');
      for (const key of [...socialV2.conversations.keys()]) {
        const sid = deps.state.sessions[key];
        if (sid) {
          delete deps.state.sessions[key];
          reverse.delete(sid);
          collectors.delete(sid);
          v2TurnStartAt.delete(sid);
          toolCallNames.delete(sid);
          pendingSendToolCalls.delete(sid);
          sendToolSucceededSessions.delete(sid);
        }
        const removedV2 = socialV2.conversations.get(key);
        if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
        socialV2.conversations.delete(key);
        seenForwardIds.delete(key);
      }
      pendingWakeKeys.clear();
      clearAllPendingWakeLeases();
      wakeConfigUpdatedKeys.clear();
      markReadCalledKeys.clear();
      wakeConfigMissCount.clear();
      socialV2.paused = false;
      try { atomicWriteJson(SOCIAL_V2_FILE, { conversations: {} }); } catch (error) { log('重置二代状态：写空状态文件失败:', error?.message ?? error); }
      log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
      sendJson({ ok: true });
      return true;
    }
    return false;
  }

  async function routeSocialV2ActivityPost() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/activity') {
      const body = await readBody();
      const paused = body.paused === true;
      socialV2.paused = paused;
      if (paused) {
        clearAllSocialV2Timers();
        log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
      } else {
        log('控制台：二代 AI 已恢复');
        for (const key of socialV2.conversations.keys()) {
        setupSleepTimerV2(key);
        scheduleProactiveCheckV2(key);
      }
      }
      saveSocialV2State();
      sendJson({ ok: true, paused: socialV2.paused });
      return true;
    }
    return false;
  }

  function routeSocialV2ActivityGet() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/activity') {
      sendJson({ ok: true, paused: socialV2.paused });
      return true;
    }
    return false;
  }

  async function routeSocialV2ConfigPost() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/config') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const current = file.socialV2 ?? {};
      // 类型规整：口径由 CONFIG_DEFAULTS 里**默认值的类型**决定（见 core/config-normalize.js）。
      // 以前这里手抄了 29 个工具名 + 各段键名（60 多个名字）来做同样的事，加一个配置键要改两处，
      // 漏一处就表现为"界面上能改，但存下去没规整"（字符串原样进 config.json）。现在这里不出现任何键名。
      // keepCurrentOnNonBool：工具开关的旧口径 —— 传了非布尔就保留当前值。别顺手改成严格布尔：
      // 一个脏值会把她所有工具关掉，而这条链路上"关掉工具"的代价远大于"多开一个"。
      const merged = normalizeByDefaults(CONFIG_DEFAULTS.socialV2, current, body, {
        prefix: 'socialV2',
        ranges: CONFIG_RANGES,
        enums: CONFIG_ENUMS,
        keepCurrentOnNonBool: ['socialV2.tools']
      });
      file.socialV2 = merged;
      atomicWriteJson(configFile, file);
      cfg.socialV2 = { ...(cfg.socialV2 ?? {}), ...merged };
      // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
      // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
      const WAKE_DEFAULT_KEYS = [
        'defaultMode', 'recommendedDefaultInfinite',
        'recommendedSleepMinMs', 'recommendedSleepMaxMs',
        'recommendedProbability', 'recommendedKeywords',
        'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
        'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
      ];
      const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
        WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
      if (wakeDefaultChanged) refreshAllDefaultWakeConfigsV2();
      log('控制台：二代仿真配置已更新');
      sendJson({ ok: true, config: cfg.socialV2 });
      return true;
    }
    return false;
  }

  function routeSocialV2ConfigGet() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {
      sendJson({ ok: true, config: cfg.socialV2 ?? {} });
      return true;
    }
    return false;
  }

  async function routeConsoleNotifyAi() {
    if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const message = String(body.message ?? '').trim();
      if (!key || !message) {
        sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
        return true;
      }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) {
        sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
        return true;
      }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0) {
        sendJson({ ok: false, error: 'id 无效' }, 400);
        return true;
      }
      if (!modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: `该会话不在当前模式（${deps.currentMode}）允许范围内` }, 403);
        return true;
      }
      if (!deps.state.sessions[key] && !allowed(kind, id, cfg)) {
        sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
        return true;
      }
      if (!deps.dshReady) {
        sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
        return true;
      }
      const isV2 = deps.currentMode === 'reserved2';
      const roleState = readRoleState();
      const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
      // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
      let tokenLine = '';
      if (isV2) {
        const stV2 = getSocialV2State(key);
        tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
      }
      const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
      let sessionId = null;
      let popSilent = null;
      try {
        sessionId = await ensureSession(key);
        const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const arr = social.silentTurns.get(sessionId) ?? [];
        social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
        popSilent = () => {
          const list = social.silentTurns.get(sessionId) ?? [];
          const next = list.filter((x) => x.id !== silentId);
          if (next.length > 0) social.silentTurns.set(sessionId, next);
          else social.silentTurns.delete(sessionId);
        };
        const result = await deliverPrompt(key, promptText, { silent: true });
        if (result.ok) {
          log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
          appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
          sendJson({ ok: true, key, sessionId });
        } else {
          popSilent();
          sendJson({ ok: false, error: result.error || '投递失败' }, 500);
        }
      } catch (error) {
        if (popSilent) popSilent();
        sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeTestSend() {
    if (req.method === 'POST' && url.pathname === '/api/test-send') {
      const body = await readBody();
      const kind = body.kind === 'private' ? 'private' : 'group';
      const id = Number(body.id);
      const message = String(body.message ?? '').trim();
      if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return true; }
      if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return true; }
      if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return true; }
      if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return true; }
      if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, deps.currentMode)) { sendJson({ ok: false, error: `当前模式（${deps.currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return true; }
      try {
        const safeMessage = escapeCqText(redactKnownTokensOnly(message));
        // 这里原本多套了一层 `text(safeMessage)`，而 `text` 在桥里既不是函数也不是注入名 ——
        // 于是「测试发送」永远返回 500 `发送失败: text is not a function`（BUG-004）。
        // CQ 转义上一行已经做过了，直接发 safeMessage。
        const result = kind === 'private'
          ? await bot.sendPrivateMessage(id, safeMessage)
          : await bot.sendGroupMessage(id, safeMessage);
        log(`控制台：测试发送 ${kind}:${id} 成功`);
        sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
      } catch (error) {
        sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeSecurityPost() {
    if (req.method === 'POST' && url.pathname === '/api/security') {
      const body = await readBody();
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const next = { ...(file.security ?? {}), ...body };
      if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
      else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
      file.security = next;
      atomicWriteJson(configFile, file);
      cfg.security = { ...(cfg.security ?? {}), ...next };
      log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
      sendJson({ ok: true, security: cfg.security });
      return true;
    }
    return false;
  }

  function routeSecurityGet() {
    if (req.method === 'GET' && url.pathname === '/api/security') {
      sendJson({ security: cfg.security ?? { interceptNotify: true } });
      return true;
    }
    return false;
  }

  async function routeWhitelistPost() {
    if (req.method === 'POST' && url.pathname === '/api/whitelist') {
      const body = await readBody();
      const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
      const configFile = path.join(ROOT, 'config.json');
      // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
      const file = readJsonSafe(configFile, null, true);
      const allow = {
        private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
        groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
      };
      const deny = {
        private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
        groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
      };
      // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
      let ownerQQ = cfg.ownerQQ ?? null;
      if (body.ownerQQ !== undefined) {
        try {
          ownerQQ = normalizeOwnerQQ(body.ownerQQ);
        } catch (error) {
          sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
          return true;
        }
      }
      file.allow = allow;
      file.deny = deny;
      file.ownerQQ = ownerQQ;
      atomicWriteJson(configFile, file);
      cfg.allow = { private: allow.private, groups: allow.groups };
      cfg.deny = { private: deny.private, groups: deny.groups };
      cfg.ownerQQ = ownerQQ;
      log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
      sendJson({ ok: true, allow, deny, ownerQQ });
      return true;
    }
    return false;
  }

  function routeWhitelistGet() {
    if (req.method === 'GET' && url.pathname === '/api/whitelist') {
      sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
      return true;
    }
    return false;
  }

  function routePendingGet() {
    if (req.method === 'GET' && url.pathname === '/api/pending') {
      const list = [];
      for (const [key, p] of deps.pending.entries()) {
        list.push({
          key,
          kind: p.kind,
          sessionId: p.sessionId,
          ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
          ...(p.kind === 'question' ? { questions: p.questions } : {})
        });
      }
      sendJson({ pending: list });
      return true;
    }
    return false;
  }

  function routeSessionsGet() {
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const list = [];
      for (const [key, sessionId] of Object.entries(deps.state.sessions)) {
        list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}` });
      }
      sendJson({ sessions: list });
      return true;
    }
    return false;
  }


  async function routeConsoleTokenPost() {
    if (req.method === 'POST' && url.pathname === '/api/console/token') {
      const body = await readBody();
      let newToken = String(body.token ?? '').trim();
      const generated = !newToken;
      if (generated) {
        newToken = crypto.randomBytes(24).toString('hex');
      }
      if (newToken.length < 16) {
        sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
        return true;
      }
      if (newToken.length > 128) {
        sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
        return true;
      }
      if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
        sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
        return true;
      }
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
      file.consoleToken = generated ? '' : newToken;
      atomicWriteJson(configFile, file);
      cfg.consoleToken = generated ? '' : newToken;
      atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
      consoleToken = newToken;
      log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
      sendJson({ ok: true, token: newToken, generated });
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 2 条路由，原 L1571–L1613
 */
export async function handleAdmin3(ctx) {
  const {
    cfg,
    deps,
    getSocialV2State,
    log,
    modeAllowed,
    readBody,
    req,
    saveSocialV2State,
    sendJson,
    sendWakePromptV2,
    socialV2,
    url,
  } = ctx;

    if (routeSocialV2States()) return true;
    if (await routeSocialV2Wake()) return true;

  return false;

  function routeSocialV2States() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/states') {
      const list = [];
      for (const [key, st] of socialV2.conversations) {
        list.push({
          key,
          wakeConfig: st.wakeConfig,
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          noActionCount: st.wakeConfig.noActionCount || 0
        });
      }
      sendJson({ ok: true, conversations: list });
      return true;
    }
    return false;
  }

  async function routeSocialV2Wake() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/wake') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const reason = String(body.reason ?? 'admin').trim() || 'admin';
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (deps.currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return true;
      }
      const st = getSocialV2State(key);
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      if (!st.bootstrapSent) st.bootstrapSent = true;
      saveSocialV2State();
      sendWakePromptV2(key, reason);
      log(`控制台：手动唤醒 ${key}（${reason}）`);
      sendJson({ ok: true, key, reason });
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 1 条路由，原 L2847–L2868
 */
export async function handleAdmin4(ctx) {
  const {
    agentTokenOk,
    cfg,
    deps,
    modeAllowed,
    readBody,
    req,
    sendJson,
    url,
  } = ctx;

    if (await routeAuthorizeRead()) return true;

  return false;

  async function routeAuthorizeRead() {
    if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? '').trim();
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      if (deps.currentMode === 'reserved2' && !agentTokenOk(key, token)) {
        sendJson({ ok: false, error: 'reserved2 模式下旧只读工具不可用，请使用带会话令牌的 v2 读工具' }, 403);
        return true;
      }
      if (token && !agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, deps.currentMode)) {
        sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
        return true;
      }
      sendJson({ ok: true, key });
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 3 条路由，原 L3015–L3128
 */
export async function handleAdmin5(ctx) {
  const {
    ACTIVITY_LOG,
    KNOWN_AGENT_TOKENS,
    api,
    cancelAllSocialTimers,
    cancelPendingEntry,
    cancelSocialTimers,
    cfg,
    clearAllSocialV2Timers,
    clearSocialV2Timers,
    collectors,
    deps,
    drainAllPromptQueues,
    drainPromptQueue,
    fs,
    log,
    markReadCalledKeys,
    messageMediaStore,
    pendingSendToolCalls,
    pendingWakeKeys,
    queued,
    queuedHintAt,
    readBody,
    releaseLock,
    req,
    reverse,
    saveSocialV2State,
    saveState,
    seenForwardIds,
    sendJson,
    sendToolSucceededSessions,
    sessionPromises,
    slangExtractionCooldowns,
    slangSubmitTimes,
    slangWindows,
    social,
    socialV2,
    toolCallNames,
    unwrap,
    url,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
  } = ctx;

    if (await routeSessionReset()) return true;
    if (await routeWorkspaceReset()) return true;
    if (routeRestart()) return true;

  return false;

  async function routeSessionReset() {
    if (req.method === 'POST' && url.pathname === '/api/session/reset') {
      const body = await readBody();
      const key = String(body.key ?? '');
      if (!key || !deps.state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return true; }
      deps.sessionEpoch++;
      const oldSessionId = deps.state.sessions[key];
      delete deps.state.sessions[key];
      reverse.delete(oldSessionId);
      collectors.delete(oldSessionId);
      sendToolSucceededSessions.delete(oldSessionId);
      pendingSendToolCalls.delete(oldSessionId);
      v2TurnStartAt.delete(oldSessionId);
      toolCallNames.delete(oldSessionId);
      const pe = deps.pending.get(key);
      if (pe) {
        clearTimeout(pe.timer);
        cancelPendingEntry(pe).catch(() => {});
      }
      deps.pending.delete(key);
      queued.delete(key);
      queuedHintAt.delete(key);
      sessionPromises.delete(key);
      drainPromptQueue(key, '会话已重置');
      social.recentMessages.delete(key);
      messageMediaStore.delete(key);
      social.pendingSummaries.delete(key);
      social.states.delete(key);
      social.silentContext.delete(key);
      social.silentTurns.delete(oldSessionId);
      social.exitingSessions.delete(oldSessionId);
      slangWindows.delete(key);
      slangExtractionCooldowns.delete(key);
      slangSubmitTimes.delete(key);
      cancelSocialTimers(key);
      clearSocialV2Timers(key);
      pendingWakeKeys.delete(key);
      wakeConfigUpdatedKeys.delete(key);
      markReadCalledKeys.delete(key);
      wakeConfigMissCount.delete(key);
      const removedV2 = socialV2.conversations.get(key);
      if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
      socialV2.conversations.delete(key);
      seenForwardIds.delete(key);
      saveSocialV2State();
      saveState();
      try { await api.workspace.archiveSession({ sessionId: oldSessionId }); } catch { /* 归档旧会话是清理动作，失败不影响当前操作 */ }
      log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已归档）`);
      sendJson({ ok: true, key, archived: oldSessionId });
      return true;
    }
    return false;
  }

  async function routeWorkspaceReset() {
    if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
      deps.sessionEpoch++;
      let archivedCount = 0;
      try {
        const ws = unwrap(await api.workspace.list({}), 'workspace.list');
        const qq = ws.items.find((w) => w.title === cfg.workspaceTitle);
        if (qq) {
          for (const sid of qq.sessionIds) {
            try { await api.workspace.archiveSession({ sessionId: sid }); archivedCount += 1; } catch { /* 逐个归档会话：单个失败就跳过，archivedCount 只统计成功的 */ }
          }
          try { await api.workspace.delete({ workspaceId: qq.workspaceId }); } catch { /* 删工作区是清理动作，失败不影响重建 */ }
        }
      } catch { /* 同上：外层删除失败也不影响后续重建 */ }
      for (const entry of deps.pending.values()) {
        clearTimeout(entry.timer);
        cancelPendingEntry(entry).catch(() => {});
      }
      deps.pending.clear();
      queued.clear();
      queuedHintAt.clear();
      sessionPromises.clear();
      drainAllPromptQueues('工作区已清空');
      social.states.clear();
      social.recentMessages.clear();
      messageMediaStore.clear();
      seenForwardIds.clear();
      social.pendingSummaries.clear();
      social.silentContext.clear();
      social.silentTurns.clear();
      social.exitingSessions.clear();
      slangWindows.clear();
      slangExtractionCooldowns.clear();
      slangSubmitTimes.clear();
      cancelAllSocialTimers();
      clearAllSocialV2Timers();
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken) KNOWN_AGENT_TOKENS.delete(st.agentToken);
      }
      socialV2.conversations.clear();
      saveSocialV2State();
      deps.state.sessions = {};
      reverse.clear();
      collectors.clear();
      sendToolSucceededSessions.clear();
      pendingSendToolCalls.clear();
      v2TurnStartAt.clear();
      toolCallNames.clear();
      saveState();
      try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch { /* 清空活动日志是维护动作，失败不影响接口返回 */ }
      log(`控制台：已清空 QQ 聊天工作区（归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
      sendJson({ ok: true, archivedCount });
      return true;
    }
    return false;
  }

  function routeRestart() {
    // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/restart') {
      sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
      setTimeout(() => {
        log('控制台：重启桥接');
        releaseLock();
        process.exit(0);
      }, 500);
      return true;
    }
    return false;
  }
}
