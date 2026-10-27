// DSH 事件泵域：从 bridge.js 的 main() 里整体搬出来的单个函数。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 3 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
import { isToolResultError, toolResultErrorText } from '../core/tool-result.js';
import { createAlertGate, alertText, recoveredText, ALERT_DEFAULT_REPEAT_MS } from '../core/alert.js';
export function createPumpModule(ctx) {
  const {
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
    preSleepWaitBlockedV2,
    recordShadowAssembly,
    registerPending,
    reverse,
    sanitizeToolArgs,
    saveSocialV2State,
    scheduleWakeV2,
    sendToQQ,
    sendToolSucceededSessions,
    settleV2ReadState,
    shouldAuditKey,
    shouldBlockSilentReply,
    sleep,
    social,
    socialState,
    toolCallNames,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
  } = ctx;


  // 故障告警闸门（用户 2026-10-03 要的）：key 失效 / 余额不足 / 网络抖动这类**连续多轮**
  // 调不通时，只私聊告诉主人，且不刷屏 —— 第一次立刻报，之后每 repeatIntervalMs 最多一次，
  // 恢复正常再报一声"已恢复"。判据与文案都在 src/core/alert.js（有单测）。
  const alertEnabled = cfg.socialV2?.alert?.enabled !== false;
  const alertRepeatMs = Number(cfg.socialV2?.alert?.repeatIntervalMs) || ALERT_DEFAULT_REPEAT_MS;
  const alertGate = createAlertGate({ repeatIntervalMs: alertRepeatMs });
  log(`[alert] 故障告警${alertEnabled ? `已启用（第一次立刻报，同一场故障每 ${Math.round(alertRepeatMs / 60000)} 分钟最多一次，恢复再报一声）` : '已关闭（cfg.socialV2.alert.enabled=false）'}`);

  // 技术性提示（回合出错 / 被中止 / 回复被拦截）只发给管理员：
  // 出错的 key 本身就是管理员私聊时直接发；否则发到 private:<ownerQQ>。
  // 目的：群里永远只看到她"像个正常人"的输出——要么说话，要么不说话，不出现系统字样。
  async function notifyOwnerQuietly(key, text) {
    const ownerKey = `private:${String(cfg.ownerQQ ?? '')}`;
    if (!cfg.ownerQQ || key === ownerKey) {
      try { await sendToQQ(key, text); } catch (error) { log(`提示发送失败 (${key})：${error?.message ?? error}`); }
      return;
    }
    try {
      await sendToQQ(ownerKey, text);
    } catch (error) {
      log(`提示未能送达管理员 (${ownerKey})：${error?.message ?? error}`);
    }
  }


  // DSH 事件流 → QQ
  async function pumpMux() {
    for (;;) {
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          const frame = envelope.payload;
          if (frame.type === 'session/event') {
            const key = reverse.get(frame.sessionId);
            if (handleLearnerSessionFrame(frame, key)) continue;
            trackTurnEvents(frame, key);
            const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
            collectors.set(frame.sessionId, collector);
            const ended = collector.push(frame.event);
            if (await handleTurnEnd(ended, frame, key)) continue;
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  type: 'client-response',
                  rpcId: envelope.rpcId,
                  result: { ok: true, value: { sessionId: frame.sessionId, answer: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } } }
                });
              } else {
                await api.respond({
                  type: 'client-response',
                  rpcId: envelope.rpcId,
                  result: { ok: true, value: { sessionId: frame.sessionId, approvalId: frame.approvalId, outcome: 'rejected' } }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, approvalId: frame.approvalId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // 【关键】清理必须放在 finally。DSH 关闭连接时，for await 会"正常结束"而不抛异常，
        // 只写在 catch 里会导致清理永远不执行 → v2TurnStartAt / promptQueues / pendingWakeKeys
        // 残留 → isConversationBusyV2 永久返回 true → 重启 DSH 后所有 @/戳一戳只被暂存、永不投递。
        // 整表清走登记处（第 2 期）：session 组 = 以 sessionId 为键的 7 个 store；
        // 4 个 conv Set 与 wipeConversation 的名单同源，不再各抄一份。
        registry.clearSessions(); // collectors / silentTurns / exitingSessions / sendToolSucceededSessions / pendingSendToolCalls / v2TurnStartAt / toolCallNames
        registry.clearStores(['pendingWakeKeys', 'wakeConfigUpdatedKeys', 'markReadCalledKeys', 'wakeConfigMissCount']);
        clearAllPendingWakeLeases();
        // promptQueues 里可能留着 running=true 的僵尸条目（正在投递时 DSH 被杀，
        // promise 永不 resolve，finally 永不执行），一并清掉。
        try { drainAllPromptQueues('DSH 事件流中断，已清空投递队列'); } catch { /* DSH 事件流断开时清空投递队列：清不动也不能影响重连 */ }
      }
      await sleep(3000);
    }
  }

  // 退场复位（第 5 期 5a）：原来 handleTurnEnd 里有 8 份逐字相同的
  // 「if (isFarewell) { const st = socialState(key); if (st.phase === 'exiting') { 三行复位 } }」，
  // 差异只有日志短语。收成一个函数：以后给退场状态加字段只改这一处。
  function exitToIdle(key, label) {
    const st = socialState(key);
    if (st.phase === 'exiting') {
      st.phase = 'idle';
      st.activeDeadlineAt = 0;
      st.activeExitAt = 0;
      log(`社交模式：${key} ${label}，回到观望`);
    }
  }

  async function handleTurnEnd(ended, frame, key) {
            if (ended) {
              // A1.0 影子组装：**放在自动标已读之前** —— 否则它读到的是"已经被清过"的状态，
              // 未读原文/未处理的 @ 就都看不见了（第一版就是放在后面，核对时表现为"缺料"）。
              // 内部全程 try/catch，失败不影响回合。
              if (key) recordShadowAssembly(key);
              // 桥侧接管"标已读"（原来她自己调 qq_mark_read，实测 1.03 次/回合 ≈ 四分之一成本）：
              // 水位线、lastActionAt、noActionCount、confirmedBy、"本回合已收尾"这些桥侧全知道。
              // 沉睡前观察窗口内只推进水位线、不确认唤醒配置（否则等于绕过观察窗口），
              // 那种情况交给下面的 remindWakeConfigIfMissing 去提醒她补一次观察。
              if (ctx.flags.currentMode === 'reserved2' && key) {
                const st = getSocialV2State(key);
                const allowSleepConfirm = !(isSleepingConfigV2(st.wakeConfig) && preSleepWaitBlockedV2(st));
                const { markedCount } = settleV2ReadState(st, { key, sleepConfirm: allowSleepConfirm });
                // 与原 mark_read 一致：这代表"本回合正常收尾"（防遗忘提醒与无行动兜底都看它）
                if (allowSleepConfirm) markReadCalledKeys.add(key);
                saveSocialV2State();
                log(`[reserved2] 回合收尾自动标已读 ${key}：${markedCount} 条${allowSleepConfirm ? '' : '（沉睡前观察窗口内，未确认唤醒配置）'}`);
              }
              applyNoActionFallback(frame, key);
              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              if (handleSummaryFedTurn(frame, key)) return true;
              remindWakeConfigIfMissing(key);
              flushPendingWakeReason(key);
              // 回合**正常跑完** = 调用链路是通的：如果之前在故障里，报一句"已恢复"（只报一次）。
              // 中止（aborted）不算成功也不算故障：那是你主动停的，不该污染计数。
              if (alertEnabled && ended.reason.kind === 'completed') {
                const recovered = alertGate.success();
                if (recovered.fire) {
                  log(`[alert] 恢复正常（刚才连续 ${recovered.count} 轮调不通）`);
                  await notifyOwnerQuietly(key, recoveredText({ count: recovered.count }));
                }
              }
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    exitToIdle(key, '空退场回合');
                  }
                  return true;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    exitToIdle(key, '退场选择静默');
                  }
                  return true;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    exitToIdle(key, '工具发送后退场完成');
                  }
                  return true;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await notifyOwnerQuietly(key, '⚠️ 她的本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    exitToIdle(key, '退场发言被拦截');
                  }
                  return true;
                }
                if (await sendSocialTimelineReply(isFarewell, key, plain)) return true;
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 【技术故障不进群】以前这里是 `sendToQQ(key)`：key 是群就发到群里，群里会冒出一行
                // "⚠️ agent 处理出错：DeepSeek API error (HTTP 400)"，人设当场破功。
                // 真实翻车（2026-09-27 21:58，DeepSeek 瞬时 400 连挂两轮）：群友看到那行字，
                // 当场「？」「卧槽」「第一次出错」。现在她只是"这轮没说话"：
                // 写日志 + 活动流 + 私聊告知管理员，群里一个字都不提。
                log(`⚠️ 回合出错 (${key})：${safeMsg}`);
                appendActivity(`⚠️ ${key} 回合出错：${safeMsg}`);
                if (!alertEnabled) {
                  await notifyOwnerQuietly(key, `⚠️ 她的回合出错（${key}）：${safeMsg}`);
                } else {
                  // 第一次立刻报；同一场故障之后每 alertRepeatMs 最多再报一次（原来是每轮一条，
                  // key 一挂就是十几条一模一样的 ⚠️，看两遍就免疫了）。
                  const gate = alertGate.failure({ reason: safeMsg, key });
                  if (gate.fire) {
                    const snap = alertGate.snapshot();
                    log(`[alert] 已私聊告警主人：连续第 ${gate.count} 轮失败${gate.repeat ? '（隔一段时间后的重复提醒）' : ''}：${snap.lastReason.slice(0, 90)}`);
                    await notifyOwnerQuietly(key, alertText({
                      count: gate.count,
                      reason: snap.lastReason,
                      keys: snap.keys,
                      repeat: gate.repeat === true,
                      repeatMs: alertRepeatMs
                    }));
                  } else {
                    log(`[alert] ${key} 连续第 ${gate.count} 轮失败，本轮不重复提醒（上次已报过）`);
                  }
                }
                if (isFarewell) {
                  exitToIdle(key, '退场发言出错');
                }
              } else if (ended.reason.kind === 'aborted') {
                log(`回合被中止 (${key})`);
                appendActivity(`${key} 回合被中止`);
                await notifyOwnerQuietly(key, `⏹️ 已停止（${key}）`);
                if (isFarewell) {
                  exitToIdle(key, '退场发言中止');
                }
              } else if (!ended.text.trim()) {
                handleCompletedWithoutText(isFarewell, key);
              }
            }
    return false;
  }

  function handleSummaryFedTurn(frame, key) {
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                return true;
              }
    return false;
  }

  function applyNoActionFallback(frame, key) {
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没正常收尾（桥侧自动标已读 / set_wake_config），
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (ctx.flags.currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                saveSocialV2State();
              }
  }

  function remindWakeConfigIfMissing(key) {
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
  }

  function flushPendingWakeReason(key) {
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，避免关键 @/提问被漏掉。
              // 但如果触发它的消息已经被 AI 在当前回合处理（unread 中已不存在该 seq），则不再补发。
              {
                const stEnd = getSocialV2State(key);
                if (Array.isArray(stEnd.pendingWakeReasons) && stEnd.pendingWakeReasons.length) {
                  const item = stEnd.pendingWakeReasons.shift();
                  if (!item || typeof item !== 'object') {
                    // 兼容旧字符串残留
                  } else {
                    const stillRelevant = Array.isArray(stEnd.unread) && stEnd.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
                    if (stillRelevant) {
                      log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
                      scheduleWakeV2(key, item.reason);
                    } else {
                      log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
                    }
                  }
                }
              }
  }

  function handleCompletedWithoutText(isFarewell, key) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  exitToIdle(key, '退场回合无文本');
                }
  }

  async function sendSocialTimelineReply(isFarewell, key, plain) {
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                // 第 5 期 5c：一代社交（isSocialEnabled 恒 false）的整块时间线发送已删；
                // 原「无条件退场复位」第 9 份副本随死代码消失，退场复位同步点只剩 exitToIdle 一处。
                if (ctx.flags.currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    return true;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
    return false;
  }

  function trackTurnEvents(frame, key) {
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              // 失败判定与错误文本抽取见 src/core/tool-result.js（有单测：真实形状在 content[0].content[0].text，
              // 旧代码读 content[0].text 浅了一层 → 33 条失败记录的 error 全是 null，等于只记了次数没记原因）。
              const resultError = isToolResultError(frame.event.data?.message);
              const errorText = resultError ? toolResultErrorText(frame.event.data?.message) : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
  }

  function handleLearnerSessionFrame(frame, key) {
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
                learnerCollectors.set(frame.sessionId, learnerCollector);
                const learnerEnded = learnerCollector.push(frame.event);
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== ctx.slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              return true;
            }
    return false;
  }


  return { pumpMux };
}
