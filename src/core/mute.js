// 静默（「关闭聊天功能」）的判定 —— 抽成纯函数，因为这条规则的边界很容易改错。
//
// 语义（2026-09-18 用户确认）：
//   · 静默**只对群聊生效**：群里谁的话都不读、不回（省 token 的主要手段就是不读群消息）；
//   · **私聊完全不受影响**：不论静默与否，你随时能在私聊里找她说话、下指令；
//   · 群里留一条通道：**管理员的指令**（@她即可），否则关了就没法再开。
//
// 为什么单独成文件：这个判断被三处用到（入站闸门 / 出站闸门 / 唤醒闸门），
// 三处写三份就有了各自跑偏的余地 —— 上一版就是"连私聊一起静默"，
// 而用户要的是群静默、私聊照常。放这里，`npm test` 会把边界钉死。

/** 会话 key 是不是群聊（`group:<群号>`）。 */
export function isGroupKey(key) {
  return String(key ?? '').trim().startsWith('group:');
}

/**
 * 当前是否应当静默这个会话的读与回。
 * @param {string} mode 角色模式（`readRoleState().mode`）：`silent` 表示「关闭聊天功能」
 * @param {string} key 会话 key（`group:123` / `private:456`）
 */
export function isChatMuted(mode, key) {
  return mode === 'silent' && isGroupKey(key);
}
