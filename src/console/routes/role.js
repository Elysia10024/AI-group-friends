// 控制台路由：role 域（1 段，共 7 条路由）。
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
 * 覆盖 7 条路由，原 L349–L459
 */
export async function handleRoleModeRoutes(ctx) {
  const {
    ROOT,
    STATE_DIR,
    api,
    atomicWriteJson,
    atomicWriteText,
    cfg,
    cleanupSocialForModeChange,
    clearAllSocialV2Timers,
    deps,
    drainAllPromptQueues,
    fs,
    listRoles,
  roleExists,
    log,
    path,
    readActivityTail,
    readBody,
    readJsonSafe,
    readRoleState,
    req,
    sanitizeRoleName,
    scheduleProactiveCheckV2,
    sendJson,
    setupSleepTimerV2,
    socialV2,
    unwrap,
    url,
    writeRoleState,
  } = ctx;

    if (routeStatus()) return true;
    if (await routePresets()) return true;
    if (await routeMode()) return true;
    if (await routeRoleSet()) return true;
    if (await routeRoleMode()) return true;
    if (routeRoles()) return true;
    if (await routeRolesCreate()) return true;

  return false;

  function routeStatus() {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const rs = readRoleState();
      sendJson({
        mode: deps.flags.currentMode,
        closedAgentPreset: deps.flags.closedAgentPreset,
        role: rs.role ?? null,
        roleMode: rs.mode ?? 'active',
        dshReady: deps.flags.dshReady,
        ownerQQ: cfg.ownerQQ ?? null,
        allowGroups: cfg.allow?.groups ?? [],
        allowPrivate: cfg.allow?.private ?? [],
        socialV2Paused: socialV2.paused,
        activity: readActivityTail(100)
      });
      return true;
    }
    return false;
  }

  async function routePresets() {
    if (req.method === 'GET' && url.pathname === '/api/presets') {
      let presets = [];
      try {
        const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
        presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
      } catch { /* 列不出预设就返回空列表：控制台仍可用，只是看不到可选人格 */ }
      sendJson({ presets });
      return true;
    }
    return false;
  }

  async function routeMode() {
    if (req.method === 'POST' && url.pathname === '/api/mode') {
      const body = await readBody();
      if (!['closed-agent', 'reserved2'].includes(body.mode)) {
        sendJson({ ok: false, error: 'mode 必须是 closed-agent / reserved2' }, 400);
        return true;
      }
      const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
      const next = {
        mode: body.mode,
        ...(body.closedAgentPreset ? { closedAgentPreset: String(body.closedAgentPreset) } : { closedAgentPreset: existing.closedAgentPreset ?? 'router-standard' })
      };
      atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
      if (next.closedAgentPreset) deps.flags.closedAgentPreset = next.closedAgentPreset;
      if (deps.flags.currentMode === 'reserved2' && body.mode !== 'reserved2') {
        clearAllSocialV2Timers();
        drainAllPromptQueues('模式切换，已取消排队中的投递');
        log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
      }
      deps.flags.currentMode = body.mode;
      deps.flags.lastMode = body.mode;
      if (body.mode === 'reserved2') {
        for (const key of socialV2.conversations.keys()) {
          setupSleepTimerV2(key);
          scheduleProactiveCheckV2(key);
        }
        log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
      }
      log(`控制台：模式已设置为 ${body.mode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}`);
      sendJson({ ok: true, mode: body.mode, closedAgentPreset: next.closedAgentPreset });
      return true;
    }
    return false;
  }

  async function routeRoleSet() {
    if (req.method === 'POST' && url.pathname === '/api/role') {
      const body = await readBody();
      const rs = readRoleState();
      if (body.role && typeof body.role === 'string') {
        const name = sanitizeRoleName(body.role);
        // 目录式角色（roles/<名字>/core.md）与单文件式（roles/<名字>.md）都认。
        if (!roleExists(name)) {
          sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}/core.md 或 roles/${name}.md）` }, 400);
          return true;
        }
        writeRoleState(name, rs.mode);
        log(`控制台：角色已设置为 ${name}`);
        sendJson({ ok: true, role: name });
      } else {
        writeRoleState(null, rs.mode);
        log('控制台：角色已清除');
        sendJson({ ok: true, role: null });
      }
      return true;
    }
    return false;
  }

  async function routeRoleMode() {
    if (req.method === 'POST' && url.pathname === '/api/role-mode') {
      const body = await readBody();
      const rs = readRoleState();
      const mode = body.mode === 'silent' ? 'silent' : 'active';
      writeRoleState(rs.role, mode);
      log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
      sendJson({ ok: true, roleMode: mode });
      return true;
    }
    return false;
  }

  function routeRoles() {
    // ── 人格管理 ──────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/roles') {
      const rs = readRoleState();
      sendJson({ roles: listRoles(), current: rs.role ?? null });
      return true;
    }
    return false;
  }

  async function routeRolesCreate() {
    if (req.method === 'POST' && url.pathname === '/api/roles/create') {
      const body = await readBody();
      const name = sanitizeRoleName(body.name);
      const content = String(body.content ?? '').trim();
      if (!name) { sendJson({ ok: false, error: '角色名不能为空（仅限中文/字母/数字/横线）' }, 400); return true; }
      if (!content) { sendJson({ ok: false, error: '角色内容不能为空' }, 400); return true; }
      if (name === 'README') { sendJson({ ok: false, error: '该名称被保留' }, 400); return true; }
      const roleFile = path.join(ROOT, 'roles', name + '.md');
      if (fs.existsSync(roleFile)) { sendJson({ ok: false, error: `角色「${name}」已存在` }, 400); return true; }
      fs.mkdirSync(path.join(ROOT, 'roles'), { recursive: true });
      atomicWriteText(roleFile, content + (content.endsWith('\n') ? '' : '\n'));
      log(`控制台：创建人格「${name}」`);
      sendJson({ ok: true, role: name });
      return true;
    }
    return false;
  }
}
