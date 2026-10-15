// src/core/ratelimit.js 的测试。
//
// 重点是**差分测试**：把抽出前内联在 console/server.js 各处的那段逻辑逐字复刻成
// orig* 函数，用随机场景 A/B 对拍。这样"看着一样"就变成了"跑出来一样"。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countRecent,
  rateLimitCheck,
  reserveSlots,
  rollbackSlots,
  replyBudgetExtra,
  hourCapFor,
  DIRECT_REPLY_REASONS,
  RATE_LIMIT_ERROR,
  WINDOW_MINUTE_MS,
  WINDOW_HOUR_MS,
  TIMES_CAP
} from './ratelimit.js';

// ---------------------------------------------------------------- 原实现（逐字复刻）

function origCheck(st, sendCfg, now, count) {
  const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
  const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
  const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
  const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
  return (maxPerMinute > 0 && recentMinute + count > maxPerMinute) || (maxPerHour > 0 && recentHour + count > maxPerHour);
}

function origReserve(st, now, count) {
  for (let i = 0; i < count; i++) st.sendTimes.push(now);
  if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
  return st.sendTimes;
}

function origRollback(st, now, count) {
  for (let i = 0; i < count; i++) {
    const idx = st.sendTimes.indexOf(now);
    if (idx >= 0) st.sendTimes.splice(idx, 1);
  }
  if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
  return st.sendTimes;
}

// ---------------------------------------------------------------- 基本语义

test('countRecent：按 1 分钟 / 1 小时两个窗口分别计数', () => {
  const now = 1_700_000_000_000;
  const times = [now - 1, now - 59_999, now - 60_000, now - 3_599_999, now - 3_600_000];
  const r = countRecent(times, now);
  assert.equal(r.minute, 2, '前两条在 1 分钟内');
  assert.equal(r.hour, 4, '最后一条刚好整 1 小时，落在窗口外');
});

test('countRecent：非数组按空处理', () => {
  assert.deepEqual(countRecent(undefined, 0), { minute: 0, hour: 0 });
  assert.deepEqual(countRecent(null, 0), { minute: 0, hour: 0 });
});

test('rateLimitCheck：刚好卡在上限还算通过，超一条就不行', () => {
  const now = 1_000_000;
  const cfg = { maxPerMinute: 8, maxPerHour: 80, now };
  const seven = Array.from({ length: 7 }, () => now);
  assert.equal(rateLimitCheck(seven, { ...cfg, count: 1 }).ok, true, '7 + 1 = 8，允许');
  assert.equal(rateLimitCheck(seven, { ...cfg, count: 2 }).ok, false, '7 + 2 = 9，超了');
  const eight = Array.from({ length: 8 }, () => now);
  assert.equal(rateLimitCheck(eight, { ...cfg, count: 1 }).ok, false);
});

test('rateLimitCheck：max 为 0 或非法值表示不限，不是禁止', () => {
  const now = 1_000_000;
  const many = Array.from({ length: 400 }, () => now);
  for (const cfg of [{ maxPerMinute: 0, maxPerHour: 0 }, { maxPerMinute: undefined, maxPerHour: NaN }, { maxPerMinute: 'x', maxPerHour: null }]) {
    assert.equal(rateLimitCheck(many, { ...cfg, count: 99, now }).ok, true, JSON.stringify(cfg));
  }
});

test('rateLimitCheck：小时窗口也会拦住（分钟没满时）', () => {
  const now = 1_000_000;
  // 80 条分布在 1 小时里但都不在最近 1 分钟
  const times = Array.from({ length: 80 }, (_, i) => now - 120_000 - i * 40_000);
  const r = rateLimitCheck(times, { maxPerMinute: 8, maxPerHour: 80, count: 1, now });
  assert.equal(r.minute, 0);
  assert.equal(r.hour, 80);
  assert.equal(r.overHour, true);
  assert.equal(r.overMinute, false);
  assert.equal(r.ok, false);
});

test('reserveSlots：预占 count 条，且按 500 封顶', () => {
  const now = 42;
  assert.deepEqual(reserveSlots([], { count: 3, now }), [42, 42, 42]);
  const full = Array.from({ length: 500 }, (_, i) => i);
  const next = reserveSlots(full, { count: 2, now });
  assert.equal(next.length, TIMES_CAP);
  assert.equal(next[next.length - 1], now, '封顶后留下的是最新的');
  assert.equal(next[0], 2, '最旧的两条被挤掉');
});

test('reserveSlots：不改入参', () => {
  const input = [1, 2];
  const out = reserveSlots(input, { count: 1, now: 3 });
  assert.deepEqual(input, [1, 2]);
  assert.deepEqual(out, [1, 2, 3]);
});

test('rollbackSlots：删掉的是第一个等于 now 的记录，且不改入参', () => {
  const input = [5, 9, 9, 7];
  const out = rollbackSlots(input, { count: 1, now: 9 });
  assert.deepEqual(out, [5, 9, 7]);
  assert.deepEqual(input, [5, 9, 9, 7]);
});

test('rollbackSlots：now 不在数组里时什么都不删', () => {
  assert.deepEqual(rollbackSlots([1, 2, 3], { count: 3, now: 99 }), [1, 2, 3]);
});

test('rollbackSlots：count 大于实际条数时只删到没有为止', () => {
  assert.deepEqual(rollbackSlots([9, 9], { count: 5, now: 9 }), []);
});

test('预占后回滚，数组回到原样（五条发送路径的共同契约）', () => {
  const now = 1_700_000_000_000;
  let times = [now - 1000];
  times = reserveSlots(times, { count: 3, now });
  assert.equal(times.length, 4);
  times = rollbackSlots(times, { count: 3, now });
  assert.deepEqual(times, [now - 1000]);
});

// ---------------------------------------------------------------- 差分对拍

/** 可复现的伪随机（mulberry32），避免用 Math.random 导致失败无法重放。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('差分：rateLimitCheck 与内联原实现逐场景一致', () => {
  const rand = rng(20260918);
  const now = 1_700_000_000_000;
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    // 时间戳刻意贴着重叠边界生成，容易踩到窗口边界
    const len = Math.floor(rand() * 30);
    const times = Array.from({ length: len }, () => now - Math.floor(rand() * 4_000_000));
    const sendCfg = {
      maxSendPerMinute: [0, 1, 2, 8, 80][Math.floor(rand() * 5)],
      maxSendPerHour: [0, 3, 80, 200][Math.floor(rand() * 4)]
    };
    const count = 1 + Math.floor(rand() * 8);
    const st = { sendTimes: times };
    const want = origCheck(st, sendCfg, now, count);
    const got = !rateLimitCheck(times, {
      maxPerMinute: sendCfg.maxSendPerMinute,
      maxPerHour: sendCfg.maxSendPerHour,
      count,
      now
    }).ok;
    assert.equal(got, want, `第 ${i} 次：times=${JSON.stringify(times)} cfg=${JSON.stringify(sendCfg)} count=${count}`);
    checked += 1;
  }
  assert.equal(checked, 3000);
});

test('差分：reserveSlots / rollbackSlots 与内联原实现结果数组一致', () => {
  const rand = rng(9818);
  const now = 1_700_000_000_000;
  for (let i = 0; i < 2000; i++) {
    const len = Math.floor(rand() * 20);
    const base = Array.from({ length: len }, () => now - Math.floor(rand() * 10) * 1000);
    const count = 1 + Math.floor(rand() * 6);

    const stR = { sendTimes: base.slice() };
    const wantR = origReserve(stR, now, count);
    const gotR = reserveSlots(base, { count, now });
    assert.deepEqual(gotR, wantR, `reserve 第 ${i} 次`);

    // 回滚在一个"刚预占过"的数组上做，覆盖 indexOf 删重复值的路径
    const stB = { sendTimes: wantR.slice() };
    const wantB = origRollback(stB, now, count);
    const gotB = rollbackSlots(wantR, { count, now });
    assert.deepEqual(gotB, wantB, `rollback 第 ${i} 次`);
  }
});

test('差分：封顶行为一致（超过 500 条时）', () => {
  const now = 1_700_000_000_000;
  const base = Array.from({ length: 505 }, (_, i) => now - (505 - i) * 1000);
  const st = { sendTimes: base.slice() };
  assert.deepEqual(reserveSlots(base, { count: 1, now }), origReserve(st, now, 1));
  const st2 = { sendTimes: base.slice() };
  assert.deepEqual(rollbackSlots(base, { count: 1, now: base[0] }), origRollback(st2, base[0], 1));
});

// ---------------------------------------------------------------- 回复额度（2026-09-19 事故的补丁）

const BUDGET_CFG = { maxSendPerHour: 80, replyBudgetPerHour: 30, replyBudgetWindowMs: 600000 };
const NOW = 1_700_000_000_000;
const directSt = (reason, agoMs = 0) => ({ lastWakeReason: reason, wakeConfig: { lastWakeAt: NOW - agoMs } });

test('回复额度：被直接叫醒的回合才有，且只在窗口内', () => {
  assert.equal(replyBudgetExtra(directSt('atMention'), BUDGET_CFG, NOW), 30);
  assert.equal(replyBudgetExtra(directSt('followUp'), BUDGET_CFG, NOW), 30);
  // 窗口过期（默认 10 分钟）→ 没有额外额度
  assert.equal(replyBudgetExtra(directSt('atMention', 600001), BUDGET_CFG, NOW), 0);
  // 时钟倒退（lastWakeAt 在未来）也算不可信，不给额度
  assert.equal(replyBudgetExtra({ lastWakeReason: 'atMention', wakeConfig: { lastWakeAt: NOW + 1000 } }, BUDGET_CFG, NOW), 0);
});

test('回复额度：主动插话的回合不给（否则等于取消了刷屏保护）', () => {
  for (const reason of ['probability', 'anyMessage', 'keyword:DS', 'question']) {
    assert.equal(replyBudgetExtra(directSt(reason), BUDGET_CFG, NOW), 0, reason);
  }
  assert.equal(replyBudgetExtra({}, BUDGET_CFG, NOW), 0);
  assert.equal(replyBudgetExtra(directSt('atMention'), {}, NOW), 0, '没配额度就是 0');
  assert.equal(replyBudgetExtra({ lastWakeReason: 'atMention' }, BUDGET_CFG, NOW), 0, '没有 lastWakeAt 不给额度');
});

test('回复额度：DIRECT_REPLY_REASONS 覆盖"必须回"的全部原因', () => {
  // 和 src/domains/wake.js 的 MUST_WAKE_REASONS 对齐；漏一个就会退化成"某个入口叫醒她时不许还嘴"。
  assert.deepEqual(
    [...DIRECT_REPLY_REASONS].sort(),
    ['atMention', 'followUp', 'nameMention', 'poke', 'private', 'redPacket'].sort()
  );
});

test('hourCapFor：只能加，不能减；基础值为 0（不限）时不叠加', () => {
  // 事故复现：80/时的额度被闲聊烧完 → 被叫醒的回合仍要多 30 条可用
  assert.equal(hourCapFor(directSt('atMention'), BUDGET_CFG, NOW), 110);
  assert.equal(hourCapFor(directSt('probability'), BUDGET_CFG, NOW), 80);
  // 0 = 不限：绝不能因为"加了回复额度"反而给它加上限
  assert.equal(hourCapFor(directSt('atMention'), { maxSendPerHour: 0, replyBudgetPerHour: 30 }, NOW), 0);
  assert.equal(hourCapFor(directSt('atMention'), { replyBudgetPerHour: 30 }, NOW), 0);
});

test('事故复现：额度烧满时，被叫醒的回合还能发出去，主动插话的不能', () => {
  const full = { sendTimes: Array.from({ length: 80 }, (_, i) => NOW - i * 10_000) }; // 一小时内已发 80 条
  const check = (st, sendCfg) => rateLimitCheck(st.sendTimes, {
    maxPerMinute: 8,
    maxPerHour: hourCapFor(st, sendCfg, NOW),
    count: 1,
    now: NOW
  }).ok;
  assert.equal(check({ ...full, ...directSt('atMention') }, BUDGET_CFG), true, '被 @ 时必须还能还嘴');
  assert.equal(check({ ...full, ...directSt('probability') }, BUDGET_CFG), false, '主动插话该被拦');
});

// ---------------------------------------------------------------- 导出面

test('RATE_LIMIT_ERROR 必须是模块导出的常量（曾经漏了 export，只靠 node --check 拦不住）', () => {
  // 背景：console/server.js 里 `import { ..., RATE_LIMIT_ERROR } from '../core/ratelimit.js'`。
  // 漏导出时 `node --check` 照样通过（它只解析语法、不解析 import），桥却是启动即
  // SyntaxError 死掉 —— 而且手动 Start-Process 不重定向 stderr 的话，报错直接丢掉，
  // 表面现象只是「控制台端口没了」。所以这条测试的意义是：让它在 npm test 里离线爆出来。
  assert.equal(typeof RATE_LIMIT_ERROR, 'string');
  assert.ok(RATE_LIMIT_ERROR.length > 0);
  assert.equal(RATE_LIMIT_ERROR, '发送频率超限，请稍后再试');
});

test('窗口常量与内联实现里的字面量一致', () => {
  assert.equal(WINDOW_MINUTE_MS, 60000);
  assert.equal(WINDOW_HOUR_MS, 3600000);
  assert.equal(TIMES_CAP, 500);
});

// ---------------------------------------------------------------- 与旧实现的唯一分歧

test('分歧（有意）：sendTimes 不是数组时本模块按空处理，原实现会抛 TypeError', () => {
  // 生产代码里 sendTimes 由状态 schema 保证是数组，且各自都有 `= st.x || []` 兜底，
  // 所以这条分歧碰不到。写出来是为了让"我们改了什么"是显式的。
  assert.deepEqual(reserveSlots(undefined, { count: 1, now: 7 }), [7]);
  assert.throws(() => origReserve({ sendTimes: undefined }, 7, 1), TypeError);
});
