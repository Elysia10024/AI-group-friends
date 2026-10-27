// core/poke-guard.js 单测（2026-10-28 防御方案·连续戳）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPokeGuard } from './poke-guard.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; } };
}

test('第 3 次触发；前两次不触发', () => {
  const c = clock();
  const g = createPokeGuard({ now: c.now });
  assert.deepEqual(g.note('group:1'), { count: 1, trigger: false });
  assert.deepEqual(g.note('group:1'), { count: 2, trigger: false });
  assert.deepEqual(g.note('group:1'), { count: 3, trigger: true });
  assert.deepEqual(g.note('group:1'), { count: 4, trigger: true });
});

test('reset 后重新计数', () => {
  const c = clock();
  const g = createPokeGuard({ now: c.now });
  g.note('group:1'); g.note('group:1'); g.note('group:1');
  g.reset('group:1');
  assert.equal(g.peek('group:1'), 0);
  assert.deepEqual(g.note('group:1'), { count: 1, trigger: false });
});

test('窗口过期：5 分钟前的戳不再计入', () => {
  const c = clock();
  const g = createPokeGuard({ now: c.now });
  g.note('group:1');
  g.note('group:1');
  c.tick(5 * 60 * 1000 + 1);
  assert.equal(g.peek('group:1'), 0, '窗口外全部过期');
  assert.deepEqual(g.note('group:1'), { count: 1, trigger: false });
});

test('窗口边界：刚好小于窗口的算，等于窗口的不算', () => {
  const c = clock(1000);
  const g = createPokeGuard({ now: c.now });
  g.note('group:1');
  c.tick(5 * 60 * 1000 - 1);
  assert.equal(g.peek('group:1'), 1);
  c.tick(1);
  assert.equal(g.peek('group:1'), 0);
});

test('跨会话隔离：群 1 的戳不影响群 2', () => {
  const c = clock();
  const g = createPokeGuard({ now: c.now });
  g.note('group:1'); g.note('group:1'); g.note('group:1');
  assert.deepEqual(g.note('group:2'), { count: 1, trigger: false });
  assert.equal(g.peek('group:1'), 3);
});

test('peek 不推进计数', () => {
  const c = clock();
  const g = createPokeGuard({ now: c.now });
  g.note('group:1');
  g.peek('group:1'); g.peek('group:1');
  assert.deepEqual(g.note('group:1'), { count: 2, trigger: false });
});

test('阈值/窗口可配', () => {
  const c = clock();
  const g = createPokeGuard({ threshold: 5, windowMs: 60 * 1000, now: c.now });
  for (let i = 1; i <= 4; i++) assert.equal(g.note('group:1').trigger, false);
  assert.equal(g.note('group:1').trigger, true);
});
