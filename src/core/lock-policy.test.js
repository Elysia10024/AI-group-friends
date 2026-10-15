// src/core/lock-policy.js 的测试。
//
// 回归目标就是 2026-09-20 早上那次事故：重启电脑后 PID 被复用，
// 锁里记的 PID（156024）变成了 SnowLuma 的进程，于是桥一直以为自己不该启动。
import test from 'node:test';
import assert from 'node:assert/strict';
import { lockLiveness, LOCK_STALE_MS, LOCK_HEARTBEAT_MS } from './lock-policy.js';

const NOW = 1_700_000_000_000;

test('PID 活着 + 心跳新鲜 → 锁有效（另一个桥真的在跑）', () => {
  const r = lockLiveness({ pidAlive: true, mtimeMs: NOW - 5_000, now: NOW });
  assert.equal(r.live, true);
  assert.equal(r.reason, 'live');
});

test('事故复现：PID 活着但心跳是昨天的（PID 被复用）→ 判为过期，不拦启动', () => {
  // 锁是重启前写的，mtime 在几小时前；PID 现在属于另一个进程
  const r = lockLiveness({ pidAlive: true, mtimeMs: NOW - 6 * 3600_000, now: NOW });
  assert.equal(r.live, false);
  assert.equal(r.reason, 'heartbeat-stale');
});

test('PID 不在了 → 过期（原有行为，别退化）', () => {
  assert.deepEqual(lockLiveness({ pidAlive: false, mtimeMs: NOW, now: NOW }), { live: false, reason: 'pid-dead' });
});

test('拿不到 mtime（文件刚被删/读不到）→ 不当成有效锁', () => {
  assert.equal(lockLiveness({ pidAlive: true, mtimeMs: 0, now: NOW }).live, false);
  assert.equal(lockLiveness({ pidAlive: true, mtimeMs: NaN, now: NOW }).reason, 'no-mtime');
});

test('心跳边界：刚好到 staleMs 算过期，差 1 毫秒算有效', () => {
  assert.equal(lockLiveness({ pidAlive: true, mtimeMs: NOW - LOCK_STALE_MS, now: NOW }).live, false);
  assert.equal(lockLiveness({ pidAlive: true, mtimeMs: NOW - LOCK_STALE_MS + 1, now: NOW }).live, true);
});

test('心跳间隔必须明显小于过期阈值（否则会误判自己在跑）', () => {
  assert.ok(LOCK_HEARTBEAT_MS * 2 <= LOCK_STALE_MS, `心跳 ${LOCK_HEARTBEAT_MS} 相对阈值 ${LOCK_STALE_MS} 太快了`);
});
