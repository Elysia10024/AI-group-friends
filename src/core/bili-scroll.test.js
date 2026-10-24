// src/core/bili-scroll.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendShareItem, inShareQuietHours, pickCandidate, scrollDailyCap, scrollQuota } from './bili-scroll.js';

// 北京时间 → 时间戳
const bj = (s) => Date.parse(`${s}+08:00`);
const v = (bvid, duration, tname) => ({ bvid, duration, tname });

test('pickCandidate：过滤超时长/无效，优先偏好分区', () => {
  const list = [
    v('BV1long', 600, '游戏'),
    v('BV1game', 200, '单机游戏'),
    v('BV1music', 120, '音乐'),
    v('BV1short', 30, '搞笑'),
    { bvid: '', duration: 100 }
  ];
  const pick = pickCandidate(list, { maxDurationSec: 300, random: () => 0 });
  assert.equal(pick.bvid, 'BV1game', '偏好分区里随机取第一个');
  const all = pickCandidate(list, { maxDurationSec: 300, random: () => 0.99 });
  assert.ok(['BV1game', 'BV1short'].includes(all.bvid), '只在偏好分区里挑');
  assert.equal(pickCandidate([v('BV1long', 600, '游戏')], { maxDurationSec: 300 }), null);
  assert.equal(pickCandidate(null), null);
});

test('scrollQuota：同天次数、间隔、跨天重置（显式 maxPerDay 优先）', () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(scrollQuota(null, now, '2026-10-23', { maxPerDay: 6, intervalMs: 3600000 }), { ok: true });
  assert.equal(scrollQuota({ day: '2026-10-23', count: 6, lastAt: now - 7200000 }, now, '2026-10-23', { maxPerDay: 6 }).reason, 'daily-cap');
  assert.equal(scrollQuota({ day: '2026-10-23', count: 1, lastAt: now - 1000 }, now, '2026-10-23', {}).reason, 'interval');
  assert.deepEqual(scrollQuota({ day: '2026-10-22', count: 6, lastAt: now - 7200000 }, now, '2026-10-23', {}), { ok: true });
});

test('scrollDailyCap：显式正数优先，否则按空闲小时数', () => {
  assert.equal(scrollDailyCap({ maxPerDay: 6 }, bj('2026-10-23T10:00:00')), 6);
  assert.equal(scrollDailyCap({}, bj('2026-10-23T10:00:00')), 17, '工作日空闲 17 小时');
  assert.equal(scrollDailyCap({ maxPerDay: 0 }, bj('2026-10-24T10:00:00')), 24, '周末全天空闲');
  assert.equal(scrollDailyCap({}, bj('2026-10-01T10:00:00')), 24, '国庆节假日');
  assert.equal(scrollDailyCap({}, bj('2026-10-10T10:00:00')), 17, '调休上班日按工作日');
});

test('scrollQuota：默认配额按空闲小时数（工作日 17）', () => {
  const now = bj('2026-10-23T10:00:00');
  const rec = { day: '2026-10-23', count: 16, lastAt: now - 7200000 };
  assert.deepEqual(scrollQuota(rec, now, '2026-10-23', {}), { ok: true }, '16 < 17 还能刷');
  assert.equal(scrollQuota({ ...rec, count: 17 }, now, '2026-10-23', {}).reason, 'daily-cap');
});

test('inShareQuietHours：北京时间 1:00–8:00 才静默', () => {
  assert.equal(inShareQuietHours(bj('2026-10-24T00:59:00')), false);
  assert.equal(inShareQuietHours(bj('2026-10-24T01:00:00')), true);
  assert.equal(inShareQuietHours(bj('2026-10-24T07:59:00')), true);
  assert.equal(inShareQuietHours(bj('2026-10-24T08:00:00')), false);
  assert.equal(inShareQuietHours(bj('2026-10-24T23:00:00')), false, '默认窗口不跨零点');
  assert.equal(inShareQuietHours(bj('2026-10-24T23:00:00'), { shareQuietStart: 23, shareQuietEnd: 8 }), true, '支持跨零点窗口');
  assert.equal(inShareQuietHours(bj('2026-10-24T09:00:00'), { shareQuietStart: 1, shareQuietEnd: 1 }), false, '空窗口不静默');
});

test('appendShareItem：同 bv 去重、上限截断、空 bv 忽略', () => {
  const a = appendShareItem([], { bv: 'BV1', title: 'a', at: 1 });
  const b = appendShareItem(a, { bv: 'BV2', title: 'b', at: 2 });
  assert.equal(b.length, 2);
  const c = appendShareItem(b, { bv: 'BV1', title: 'a2', at: 3 });
  assert.deepEqual(c.map((x) => x.bv), ['BV2', 'BV1'], '重复的挪到最新，不重复占位');
  assert.equal(appendShareItem([], { bv: '' }).length, 0);
  const many = [];
  for (let i = 0; i < 5; i++) many.push({ bv: 'BV' + i, at: i });
  assert.equal(appendShareItem(many, { bv: 'BV9' }, 3).length, 3, '超过上限只留最近的');
  assert.deepEqual(appendShareItem(null, { bv: 'BVX' }).map((x) => x.bv), ['BVX'], 'null 池也能追加');
});
