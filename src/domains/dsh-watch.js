// DSH 就绪监测域：从 bridge.js 的main()整体搬出来的一个"簇"（2 个互相调用的函数）。
//
// 搬出来的理由：bridge.js 是个巨型文件（main() 曾占 86%），想读这一段得跨过整个文件。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且**在构造点之前**声明的名字走解构；
//   · **可写的**和**在构造点之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）；
//   · 被更早的构造点引用的名字，在那个更早的构造处要包 thunk（`name: (...a) => name(...a)`）。
//
// 正文与搬迁前**逐字相同**，只有上述 28 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
export function createDshWatchModule(ctx) {
  const {
    api,
    flushQueue,
    log,
    maybeQueueSlangExtraction,
    refreshMode,
    setupSleepTimerV2,
    slangWindows,
  } = ctx;

  const checkDsh = async () => {
    let ok = false;
    try {
      await api.host.describe({});
      ok = true;
    } catch { /* 探测 DSH host 是否可用：失败即置 ok=false，结果由返回值表达而不是异常 */ }
    if (ok) {
      await refreshMode();
      if (!ctx.dshReady) {
        ctx.dshReady = true;
        ctx.lastMode = ctx.currentMode;
        log(`DSH 已就绪（模式: ${ctx.currentMode}）`);
        if (ctx.currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of ctx.socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            ctx.scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (ctx.currentMode !== ctx.lastMode) {
        if (ctx.lastMode === 'reserved' && ctx.currentMode !== 'reserved') {
          ctx.cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (ctx.lastMode === 'reserved2' && ctx.currentMode !== 'reserved2') {
          ctx.clearAllSocialV2Timers();
          ctx.drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (ctx.currentMode === 'reserved2' && ctx.lastMode !== 'reserved2') {
          for (const key of ctx.socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            ctx.scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${ctx.currentMode}`);
        ctx.lastMode = ctx.currentMode;
      }
    } else if (ctx.dshReady) {
      ctx.dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (ctx.dshCheckStarted) return;
    ctx.dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }


  return { checkDsh, startDshWatch };
}
