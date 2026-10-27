// 管理指令域：从 src/domains/incoming.js 的工厂里整体搬出来的 runAdminCommands。
//
// 为什么要单独成域：指令是会**持续增加**的东西（用户明确要求"留冗余，方便后续加指令"）。
// 匹配规则已经抽成纯函数（src/core/commands.js，带单测），这里放**执行**：
// 权限（仅管理员）、改状态、发回执。
//
// 接口同其它域：工厂 + ctx。正文与搬迁前**逐字相同**；因为正文里本来就用 `ctx.X` 访问
// 可写状态，所以把 `ctx` 整个递进来，正文一个字都不用改。
import path from 'node:path';
import { matchAdminCommand, isSlashCommand } from '../core/commands.js';
import { checkGroupAdminCommand, adminGroupsOf, GROUP_ADMIN_COMMANDS } from '../core/group-admin.js';
import { parseSubscribeArg, looksLikeQq, addSpeakerId, removeSpeakerId } from '../core/subscribe.js';
import { memoryFileName } from '../core/memory-files.js';
import { atomicWriteJson } from '../core/state-io.js';

// 默认角色（= 小鲸鱼本人）。退出角色扮演时切回她，而不是 role=null ——
// null 时 currentRoleHint() 返回空串，她就彻底没有人格了（2026-10-19 改）。
const DEFAULT_ROLE_NAME = '小鲸鱼';

// 「/」速查：所有人可用。加命令时记得同步这里（有 check 脚本盯着命令表，但这份文案是手写的）。
const HELP_TEXT = [
  '可用命令（直接发，不用 @ 她）：',
  '· /　看这份列表',
  '· /status　当前状态（管理员）',
  '· /reset　重置会话（管理员）',
  '· /roles　看有哪些角色（所有人）',
  '· /role <名字>　进入角色扮演（仅主人）',
  '· /role off　退出角色扮演（仅主人）',
  '· /订阅 <群号> <QQ或昵称>　订阅某人（管理员）',
  '· /取消订阅 <群号> <QQ或昵称>　取消订阅（管理员）',
  '· /订阅列表　看订阅（管理员）',
  '· /安静　本群暂时闭嘴（群管理员）',
  '· /恢复　本群恢复说话（群管理员）',
].join('\n');

export function createAdminCommandsModule(deps) {
  const {
    KNOWN_AGENT_TOKENS,
    registry,
    ROOT,
    allowed,
    cancelPendingEntry,
    cancelSocialTimers,
    clearSocialV2Timers,
    collectors,
    ctx,
    drainPromptQueue,
    fs,
    getSocialV2State,
    groupMemberNameCache,
    log,
    markReadCalledKeys,
    messageMediaStore,
    path,
    pending,
    pendingSendToolCalls,
    pendingWakeKeys,
    queued,
    queuedHintAt,
    readRoleState,
    resolveGroupMemberName,
    reverse,
    sanitizeRoleName,
    saveSocialV2State,
    saveState,
    seenForwardIds,
    sendToQQ,
    sendToolSucceededSessions,
    sessionPromises,
    slangExtractionCooldowns,
    slangSubmitTimes,
    slangWindows,
    social,
    socialV2,
    state,
    toolCallNames,
    v2TurnStartAt,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
    writeRoleState,
  } = deps;

  /**
   * 清掉一个会话的全部上下文（DSH 会话 + 材料 + 定时器）。
   * reset 和「切换角色」共用：切角色必须清场，否则她会在新角色里回应切换前的旧对话
   * （实测 2026-10-19：刚切到爱弥斯，她先回「设定收到啦！小爱这就上线」，因为上一轮还在要设定）。
   * 返回值：是否清过（会话本来就不存在时也照清材料，返回 false 只表示没有 DSH 会话）。
   */
  function wipeConversation(key) {
    const old = state.sessions[key];
    const hadSession = Boolean(old);
    if (hadSession) {
      ctx.flags.sessionEpoch++;
      delete state.sessions[key];
      reverse.delete(old);
      registry.disposeSession(old);
    }
    drainPromptQueue(key, '会话已重置');
    cancelSocialTimers(key);
    clearSocialV2Timers(key);
    const removedV2 = socialV2.conversations.get(key);
    if (removedV2?.agentToken) KNOWN_AGENT_TOKENS.delete(removedV2.agentToken);
    // 30 多个 per-key delete 收敛成一次登记处调用（第 2 期）：注册名单在 bridge.js，
    // 是旧三张手写清单的并集；以后加 per-key Map 只需在声明处 register，这里不用动。
    registry.disposeKey(key);
    saveSocialV2State();
    saveState();
    return hadSession;
  }

  // ── 角色扮演隔离区（2026-10-19 主人要求）──────────────────────────────
  // 不要忘记之前的对话，只隔离：进入扮演时把「这个会话」的上下文备份到磁盘、然后清场
  // （她以新角色从干净的开场说话，不会接着切换前的旧对话）；退出扮演时原样恢复。
  const ROLEPLAY_ISO_DIR = path.join(ROOT, 'state', 'roleplay-isolation');
  const MEMORY_DIR = path.join(ROOT, 'state', 'memory');
  const isoFileOf = (key) => path.join(ROLEPLAY_ISO_DIR, String(key).replace(/[^a-zA-Z0-9]+/g, '_') + '.json');
  const memFileOf = (key) => {
    const n = memoryFileName(key);
    return n ? path.join(MEMORY_DIR, n) : '';
  };
  const emptyMemory = (memoryVersion = 2) => ({ activeTopics: [], pendingThoughts: [], memberImpressions: {}, memoryVersion });

  /** 合并记忆：旧的 + 扮演期间的（小鲸鱼要能看到扮演时记下的事，带着 [扮演:角色] 标签）。 */
  function mergeMemory(old, cur) {
    const out = {
      activeTopics: Array.isArray(old?.activeTopics) ? [...old.activeTopics] : [],
      pendingThoughts: Array.isArray(old?.pendingThoughts) ? [...old.pendingThoughts] : [],
      memberImpressions: old?.memberImpressions && typeof old.memberImpressions === 'object' ? JSON.parse(JSON.stringify(old.memberImpressions)) : {},
      memoryVersion: old?.memoryVersion ?? cur?.memoryVersion ?? 2,
    };
    if (!cur) return out;
    const seenTopic = new Set(out.activeTopics.map((t) => String(t?.text ?? '')));
    for (const t of Array.isArray(cur.activeTopics) ? cur.activeTopics : []) {
      const k = String(t?.text ?? '');
      if (!k || seenTopic.has(k)) continue;
      seenTopic.add(k);
      out.activeTopics.push(t);
    }
    const seenThought = new Set(out.pendingThoughts.map((t) => String(t?.text ?? '')));
    for (const t of Array.isArray(cur.pendingThoughts) ? cur.pendingThoughts : []) {
      const k = String(t?.text ?? '');
      if (!k || seenThought.has(k)) continue;
      seenThought.add(k);
      out.pendingThoughts.push(t);
    }
    for (const [k, im] of Object.entries(cur.memberImpressions && typeof cur.memberImpressions === 'object' ? cur.memberImpressions : {})) {
      const prev = out.memberImpressions[k] && typeof out.memberImpressions[k] === 'object' ? out.memberImpressions[k] : { traits: [] };
      const traits = Array.isArray(prev.traits) ? [...prev.traits] : [];
      const seen = new Set(traits);
      for (const tr of Array.isArray(im?.traits) ? im.traits : []) {
        if (!tr || seen.has(tr)) continue;
        seen.add(tr);
        traits.push(tr);
      }
      out.memberImpressions[k] = {
        ...prev,
        traits,
        interactionCount: (Number(prev.interactionCount) || 0) + (Number(im?.interactionCount) || 0),
        lastSeenAt: Math.max(Number(prev.lastSeenAt) || 0, Number(im?.lastSeenAt) || 0),
        ...(im?.displayName && !prev.displayName ? { displayName: im.displayName } : {}),
      };
    }
    return out;
  }

  /** 进入扮演：备份 session + conversation，然后清场。已备份过就不覆盖（角色间切换保持第一次的备份）。 */
  function isolateConversation(key) {
    try {
      const f = isoFileOf(key);
      if (!fs.existsSync(f)) {
        const conv = socialV2.conversations.get(key) ?? null;
        const snap = {
          at: Date.now(),
          key,
          session: state.sessions[key] ?? null,
          conversation: conv ? JSON.parse(JSON.stringify(conv)) : null,
        };
        // 记忆隔离（2026-10-19 主人要求）：备份这个会话的记忆文件再清空——
        // 扮演的角色看不到小鲸鱼记得的事；扮演期间她记下的东西会带 [扮演:角色] 标签。
        const memFile = memFileOf(key);
        if (memFile && fs.existsSync(memFile)) {
          try {
            const mem = JSON.parse(fs.readFileSync(memFile, 'utf8'));
            snap.memory = mem;
            const bak = memFile.replace(/\.json$/, '.roleplay-bak.json');
            fs.copyFileSync(memFile, bak);
          } catch (e) {
            log(`角色扮演：备份记忆失败（继续）：${e?.message ?? e}`);
          }
        }
        // 先写快照、再清记忆：两步之间崩溃时快照仍在，restoreConversation 能恢复。
        // 旧顺序是「先清记忆再写快照」，崩在中间 = 记忆已空而快照不存在（审计 D-03）。
        // 两步都走 atomicWriteJson：写一半的坏文件不会被 readJsonSafe 静默当成空状态。
        atomicWriteJson(f, snap);
        if (snap.memory && memFile) {
          try {
            atomicWriteJson(memFile, emptyMemory(snap.memory.memoryVersion ?? 2));
            log(`角色扮演：已隔离 ${key} 的记忆（备份 ${memFile.replace(/\.json$/, '.roleplay-bak.json')}）`);
          } catch (e) {
            log(`角色扮演：清空记忆失败（快照已写成，继续）：${e?.message ?? e}`);
          }
        }
        log(`角色扮演：已隔离 ${key} 的上下文（session=${snap.session ?? '无'}，材料=${snap.conversation ? '有' : '无'}）`);
      }
    } catch (error) {
      log(`角色扮演：隔离 ${key} 失败（继续切换）：${error?.message ?? error}`);
    }
    wipeConversation(key);
  }

  /** 退出扮演：恢复备份的 session + conversation，并把隔离期间的聊天记录合并回去。返回是否恢复过。 */
  function restoreConversation(key) {
    try {
      const f = isoFileOf(key);
      if (!fs.existsSync(f)) return false;
      const snap = JSON.parse(fs.readFileSync(f, 'utf8'));
      const cur = socialV2.conversations.get(key) ?? null;
      const merged = snap?.conversation ? JSON.parse(JSON.stringify(snap.conversation)) : (cur ? JSON.parse(JSON.stringify(cur)) : null);
      // 主人要求：扮演期间的记录要保留。把隔离期间新产生的聊天记录并回旧材料里，
      // 按时间排序、按 messageId 去重，最多留最近 150 条（和桥的常规上限一致）。
      if (merged && Array.isArray(cur?.recentMessages) && cur.recentMessages.length) {
        const seen = new Set();
        const all = [];
        for (const m of [...(Array.isArray(merged.recentMessages) ? merged.recentMessages : []), ...cur.recentMessages]) {
          const mid = String(m?.messageId ?? '');
          const dedupeKey = mid ? `id:${mid}` : `seq:${m?.seq}:${String(m?.text ?? m?.plain ?? '').slice(0, 40)}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          all.push(m);
        }
        all.sort((a, b) => (Number(a?.time) || 0) - (Number(b?.time) || 0));
        merged.recentMessages = all.slice(-150);
        log(`角色扮演：合并 ${key} 的聊天记录（旧 ${Array.isArray(snap?.conversation?.recentMessages) ? snap.conversation.recentMessages.length : 0} 条 + 隔离期间 ${cur.recentMessages.length} 条 → ${merged.recentMessages.length} 条）`);
      }
      if (snap?.session) state.sessions[key] = snap.session;
      if (merged) {
        socialV2.conversations.set(key, merged);
        if (merged.agentToken) KNOWN_AGENT_TOKENS.add(merged.agentToken);
      }
      // 记忆：旧记忆 + 扮演期间的记忆合并写回——小鲸鱼要能看到扮演时记下的事（带 [扮演:角色] 标签）。
      const memFile = memFileOf(key);
      if (snap?.memory && memFile) {
        try {
          const curMem = fs.existsSync(memFile) ? JSON.parse(fs.readFileSync(memFile, 'utf8')) : null;
          const mergedMem = mergeMemory(snap.memory, curMem);
          atomicWriteJson(memFile, mergedMem);
          const st = socialV2.conversations.get(key);
          if (st) {
            st.activeTopics = mergedMem.activeTopics;
            st.pendingThoughts = mergedMem.pendingThoughts;
            st.memberImpressions = mergedMem.memberImpressions;
          }
          const bak = memFile.replace(/\.json$/, '.roleplay-bak.json');
          if (fs.existsSync(bak)) fs.unlinkSync(bak);
          log(`角色扮演：已合并 ${key} 的记忆（旧 ${Array.isArray(snap.memory.activeTopics) ? snap.memory.activeTopics.length : 0} 话题 + 扮演期间 ${Array.isArray(curMem?.activeTopics) ? curMem.activeTopics.length : 0} 话题）`);
        } catch (e) {
          log(`角色扮演：合并记忆失败：${e?.message ?? e}`);
        }
      }
      saveState();
      saveSocialV2State();
      fs.unlinkSync(f);
      log(`角色扮演：已解除隔离，恢复 ${key} 的上下文（session=${snap?.session ?? '无'}）`);
      return true;
    } catch (error) {
      log(`角色扮演：恢复 ${key} 失败：${error?.message ?? error}`);
      return false;
    }
  }

  // 「订阅」管理：speakerIds（订阅某人 = 他说任何话都唤醒她）───────────────
  // 用户要的用法：私聊里说「订阅 20000001 讨厌偏头痛」/「取消订阅 全部」/「订阅列表」。
  // 名字→QQ 靠**最近的群成员名缓存**反查（bridge 收到消息时会缓存 groupId:qq -> 名字），
  // 所以要求"这人最近在群里说过话"；不想等就直接给 QQ 号。
  function cacheEntriesFor(groupId) {
    const out = [];
    for (const [k, v] of groupMemberNameCache ?? []) {
      const [gid, qq] = String(k).split(':');
      if (String(gid) !== String(groupId)) continue;
      const name = String(v?.name ?? '').trim();
      if (name) out.push({ qq: String(qq), name });
    }
    return out;
  }

  /** 名字/QQ → QQ。返回 { qq } / { candidates } / {}。 */
  function resolveTarget(groupId, target) {
    const t = String(target ?? '').trim();
    if (!t) return {};
    if (looksLikeQq(t)) return { qq: t };
    const all = cacheEntriesFor(groupId);
    const exact = all.filter((e) => e.name === t);
    if (exact.length === 1) return { qq: exact[0].qq };
    const part = all.filter((e) => e.name.includes(t));
    if (part.length === 1) return { qq: part[0].qq };
    const uniq = [...new Map((exact.length ? exact : part).map((e) => [e.qq, e])).values()];
    if (uniq.length > 1) return { candidates: uniq };
    return {};
  }

  function displayName(groupId, qq) {
    for (const [k, v] of groupMemberNameCache ?? []) {
      const [gid, id] = String(k).split(':');
      if (String(gid) === String(groupId) && String(id) === String(qq)) return String(v?.name ?? qq);
    }
    return qq;
  }

  /** 只列**一个群**的订阅名单（委派管理员用：不许他知道别的群）。 */
  function fmtSubsOf(groupId) {
    const s = getSocialV2State(`group:${groupId}`);
    const ids = Array.isArray(s.wakeConfig?.triggers?.speakerIds) ? s.wakeConfig.triggers.speakerIds.map(String) : [];
    return ids.length ? ids.map((q) => `${displayName(groupId, q)}(${q})`).join('、') : '（空）';
  }

  async function handleSubscribeCommand(cfg, hit, key, plainContent) {
    const groups = (Array.isArray(cfg?.allow?.groups) ? cfg.allow.groups : []).map(String);
    if (!groups.length) { await sendToQQ(key, '白名单里没有群，订阅无处可加。'); return; }
    const listAll = () => groups.map((g) => {
      const s = getSocialV2State(`group:${g}`);
      const ids = Array.isArray(s.wakeConfig?.triggers?.speakerIds) ? s.wakeConfig.triggers.speakerIds.map(String) : [];
      return `· 群 ${g}：${ids.length ? ids.map((q) => `${displayName(g, q)}(${q})`).join('、') : '（空）'}`;
    }).join('\n');

    // ① 看名单：不解析群/人（否则 "/订阅列表" 会被当成人名去认，冒烟测时真踩过）
    if (hit.id === 'subscribe-list') {
      await sendToQQ(key, `当前订阅（这些人一说话就唤醒她）：\n${listAll()}\n\n加：/订阅 <群号> <QQ号或昵称>　删：/取消订阅 <群号> <QQ号或昵称>，或 /取消订阅 全部`);
      return;
    }

    const { groupId, target } = parseSubscribeArg(hit.arg || plainContent);
    const clearAll = /^(全部|所有|all|清空)$/i.test(target);

    // ② 清空：没带群号就清掉所有白名单群；带了就只清那个群
    if (hit.id === 'unsubscribe' && clearAll) {
      if (!groupId) {
        let cleared = 0;
        for (const g of groups) {
          const s = getSocialV2State(`group:${g}`);
          if (!s.wakeConfig?.triggers) continue;
          if ((s.wakeConfig.triggers.speakerIds ?? []).length) cleared++;
          s.wakeConfig.triggers.speakerIds = [];
        }
        if (cleared) saveSocialV2State();
        await sendToQQ(key, `已清空 ${cleared} 个群的订阅。\n${listAll()}`);
        return;
      }
      if (!groups.includes(String(groupId))) { await sendToQQ(key, `群 ${groupId} 不在白名单里。当前白名单群：${groups.join('、')}`); return; }
      const s = getSocialV2State(`group:${groupId}`);
      const had = (s.wakeConfig?.triggers?.speakerIds ?? []).length;
      if (s.wakeConfig?.triggers) s.wakeConfig.triggers.speakerIds = [];
      if (had) saveSocialV2State();
      await sendToQQ(key, had ? `已清空群 ${groupId} 的订阅。\n${listAll()}` : `群 ${groupId} 本来就没订阅谁。`);
      return;
    }

    // 1) 定群：给了群号就用它；没给就看这人在哪个群里说得上话
    let gid = String(groupId || '').trim();
    if (!gid) {
      if (!target) { await sendToQQ(key, '用法：/订阅 <群号> <QQ号或昵称>；或 /订阅列表。'); return; }
      const inGroups = groups.filter((g) => resolveTarget(g, target).qq);
      if (inGroups.length === 1) gid = inGroups[0];
      else if (inGroups.length === 0) {
        await sendToQQ(key, `没在最近的群成员里认出「${target}」。直接给 QQ 号更稳（/订阅 <群号> <QQ号>），或者等他先在群里说句话。`);
        return;
      } else {
        await sendToQQ(key, `「${target}」在多个群都出现过（${inGroups.join('、')}），请带上群号：/订阅 <群号> ${target}`);
        return;
      }
    }
    if (!groups.includes(gid)) { await sendToQQ(key, `群 ${gid} 不在白名单里，不能订阅。当前白名单群：${groups.join('、')}`); return; }

    const gkey = `group:${gid}`;
    const st = getSocialV2State(gkey);
    if (!st.wakeConfig?.triggers) { await sendToQQ(key, `群 ${gid} 的会话状态异常，没找到唤醒配置。`); return; }
    const cur = Array.isArray(st.wakeConfig.triggers.speakerIds) ? st.wakeConfig.triggers.speakerIds.map(String) : [];

    const fmtList = () => (cur.length ? cur.map((q) => `${displayName(gid, q)}(${q})`).join('、') : '（空）');

    if (hit.id === 'unsubscribe') {
      if (!target) { await sendToQQ(key, '用法：/取消订阅 <群号> <QQ号或昵称>，或 /取消订阅 全部'); return; }
      let qq = '';
      const r = resolveTarget(gid, target);
      if (r.candidates) { await sendToQQ(key, `「${target}」对上了多个人：${r.candidates.map((c) => `${c.name}(${c.qq})`).join('、')}，请直接用 QQ 号。`); return; }
      if (!r.qq) { await sendToQQ(key, `没认出「${target}」。当前订阅：${fmtList()}（也可以直接给 QQ 号）`); return; }
      qq = r.qq;
      const res = removeSpeakerId(cur, qq);
      if (!res.removed) { await sendToQQ(key, `群 ${gid} 本来就没订阅「${target}」。当前：${fmtList()}`); return; }
      st.wakeConfig.triggers.speakerIds = res.list;
      saveSocialV2State();
      await sendToQQ(key, `已取消订阅：${displayName(gid, qq)}(${qq})　群 ${gid}\n当前订阅：${res.list.length ? res.list.map((q) => `${displayName(gid, q)}(${q})`).join('、') : '（空）'}`);
      return;
    }

    // subscribe
    if (!target) { await sendToQQ(key, '用法：/订阅 <群号> <QQ号或昵称>'); return; }
    const r = resolveTarget(gid, target);
    if (r.candidates) { await sendToQQ(key, `「${target}」对上了多个人：${r.candidates.map((c) => `${c.name}(${c.qq})`).join('、')}，请直接用 QQ 号。`); return; }
    if (!r.qq) { await sendToQQ(key, `没在群 ${gid} 的最近成员里认出「${target}」。直接给 QQ 号更稳（/订阅 ${gid} <QQ号>），或者让他先在群里说句话。`); return; }
    const next = addSpeakerId(cur, r.qq);
    if (next.length === cur.length) { await sendToQQ(key, `群 ${gid} 已经订阅了 ${displayName(gid, r.qq)}(${r.qq})。当前：${fmtList()}`); return; }
    st.wakeConfig.triggers.speakerIds = next;
    saveSocialV2State();
    await sendToQQ(key, `已订阅：${displayName(gid, r.qq)}(${r.qq})　群 ${gid}\n注意：订阅 = 他**说任何话**都会唤醒她（成本开关）。当前订阅：${next.map((q) => `${displayName(gid, q)}(${q})`).join('、')}`);
  }


  // 按会话静音（/安静、/恢复）：只影响**目标会话**，别人、别的群一律不受影响。
  // owner 与「被委派的群管理员」共用这一条路径 —— 委派管理员在私聊里下 /安静 <群号> 时，
  // targetKey 是他管的那个群，ackKey 是他说话的地方（私聊），别把回执发到群里去。
  async function applyConversationMute(targetKey, muted, actor, ackKey = targetKey) {
    const stQ = getSocialV2State(targetKey);
    stQ.muted = muted === true;
    saveSocialV2State();
    log(`[admin] ${targetKey} 会话静音 = ${stQ.muted}（执行者 ${actor}）`);
    await sendToQQ(ackKey, stQ.muted ? '这个群我先安静着，需要我就点名。' : '行，我回来了。');
  }


  async function runAdminCommands(cfg, id, isOwner, key, kind, plainContent, roleState, addressed = false, speakerQq = '') {
    // ⚠️ `id` 是**会话号**（群里就是群号），**不是说话的人**。权限判定、日志、"执行者是谁"
    // 都必须用 speakerQq —— 曾经这里拿 id 当执行者，于是委派管理员在群里下指令时
    // 拿群号去查自己那份名单，永远查不到，指令 100% 被拒（私聊里恰好 id=对方QQ，所以没露馅）。
    const actorQq = String(speakerQq ?? '').trim() || (kind === 'private' ? String(id) : '');
    const actorLabel = `${isOwner ? '主人' : '委派管理员'} ${actorQq || '（未知）'}`;
    // 匹配交给纯函数（斜杠写法 + 自然语言写法都在 src/core/commands.js 的表里）。
    // 三种情况：命中了指令 → 管家；斜杠但没命中（如 /model）→ 放行给 DSH；其余 → 不接管。
    const hit = matchAdminCommand(plainContent);
    const slash = isSlashCommand(plainContent);
    // 自然语言写法在**群里必须点名**（@ / 叫名字 / 引用她自己）才算指令 ——
    // 否则"群里随口提到这句"就会触发。真实事故：有人只是在描述"她有两个指令"，
    // 那句话里含"关闭聊天功能"，她就把聊天关了（匹配层已改成整句锚定，这是第二道）。
    // 私聊不必点名（你说什么都是对她说）；斜杠写法不受限（显式指令，历史上就随处可用）。
    if (hit && !slash && kind === 'group' && !addressed) return false;
    if (!hit && !slash) return false;
    if (hit?.id === 'help') {
      // 「/」速查：放在权限检查**之前**，所有人（群友/管理员/主人）都能看。
      await sendToQQ(key, HELP_TEXT);
      return true;
    }
    if (!isOwner) {
      // 被**委派**的群管理员（用户 2026-10-03 定）：按群授权、权限低于 owner。
      // 只放行白名单里的指令；私聊必须显式带群号；危险动作（切角色/全局静默/清记忆…）一律拒绝。
      // 判据是纯函数（src/core/group-admin.js，有单测），这里只负责"跑指令 + 留日志"。
      const cmdId = String(hit?.id ?? (slash ? plainContent.slice(1).trim().split(/\s+/)[0] : '')).trim();
      const argGroupId = (() => {
        const m = /(?:^|\s)(\d{6,12})(?:\s|$)/.exec(String(hit?.arg ?? plainContent ?? ''));
        return m ? m[1] : '';
      })();
      const verdict = checkGroupAdminCommand({ cfg, key, qq: actorQq, command: cmdId, targetGroupId: argGroupId });
      if (!verdict.ok) {
        log(`[admin] 拒绝 ${actorQq || '（未知）'} 在 ${key} 执行「${cmdId || plainContent.slice(0, 20)}」：${verdict.reason}`);
        await sendToQQ(key, `管理命令仅管理员可用（${verdict.reason}）。`);
        return true;
      }
      log(`[admin] 委派管理员 ${actorQq} 在 ${key} 执行「${cmdId}」（管的是群 ${verdict.groupId}）`);
      // 白名单直接读纯函数那份常量，别再抄一遍字面量（抄一遍就会有一天两边不一致）。
      if (!GROUP_ADMIN_COMMANDS.includes(cmdId)) {
        await sendToQQ(key, `这条指令不在群管理员可用的范围里（可用：/订阅、/取消订阅、/订阅列表、/status、/安静、/恢复）。`);
        return true;
      }
      if (cmdId === 'status') {
        await sendToQQ(key, `群 ${verdict.groupId}：她照常在跑。详细状态只有主人能看。`);
        return true;
      }
      // 订阅列表：**只列他管的群**。owner 那条实现会列出全部白名单群，
      // 那等于把"她还待在哪些群"告诉他 —— 与 R-19（不许知道别的群）直接冲突。
      if (cmdId === 'subscribe-list') {
        const whitelist = (Array.isArray(cfg?.allow?.groups) ? cfg.allow.groups : []).map(String);
        const mine = (verdict.groupId ? [verdict.groupId] : adminGroupsOf(cfg, actorQq))
          .filter((g) => !whitelist.length || whitelist.includes(g));
        const body = mine.length
          ? mine.map((g) => `· 群 ${g}：${fmtSubsOf(g)}`).join('\n')
          : '你名下没有还在跑着的群。';
        await sendToQQ(key, `当前订阅（这些人一说话就唤醒她）：\n${body}\n\n加：/订阅 <群号> <QQ号或昵称>　删：/取消订阅 <群号> <QQ号或昵称>`);
        return true;
      }
      // /安静、/恢复：作用对象是**他管的那个群**（私聊里下就是那个群；在群里下就是本群）。
      // ⚠️ 必须在这里截住，不能落到下面的订阅分支——那样 /恢复 会得到一句"用法：/订阅 …"，
      // 而他刚刚关掉的群就再也没人能打开了（群主/管理员都被静音挡在外面）。
      if (cmdId === 'quiet' || cmdId === 'resume') {
        const gkey = `group:${verdict.groupId}`;
        // 回执发回**他说话的地方**（群里就发群里、私聊就发私聊），静音作用在他管的那个群。
        await applyConversationMute(gkey, cmdId === 'quiet', actorLabel, key);
        return true;
      }
      // 订阅三条复用 owner 那条实现，但**只作用于他管的那个群**
      return await handleSubscribeCommand(cfg, { id: cmdId, arg: `${verdict.groupId} ${hit?.arg ?? ''}`.trim() }, key, plainContent);
    }
    if (hit?.id === 'reset' || plainContent === '/reset' || plainContent === '/new') {
      const wiped = wipeConversation(key);
      if (wiped) await sendToQQ(key, '已重置会话，下次消息将开新上下文');
      return true;
      }
      if (hit?.id === 'status' || plainContent === '/status') {
      const rs = readRoleState();
      await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
      return true;
      }
      if (hit?.id === 'roles' || plainContent === '/roles') {
      // /roles：列 roles/ 下可扮演的角色（目录式 <名字>/core.md 和单文件 <名字>.md 都算）
      let names = [];
      try {
        const dir = path.join(ROOT, 'roles');
        const files = fs.readdirSync(dir)
          .filter((f) => f.endsWith('.md') && !['README.md', 'CHANGELOG.md'].includes(f) && !f.startsWith('_'))
          .map((f) => f.slice(0, -3));
        const dirs = fs.readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'core.md')))
          .map((d) => d.name);
        names = [...new Set([...files, ...dirs])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      } catch { names = []; }
      const curRole = readRoleState().role ?? DEFAULT_ROLE_NAME;
      await sendToQQ(key, names.length
        ? `可扮演的角色：${names.map((n) => (n === curRole ? `${n}（当前）` : n)).join('、')}\n用法：/role <角色名> 进入，/role off 退出`
        : 'roles/ 目录下还没有角色文件。');
      return true;
      }
      if (hit?.id === 'role' || plainContent === '/role' || plainContent.startsWith('/role ')) {
      // 斜杠写法从 "/role " 之后取名字；自然语言写法由匹配层用命名组 arg 取出来。
      const name = sanitizeRoleName(hit?.id === 'role' ? hit.arg : plainContent.slice(5).trim());
      // 按会话切：**群里发 = 只切这个群**（不同群可以不同人格）；私聊发 = 切私聊/全局。
      // 2026-10-27 用户要求：宠物在主群、小鲸鱼在 20000003 群。
      const isGroupCmd = String(kind ?? '') === 'group' || String(key ?? '').startsWith('group:');
      if (!name || name === 'off' || name === 'clear') {
        // 退出：群聊 /role off = 清掉这个群的单独角色；私聊 = 清全局角色。
        writeRoleState(isGroupCmd ? null : DEFAULT_ROLE_NAME, roleState.mode, isGroupCmd ? { groupKey: key } : {});
        let restoredAny = false;
        if (isGroupCmd) {
          restoredAny = restoreConversation(key);
        } else {
          for (const k of socialV2.conversations.keys()) {
            if (String(k).startsWith('private:') && restoreConversation(k)) restoredAny = true;
          }
        }
        await sendToQQ(key, restoredAny
          ? `已退出角色扮演，恢复正常人格（之前的对话已恢复）。`
          : `已退出角色扮演，恢复正常人格。`);
      } else {
        // 角色可以是目录（roles/<名字>/core.md，模块化结构）或单文件（roles/<名字>.md，旧结构）。
        const roleDir = path.join(ROOT, 'roles', name, 'core.md');
        const roleFile = fs.existsSync(roleDir) ? roleDir : path.join(ROOT, 'roles', name + '.md');
        if (!fs.existsSync(roleFile)) {
          await sendToQQ(key, `角色「${name}」不存在。角色放 qq-bridge/roles/<名字>/core.md，或单个 roles/<名字>.md。`);
        } else {
          // 当前这个会话是什么角色：群看 key，私聊看全局。
          const cur = isGroupCmd ? String(readRoleState(key)?.role ?? '') : String(roleState.role ?? '');
          const wasDefault = !cur || cur === DEFAULT_ROLE_NAME;
          writeRoleState(name, roleState.mode, isGroupCmd ? { groupKey: key } : {});
          if (isGroupCmd) {
            // 只清/隔离**这个群**，别的群不受影响。
            if (wasDefault) isolateConversation(key);
            else wipeConversation(key);
            await sendToQQ(key, `已切换本群角色：${name}（这个群已隔离，下一条就是角色本人；其他群不变）。`);
          } else {
            // 私聊：切私聊/全局；只动私聊会话。
            const scope = 'private:';
            if (wasDefault) {
              for (const k of socialV2.conversations.keys()) {
                if (String(k).startsWith(scope)) isolateConversation(k);
              }
              await sendToQQ(key, `已切换私聊角色：${name}（私聊已隔离，下一条就是角色本人）。`);
            } else {
              for (const k of socialV2.conversations.keys()) {
                if (String(k).startsWith(scope)) wipeConversation(k);
              }
              await sendToQQ(key, `已切换私聊角色：${name}。`);
            }
          }
        }
      }
      return true;
      }
      if (hit?.id === 'quiet' || hit?.id === 'resume') {
        // 按会话静音（群管理员也能用）：只影响**目标会话**，别人/别的群不受影响。
        // 带了群号就作用在那个群（私聊里下 `/安静 20000001` 就是关那个群），没带就是当前会话。
        const gidArg = String(hit.arg ?? '').trim();
        const targetKey = /^\d{6,12}$/.test(gidArg) ? `group:${gidArg}` : key;
        await applyConversationMute(targetKey, hit.id === 'quiet', actorLabel, key);
        return true;
      }
      if (hit?.id === 'silent' || plainContent === '/silent' || plainContent === '/quiet') {
      writeRoleState(roleState.role, 'silent');
      await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
      return true;
      }
      if (hit?.id === 'active' || plainContent === '/active' || plainContent === '/speak') {
      writeRoleState(roleState.role, 'active');
      await sendToQQ(key, '已退出静默模式，恢复正常回复。');
      return true;
      }
      if (hit?.id === 'subscribe' || hit?.id === 'unsubscribe' || hit?.id === 'subscribe-list') {
      await handleSubscribeCommand(cfg, hit, key, plainContent);
      return true;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    return false;
  }


  return { runAdminCommands };
}
