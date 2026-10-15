// src/core/social-state.js 的测试。
//
// 这些函数小到"看一眼就对"，但正因为小，散着抄 7 遍时最容易某一遍抄漏一行 ——
// 所以测试的重点不是"值对不对"，而是**契约**：每个函数到底动哪几个字段、不动什么。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resetPreSleepWait,
  markAiSpoke,
  recentLimitOf,
  capList,
  DEFAULT_RECENT_LIMIT
} from './social-state.js';

/** 造一个带哨兵的 st：任何多余写入都会让它变化。 */
function makeSt() {
  return {
    preSleepWaitSatisfiedAt: 111,
    preSleepWaitObservedAt: 222,
    preSleepWaitAccumMs: 333,
    lastAiReplyAt: 444,
    lastActionAt: 555,
    wakeConfig: { noActionCount: 666, other: 'keep' },
    recentMessages: [],
    unread: []
  };
}

// ---------------------------------------------------------------- 原实现（逐字复刻）

function origReset(st) {
  st.preSleepWaitSatisfiedAt = 0;
  st.preSleepWaitObservedAt = 0;
  st.preSleepWaitAccumMs = 0;
}

function origMarkSpoke(st, now) {
  st.lastAiReplyAt = now;
  st.lastActionAt = now;
  st.wakeConfig.noActionCount = 0;
}

// ---------------------------------------------------------------- 契约

test('resetPreSleepWait：只动那三个字段，其余原样', () => {
  const st = makeSt();
  const ret = resetPreSleepWait(st);
  assert.equal(ret, st, '返回同一个对象，方便链式/忽略返回值');
  assert.equal(st.preSleepWaitSatisfiedAt, 0);
  assert.equal(st.preSleepWaitObservedAt, 0);
  assert.equal(st.preSleepWaitAccumMs, 0);
  assert.equal(st.lastAiReplyAt, 444, '不该碰活跃时间');
  assert.equal(st.wakeConfig.noActionCount, 666, '不该碰不动作计数');
  assert.equal(st.wakeConfig.other, 'keep');
});

test('markAiSpoke：写入 lastAiReplyAt / lastActionAt 并清零 noActionCount', () => {
  const st = makeSt();
  markAiSpoke(st, 12345);
  assert.equal(st.lastAiReplyAt, 12345);
  assert.equal(st.lastActionAt, 12345);
  assert.equal(st.wakeConfig.noActionCount, 0);
  assert.equal(st.wakeConfig.other, 'keep', '不该动 wakeConfig 的其它字段');
  assert.equal(st.preSleepWaitAccumMs, 333, '不该碰沉睡前等待状态');
});

test('recentLimitOf：读配置，缺省 100，非法值回退 100', () => {
  assert.equal(recentLimitOf({ socialV2: { context: { recentLimit: 30 } } }), 30);
  assert.equal(recentLimitOf({ socialV2: { context: {} } }), DEFAULT_RECENT_LIMIT);
  assert.equal(recentLimitOf({ socialV2: {} }), DEFAULT_RECENT_LIMIT);
  assert.equal(recentLimitOf({}), DEFAULT_RECENT_LIMIT);
  // 与 `Number(x) || 100` 一致：0 / NaN / 字符串都回退
  assert.equal(recentLimitOf({ socialV2: { context: { recentLimit: 0 } } }), DEFAULT_RECENT_LIMIT);
  assert.equal(recentLimitOf({ socialV2: { context: { recentLimit: 'abc' } } }), DEFAULT_RECENT_LIMIT);
  assert.equal(recentLimitOf({ socialV2: { context: { recentLimit: '42' } } }), 42);
});

test('capList：超上限裁掉最旧的，且就地修改', () => {
  const list = [1, 2, 3, 4, 5];
  const ret = capList(list, 3);
  assert.equal(ret, list, '返回同一个数组');
  assert.deepEqual(list, [3, 4, 5], '保留最新的 3 条');
});

test('capList：没超上限时不动', () => {
  const list = [1, 2];
  capList(list, 5);
  assert.deepEqual(list, [1, 2]);
  capList(list, 2);
  assert.deepEqual(list, [1, 2], '刚好等于上限也不裁');
});

test('capList：limit 为 0 时清空（与 `length > 0` 的原写法一致）', () => {
  const list = [1, 2];
  capList(list, 0);
  assert.deepEqual(list, []);
});

test('分歧（有意）：非数组时 capList 静默返回，原写法会抛 TypeError', () => {
  // 生产代码里 recentMessages 由状态 schema 保证是数组。写出来是为了让分歧显式。
  assert.doesNotThrow(() => capList(undefined, 5));
  assert.throws(() => { const l = undefined; if (l.length > 5) l.splice(0, l.length - 5); }, TypeError);
});

// ---------------------------------------------------------------- 差分对拍

test('差分：与内联原实现逐字段一致', () => {
  for (let i = 0; i < 500; i++) {
    const now = 1_700_000_000_000 + i * 977;

    const a = makeSt();
    const b = makeSt();
    resetPreSleepWait(a);
    origReset(b);
    assert.deepEqual(a, b, `reset 第 ${i} 次`);

    const c = makeSt();
    const d = makeSt();
    markAiSpoke(c, now);
    origMarkSpoke(d, now);
    assert.deepEqual(c, d, `markAiSpoke 第 ${i} 次`);

    const list = Array.from({ length: i % 12 }, (_, k) => k);
    const e = list.slice();
    const f = list.slice();
    capList(e, i % 7);
    if (f.length > (i % 7)) f.splice(0, f.length - (i % 7));
    assert.deepEqual(e, f, `capList 第 ${i} 次`);
  }
});
