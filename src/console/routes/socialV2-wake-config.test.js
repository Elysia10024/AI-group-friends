// POST /api/socialV2/wake-config（qq_set_wake_config）的 hermetic 测试（2026-10-28 第 42 轮）。
//
// 这是决定"她什么时候被叫醒"的最大一块校验逻辑。本文件钉住最贵的几条：
//   · 永眠防护：无限期潜水必须至少保留一个触发条件；
//   · 常态潜水策略锁：她不能把 anyMessage/question/probability 开回来；
//   · active 模式语义：无限、清 sleepUntil、anyMessage=true；
//   · 概率夹取 0..1、speakerIds 只留正整数且私聊清空；
//   · 沉睡前强制观察窗口：没等够 → 400 给剩余时间；
//   · 成功后清待唤醒定时器、取消回复检查、登记唤醒配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSocialV2ReadWrite } from './socialV2.js';

function makeCtx({ body = {}, mode = 'diving', mentionsOnly = false, preSleepBlocked = false, wake = {}, current = {} } = {}) {
  const sentJson = [];
  const calls = { saves: 0, setups: 0, cancels: 0, resetPre: 0 };
  const st = {
    wakeConfig: {
      mode,
      infinite: false,
      sleepUntil: null,
      triggers: { atMention: true, nameMention: false, question: false, anyMessage: false, poke: false, keywords: ['大肥鱼'], probability: 0, speakerIds: [] },
      batchWindowMs: 5000,
      ...current,
    },
    pendingWakeTimer: setTimeout(() => {}, 1000).unref?.(),
    lastIncomingAt: 0,
    lastActionAt: 0,
  };
  st.pendingWakeTimer = setTimeout(() => {}, 1000);
  st.pendingWakeTimer.unref?.();
  const ctx = {
    agentTokenOk: () => true,
    allowedKeywordsRawV2: () => ['大肥鱼', '鲸鱼'],
    allowedKeywordsV2: () => ['大肥鱼'],
    buildSlangContext: () => '',
    buildStickerContext: () => '',
    buildStickerStrategyHint: () => '',
    cancelReplyCheckV2: () => { calls.cancels += 1; },
    cfg: { socialV2: { wake: { sleepMinMs: 60000, sleepMaxMs: 600000, preSleepWaitMs: 120000, recommendedSleepMinMs: 300000, recommendedSleepMaxMs: 7200000 } } },
    computeWakeSafetyV2: (wc) => ({ mode: wc.mode }),
    confirmedSlangListV2: () => [],
    currentRoleHint: () => '',
    currentRoleHintV2: () => '',
    deps: { flags: { currentMode: 'reserved2' } },
    ensureWakeableV2: () => true,
    formatMemoryV2: () => '',
    formatParticipationV2: () => '',
    getSocialV2State: () => st,
    isSleepingConfigV2: (wc) => wc.mode === 'diving' && !wc.infinite,
    log: () => {},
    mentionsOnlyV2: () => mentionsOnly,
    normalizeSpeakerIdsV2: (ids) => Array.isArray(ids) ? [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 20) : [],
    preSleepWaitBlockedV2: () => preSleepBlocked,
    readBody: async () => body,
    readRoleState: () => ({}),
    readShadowAssemblies: () => ({}),
    req: { method: 'POST', headers: { 'x-agent-token': 'T' }, on: () => {} },
    resetPreSleepWait: () => { calls.resetPre += 1; },
    saveSocialV2State: () => { calls.saves += 1; },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    settleV2ReadState: () => ({ markedCount: 0 }),
    setupSleepTimerV2: () => { calls.setups += 1; },
    stickerEnabled: () => true,
    syncStickerLibrary: async () => {},
    url: new URL('http://127.0.0.1:3100/api/socialV2/wake-config'),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    wakeConfigMissCount: new Map([['group:1', 3]]),
    wakeConfigUpdatedKeys: new Set(),
  };
  return { ctx, st, sentJson, calls };
}

test('wake-config：缺 key / 坏 token / 会话越界 / 工具关闭 拒绝', async () => {
  const noKey = makeCtx({ body: {} });
  await handleSocialV2ReadWrite(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const badToken = makeCtx({ body: { key: 'group:1' } });
  badToken.ctx.agentTokenOk = () => false;
  await handleSocialV2ReadWrite(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const noSession = makeCtx({ body: { key: 'group:1' } });
  noSession.ctx.v2SessionAllowed = () => false;
  await handleSocialV2ReadWrite(noSession.ctx);
  assert.match(noSession.sentJson.at(-1).body.error, /不在当前模式允许范围/);

  const off = makeCtx({ body: { key: 'group:1' } });
  off.ctx.v2ToolEnabled = () => false;
  await handleSocialV2ReadWrite(off.ctx);
  assert.match(off.sentJson.at(-1).body.error, /工具未启用：qq_set_wake_config/);
});

test('wake-config：永眠防护——无限期潜水且所有触发全关 → 400', async () => {
  const { ctx, sentJson, st } = makeCtx({
    mentionsOnly: false,
    body: { key: 'group:1', config: { infinite: true, triggers: { atMention: false, nameMention: false, poke: false, keywords: [], probability: 0 } } },
    current: { mode: 'diving', triggers: { atMention: false, nameMention: false, question: false, anyMessage: false, poke: false, keywords: [], probability: 0, speakerIds: [] } },
  });
  await handleSocialV2ReadWrite(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /至少保留一个唤醒条件/);
  assert.equal(st.wakeConfig.confirmedBy, undefined, '拒绝时不许落配置');
});

test('wake-config：常态潜水策略锁——anyMessage/question 开不回来、关键词取白名单', async () => {
  const { ctx, st, sentJson } = makeCtx({
    mentionsOnly: true,
    body: { key: 'group:1', config: { triggers: { anyMessage: true, question: true, keywords: ['随便填'] } } },
  });
  await handleSocialV2ReadWrite(ctx);
  const wc = st.wakeConfig;
  assert.equal(wc.mode, 'diving', '策略锁强制潜水');
  assert.equal(wc.triggers.anyMessage, false);
  assert.equal(wc.triggers.question, false);
  assert.equal(wc.triggers.probability, 0);
  assert.deepEqual(wc.triggers.keywords, ['大肥鱼', '鲸鱼'], '关键词被白名单整体替换');
  assert.equal(sentJson.at(-1).body.ok, true);
});

test('wake-config：active 模式 = 无限 + 清 sleepUntil + anyMessage=true；概率夹到 0..1', async () => {
  const { ctx, st } = makeCtx({ body: { key: 'group:1', config: { mode: 'active', triggers: { probability: 5 } } } });
  await handleSocialV2ReadWrite(ctx);
  assert.equal(st.wakeConfig.mode, 'active');
  assert.equal(st.wakeConfig.infinite, true);
  assert.equal(st.wakeConfig.sleepUntil, null);
  assert.equal(st.wakeConfig.triggers.anyMessage, true);
  assert.equal(st.wakeConfig.triggers.probability, 1, '概率上限 1');

  const low = makeCtx({ body: { key: 'group:1', config: { mode: 'active', triggers: { probability: -3 } } } });
  await handleSocialV2ReadWrite(low.ctx);
  assert.equal(low.st.wakeConfig.triggers.probability, 0, '概率下限 0');
});

test('wake-config：speakerIds 只留正整数并去重；私聊清空', async () => {
  const g = makeCtx({ body: { key: 'group:1', config: { triggers: { speakerIds: [5, '5', -1, 'abc', 7.8] } } } });
  await handleSocialV2ReadWrite(g.ctx);
  // 7.8 不是整数 → 被过滤（只留正整数）
  assert.deepEqual(g.st.wakeConfig.triggers.speakerIds, [5], '只留正整数、去重');

  const p = makeCtx({ body: { key: 'private:1', config: { triggers: { speakerIds: [5] } } } });
  await handleSocialV2ReadWrite(p.ctx);
  assert.deepEqual(p.st.wakeConfig.triggers.speakerIds, [], '私聊不适用指定成员唤醒');
});

test('wake-config：sleepMs 被 min/max 夹取', async () => {
  const { ctx, st } = makeCtx({ body: { key: 'group:1', config: { sleepMs: 1 } } });
  const before = Date.now();
  await handleSocialV2ReadWrite(ctx);
  const until = Date.parse(st.wakeConfig.sleepUntil);
  assert.ok(until >= before + 59000, '被抬到 sleepMinMs(60s)');

  const big = makeCtx({ body: { key: 'group:1', config: { sleepMs: 10 * 3600000 } } });
  await handleSocialV2ReadWrite(big.ctx);
  const until2 = Date.parse(big.st.wakeConfig.sleepUntil);
  assert.ok(until2 <= Date.now() + 601000, '被压到 sleepMaxMs(10min)');
});

test('wake-config：沉睡前观察窗口没等够 → 400 并给剩余毫秒', async () => {
  const { ctx, sentJson } = makeCtx({
    preSleepBlocked: true,
    body: { key: 'group:1', config: { infinite: false, sleepMs: 60000, triggers: { atMention: true } } },
  });
  await handleSocialV2ReadWrite(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.status, 400);
  assert.match(last.body.error, /还不能立刻设置潜水/);
  assert.equal(last.body.preSleepWaitMs, 120000);
});

test('wake-config：成功 → 落盘、清待唤醒定时器、取消回复检查、重建睡眠定时器', async () => {
  const { ctx, st, sentJson, calls } = makeCtx({ body: { key: 'group:1', config: { mode: 'diving', triggers: { atMention: true } } } });
  await handleSocialV2ReadWrite(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.deepEqual(last.body.wakeSafety, { mode: 'diving' });
  assert.equal(calls.saves, 1);
  assert.equal(calls.setups, 1);
  assert.equal(calls.cancels, 1);
  assert.equal(st.pendingWakeTimer, null, '待唤醒定时器被清掉');
  assert.equal(st.wakeConfig.noActionCount, 0);
  assert.equal(st.wakeConfig.confirmedBy, 'set_wake_config');
  assert.equal(ctx.wakeConfigUpdatedKeys.has('group:1'), true);
  assert.equal(ctx.wakeConfigMissCount.has('group:1'), false);
});
