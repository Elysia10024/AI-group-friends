// 每会话状态登记处（2026-10-27 重构第 2 期，审计第 6 条）。
//
// 问题：重置一个会话以前要手抄 31 个 delete/clear（admin-commands 的 wipeConversation），
// DSH 断线时 pump 的 finally 再抄一组，模式切换时 timers 再抄第三组 ——
// 加一个 per-key Map = 多处必改，漏一处就是泄漏或串号。
//
// 做法：声明处 register(group, name, store)；清理统一走
// disposeKey / disposeSession / clearSessions / clearStores。
// 本模块**不搬数据居住地**：每个 Map/Set 仍住在原模块/闭包里，
// 登记处只接管"谁负责删"——注册名单 = 旧三张手写清单的并集，一个 store 不多（行为不变）。
//
// 两个 group 的键空间不同：
//   'session' —— 以 DSH sessionId 为键（collectors / v2TurnStartAt / silentTurns …）；
//   'conv'    —— 以会话 key 为键（group:xxx / private:xxx）。
// 有特殊删除语义的 store 传适配器（{has, delete}）：例如 pending 删除前
// 要 clearTimeout + cancelPendingEntry。
export function createConversationRegistry() {
  const groups = { conv: new Map(), session: new Map() };

  function register(group, name, store) {
    if (!groups[group]) throw new Error(`conversation-registry：未知 group ${group}`);
    if (groups[group].has(name)) throw new Error(`conversation-registry：${group}/${name} 已登记`);
    groups[group].set(name, store);
    return store;
  }

  /** 从所有 conv store 里删掉这个 key（适配器走自己的 delete）。 */
  function disposeKey(key) {
    for (const store of groups.conv.values()) store?.delete?.(key);
  }

  /** 从所有 session store 里删掉这个 sessionId。 */
  function disposeSession(sessionId) {
    for (const store of groups.session.values()) store?.delete?.(sessionId);
  }

  /** 全部 session store 整表 clear（DSH 断线重连清理）。 */
  function clearSessions() {
    for (const store of groups.session.values()) store?.clear?.();
  }

  /** 按名单整表 clear 指定 conv store（断线/模式切换的整表语义）。 */
  function clearStores(names) {
    for (const name of names) groups.conv.get(name)?.clear?.();
  }

  function names(group) {
    return [...(groups[group] ?? new Map()).keys()];
  }

  return { register, disposeKey, disposeSession, clearSessions, clearStores, names };
}
