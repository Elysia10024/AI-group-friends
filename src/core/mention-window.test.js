// src/core/mention-window.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { isMentionLive, liveMentions, pruneMentions, fmtClock, DEFAULT_MENTION_TTL_MS } from './mention-window.js';

const NOW = new Date('2026-10-02T11:09:00+08:00').getTime();
const at = (msAgo) => NOW - msAgo;

test('已经看过的（水位线越过）不算"有人在找你"', () => {
  const m = { seq: 4313, at: at(60_000) };
  assert.equal(isMentionLive(m, { fetchedSeq: 4315, now: NOW }), false, 'seq <= 水位线 = 已读');
  assert.equal(isMentionLive(m, { fetchedSeq: 4312, now: NOW }), true, 'seq > 水位线 = 还没看过');
});

test('超过 TTL 的不算——这正是"昨晚十点那条被回第二遍"的堵口', () => {
  const old = { seq: 4242, at: at(13 * 3600000) }; // 13 小时前
  assert.equal(isMentionLive(old, { fetchedSeq: 0, now: NOW }), false);
  const fresh = { seq: 4318, at: at(30 * 60_000) };
  assert.equal(isMentionLive(fresh, { fetchedSeq: 0, now: NOW }), true);
  assert.equal(DEFAULT_MENTION_TTL_MS, 2 * 3600000, '默认 2 小时');
});

test('TTL 可配（socialV2.context.mentionTtlMs）', () => {
  const m = { seq: 4318, at: at(3 * 3600000) };
  assert.equal(isMentionLive(m, { now: NOW }), false, '默认 2 小时：3 小时前已过期');
  assert.equal(isMentionLive(m, { now: NOW, ttlMs: 6 * 3600000 }), true, '放到 6 小时就还活着');
});

test('坏数据不炸：没有 at / 空对象一律不算', () => {
  assert.equal(isMentionLive(null, { now: NOW }), false);
  assert.equal(isMentionLive({}, { now: NOW }), false);
  assert.equal(isMentionLive({ seq: 1 }, { now: NOW }), false);
});

test('liveMentions / pruneMentions 保序过滤', () => {
  const list = [
    { seq: 1, at: at(10 * 3600000) },
    { seq: 9, at: at(5 * 60_000) },
    { seq: 10, at: at(60_000) },
    { seq: 11, at: at(30_000) }
  ];
  const live = liveMentions(list, { fetchedSeq: 10, now: NOW });
  assert.deepEqual(live.map((m) => m.seq), [11]);
  assert.deepEqual(pruneMentions(list, { fetchedSeq: 10, now: NOW }).map((m) => m.seq), [11]);
});

test('时间戳：今天 / 昨天 / 更早', () => {
  assert.equal(fmtClock(new Date('2026-10-02T11:14:00+08:00').getTime(), NOW), '11:14');
  assert.equal(fmtClock(new Date('2026-10-01T22:10:00+08:00').getTime(), NOW), '昨天 22:10');
  assert.equal(fmtClock(new Date('2026-09-29T18:37:00+08:00').getTime(), NOW), '9/29 18:37');
  assert.equal(fmtClock(0, NOW), '', '没有时间就不写');
});

test('凌晨跨天也算"昨天"（她半夜看到的是同一天）', () => {
  const late = new Date('2026-10-02T00:30:00+08:00').getTime();
  assert.equal(fmtClock(late, NOW), '00:30', '同一天');
  const yesterdayLate = new Date('2026-10-01T23:50:00+08:00').getTime();
  assert.equal(fmtClock(yesterdayLate, NOW), '昨天 23:50');
});
