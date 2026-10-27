// core/mom-channel.js 的单测（2026-10-28 第 19 轮）：妈妈通道的文件读写。
// 全部用临时目录 root，不碰真实 state/。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  momChannelFile,
  readChannel,
  appendHerNote,
  takeUnanswered,
  markReplied,
  recentDialog,
  appendMomNote,
  renderMomBlock,
} from './mom-channel.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momch-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

test('readChannel：文件不存在时返回空列表', (t) => {
  const root = tempRoot(t);
  assert.deepEqual(readChannel(root), { messages: [] });
  assert.ok(momChannelFile(root).endsWith(path.join('state', 'mom-channel.json')));
});

test('appendHerNote：空白折叠、裁剪 300 字、空串返回 null', (t) => {
  const root = tempRoot(t);
  assert.equal(appendHerNote(root, '   ', 1), null);
  const msg = appendHerNote(root, `  今天\n\n有点  累 ${'啊'.repeat(400)}  `, 1750000000000, ' private:1 ');
  assert.ok(msg);
  assert.equal(msg.from, '小鲸鱼');
  assert.equal(msg.replied, false);
  assert.equal(msg.key, 'private:1');
  assert.ok(msg.text.length <= 300);
  assert.doesNotMatch(msg.text, /\n/);
  assert.match(msg.shown, /^\d{1,2}-\d{1,2} \d{2}:\d{2}$/);
});

test('takeUnanswered：只取她未回复的留言', (t) => {
  const root = tempRoot(t);
  const a = appendHerNote(root, '第一条', 1000);
  appendHerNote(root, '第二条', 2000);
  appendMomNote(root, '妈妈的回复', 3000);
  let unanswered = takeUnanswered(root);
  assert.equal(unanswered.length, 2);
  markReplied(root, a);
  unanswered = takeUnanswered(root);
  assert.equal(unanswered.length, 1);
  assert.equal(unanswered[0].text, '第二条');
});

test('markReplied：按 at+text 精确匹配，别的留言不受影响', (t) => {
  const root = tempRoot(t);
  const a = appendHerNote(root, '同一句话', 1111);
  const b = appendHerNote(root, '同一句话', 2222);
  markReplied(root, a);
  const left = takeUnanswered(root);
  assert.equal(left.length, 1);
  assert.equal(left[0].at, b.at);
});

test('appendMomNote：裁剪 500 字并带 shown 时间', (t) => {
  const root = tempRoot(t);
  const msg = appendMomNote(root, '妈'.repeat(600), 1750000000000);
  assert.equal(msg.from, '妈妈');
  assert.equal(msg.text.length, 500);
  assert.ok(msg.shown);
});

test('renderMomBlock：只取最近 5 条妈妈的话；没有就空串', (t) => {
  const root = tempRoot(t);
  assert.equal(renderMomBlock(root), '');
  appendHerNote(root, '她的话', 1);
  for (let i = 1; i <= 6; i += 1) appendMomNote(root, `妈${i}`, 1000 + i);
  const block = renderMomBlock(root, 5);
  assert.match(block, /【妈妈留言】/);
  assert.match(block, /妈6/);
  assert.doesNotMatch(block, /妈1/);   // 第 6 条往后截
  assert.doesNotMatch(block, /她的话/);
});

test('recentDialog：按时间顺序取最近 limit 条（她+妈妈）', (t) => {
  const root = tempRoot(t);
  appendHerNote(root, '她1', 1);
  appendMomNote(root, '妈1', 2);
  appendHerNote(root, '她2', 3);
  const recent = recentDialog(root, 2);
  assert.deepEqual(recent.map((m) => m.text), ['妈1', '她2']);
});

test('消息上限 200 条：超了只留最近 200', (t) => {
  const root = tempRoot(t);
  for (let i = 0; i < 205; i += 1) appendHerNote(root, `第${i}条`, i + 1);
  const data = readChannel(root);
  assert.equal(data.messages.length, 200);
  assert.equal(data.messages.at(-1).text, '第204条');
});
