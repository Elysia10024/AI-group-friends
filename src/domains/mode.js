// 模式与准入域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（8 个互相调用的函数）。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 15 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
import { adminGroupsOf } from '../core/group-admin.js';

export function createModeModule(ctx) {
  const {
    STATE_DIR,
    VALID_MODES,
    allowed,
    api,
    log,
    memberName,
    mentionsAlias,
    cfg,
    normalizeOwnerQQ,
    path,
    readJsonSafe,
    selfAliases,
    unwrap,
  } = ctx;

  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      if (ns?.value && typeof ns.value.mode === 'string' && VALID_MODES.includes(ns.value.mode)) {
        ctx.currentMode = ns.value.mode;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        return;
      }
    } catch { /* 读 DSH 设置失败就往下走、改用本地 state/mode.json —— 这是预期的回退路径 */ }
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    if (local?.mode && VALID_MODES.includes(local.mode)) ctx.currentMode = local.mode;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      ctx.closedAgentPreset = local.closedAgentPreset;
    }
  }
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // closed-agent 仅 owner 私聊；reserved2 走白名单（一代 chat/reserved 已删除）
    if (allowed(kind, id, cfg)) return true;
    // 被**委派**的群管理员：私聊也放行 —— 用户 2026-10-03 选的是"完整私聊"：
    // 他能像朋友一样私聊她，顺带在私聊里下管理指令（指令权限仍然只有他自己那几个群，
    // 判据在 src/core/group-admin.js）。加一个 QQ 到 config.groupAdmins = 这两件事同时生效，
    // **不用**再单独改 allow.private（两处配置迟早会不一致）。
    // 从名单里删掉 = 私聊立刻回到"未授权会话"（fail-closed）。
    if (kind === 'private' && adminGroupsOf(cfg, id).length > 0) return true;
    return false;
  }
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') return ctx.closedAgentPreset || 'router-standard';
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设
    if (mode === 'reserved2') {
      // 角色扮演期间换一份不带小鲸鱼速记/关系的预设（2026-10-20：预设是常驻系统提示，
      // 材料层换了角色卡也没用——速记里的说话方式会让角色说成小鲸鱼的口吻）。
      if (typeof ctx.isRoleplaying === 'function' && ctx.isRoleplaying()) {
        return cfg.socialV2?.roleplayPreset || 'qq-roleplay';
      }
      return cfg.socialV2?.agentPreset || cfg.agentPreset || undefined;
    }
    return cfg.agentPreset || undefined;
  }
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, ctx.currentMode);
  }

  // groupIdFromKey 已抽到 src/core/identity.js（纯函数，有单测）。
  // selfAliasesFor 保留薄包装：把 selfNickname 与该群的名片缓存喂给纯函数。
  function selfAliasesFor(groupId) {
    const hit = ctx.selfAliasCache.get(String(groupId ?? ''));
    return selfAliases(ctx.selfNickname, hit?.names);
  }

  function textMentionsSelf(lowerText, groupId) {
    return mentionsAlias(lowerText, selfAliasesFor(groupId));
  }
  // 拉取并缓存机器人在某群的名片（TTL 内不重复请求）
  async function refreshSelfAliases(groupId) {
    const gid = String(groupId ?? '');
    if (!gid || !ctx.selfUserId) return;
    const hit = ctx.selfAliasCache.get(gid);
    if (hit && Date.now() - hit.ts < ctx.SELF_ALIAS_TTL_MS) return;
    const names = new Set();
    try {
      const info = await ctx.bot.getGroupMemberInfo(Number(gid), Number(ctx.selfUserId));
      const card = memberName(info);
      if (card) names.add(String(card).toLowerCase());
    } catch { /* 取群名片失败只是少一个别名，不影响主流程（只影响「被叫名字」识别的覆盖面） */ }
    // 兜底：部分网关的"单成员查询"不返回群名片（返回空 card），
    // 这时退回拉整张成员表，从里面挑出自己——实测 SnowLuma 就是这种。
    try {
      const list = await ctx.bot.getGroupMemberList(Number(gid));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const me = members.find((m) => String(m?.user_id) === String(ctx.selfUserId));
      const card = memberName(me);
      if (card) names.add(String(card).toLowerCase());
    } catch { /* 同上：从成员列表里取名片也是尽力而为 */ }
    ctx.selfAliasCache.set(gid, { names, ts: Date.now() });
    if (names.size) log(`机器人在群 ${gid} 的别名: ${[...names].join(' / ')}`);
  }

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }


  return { refreshMode, modeAllowed, modePreset, isSessionAllowedInCurrentMode, selfAliasesFor, textMentionsSelf, refreshSelfAliases, normalizeSpeakerIdsV2 };
}
