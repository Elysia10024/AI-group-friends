// 角色扮演（宠物等非小鲸鱼角色）期间的桥接 API 白名单。
//
// 2026-10-27 用户要求：「宠物与小鲸鱼全线隔离，仅保留识图，取消发图、语音、学习等功能」。
// 做法：扮演期间，agent 发起的 /api/socialV2/* 与 /api/images/* 请求只放行白名单里的路径，
// 其余一律 403。角色卡+提示词只是软约束，这里才是硬门禁。
//
// 白名单只留「聊天 + 看消息 + 识图 + 收尾」：
//   · 发消息 / 看消息 / 看详情 / 看活跃成员 / 等回复（聊天必需）
//   · 识图（/api/images/message，用户明确保留）
//   · 看合并转发（只读，含图）
//   · 自己的角色卡/材料（prompt）、唤醒配置（收尾）、等待
// 不放行：发图/图库、表情、语音、拍一拍、B 站（look/scroll）、黑话、记忆、说说/空间、
// 自己的头像、反馈等 —— 宠物不需要，也不该碰小鲸鱼的东西。

export const ROLEPLAY_ALLOWED_PATHS = new Set([
  '/api/socialV2/send-message',
  '/api/socialV2/recent',
  '/api/socialV2/my-recent',
  '/api/socialV2/message-detail',
  '/api/socialV2/forward-message',
  '/api/socialV2/forward-media',
  '/api/socialV2/active-members',
  '/api/socialV2/prompt',
  '/api/socialV2/wake-config',
  '/api/socialV2/wait',
  '/api/images/message'
]);

/** 当前角色是否是「扮演别人」（非小鲸鱼）。 */
export function isRoleplayRole(role) {
  const r = String(role ?? '').trim();
  return !!r && r !== '小鲸鱼';
}

/** 扮演期间这个请求路径是否放行。 */
export function roleplayToolAllowed(pathname) {
  return ROLEPLAY_ALLOWED_PATHS.has(String(pathname ?? ''));
}
