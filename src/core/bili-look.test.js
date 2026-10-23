// src/core/bili-look.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBv, pickSharer, quotaAllowed, bumpQuota, formatLookText } from './bili-look.js';

test('extractBv：BV 号 / 链接 / 纯文字都能抠出来', () => {
  assert.equal(extractBv('BV1SknF6KE5g'), 'BV1SknF6KE5g');
  assert.equal(extractBv('https://www.bilibili.com/video/BV1SknF6KE5g?spm=1'), 'BV1SknF6KE5g');
  assert.equal(extractBv('你看这个 BV1SknF6KE5g 笑死'), 'BV1SknF6KE5g');
  assert.equal(extractBv('没有链接'), '');
  assert.equal(extractBv(null), '');
});

test('pickSharer：从新到旧找包含 BV 的非自己消息', () => {
  const msgs = [
    { sender: '甲', userId: '1', text: 'BV1SknF6KE5g 看看', isSelf: false, time: 100 },
    { sender: '我', isSelf: true, text: 'BV1SknF6KE5g 看过了', time: 200 },
    { sender: '乙', userId: '2', text: '另一个 BV1aaaaaaaaa', isSelf: false, time: 300 }
  ];
  assert.deepEqual(pickSharer(msgs, 'BV1SknF6KE5g'), { userId: '1', sender: '甲', messageId: null, at: 100 });
  assert.equal(pickSharer(msgs, 'BV1zzzzzzzzz'), null);
  assert.equal(pickSharer(null, 'BV1SknF6KE5g'), null);
});

test('quotaAllowed：同一天同一人用完就拒，换天重置', () => {
  assert.equal(quotaAllowed(null, '2026-10-23', 1), true);
  assert.equal(quotaAllowed({ day: '2026-10-23', count: 1 }, '2026-10-23', 1), false);
  assert.equal(quotaAllowed({ day: '2026-10-22', count: 1 }, '2026-10-23', 1), true);
  assert.equal(quotaAllowed({ day: '2026-10-23', count: 1 }, '2026-10-23', 2), true);
});

test('bumpQuota：同一天累加，换天归零重记', () => {
  assert.deepEqual(bumpQuota(null, '2026-10-23', 'BV1SknF6KE5g', 1), { day: '2026-10-23', count: 1, lastBv: 'BV1SknF6KE5g', at: 1 });
  assert.deepEqual(bumpQuota({ day: '2026-10-23', count: 2 }, '2026-10-23', 'BV1x', 2), { day: '2026-10-23', count: 3, lastBv: 'BV1x', at: 2 });
  assert.deepEqual(bumpQuota({ day: '2026-10-22', count: 2 }, '2026-10-23', 'BV1y', 3), { day: '2026-10-23', count: 1, lastBv: 'BV1y', at: 3 });
});

test('formatLookText：带标题/简介/热评/链接，没评论也不崩', () => {
  const out = formatLookText({
    bv: 'BV1SknF6KE5g',
    title: '测试视频',
    owner: 'UP',
    desc: '简介 文本',
    comments: [{ like: 5, content: '好看' }]
  });
  assert.ok(out.includes('测试视频'));
  assert.ok(out.includes('· UP'));
  assert.ok(out.includes('简介：简介 文本'));
  assert.ok(out.includes('[5赞] 好看'));
  assert.ok(out.includes('https://www.bilibili.com/video/BV1SknF6KE5g'));
  const empty = formatLookText({ bv: 'BV1x', title: '', comments: [] });
  assert.ok(empty.includes('热评这次没拿到'));
});
