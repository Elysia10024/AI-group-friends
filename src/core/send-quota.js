// 发送额度的「预占 → 执行 → 失败回滚」三步舞（2026-10-28 第 17 轮）。
//
// 为什么要有它：同一段舞全仓手抄了 4 份（send.js 的分条/图库/表情、media.js 的旧发送路由），
// 而且抄出了 3 种写法：reserved 门控、catch 里重新取 st、无条件回滚。2026-10-27 修 D-01 时
// 只修了其中一份，另外两份带着同类 bug 活了下来（2026-10-28 才被 media-send 测试抓出来）。
//
// 契约（与各调用点的既有行为逐条对齐）：
//   · gate() 返回 false = 已由闸门回了 429/403，不再预占（调用方按"已处理"返回）；
//   · gate() 抛错 = 还没预占，**不回滚**（旧的无条件写法会回滚一个没占的额度 → 额度通胀）；
//   · 执行体抛错 = 按 error.sent 的条数回滚**未发出**的那部分；回滚自身的异常不吞，作为
//     rollbackError 返回给调用方去记日志；是否落盘由调用方决定（与旧代码一致）。
//
// 依赖注入 reserveSlots / rollbackSlots，便于单测；两个函数在 core/ratelimit.js（有单测）。
export async function withSendQuota({
  st,
  count = 1,
  now,
  gate,
  run,
  reserveSlots,
  rollbackSlots,
}) {
  let reserved = false;
  try {
    if (typeof gate === 'function' && !(await gate())) return { ok: false, gateFailed: true };
    st.sendTimes = reserveSlots(st.sendTimes, { count, now });
    reserved = true;
    const value = await run();
    return { ok: true, value };
  } catch (error) {
    const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
    const failedCount = Math.max(0, count - sentCount);
    let rollbackError = null;
    let rolledBack = false;
    if (reserved && failedCount > 0) {
      try {
        st.sendTimes = rollbackSlots(st.sendTimes, { count: failedCount, now });
        rolledBack = true;
      } catch (e) {
        rollbackError = e;
      }
    }
    return { ok: false, error, rolledBack, rollbackError };
  }
}
