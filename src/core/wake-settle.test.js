// 回合收尾"自动标已读"（settleV2ReadState）：原来是她调 qq_mark_read 做的 8 件事。
//
// 为什么单独测：这条路径以前只有"她真的调了工具"才能验证，而它同时管着
// 未读水位线、无行动计数、唤醒配置确认（confirmedBy）—— 弄错任何一项都会表现成
// "她莫名其妙漏消息"或"她卡死不睡"，是最难从聊天里看出原因的那类 bug。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWakePolicyModule } from '../domains/wake-policy.js';

function makePolicy() {
  const saved = [];
  const mod = createWakePolicyModule({
    allowedKeywords: () => [],
    allowedKeywordsRaw: () => [],
    armFollowUp: () => {},
    cfg: { socialV2: { wake: { preSleepWaitEnabled: true, preSleepWaitMs: 120000 } } },
    followUpState: () => null,
    log: () => {},
    mentionsOnly: () => true,
    normalizeSpeakerIdsV2: (v) => (Array.isArray(v) ? v : []),
    saveSocialV2State: () => {},
    setupSleepTimerV2: () => {},
    socialV2: { conversations: new Map() },
    wakePolicy: () => ({})
  });
  return { mod, saved };
}

const baseState = (over = {}) => ({
  unread: [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }],
  deliveredSeq: 2,
  lastActionAt: 0,
  wakeConfig: { infinite: true, triggers: { atMention: true } },
  ...over
});

test('只清水位线以内的未读，turn 期间新到的留在队列里', () => {
  const { mod } = makePolicy();
  const st = baseState();
  const r = mod.settleV2ReadState(st, { key: 'group:1' });
  assert.equal(r.markedCount, 2);
  assert.deepEqual(st.unread.map((m) => m.seq), [3, 4]);
  assert.equal(r.sleepConfirmed, true);
});

test('水位线为 0（从没投递过）时清空未读', () => {
  const { mod } = makePolicy();
  const st = baseState({ deliveredSeq: 0 });
  mod.settleV2ReadState(st, { key: 'group:1' });
  assert.deepEqual(st.unread, []);
});

test('正常收尾：记 lastActionAt、清 noActionCount、写 confirmedBy、补 ensureWakeable 的兜底', () => {
  const { mod } = makePolicy();
  const st = baseState({ wakeConfig: { infinite: false, sleepUntil: null, noActionCount: 2, triggers: {} } });
  const before = Date.now();
  mod.settleV2ReadState(st, { key: 'group:1' });
  assert.ok(st.lastActionAt >= before);
  assert.equal(st.wakeConfig.noActionCount, 0);
  assert.equal(st.wakeConfig.confirmedBy, 'auto-settle');
  assert.ok(st.wakeConfig.confirmedAt >= before);
  // 有限潜水但 sleepUntil 为空 → 必须补成 infinite，否则会出现"没有定时器也没有触发条件"的静默态
  assert.equal(st.wakeConfig.infinite, true);
});

test('沉睡前观察窗口内：只推水位线，不确认唤醒配置（sleepConfirm:false）', () => {
  const { mod } = makePolicy();
  const st = baseState({ wakeConfig: { infinite: true, triggers: { atMention: true } } });
  const r = mod.settleV2ReadState(st, { key: 'group:1', sleepConfirm: false });
  assert.equal(r.markedCount, 2);
  assert.equal(r.sleepConfirmed, false);
  assert.equal(st.lastActionAt, 0);          // 没被当成"行动"
  assert.equal(st.wakeConfig.confirmedBy, undefined);  // 没确认
});

test('preSleepWaitBlockedV2：安静够久 / 已观察过 / 已显式收尾 → 不再拦', () => {
  const { mod } = makePolicy();
  const wc = { infinite: true, triggers: { atMention: true } };
  assert.equal(mod.preSleepWaitBlockedV2({ wakeConfig: wc, lastIncomingAt: Date.now() - 180000 }), false);
  assert.equal(mod.preSleepWaitBlockedV2({ wakeConfig: wc, lastIncomingAt: Date.now() - 1000, preSleepWaitObservedAt: Date.now() }), false);
  assert.equal(mod.preSleepWaitBlockedV2({ wakeConfig: wc, lastIncomingAt: Date.now() - 1000 }), true);
});
