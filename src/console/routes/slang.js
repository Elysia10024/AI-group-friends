// 控制台路由：slang 域（2 段，共 11 条路由）。
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
 * 覆盖 9 条路由，原 L459–L714
 */
export async function handleSlang1(ctx) {
  const {
    ROOT,
    SLANG_STATUS,
    atomicWriteJson,
    cfg,
    createSlangEntry,
    deps,
    invalidateSlangLearnerSession,
    log,
    path,
    queueSlangTask,
    readBody,
    readJsonSafe,
    req,
    runSlangExtraction,
    runSlangResearch,
    saveSlangStore,
    sendJson,
    slangEntries,
    slangExtractionCooldowns,
    slangResearchingIds,
    slangSubmitTimes,
    slangWindows,
    url,
  } = ctx;

    if (routeSlangList()) return true;
    if (await routeSlangAdd()) return true;
    if (await routeSlangClear()) return true;
    if (await routeSlangBatchDelete()) return true;
    if (await routeSlangBatchConfirm()) return true;
    if (await routeSlangBatchReject()) return true;
    const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
    if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
      const id = slangMatch[1];
      const idx = deps.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
      const body = await readBody();
      const entry = { ...slangEntries[idx] };
      if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
      if (body.content !== undefined && deps.slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
        sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
        return true;
      }
      if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
      if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
      if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
      if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
      if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
      if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
      if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; }
      entry.updatedAt = new Date().toISOString();
      deps.slangEntries[idx] = entry;
      saveSlangStore();
      log(`控制台：更新黑话「${entry.content}」`);
      sendJson({ ok: true, entry });
      return true;
    }
    if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
      const id = slangMatch[1];
      const idx = deps.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
      const body = await readBody();
      const entry = deps.slangEntries[idx];
      if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
      if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
      if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
      if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
      if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
      if (!entry.meaning) {
        sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
        return true;
      }
      entry.status = SLANG_STATUS.CONFIRMED;
      entry.updatedAt = new Date().toISOString();
      saveSlangStore();
      log(`控制台：确认黑话「${entry.content}」`);
      sendJson({ ok: true, entry });
      return true;
    }
    if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
      const id = slangMatch[1];
      const idx = deps.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
      const entry = deps.slangEntries[idx];
      entry.status = SLANG_STATUS.REJECTED;
      entry.updatedAt = new Date().toISOString();
      saveSlangStore();
      log(`控制台：拒绝黑话「${entry.content}」`);
      sendJson({ ok: true, entry });
      return true;
    }
    if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
      const id = slangMatch[1];
      const idx = deps.slangEntries.findIndex((e) => e.id === id);
      if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return true; }
      const [removed] = deps.slangEntries.splice(idx, 1);
      saveSlangStore();
      log(`控制台：删除黑话「${removed.content}」`);
      sendJson({ ok: true, removed });
      return true;
    }
    if (await routeSlangExtract()) return true;
    if (await routeSlangResearch()) return true;
    if (await routeSlangConfig()) return true;

  return false;

  function routeSlangList() {
    if (req.method === 'GET' && url.pathname === '/api/slang') {
      const status = url.searchParams.get('status') || '';
      const list = status ? deps.slangEntries.filter((e) => e.status === status) : deps.slangEntries;
      sendJson({ entries: list, config: cfg.slang });
      return true;
    }
    return false;
  }

  async function routeSlangAdd() {
    if (req.method === 'POST' && url.pathname === '/api/slang') {
      const body = await readBody();
      const content = String(body.content ?? '').trim();
      if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return true; }
      if (deps.slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return true; }
      const entry = createSlangEntry({
        content,
        meaning: String(body.meaning ?? '').trim(),
        usage: String(body.usage ?? '').trim(),
        example: String(body.example ?? '').trim(),
        risk: String(body.risk ?? '').trim(),
        sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
        status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
        source: 'manual',
        evidence: Array.isArray(body.evidence) ? body.evidence : []
      });
      deps.slangEntries.push(entry);
      saveSlangStore();
      log(`控制台：新增黑话「${content}」`);
      sendJson({ ok: true, entry });
      return true;
    }
    return false;
  }

  async function routeSlangClear() {
    if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
      const body = await readBody();
      const status = String(body.status ?? '').trim();
      if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
        sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
        return true;
      }
      let removedCount = 0;
      if (status) {
        removedCount = deps.slangEntries.filter((e) => e.status === status).length;
        deps.slangEntries = deps.slangEntries.filter((e) => e.status !== status);
      } else {
        removedCount = deps.slangEntries.length;
        deps.slangEntries = [];
        // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
        slangWindows.clear();
        slangExtractionCooldowns.clear();
        slangSubmitTimes.clear();
        slangResearchingIds.clear();
      }
      saveSlangStore();
      log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
      sendJson({ ok: true, removedCount });
      return true;
    }
    return false;
  }

  async function routeSlangBatchDelete() {
    if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      const status = String(body.status ?? '').trim();
      if (ids.length) {
        const idSet = new Set(ids);
        const before = deps.slangEntries.length;
        deps.slangEntries = deps.slangEntries.filter((e) => !idSet.has(e.id));
        const removedCount = before - deps.slangEntries.length;
        if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return true; }
        saveSlangStore();
        log(`控制台：批量删除黑话 ${removedCount} 条`);
        sendJson({ ok: true, removedCount });
        return true;
      }
      if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
        sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
        return true;
      }
      if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return true; }
      const removedCount = deps.slangEntries.filter((e) => e.status === status).length;
      deps.slangEntries = deps.slangEntries.filter((e) => e.status !== status);
      saveSlangStore();
      log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
      sendJson({ ok: true, removedCount });
      return true;
    }
    return false;
  }

  async function routeSlangExtract() {
    if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
      if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return true; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (key && slangWindows.has(key)) {
        queueSlangTask(() => runSlangExtraction(key));
        sendJson({ ok: true, key });
      } else {
        const firstKey = slangWindows.keys().next().value;
        if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return true; }
        queueSlangTask(() => runSlangExtraction(firstKey));
        sendJson({ ok: true, key: firstKey });
      }
      return true;
    }
    return false;
  }

  async function routeSlangResearch() {
    if (req.method === 'POST' && url.pathname === '/api/slang/research') {
      if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return true; }
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const candidates = ids.length
        ? deps.slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
        : deps.slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
      if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return true; }
      queueSlangTask(() => runSlangResearch(candidates));
      sendJson({ ok: true, count: candidates.length });
      return true;
    }
    return false;
  }

  async function routeSlangConfig() {
    if (req.method === 'POST' && url.pathname === '/api/slang/config') {
      const body = await readBody();
      const oldPreset = cfg.slang?.learnerPreset;
      const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
      const configFile = path.join(ROOT, 'config.json');
      const file = readJsonSafe(configFile, null, true);
      const merged = { ...(file.slang ?? {}), ...body };
      if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
      else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
      if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
      if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
      if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
      if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
      if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
      if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
      if (body.inferenceThresholds !== undefined) {
        const raw = Array.isArray(body.inferenceThresholds)
          ? body.inferenceThresholds
          : String(body.inferenceThresholds).split(/[,，\s]+/);
        merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
        if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
      }
      file.slang = merged;
      atomicWriteJson(configFile, file);
      cfg.slang = { ...cfg.slang, ...merged };
      if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
        invalidateSlangLearnerSession();
        log('黑话学习 preset 已变更，已重置学习会话');
      } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
        invalidateSlangLearnerSession();
        log('黑话学习工作区名已变更，已重置学习会话');
      }
      log('控制台：黑话系统配置已更新');
      sendJson({ ok: true, config: cfg.slang });
      return true;
    }
    return false;
  }

  async function routeSlangBatchConfirm() {
    if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return true; }
      let confirmedCount = 0;
      let skippedCount = 0;
      const skipped = [];
      for (const id of ids) {
        const idx = deps.slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
        const entry = deps.slangEntries[idx];
        if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
        if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
        entry.status = SLANG_STATUS.CONFIRMED;
        entry.updatedAt = new Date().toISOString();
        confirmedCount++;
      }
      if (confirmedCount) saveSlangStore();
      log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
      sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
      return true;
    }
    return false;
  }

  async function routeSlangBatchReject() {
    if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
      const body = await readBody();
      const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
      if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return true; }
      let rejectedCount = 0;
      for (const id of ids) {
        const idx = deps.slangEntries.findIndex((e) => e.id === id);
        if (idx < 0) continue;
        const entry = deps.slangEntries[idx];
        if (entry.status === SLANG_STATUS.REJECTED) continue;
        entry.status = SLANG_STATUS.REJECTED;
        entry.updatedAt = new Date().toISOString();
        rejectedCount++;
      }
      if (rejectedCount) saveSlangStore();
      log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
      sendJson({ ok: true, rejectedCount });
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 2 条路由，原 L2767–L2847
 */
export async function handleSlang2(ctx) {
  const {
    SLANG_STATUS,
    agentTokenOk,
    allowSlangSubmit,
    appendActivity,
    buildSlangContext,
    cfg,
    confirmedSlangListV2,
    createSlangEntry,
    deleteExpressionById,
    deps,
    listExpressions,
    log,
    mergeEvidence,
    publicSlangEntry,
    queueSlangTask,
    readBody,
    redactKnownTokensOnly,
    req,
    runExpressionExtraction,
    runSlangResearch,
    saveSlangStore,
    sendJson,
    setExpressionStatus,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

    if (routeSlangQuery()) return true;
    if (await routeSlangSubmit()) return true;
    if (await routeExpressions()) return true;

  return false;

  // ── 表达方式库（「场景 → 怎么说」）：手动触发学习 + 人工审核 ─────────────
  async function routeExpressions() {
    if (url.pathname === '/api/expressions' && req.method === 'GET') {
      const status = String(url.searchParams.get('status') ?? '').trim();
      const key = String(url.searchParams.get('key') ?? '').trim();
      const entries = listExpressions({ status, sessionKey: key });
      sendJson({ ok: true, count: entries.length, entries });
      return true;
    }
    if (url.pathname === '/api/expressions/extract' && req.method === 'POST') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '学习已关闭（slang.enabled=false）' }, 400); return true; }
      // 一次手动提取 = 一次模型调用；走黑话的任务链串行执行，不抢学习者会话。
      const result = await queueSlangTask(() => runExpressionExtraction(key));
      sendJson(result ?? { ok: false, error: '提取没有返回结果' });
      return true;
    }
    const m = url.pathname.match(/^\/api\/expressions\/([^/]+)(?:\/(confirm|reject))?$/);
    if (m) {
      const id = m[1];
      if (req.method === 'POST' && m[2] === 'confirm') {
        const entry = setExpressionStatus(id, 'confirmed');
        if (!entry) { sendJson({ ok: false, error: '表达式不存在' }, 404); return true; }
        sendJson({ ok: true, entry });
        return true;
      }
      if (req.method === 'POST' && m[2] === 'reject') {
        const entry = setExpressionStatus(id, 'rejected');
        if (!entry) { sendJson({ ok: false, error: '表达式不存在' }, 404); return true; }
        sendJson({ ok: true, entry });
        return true;
      }
      if (req.method === 'DELETE' && !m[2]) {
        if (!deleteExpressionById(id)) { sendJson({ ok: false, error: '表达式不存在' }, 404); return true; }
        sendJson({ ok: true });
        return true;
      }
    }
    return false;
  }

  async function routeSlangSubmit() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/slang/submit') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const token = String(body.token ?? '').trim();
      const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
      const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return true; }
      if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return true; }
      if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return true; }
      if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return true; }
      if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return true; }
      const existing = deps.slangEntries.find((e) => e.content === content);
      if (existing) {
        if (existing.status === SLANG_STATUS.CONFIRMED) {
          sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
          return true;
        }
        if (existing.status === SLANG_STATUS.REJECTED) {
          sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
          return true;
        }
        // candidate：累计出现次数并追加语境证据
        existing.count = (Number(existing.count) || 0) + 1;
        if (context) {
          existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
        }
        existing.updatedAt = new Date().toISOString();
        saveSlangStore();
        if (cfg.slang?.autoResearch !== false) {
          const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
          if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
            queueSlangTask(() => runSlangResearch([existing]));
          }
        }
        log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
        sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
        return true;
      }
      const entry = createSlangEntry({
        content,
        source: 'ai',
        status: SLANG_STATUS.CANDIDATE,
        evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
      });
      deps.slangEntries.push(entry);
      saveSlangStore();
      if (cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch([entry]));
      }
      log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
      appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
      sendJson({ ok: true, entry: publicSlangEntry(entry) });
      return true;
    }
    return false;
  }

  function routeSlangQuery() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/slang/query') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return true; }
      const list = confirmedSlangListV2().filter((e) => {
        if (!q) return true;
        return e.content.toLowerCase().includes(q)
          || e.meaning.toLowerCase().includes(q)
          || e.usage.toLowerCase().includes(q)
          || e.example.toLowerCase().includes(q);
      });
      sendJson({
        ok: true,
        key,
        total: list.length,
        entries: list,
        block: buildSlangContext(deps.slangEntries, cfg.slang?.injectMax ?? 8)
      });
      return true;
    }
    return false;
  }
}
