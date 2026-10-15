// 群管理员（**委派**的、按群授权、权限低于 owner）。
//
// 用户场景（2026-10-03）：把小鲸鱼拉进一个新群，用户自己不在那个群里，让群里的朋友当"那个群的管理员"：
// 能在**该群**和**私聊**里用管理指令，但权限低于用户本人。
//
// 三条设计边界（用户已确认）：
//   1. 授权形式 `groupAdmins: { "群号": [QQ, ...] }` —— 一个群可多个管理员，一个人也可管多个群，加群不用改代码；
//   2. 私聊里**必须显式带群号**，且只能操作他管的那些群（避免误伤别的群）；
//   3. 危险动作一律不给：切角色、全局静默、清记忆/清工作区、改设置、看别的群与 owner 私聊。
//
// 纯函数：只回答"这个人在这条指令上有没有权限"，执行与日志由调用方负责。

/**
 * 群管理员**允许**用的指令（其余一律拒绝）。
 * 说明：`quiet`/`resume`（让这个群暂时安静/恢复）是下一步要做的，**没实现之前不放进白名单**，
 * 免得对外承诺一个用不了的能力。
 */
export const GROUP_ADMIN_COMMANDS = ['subscribe', 'unsubscribe', 'subscribe-list', 'status', 'quiet', 'resume'];

/** 明确**不给**群管理员的指令（列出来是为了让拒绝信息说清原因，也方便守卫核对）。 */
export const OWNER_ONLY_COMMANDS = ['role', 'silent', 'active', 'reset', 'clear', 'memory-clear', 'quit', 'restart'];

/** 这个人在这条会话 key 上是不是"被委派的群管理员"（owner 不算，owner 由上层单独判）。 */
export function isGroupAdmin(cfg, key, qq) {
  const m = /^group:(\d+)$/.exec(String(key ?? ''));
  const id = String(qq ?? '').trim();
  if (!m || !id) return false;
  const list = cfg?.groupAdmins?.[m[1]];
  return Array.isArray(list) && list.map(String).includes(id);
}

/** 这个人在私聊里能操作的群号列表（他管的那些群）。 */
export function adminGroupsOf(cfg, qq) {
  const id = String(qq ?? '').trim();
  const out = [];
  for (const [gid, list] of Object.entries(cfg?.groupAdmins ?? {})) {
    if (Array.isArray(list) && list.map(String).includes(id)) out.push(String(gid));
  }
  return out;
}

/**
 * 委派管理员执行一条指令前的判定。
 * @param {object} p
 * @param {object} p.cfg
 * @param {string} p.key 当前会话（group:xxx 或 private:xxx）
 * @param {string} p.qq 执行者
 * @param {string} p.command 指令 id（见 GROUP_ADMIN_COMMANDS）
 * @param {string} [p.targetGroupId] 私聊里必须显式给的群号
 * @returns {{ok:boolean, reason?:string, groupId?:string}}
 */
export function checkGroupAdminCommand({ cfg, key, qq, command, targetGroupId } = {}) {
  const mine = adminGroupsOf(cfg, qq);
  if (!mine.length) return { ok: false, reason: '你不是被授权的群管理员' };
  if (OWNER_ONLY_COMMANDS.includes(String(command))) {
    return { ok: false, reason: '这条指令只有主人（owner）能用' };
  }
  if (!GROUP_ADMIN_COMMANDS.includes(String(command))) {
    return { ok: false, reason: '这条指令不在群管理员可用的范围里' };
  }
  const isPrivate = String(key).startsWith('private:');
  if (!isPrivate) {
    const m = /^group:(\d+)$/.exec(String(key));
    const gid = m ? m[1] : '';
    if (!mine.includes(gid)) return { ok: false, reason: '你只能管你自己那个群' };
    return { ok: true, groupId: gid };
  }
  // 私聊：必须显式带群号，且只能是他管的群
  const gid = String(targetGroupId ?? '').trim();
  // 例外：「订阅列表」是只读的，而且**只会列出他自己管的那些群** —— 带不带群号都漏不出别人的群，
  // 所以不带时按"我管的那些群"处理（groupId 回空串，由调用方展开成他的群列表）。
  if (!gid && String(command) === 'subscribe-list') return { ok: true, groupId: '' };
  if (!gid) return { ok: false, reason: '私聊里要带群号（例如：/订阅列表 20000001）' };
  if (!mine.includes(gid)) return { ok: false, reason: `群 ${gid} 不归你管` };
  return { ok: true, groupId: gid };
}
