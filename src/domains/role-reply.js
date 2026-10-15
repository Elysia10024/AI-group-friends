// 角色提示与引用解析域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（8 个互相调用的函数）。
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
export function createRoleReplyModule(ctx) {
  const {
    ROOT,
    convertExampleSpacesToComma,
    currentRoleHint,
    fs,
    localReplyInfo,
    log,
    memberName,
    path,
    readRoleState,
    replyOwnershipOk,
    segmentsToText,
    senderLabel,
  } = ctx;

  function currentRoleDigest() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 新结构：roles/<角色>/速记.core.md；旧结构 roles/<角色>.速记.md 仍兼容。
      const digestNew = path.join(ROOT, 'roles', rs.role, '速记.core.md');
      const f = fs.existsSync(digestNew) ? digestNew : path.join(ROOT, 'roles', rs.role + '.速记.md');
      if (!fs.existsSync(f)) return '';
      const st = fs.statSync(f);
      if (ctx.roleDigestCache.key === String(st.mtimeMs)) return ctx.roleDigestCache.text;
      const text = fs.readFileSync(f, 'utf8').trim();
      ctx.roleDigestCache = { key: String(st.mtimeMs), text };
      return text;
    } catch {
      return '';
    }
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  // 中文排版的 4 个纯函数（isCjkLikeChar / convertExampleSpacesToComma /
  // findCjkSpaceWarning / findSplitBoundaryWarning）已抽到 src/core/text.js（有 17 条单测）。

  function currentRoleHintV2() {
    const raw = currentRoleHint();
    if (!raw) return '';
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议
    const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析 + 材料里的"你订阅了谁"共用。
  // 30 分钟：名片几乎不变，TTL 太短的话，材料里刚才是名字、过一会儿又变回 QQ 号。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 30 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await ctx.bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = memberName(info) || null;
      } catch { /* 取名失败就用 QQ 号兜底（调用处写的是 memberName(info) || null） */ }
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await ctx.bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = memberName(m) || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  /**
   * 启动预热：把允许群组的成员名片整表灌进缓存。
   * 材料里的「你订阅了…」要写名字而不是 QQ 号，而这张缓存原本只在解析 @ 时才被动填充；
   * 订阅唤醒恰恰是"没人 @ 她"的情况，所以启动时先灌一遍（失败只记日志，不影响启动）。
   * @returns {Promise<number>} 灌进去的成员数
   */
  async function prewarmGroupMemberNames(groupIds = []) {
    let total = 0;
    for (const gid of groupIds) {
      try {
        const list = await ctx.bot.getGroupMemberList(Number(gid));
        const members = Array.isArray(list) ? list : (list?.data ?? []);
        const now = Date.now();
        for (const m of members) {
          const n = memberName(m) || null;
          if (!n) continue;
          groupMemberNameCache.set(`${String(gid)}:${String(m.user_id)}`, { name: n, ts: now });
          total += 1;
        }
      } catch (error) {
        log(`预热群成员名片失败（${gid}）：${error?.message ?? error}`);
      }
    }
    pruneGroupMemberNameCache();
    return total;
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await ctx.bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。规则见 src/core/identity.js（有单测）。
      if (!replyOwnershipOk(raw, kind, convId, selfId)) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const sender = senderLabel(raw.sender, raw.sender?.user_id ?? raw.user_id);
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false,
        selfId
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 1200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || localReplyInfo(found, realId),
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || localReplyInfo(found, realId),
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }


  return { currentRoleDigest, currentRoleHintV2, pruneGroupMemberNameCache, prewarmGroupMemberNames, resolveGroupMemberName, pruneReplyInfoCache, resolveReplyInfo, resolveReplyTargetV2, isQuoteTargetSelf, groupMemberNameCache, GROUP_MEMBER_NAME_TTL_MS, replyInfoCache, REPLY_INFO_TTL_MS, REPLY_NEGATIVE_TTL_MS };
}
