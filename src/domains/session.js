// DSH 会话建立域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（2 个互相调用的函数）。
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
// 唯一的例外：推理档位的兜底值不再写字面量。它曾经是 `|| 'max'`，而 config.json 里是 `low`、
// 守卫断言是 `max` —— 三处打架。现在从 config.js 的常量取（那是唯一来源）。
import { DEFAULT_REASONING_EFFORT } from '../config.js';

export function createSessionModule(ctx) {
  const {
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
  } = ctx;

  async function ensureVisionModel(sessionId) {
    if (visionModelAppliedSessions.has(sessionId)) return;
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-v4-flash-vision-exp');
    const effort = String(cfg.dsh?.reasoningEffort || DEFAULT_REASONING_EFFORT);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = unwrap(await api.sessions.selectModel({ sessionId, provider, model, reasoningEffort: effort }), 'session.selectModel');
        visionModelAppliedSessions.add(sessionId);
        log(`已设置会话视觉模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})`);
        return;
      } catch (error) {
        log(`设置会话视觉模型失败 ${sessionId}（第 ${attempt}/2 次）: ${error?.message ?? error}`);
        if (attempt < 2) await sleep(1000);
      }
    }
  }

  async function ensureSession(key) {
    const epoch = ctx.sessionEpoch;
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (epoch !== ctx.sessionEpoch) {
        delete state.sessions[key];
        if (reverse.get(existing) === key) reverse.delete(existing);
        try { await api.workspace.archiveSession({ sessionId: existing }); } catch { /* 归档旧会话是清理动作，失败不影响新会话建立 */ }
      } else {
        await ensureVisionModel(existing);
        return existing;
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      for (const withPreset of [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          const preset = modePreset(key, ctx.currentMode, cfg);
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        log(`归组创建失败（${lastError?.message}），回退无参创建`);
        const value = unwrap(await api.sessions.create({}), 'session.create');
        sessionId = value.sessionId;
      }
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== ctx.sessionEpoch) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); } catch { /* 同上：归档失败不影响当前这次会话建立 */ }
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      reverse.set(sessionId, key);
      saveState();
      await ensureVisionModel(sessionId);
      log(`新会话 ${key} -> ${sessionId}（模式 ${ctx.currentMode}，preset: ${modePreset(key, ctx.currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }


  /**
   * 丢掉当前会话、下一次投递会建一个**全新会话**（A1.1 上下文组装用）。
   *
   * 为什么要它：开启组装器后，她的上下文不再靠"一个越来越长的会话"累积，而是每回合由桥侧
   * 组装好材料送进去。所以每回合开始前必须换新会话，否则长历史还在，组装就白做了。
   * 旧会话**归档**（不是删），出问题还能从 DSH 的 session 文件里翻回来——这是"别让记忆消失"的一层。
   */
  async function startFreshSession(key) {
    const existing = state.sessions[key];
    if (!existing) return;
    delete state.sessions[key];
    if (reverse.get(existing) === key) reverse.delete(existing);
    saveState();
    try { await api.workspace.archiveSession({ sessionId: existing }); } catch { /* 归档失败不影响新会话建立 */ }
  }


  return { ensureVisionModel, ensureSession, startFreshSession };
}
