// 社交定时器与队列排空域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（6 个互相调用的函数）。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 1 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
//
// 后加的一块（2026-10-14）：聊天密度触发插话（densityWake）的记账与周期判定，见文件末尾注释。
import { DENSITY_DEFAULTS, pushStamp, densityDecision } from '../core/msg-density.js';
import { localDayKey } from '../core/local-day.js';

export function createTimersModule(ctx) {
  const {
    cfg,
    registry,
    ensureWakeableV2,
    getSocialV2State,
    isConversationBusyV2,
    isSessionAllowedInCurrentMode,
    log,
    markReadCalledKeys,
    messageMediaStore,
    pendingWakeKeys,
    promptQueues,
    sendWakePromptV2,
    socialV2,
    wakeConfigMissCount,
    wakeConfigUpdatedKeys,
  } = ctx;


  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function scheduleProactiveCheckV2(key) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || ctx.flags.currentMode !== 'reserved2') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  // ── 聊天密度触发插话（densityWake，2026-10-14）────────────────────────────────
  // 每收到一条普通群消息就记一个时间戳（只有数字，没有内容），然后每 1~2 分钟问一次
  // core/msg-density.js：「这个群最近 10 分钟够不够热闹？」—— 够了就给她一次插话机会。
  // 为什么不是"每条消息都判一次"：判定要按 key 遍历、还要读配置，绑在消息路径上会拖慢入站；
  // 而"热闹"是分钟级的现象，1~2 分钟的粒度完全够（迟一分钟插话照样接得上）。
  //
  // 为什么状态只在内存、不落盘进 socialV2 状态：
  //   · 观察窗口只有 10 分钟，桥接重启后旧时间戳本来就过期，存下来也是白存；
  //   · 代价只有"重启后当天次数归零，最坏多插一两次话"，而给每个会话往 state 文件里加持久化
  //     字段要动状态结构、加载清理与归档逻辑 —— 不值这个复杂度。
  // 两个有意为之的后果：重启会重置当天次数；clearAllSocialV2Timers 会把它整体清空。
  const densityStamps = new Map();        // key -> number[]（升序时间戳，只留窗口内、最多 maxKeep 条）
  const densityTriggerState = new Map();  // key -> { lastTriggerAt, day, count }（当天次数按**本地日**比较）
  const DENSITY_CHECK_MIN_MS = 60 * 1000;
  const DENSITY_CHECK_MAX_MS = 120 * 1000;
  let densityTimer = null;

  function stopDensityCheck() {
    if (!densityTimer) return;
    clearTimeout(densityTimer);
    densityTimer = null;
  }

  /** 生效的 densityWake 配置：默认值来自 core（唯一来源），config.json 只做覆盖。 */
  function densityCfg() {
    return { ...DENSITY_DEFAULTS, ...(cfg.socialV2?.densityWake ?? {}) };
  }

  /** 记一条普通群消息。incoming.js 在"群消息入库"那一步调用；私聊不记（插话只发生在群里）。 */
  function noteGroupDensityMessage(key, now = Date.now()) {
    const d = densityCfg();
    if (d.enabled === false) return;   // 关掉就连账都不记：省内存，也不让定时器空转
    const prev = densityStamps.get(key) ?? [];
    densityStamps.set(key, pushStamp(prev, now, { windowMs: d.windowMs, maxKeep: d.maxKeep }));
    scheduleDensityCheck();
  }

  function scheduleDensityCheck() {
    if (densityTimer) return;
    if (densityStamps.size === 0) return;   // 没人记账就不空转；下一条群消息进来会重新排
    const delay = DENSITY_CHECK_MIN_MS + Math.floor(Math.random() * (DENSITY_CHECK_MAX_MS - DENSITY_CHECK_MIN_MS));
    densityTimer = setTimeout(() => {
      densityTimer = null;
      try {
        runDensityCheck();
      } catch (error) {
        // 定时器回调里抛出去就是 uncaughtException，整个桥接会被掀掉；而"能不能插一句话"
        // 不值这个价 —— 记一行日志，下一轮继续（不静默）。
        log(`[reserved2] densityWake 检查异常：`, error?.message ?? error);
      }
      scheduleDensityCheck();   // 自递归续期，风格同上面 proactive 的 st.proactiveTimer
    }, delay);
    densityTimer.unref?.();
  }

  function runDensityCheck() {
    const d = densityCfg();
    if (d.enabled === false) {   // 运行中被关掉：停表并清账，别留着每 1~2 分钟空转
      stopDensityCheck();
      densityStamps.clear();
      densityTriggerState.clear();
      return;
    }
    if (socialV2.paused || ctx.flags.currentMode !== 'reserved2') return;
    const now = Date.now();
    const hour = new Date(now).getHours();   // 本地小时在**调用侧**取：纯函数内部不许读时钟
    const today = localDayKey(now);          // 本地日（不是 UTC 日）：否则额度会在早上 8 点偷偷刷新
    for (const [key, stamps] of densityStamps) {
      if (!isSessionAllowedInCurrentMode(key)) continue;
      const rec = densityTriggerState.get(key);
      const sameDay = rec?.day === today;
      const decision = densityDecision({
        stamps,
        now,
        cfg: d,
        // 冷却**不**跟着跨天重置：否则 23:50 触发过，00:10 又能立刻触发一次
        lastTriggerAt: Number(rec?.lastTriggerAt) || 0,
        triggeredToday: sameDay ? Math.max(0, Math.floor(Number(rec.count) || 0)) : 0,
        hour,
        random: Math.random()
      });
      if (!decision.wake) {
        // 只记"确实热闹、但被闸门挡住"的那几种（cooldown / daily-cap / dice）—— 那是调参和排障要的信息。
        // 两类高频无价值的必须静默，否则日志会被它们刷满、真出问题时反而看不见：
        //   · too-few：平时群就不够热闹，每轮都会命中；
        //   · quiet-hours：凌晨必然发生（2026-10-14 实测本地 00:00 起每 1~2 分钟 × 每个会话一条，
        //     一晚几百条）。它只反映"时段配置生效了"，没有调参价值。
        if (decision.reason !== 'too-few' && decision.reason !== 'quiet-hours') {
          log(`[reserved2] densityWake 未触发 ${key}：${decision.reason}（窗口内 ${stamps.length} 条）`);
        }
        continue;
      }
      // 触发后清空窗口：同一波热闹只给一次机会。不清的话，30 分钟冷却一过，旧时间戳还在，
      // 会拿同一批消息再触发一遍 —— 那就不是"趁热插话"，是"翻旧账"。
      densityStamps.set(key, []);
      densityTriggerState.set(key, { lastTriggerAt: now, day: today, count: (sameDay ? Math.max(0, Math.floor(Number(rec.count) || 0)) : 0) + 1 });
      log(`[reserved2] densityWake 触发插话机会 ${key}（窗口内 ${stamps.length} 条，今天第 ${densityTriggerState.get(key).count}/${d.dailyCap} 次）`);
      void sendWakePromptV2(key, 'densityWake').catch((error) => log(`[reserved2] densityWake 唤醒异常 ${key}:`, error?.message ?? error));
    }
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
    // 这个会话不再记账：时间戳与触发记录一起删（定时器本身在没人记账时不再续期，见上面）
    densityStamps.delete(key);
    densityTriggerState.delete(key);
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    stopDensityCheck();
    densityStamps.clear();
    densityTriggerState.clear();
    // 这 5 个 conv store 的整表清走登记处（第 2 期）：与 wipeConversation / pump 断线同一张名单，单一真相源。
    registry.clearStores(['pendingWakeKeys', 'wakeConfigUpdatedKeys', 'markReadCalledKeys', 'wakeConfigMissCount', 'messageMediaStore']);
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }


  return { cancelProactiveCheckV2, scheduleProactiveCheckV2, noteGroupDensityMessage, clearSocialV2Timers, clearAllSocialV2Timers, drainPromptQueue, drainAllPromptQueues };
}
