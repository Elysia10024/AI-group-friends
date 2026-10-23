// 挂起请求与拍一拍应答域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（4 个互相调用的函数）。
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
import { isIgnoredUser } from '../core/ignore-users.js';

export function createPendingModule(ctx) {
  const {
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
    resolveGroupMemberName,
    saveSocialV2State,
    scheduleWakeV2,
    sendToQQ,
    socialV2,
    withTimeout,
  } = ctx;

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          type: 'client-response',
          rpcId: entry.rpcId,
          result: { ok: true, value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome: 'rejected' } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          type: 'client-response',
          rpcId: entry.rpcId,
          result: { ok: true, value: { sessionId: entry.sessionId, answer: { answers: [] } } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          type: 'client-response',
          rpcId: p.rpcId,
          result: { ok: true, value: { sessionId: p.sessionId, answer: { answers } } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          type: 'client-response',
          rpcId: p.rpcId,
          result: { ok: true, value: { sessionId: p.sessionId, approvalId: p.approvalId, outcome } }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, ctx.currentMode)) return;
    // 「不理某人」名单（socialV2.ignoreUsers）：名单里的人拍她也不叫醒、不进消息流。
    // 判定与群消息入站共用 src/core/ignore-users.js（一处改、两处一致）。
    if (isIgnoredUser(cfg.socialV2?.ignoreUsers, senderId)) {
      appendActivity(`${key} 忽略名单：${senderId} 的拍一拍不处理`);
      return;
    }
    if (ctx.currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch { /* 解析群成员名失败就用 QQ 号兜底 */ }
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    // 被拍的是**别人**时也把名字解析出来：不然材料里写的是「戳了戳 10000003」，
    // 她不知道那串数字是谁（既不认识也说不出是"别人"）。解析失败就用 QQ 兜底。
    let targetName = '';
    if (kind === 'group' && targetId && !targetIsSelf) {
      try {
        targetName = await resolveGroupMemberName(Number(id), targetId) || '';
      } catch { /* 用 QQ 兜底 */ }
    }
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetName,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (ctx.currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke && targetIsSelf) {
      // 只在她**自己被拍**时唤醒。原来是"群里任何拍一拍都唤醒她"——真实事故（2026-09-29）：
      // AF 戳的是丰川祥子，她被叫醒后以为在拍她，回手给了管理员一个拍一拍（"还你一下，收好"），
      // 群里当场"？"。别人互拍不叫她；她醒着时在【最近的群聊】里照样看得到（只是不因此唤醒）。
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }


  return { registerPending, cancelPendingEntry, handlePendingAnswer, handlePokeNotice };
}
