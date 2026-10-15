// src/core/alert.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlertGate, alertText, recoveredText } from './alert.js';

const MIN = 60 * 1000;
const T0 = 1_800_000_000_000;

test('第一次失败立刻报，随后安静（不刷屏）', () => {
  const g = createAlertGate({ repeatIntervalMs: 30 * MIN });
  const a = g.failure({ reason: 'HTTP 401', key: 'group:1', now: T0 });
  assert.deepEqual(a, { fire: true, first: true, count: 1 });
  for (const i of [1, 2, 3, 4]) {
    const r = g.failure({ reason: 'HTTP 401', key: 'group:1', now: T0 + i * 1000 });
    assert.equal(r.fire, false, `第 ${i + 1} 次不该再报`);
    assert.equal(r.count, i + 1);
  }
  assert.equal(g.failing, true);
});

test('同一场故障隔一段时间再报一次，并带上"连续第 N 轮"', () => {
  const g = createAlertGate({ repeatIntervalMs: 30 * MIN });
  g.failure({ reason: 'HTTP 402', now: T0 });
  g.failure({ now: T0 + MIN });
  const again = g.failure({ now: T0 + 31 * MIN });
  assert.equal(again.fire, true);
  assert.equal(again.repeat, true);
  assert.equal(again.count, 3);
  assert.match(alertText({ count: again.count, reason: 'HTTP 402', repeat: true, repeatMs: 30 * MIN }), /连续 3 轮/);
});

test('恢复只报一次，且不再处于故障态', () => {
  const g = createAlertGate();
  g.failure({ reason: 'x', now: T0 });
  const ok = g.success();
  assert.deepEqual(ok, { fire: true, recovered: true, count: 1 });
  assert.equal(g.failing, false);
  assert.equal(g.success().fire, false, '没故障就没有恢复通知');
});

test('没报过故障就恢复 → 不打扰（避免每轮都说一句）', () => {
  const g = createAlertGate({ repeatIntervalMs: 30 * MIN });
  g.failure({ now: T0 });                       // 第一次就会报，所以先构造"不该报"的场景：
  const g2 = createAlertGate({ repeatIntervalMs: 30 * MIN });
  assert.equal(g2.success().fire, false);
});

test('reason 截断、keys 最多记 3 个（告警文案不许被超长错误刷爆）', () => {
  const g = createAlertGate({ repeatIntervalMs: 30 * MIN });
  g.failure({ reason: 'x'.repeat(500), key: 'group:1', now: T0 });
  for (const k of ['group:2', 'group:3', 'group:4', 'group:5']) g.failure({ key: k, now: T0 + 1 });
  const s = g.snapshot();
  assert.equal(s.lastReason.length, 161, '160 字 + 省略号');
  assert.deepEqual(s.keys, ['group:3', 'group:4', 'group:5']);
});

test('文案：故障条说清"多少次/为什么/该怀疑什么"，恢复条说清"刚才几轮"', () => {
  const t = alertText({ count: 3, reason: 'model not found', keys: ['group:1', 'private:9'], repeatMs: 30 * MIN });
  assert.match(t, /连续第 3 轮/);
  assert.match(t, /model not found/);
  assert.match(t, /group:1/);
  assert.match(t, /key 失效/);
  assert.match(recoveredText({ count: 3 }), /连续 3 轮/);
});

test('脏参数不炸', () => {
  const g = createAlertGate({ repeatIntervalMs: 'abc' });
  assert.equal(g.failure({}).fire, true);
  assert.equal(g.success().fire, true);
  assert.equal(typeof alertText({}).length, 'number');
  assert.equal(typeof recoveredText().length, 'number');
});
