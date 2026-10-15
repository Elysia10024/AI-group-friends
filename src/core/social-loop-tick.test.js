// socialLoopTick 的特征测试（拆函数之前先钉住行为）。
//
// ⚠️ 被测的一代社交（chat / reserved）**已停用、当前不可达**（模式已从 VALID_MODES 删除）。
// 这些测试保留着，是因为模块本体也保留着 —— 哪天要删一代，删模块的同时把本文件一起删；
// 去留与理由见 src/domains/social-loop.js 文件头。
//
// 这个 tick 是她行为的**主循环**（5 秒一次：观望期主动开话题 / 活跃期检测 / 冷场试探 / 退场收尾），
// 之前一条测试都没有 —— 所以拆分之前先把它现在的行为逐条测出来，拆完必须一模一样。
//
// 打法：`social` / `socialState` / `enterActive` / `leaveActive` 全是注入的，喂假对象就能精确驱动；
// 随机数与时间用猴子补丁（模块内部直接调 `Math.random()` / `Date.now()`，为可测性去改生产代码不值得）。
// "有没有安排回复"看**日志**（模块自己会打「社交模式：<标签> <key>，延迟 Xs 后投递」）——
// 内部的 scheduleSocialReply 没注入，日志是它唯一的同步可观测出口。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocialLoopModule } from '../domains/social-loop.js';

const MIN = 60 * 1000;
const AT = 1_000_000_000;

function makeTick({ cfgSocial = {}, overrides = {} } = {}) {
  const states = new Map();
  const state = { sessions: {} };
  const social = {
    states,
    recentMessages: new Map(),
    pendingTimers: new Map(),
    silentContext: new Map(),
    exitingSessions: new Set(),
    silentTurns: new Map(),
    pendingSummaries: new Map()
  };
  const calls = { enterActive: [], leaveActive: [], logs: [], summaries: [] };
  const ctx = {
    DIRECTION_HINT: '方向', QUEUE_MAX: 5, SENSITIVE_RE: /x/, SILENT_MARKER: '[SILENT]', SPACE_SPLIT_HINT: '分句',
    api: {}, appendSummary: (...a) => calls.summaries.push(a), auditAndSend: () => {},
    buildContextBlock: () => 'CTX', cancelSocialTimers: () => {},
    cfg: {
      social: {
        proactiveEnabled: true, proactiveIdleThresholdMs: 30 * MIN,
        proactiveCheckMinMs: 45 * MIN, proactiveCheckMaxMs: 90 * MIN, proactiveProbability: 1,
        activeCheckMinMs: 10 * 1000, activeCheckMaxMs: 30 * 1000,
        activeReplyDelayMinMs: 1, activeReplyDelayMaxMs: 1,
        idleWindowMs: 6 * MIN, idleRetryProbability: 1, idleRetryWaitMs: 2 * MIN,
        skipProbability: 0.15, activeDurationEnabled: false,
        ...cfgSocial
      }
    },
    currentRoleHint: () => '角色',
    enqueueForRetry: () => {}, ensureSession: async () => 'sid',
    enterActive: (key) => { calls.enterActive.push(key); const s = states.get(key) ?? { phase: 'idle' }; s.phase = 'active'; states.set(key, s); },
    getSocialV2State: () => ({}), groupIdFromKey: (k) => k.split(':')[1],
    isMustReplyText: () => false, isSocialEnabled: () => true,
    leaveActive: (key) => { calls.leaveActive.push(key); (states.get(key) ?? {}).phase = 'idle'; },
    log: (...a) => calls.logs.push(a.join(' ')),
    mdToPlain: (t) => t, mediaHintFor: () => '', promptQueues: new Map(), queued: new Map(),
    randInt: (a, b) => Math.max(1, Math.min(a, b)),   // 最小延迟：1ms 后定时器自己清掉，测试不会挂着
    resolveMediaList: () => [], saveSocialV2State: () => {}, sendToQQ: async () => {},
    shouldAuditKey: () => false, social,
    socialState: (key) => {
      if (!states.has(key)) states.set(key, { phase: 'idle' });
      return states.get(key);
    },
    state,
    withSlangContext: (t) => t,
    ...overrides
  };
  const mod = createSocialLoopModule(ctx);
  const socialState = (key) => {
    if (!states.has(key)) states.set(key, { phase: 'idle' });
    return states.get(key);
  };
  return { mod, social, state, calls, states, socialState };
}

/** 固定时间与随机数跑一次 tick。 */
function runTick(env, { now = AT, random = 0.5 } = {}) {
  const realNow = Date.now; const realRandom = Math.random;
  Date.now = () => now;
  Math.random = () => random;
  try { env.mod.socialLoopTick(); } finally { Date.now = realNow; Math.random = realRandom; }
}

/** 本次 tick 安排的回复标签（从日志里抠）。 */
const scheduled = (env) => env.calls.logs
  .filter((l) => l.includes('后投递'))
  .map((l) => l.replace(/^社交模式：/, '').split(' ')[0]);

/** 放掉 1ms 定时器，避免测试进程被挂住。 */
const drain = () => new Promise((r) => setTimeout(r, 20));

const msg = (over = {}) => ({ time: AT - 1000, sender: '甲', text: 'hi', isOwner: false, media: [], messageId: '1', ...over });

test('关掉社交：一条都不处理', async () => {
  const env = makeTick({ overrides: { isSocialEnabled: () => false } });
  env.social.recentMessages.set('group:1', [msg()]);
  runTick(env);
  assert.equal(env.calls.enterActive.length + scheduled(env).length, 0);
  await drain();
});

test('观望期：群安静够久 + 概率命中 → 主动开话题并进入活跃', async () => {
  const env = makeTick();
  env.social.recentMessages.set('group:1', [msg({ time: AT - 40 * MIN })]);
  env.socialState('group:1').proactiveNextCheckAt = AT - 1;   // 已到判定时间且非 0（0 会被当成"还没排期"，只排期不判定）
  runTick(env, { random: 0 });
  assert.deepEqual(env.calls.enterActive, ['group:1']);
  assert.deepEqual(scheduled(env), ['主动开话题']);
  await drain();
});

test('观望期：概率没命中 → 不进入活跃，但下次判定时间已推进', async () => {
  const env = makeTick();
  env.social.recentMessages.set('group:1', [msg({ time: AT - 40 * MIN })]);
  env.socialState('group:1').proactiveNextCheckAt = 0;
  runTick(env, { random: 0.99 });
  assert.equal(env.calls.enterActive.length, 0);
  assert.ok(env.states.get('group:1').proactiveNextCheckAt > AT);
  await drain();
});

test('观望期：私聊不主动开话题（只群聊）', async () => {
  const env = makeTick();
  env.social.recentMessages.set('private:1', [msg({ time: AT - 40 * MIN })]);
  runTick(env, { random: 0 });
  assert.equal(env.calls.enterActive.length, 0);
  await drain();
});

test('观望期：还没到判定时间 → 什么都不做', async () => {
  const env = makeTick();
  env.social.recentMessages.set('group:1', [msg({ time: AT - 40 * MIN })]);
  env.socialState('group:1').proactiveNextCheckAt = AT + MIN;
  runTick(env, { random: 0 });
  assert.equal(env.calls.enterActive.length, 0);
  await drain();
});

test('活跃期：到时长上限要收尾退场 → 本轮直接结束（不检测新消息）', async () => {
  const env = makeTick({ overrides: { triggerActiveDurationExit: () => true } });
  env.socialState('group:1').phase = 'active';
  env.social.recentMessages.set('group:1', [msg()]);
  runTick(env);
  assert.deepEqual(scheduled(env), []);
  await drain();
});

test('活跃期：必须回的消息（私聊）→ 安排回应，且不吞进 silentContext', async () => {
  const env = makeTick();
  Object.assign(env.socialState('private:1'), { phase: 'active', nextCheckAt: 0, lastCheckAt: 0, lastActiveMessageAt: AT, lastAiReplyAt: 0 });
  env.social.recentMessages.set('private:1', [msg()]);
  runTick(env);
  assert.deepEqual(scheduled(env), ['活跃期回应']);
  assert.equal(env.social.silentContext.has('private:1'), false);
  await drain();
});

test('活跃期：选择性沉默 → 消息转摘要并留在 silentContext，不发回复', async () => {
  const env = makeTick();
  Object.assign(env.socialState('group:1'), { phase: 'active', nextCheckAt: 0, lastCheckAt: 0, lastActiveMessageAt: AT, lastAiReplyAt: AT - 10 * MIN });
  env.social.recentMessages.set('group:1', [msg()]);
  runTick(env, { random: 0 });   // 0 < skipProbability → 沉默
  assert.deepEqual(scheduled(env), []);
  assert.equal(env.social.silentContext.get('group:1').length, 1);
  assert.equal(env.calls.summaries.length, 1);
  await drain();
});

test('活跃期：刚发过言（60 秒内）不沉默 —— 避免"活跃到一半突然不接"', async () => {
  const env = makeTick();
  Object.assign(env.socialState('group:1'), { phase: 'active', nextCheckAt: 0, lastCheckAt: 0, lastActiveMessageAt: AT, lastAiReplyAt: AT - 10 * 1000 });
  env.social.recentMessages.set('group:1', [msg()]);
  runTick(env, { random: 0 });
  assert.deepEqual(scheduled(env), ['活跃期回应']);
  await drain();
});

test('活跃期：沉默过的消息在下次回复时一起带上（silentContext 被清空）', async () => {
  const env = makeTick();
  Object.assign(env.socialState('group:1'), { phase: 'active', nextCheckAt: 0, lastCheckAt: 0, lastActiveMessageAt: AT, lastAiReplyAt: AT - 10 * MIN });
  env.social.silentContext.set('group:1', [msg({ text: '之前没接的' })]);
  env.social.recentMessages.set('group:1', [msg({ text: '新消息' })]);
  runTick(env, { random: 0.99 });   // 不沉默 → 正常回复
  assert.deepEqual(scheduled(env), ['活跃期回应']);
  assert.equal(env.social.silentContext.has('group:1'), false);
  await drain();
});

test('活跃期：冷场概率命中 → 进入试探并安排试探发言', async () => {
  const env = makeTick();
  Object.assign(env.socialState('group:1'), { phase: 'active', nextCheckAt: 0, lastCheckAt: AT, lastActiveMessageAt: AT - 10 * MIN });
  runTick(env, { random: 0 });
  assert.equal(env.states.get('group:1').phase, 'probing');
  assert.ok(env.states.get('group:1').probeDeadline > AT);
  assert.deepEqual(scheduled(env), ['冷场试探']);
  await drain();
});

test('活跃期：冷场概率没命中 → 回观望', async () => {
  const env = makeTick({ cfgSocial: { idleRetryProbability: 0.5 } });
  Object.assign(env.socialState('group:1'), { phase: 'active', nextCheckAt: 0, lastCheckAt: AT, lastActiveMessageAt: AT - 10 * MIN });
  runTick(env, { random: 0.99 });
  assert.deepEqual(env.calls.leaveActive, ['group:1']);
  await drain();
});

test('退场中：超过 60 分钟没等回 AI 收尾 → 强制回观望并清掉会话标记', async () => {
  const env = makeTick();
  Object.assign(env.socialState('group:1'), { phase: 'exiting', activeExitAt: AT - 61 * MIN, activeDeadlineAt: 123 });
  env.state.sessions['group:1'] = 'sid';
  env.social.exitingSessions.add('sid');
  runTick(env);
  const live = env.states.get('group:1');
  assert.equal(live.phase, 'idle');
  assert.equal(live.activeDeadlineAt, 0);
  assert.equal(live.activeExitAt, 0);
  assert.equal(env.social.exitingSessions.has('sid'), false);
  await drain();
});

test('试探中：过了 deadline 仍无人说话 → 回观望', async () => {
  const env = makeTick();
  Object.assign(env.socialState('group:1'), { phase: 'probing', probeDeadline: AT - 1 });
  runTick(env);
  assert.deepEqual(env.calls.leaveActive, ['group:1']);
  await drain();
});

test('试探中：还没到 deadline → 什么都不做', async () => {
  const env = makeTick();
  Object.assign(env.socialState('group:1'), { phase: 'probing', probeDeadline: AT + MIN });
  runTick(env);
  assert.equal(env.calls.leaveActive.length, 0);
  await drain();
});
