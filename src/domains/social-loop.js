// 社交投递域（第 5 期 5c-2 修剪；文件名沿用 social-loop.js 避免 import 面动荡）。
//   一代社交主循环（tick / 四相位状态机 / 补刀试探 / 主动冒泡提示）已于 5c 全删——
//   它的入口自 2026-09「reserved」移出 VALID_MODES 起就不可达，2026-10-27 审计后分两刀清除。
//   现在只剩 v2 活投递链：deliverPrompt → processPromptQueue → deliverPromptNow，以及 flushSummaries。
//
// 历史：本域从 bridge.js 的 main() 里整体搬出（机械切割时期），曾承载 13 个互相调用的函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 3 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
export function createSocialLoopModule(ctx) {
  const {
    QUEUE_MAX,
    SENSITIVE_RE,
    api,
    auditAndSend,
    buildContextBlock,
    buildMaterialV2,
    cfg,
    currentRoleHint,
    enqueueForRetry,
    ensureSession,
    getSocialV2State,
    recordShadowAssembly,
    startFreshSession,
    log,
    mdToPlain,
    mediaHintFor,
    promptQueues,
    queued,
    resolveMediaList,
    saveSocialV2State,
    sendToQQ,
    shouldAuditKey,
    social,
    withSlangContext,
  } = ctx;






  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!ctx.flags.dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [] });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    // A1.1 上下文组装（开关：cfg.socialV2.context.assembler.enabled）：
    //   ① 投递前换**新会话** —— 否则那个 18 万 token 的长历史还在，组装就白做了；
    //   ② 把桥侧组装好的材料拼在唤醒提示前面 —— 她不背长历史、也不用自己去查资料。
    // 关掉开关立刻回到原来的长会话路径，不需要改代码（这是后路）。
    const assembling = cfg.socialV2?.context?.assembler?.enabled === true;
    try {
      if (assembling) await startFreshSession(key);
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let effectiveText = promptText;
    let materialChars = 0;
    if (assembling) {
      const material = buildMaterialV2(key);
      materialChars = material.chars;
      effectiveText = `${material.text}\n\n---\n${promptText}`;
      log(`[组装投递] ${key}：材料 ${material.chars} 字（约 ${Math.round(material.chars / 1.5)} token）+ 提示 ${promptText.length} 字，新会话（不再背长历史）`);
      // 正式路径也留一份影子：这时影子材料就是她真正拿到的东西，可当覆盖度核对的地面真值
      try { recordShadowAssembly(key, { actualPrompt: effectiveText }); } catch { /* 留档失败不影响投递 */ }
    }
    let content = [{ type: 'text', text: assembling ? effectiveText : withSlangContext(promptText) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: assembling ? effectiveText : withSlangContext(promptText) }, ...imageParts];
    }
    // 记录水位线：这次投递她能看到的未读 seq 上限。qq_mark_read 只清到这个位置，
    // 之后新到的消息保留在未读队列里（否则会被一起标记已读 → 判定"已处理" → 永久漏回）。
    try {
      if (ctx.flags.currentMode === 'reserved2') {
        const stWm = getSocialV2State(key);
        stWm.deliveredSeq = Number(stWm.lastUnreadSeq) || 0;
        // 唤醒提示里已经内联了群聊正文，她确实"看过"了——同步推进 lastFetchedSeq，
        // 否则 mark_read 守卫会把已经内联给她看过的 @ 再拦一次。
        stWm.lastFetchedSeq = Math.max(Number(stWm.lastFetchedSeq) || 0, Number(stWm.lastUnreadSeq) || 0);
        stWm.deliveredAt = Date.now();
        saveSocialV2State();
      }
    } catch { /* 水位线更新失败不能挡住这次投递本身 */ }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      // 【技术故障不进群】和回合出错那条同一个道理（见 pump.js 里 2026-09-27 那次翻车的注释）：
      // 这里是"DSH 没收下这次投递"（会话丢了 / 额度被拒 / 参数不合法），属于系统故障。
      // 原来直接 `sendToQQ(key)` —— key 是群的话，群里会冒出一行"⚠️ 消息未被接受：…"，人设当场破功。
      // 现在只发主人私聊（主人自己的私聊就是那个 key，行为不变）。
      if (!opts.silent) {
        const ownerKey = `private:${String(cfg.ownerQQ ?? '')}`;
        const dest = cfg.ownerQQ ? ownerKey : key;
        try {
          await sendToQQ(dest, `⚠️ 消息未被接受（${key}）：${safeErrText}`);
        } catch (error) {
          log(`提示未能送达管理员 (${dest})：${error?.message ?? error}`);
        }
      }
      return { ok: false, error: safeErrText };
    }
    if (accepted.result.value.command?.text && !opts.silent && ctx.flags.currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (entry.queue.length) processPromptQueue(key);
      else promptQueues.delete(key);
    }
  }








  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }


  return { deliverPromptNow, deliverPrompt, processPromptQueue, flushSummaries };
}
