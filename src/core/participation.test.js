// src/core/participation.js 的测试。
//
// 回归目标（2026-09-19 实测）：群里最近 150 条她占 42%，而【参与度参考】段当时只会催她说话。
// 这里既钉住"占比高要提醒"，也钉住"不该提醒的时候别乱提醒"（1v1、样本太小、正常占比）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  participationStats,
  overParticipationHint,
  OVER_PARTICIPATION_SHARE,
  OVER_PARTICIPATION_MIN_TOTAL,
  OVER_PARTICIPATION_MIN_SENDERS
} from './participation.js';

const NOW = 1_700_000_000_000;
const at = (minAgo) => NOW - minAgo * 60_000;

/** 造一个窗口：self 条她自己的 + senders 每个人 othersEach 条，**按真实时间交错**排列。 */
function st({ self = 0, senders = [], othersEach = 0, minutesAgo = 1 } = {}) {
  const others = [];
  for (const s of senders) {
    for (let i = 0; i < othersEach; i++) others.push({ isSelf: false, sender: s, time: at(minutesAgo), text: 'x' });
  }
  const mine = Array.from({ length: self }, () => ({ isSelf: true, time: at(minutesAgo), text: '我' }));
  // 交错：真实群里两边是来回说的，不是"她连发 63 条再轮到别人"
  const recent = [];
  const maxLen = Math.max(mine.length, others.length);
  for (let i = 0; i < maxLen; i++) {
    if (mine[i]) recent.push(mine[i]);
    if (others[i]) recent.push(others[i]);
  }
  return { recentMessages: recent };
}

test('统计：占比、人数、窗口过滤都对', () => {
  const s = participationStats(st({ self: 20, senders: ['A', 'B', 'C'], othersEach: 10 }).recentMessages, { now: NOW });
  assert.equal(s.total, 50);
  assert.equal(s.selfN, 20);
  assert.equal(s.otherN, 30);
  assert.equal(s.senders, 3);
  assert.equal(s.share, 0.4);
});

test('窗口外的旧消息不算进来', () => {
  const recent = [
    { isSelf: true, time: at(120), text: '两小时前' },
    { isSelf: false, sender: 'A', time: at(5), text: '刚才' }
  ];
  const s = participationStats(recent, { now: NOW });
  assert.equal(s.total, 1);
  assert.equal(s.selfN, 0);
});

/**
 * 按目标条数造一个"她均匀参与"的窗口（真实群里她的发言是散布在整段里的，
 * 不是"先连发 N 条再轮到别人"——后者会让末尾 sample 条里她占比失真）。
 */
function windowWith({ selfN, totalN, senders = ['A', 'B', 'C'] }) {
  const recent = [];
  let selfLeft = selfN;
  let otherLeft = totalN - selfN;
  for (let i = 0; i < totalN; i++) {
    const wantSelf = selfLeft > 0 && (otherLeft === 0 || (i % 12) < Math.round((selfN / totalN) * 12));
    if (wantSelf) { recent.push({ isSelf: true, time: at(1), text: '我' }); selfLeft--; }
    else { recent.push({ isSelf: false, sender: senders[i % senders.length], time: at(1), text: 'x' }); otherLeft--; }
  }
  return { recentMessages: recent };
}

test('真实事故复现：她占 42%、群里有 4 个人 → 必须提醒收着点', () => {
  // 150 条里她 63 条 = 42%（statistics 只看末尾 60 条，所以这里按同样占比铺满窗口）
  const hint = overParticipationHint(windowWith({ selfN: 25, totalN: 60 }), { now: NOW });
  assert.match(hint, /偏密了/);
  assert.match(hint, /42%/);
  assert.match(hint, /这轮只接一句/);
});

test('只在 1v1 聊天时她占一半 → 不提醒（那不是话密）', () => {
  const hint = overParticipationHint(st({ self: 20, senders: ['群友乙'], othersEach: 20 }).recentMessages, { now: NOW });
  assert.equal(hint, '');
});

test('样本太小 → 不提醒', () => {
  const hint = overParticipationHint(st({ self: 5, senders: ['A', 'B', 'C'], othersEach: 1 }).recentMessages, { now: NOW });
  assert.ok(5 + 3 < OVER_PARTICIPATION_MIN_TOTAL);
  assert.equal(hint, '');
});

test('占比低于阈值 → 不提醒', () => {
  const hint = overParticipationHint(st({ self: 8, senders: ['A', 'B', 'C'], othersEach: 10 }).recentMessages, { now: NOW });
  assert.ok(8 / 38 < OVER_PARTICIPATION_SHARE);
  assert.equal(hint, '');
});

test('阈值常量之间的关系是自洽的', () => {
  assert.ok(OVER_PARTICIPATION_SHARE > 0 && OVER_PARTICIPATION_SHARE < 1);
  assert.ok(OVER_PARTICIPATION_MIN_TOTAL >= 10);
  assert.ok(OVER_PARTICIPATION_MIN_SENDERS >= 2);
});

test('st 为空 / recentMessages 缺失不炸', () => {
  assert.equal(overParticipationHint(null, { now: NOW }), '');
  assert.equal(overParticipationHint({}, { now: NOW }), '');
  assert.equal(participationStats(undefined, { now: NOW }).total, 0);
  // 没有 time 的消息按"很旧"处理（算不进窗口），所以这里只有 0 条有效样本
  assert.equal(participationStats([null, undefined, {}], { now: NOW }).total, 0);
});
