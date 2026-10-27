// core/takeover.js 的单测（2026-10-28 第 19 轮）：妈妈接管模式的状态机与文件读写。
// 全部用临时目录 root，不碰真实 state/。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  takeoverFile,
  readTakeover,
  isTakeoverOn,
  startTakeover,
  stopTakeover,
  appendOwnerMessage,
  appendMomMessage,
  unansweredOwnerMessages,
  recentTakeoverDialog,
} from './takeover.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'takeover-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

test('readTakeover：文件不存在时是关闭状态', (t) => {
  const root = tempRoot(t);
  assert.deepEqual(readTakeover(root), { on: false, startedAt: 0, messages: [] });
  assert.ok(takeoverFile(root).endsWith(path.join('state', 'takeover.json')));
  assert.equal(isTakeoverOn(root), false);
});

test('start/stop：切换开关并记录时间点', (t) => {
  const root = tempRoot(t);
  const s = startTakeover(root, 1111);
  assert.equal(s.on, true);
  assert.equal(s.startedAt, 1111);
  assert.equal(isTakeoverOn(root), true);
  const stopped = stopTakeover(root);
  assert.equal(stopped.on, false);
  assert.ok(stopped.stoppedAt > 0);
  assert.equal(isTakeoverOn(root), false);
});

test('appendOwnerMessage：裁剪 500 字，初始未回', (t) => {
  const root = tempRoot(t);
  startTakeover(root, 1);
  const msg = appendOwnerMessage('主'.repeat(600), root, 1750000000000);
  assert.equal(msg.role, 'owner');
  assert.equal(msg.text.length, 500);
  assert.equal(msg.replied, false);
  assert.deepEqual(unansweredOwnerMessages(root).map((m) => m.text), [msg.text]);
});

test('appendMomMessage：把之前所有主人消息标记为已回', (t) => {
  const root = tempRoot(t);
  startTakeover(root, 1);
  appendOwnerMessage('主1', root, 1000);
  appendOwnerMessage('主2', root, 2000);
  assert.equal(unansweredOwnerMessages(root).length, 2);
  const mom = appendMomMessage('妈的回话', root, 3000);
  assert.equal(mom.role, 'mom');
  assert.equal(unansweredOwnerMessages(root).length, 0);
});

test('已回的主人消息不再出现在 unanswered 里', (t) => {
  const root = tempRoot(t);
  startTakeover(root, 1);
  appendOwnerMessage('主1', root, 1000);
  appendMomMessage('回过了', root, 2000);
  appendOwnerMessage('主2', root, 3000);
  assert.deepEqual(unansweredOwnerMessages(root).map((m) => m.text), ['主2']);
});

test('recentTakeoverDialog：取最近 limit 条（两种角色都算）', (t) => {
  const root = tempRoot(t);
  startTakeover(root, 1);
  appendOwnerMessage('主1', root, 1000);
  appendMomMessage('妈1', root, 2000);
  appendOwnerMessage('主2', root, 3000);
  const recent = recentTakeoverDialog(root, 2);
  assert.deepEqual(recent.map((m) => m.text), ['妈1', '主2']);
});

test('消息上限 200 条：超了只留最近 200', (t) => {
  const root = tempRoot(t);
  startTakeover(root, 1);
  for (let i = 0; i < 205; i += 1) appendOwnerMessage(`第${i}条`, root, i + 1);
  const state = readTakeover(root);
  assert.equal(state.messages.length, 200);
  assert.equal(state.messages.at(-1).text, '第204条');
});
