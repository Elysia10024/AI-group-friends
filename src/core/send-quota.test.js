// core/send-quota.js 的单测（第 17 轮）。用真实 reserveSlots/rollbackSlots，行为才可信。
import test from 'node:test';
import assert from 'node:assert/strict';
import { withSendQuota } from './send-quota.js';
import { reserveSlots, rollbackSlots } from './ratelimit.js';

const deps = { reserveSlots, rollbackSlots };
const makeSt = () => ({ sendTimes: [] });

test('成功：预占保留，返回执行结果', async () => {
  const st = makeSt();
  const r = await withSendQuota({ st, count: 2, now: 1000, gate: async () => true, run: async () => ['m1', 'm2'], ...deps });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, ['m1', 'm2']);
  assert.equal(st.sendTimes.length, 2);
});

test('闸门拒绝：不预占，不执行', async () => {
  const st = makeSt();
  let ran = 0;
  const r = await withSendQuota({ st, count: 1, now: 1000, gate: async () => false, run: async () => { ran += 1; }, ...deps });
  assert.equal(r.gateFailed, true);
  assert.equal(r.ok, false);
  assert.equal(ran, 0);
  assert.equal(st.sendTimes.length, 0);
});

test('闸门抛错：还没预占 → 不回滚（否则额度通胀）', async () => {
  const st = makeSt();
  st.sendTimes = reserveSlots(st.sendTimes, { count: 1, now: 900 }); // 之前已有一个额度
  const boom = new Error('闸门炸了');
  const r = await withSendQuota({ st, count: 1, now: 1000, gate: () => { throw boom; }, run: async () => {}, ...deps });
  assert.equal(r.ok, false);
  assert.equal(r.error, boom);
  assert.equal(r.rolledBack, false);
  assert.equal(st.sendTimes.length, 1, '既有额度不能被误动');
});

test('部分失败：按 error.sent 只回滚未发出的', async () => {
  const st = makeSt();
  const err = Object.assign(new Error('第 2 条超时'), { sent: ['m1'] });
  const r = await withSendQuota({ st, count: 2, now: 1000, gate: async () => true, run: async () => { throw err; }, ...deps });
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, true);
  assert.equal(st.sendTimes.length, 1, '2 预占 - 1 回滚');
});

test('全失败：全部回滚', async () => {
  const st = makeSt();
  const r = await withSendQuota({ st, count: 2, now: 1000, gate: async () => true, run: async () => { throw new Error('网关挂了'); }, ...deps });
  assert.equal(r.rolledBack, true);
  assert.equal(st.sendTimes.length, 0);
});

test('回滚自身抛错：不吞，作为 rollbackError 交回调用方', async () => {
  const st = makeSt();
  const rbErr = new Error('回滚失败');
  const r = await withSendQuota({
    st, count: 1, now: 1000,
    gate: async () => true,
    run: async () => { throw new Error('发送失败'); },
    reserveSlots,
    rollbackSlots: () => { throw rbErr; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, false);
  assert.equal(r.rollbackError, rbErr);
});
