// src/core/bili-scroll.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickCandidate, scrollQuota } from './bili-scroll.js';

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

test('scrollQuota：同天次数、间隔、跨天重置', () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(scrollQuota(null, now, '2026-10-23', { maxPerDay: 6, intervalMs: 3600000 }), { ok: true });
  assert.equal(scrollQuota({ day: '2026-10-23', count: 6, lastAt: now - 7200000 }, now, '2026-10-23', { maxPerDay: 6 }).reason, 'daily-cap');
  assert.equal(scrollQuota({ day: '2026-10-23', count: 1, lastAt: now - 1000 }, now, '2026-10-23', {}).reason, 'interval');
  assert.deepEqual(scrollQuota({ day: '2026-10-22', count: 6, lastAt: now - 7200000 }, now, '2026-10-23', {}), { ok: true });
});
