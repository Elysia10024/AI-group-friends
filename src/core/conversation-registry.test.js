// core/conversation-registry.js 的单测（第 2 期；被 src/**/*.test.js 捡到）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationRegistry } from './conversation-registry.js';

test('disposeKey 删所有 conv store，不碰 session store', () => {
  const r = createConversationRegistry();
  const a = new Map([['group:1', 1], ['group:2', 2]]);
  const b = new Set(['group:1']);
  const s = new Map([['session-x', 1]]);
  r.register('conv', 'a', a);
  r.register('conv', 'b', b);
  r.register('session', 's', s);
  r.disposeKey('group:1');
  assert.equal(a.has('group:1'), false);
  assert.equal(b.has('group:1'), false);
  assert.equal(a.get('group:2'), 2);
  assert.equal(s.has('session-x'), true);
});

test('disposeSession 只删 session 组', () => {
  const r = createConversationRegistry();
  const c = new Map([['group:1', 1]]);
  const s = new Map([['session-x', 1], ['session-y', 2]]);
  r.register('conv', 'c', c);
  r.register('session', 's', s);
  r.disposeSession('session-x');
  assert.deepEqual([...s.keys()], ['session-y']);
  assert.equal(c.has('group:1'), true);
});

test('适配器：删除语义由 store 自己定义（pending 那种带副作用的）', () => {
  const r = createConversationRegistry();
  const inner = new Map([['group:1', { timer: 1 }]]);
  const cleaned = [];
  r.register('conv', 'pending', {
    has: (k) => inner.has(k),
    delete: (k) => { cleaned.push(k); inner.delete(k); },
  });
  r.disposeKey('group:1');
  assert.deepEqual(cleaned, ['group:1']);
  assert.equal(inner.size, 0);
});

test('clearSessions 整表清 session 组，conv 不动', () => {
  const r = createConversationRegistry();
  const c = new Map([['group:1', 1]]);
  const s1 = new Map([['a', 1]]);
  const s2 = new Set(['b']);
  r.register('conv', 'c', c);
  r.register('session', 's1', s1);
  r.register('session', 's2', s2);
  r.clearSessions();
  assert.equal(s1.size, 0);
  assert.equal(s2.size, 0);
  assert.equal(c.size, 1);
});

test('clearStores 只清名单里的，名字不存在不炸', () => {
  const r = createConversationRegistry();
  const a = new Map([['x', 1]]);
  const b = new Map([['x', 1]]);
  r.register('conv', 'a', a);
  r.register('conv', 'b', b);
  r.clearStores(['a', '不存在的']);
  assert.equal(a.size, 0);
  assert.equal(b.size, 1);
});

test('重复登记抛错（防止两个 store 同名、清理时漏一个）', () => {
  const r = createConversationRegistry();
  r.register('conv', 'a', new Map());
  assert.throws(() => r.register('conv', 'a', new Map()), /已登记/);
  assert.throws(() => r.register('nope', 'a', new Map()), /未知 group/);
});

test('names 列出已登记名字（守卫可以拿它和清理清单对账）', () => {
  const r = createConversationRegistry();
  r.register('conv', 'queued', new Map());
  r.register('session', 'collectors', new Map());
  assert.deepEqual(r.names('conv'), ['queued']);
  assert.deepEqual(r.names('session'), ['collectors']);
});
