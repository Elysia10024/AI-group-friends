// 静默判定（「关闭聊天功能」）的单测。
//
// 这组测试的意义：静默的**边界**（只群聊、私聊照常）必须被钉死 ——
// 上一版实现"连私聊一起静默"，用户明确说私聊要不受影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isChatMuted, isGroupKey } from './mute.js';

test('静默只对群聊生效', () => {
  assert.equal(isChatMuted('silent', 'group:20000001'), true);
  assert.equal(isChatMuted('silent', 'private:10000001'), false, '私聊不受静默影响');
  assert.equal(isChatMuted('silent', 'group:'), true, '前缀就够（key 一定是规范化的）');
});

test('非静默模式一律不拦', () => {
  for (const mode of ['active', 'chat', '', undefined, null, 'SILENT']) {
    assert.equal(isChatMuted(mode, 'group:20000001'), false, String(mode));
    assert.equal(isChatMuted(mode, 'private:10000001'), false, String(mode));
  }
});

test('私聊 key 不因为长得像群就误判', () => {
  assert.equal(isGroupKey('private:20000001'), false);
  assert.equal(isGroupKey(' group:123 '), true, '前后空白要容忍');
  assert.equal(isGroupKey(''), false);
  assert.equal(isGroupKey(undefined), false);
  assert.equal(isChatMuted('silent', 'groupchat:1'), false, '必须严格是 group: 前缀');
});
