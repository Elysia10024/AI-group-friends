// src/core/msg-density.js 的测试。跑法：npm test / node --test src/core/*.test.js
//
// 这个机制的钱全花在"该不该叫她"上，所以每条分支（disabled / quiet-hours / too-few /
// cooldown / daily-cap / dice / ok）都要有一条能红的断言 —— 少测一条，线上就是"她多花了一轮钱"
// 或者"该插话时永远不插"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DENSITY_DEFAULTS, pushStamp, densityDecision, inActiveHours } from './msg-density.js';

const NOW = new Date('2026-10-14T20:30:00+08:00').getTime();
const MIN = 60 * 1000;
const ago = (ms) => NOW - ms;

/** 造一批"窗口内"的时间戳（默认 25 条 = 刚好达标）。 */
const stamps = (n, gapMs = 1000) => Array.from({ length: n }, (_, i) => NOW - (n - i) * gapMs);

/** 判定用的基线参数：所有闸门都开着，骰子必中。 */
const base = (over = {}) => ({
  stamps: stamps(25),
  now: NOW,
  cfg: { ...DENSITY_DEFAULTS },
  lastTriggerAt: 0,
  triggeredToday: 0,
  hour: 20,
  random: 0.1,
  ...over
});

// ---------- pushStamp ----------
test('pushStamp：裁掉窗口外的旧时间戳（正好卡在边界上的也算过期）', () => {
  const W = 10 * MIN;
  const old = [ago(W + 1), ago(W), ago(60 * 1000)];
  const out = pushStamp(old, NOW, { windowMs: W, maxKeep: 300 });
  assert.deepEqual(out, [ago(60 * 1000), NOW]);
  assert.deepEqual(old, [ago(W + 1), ago(W), ago(60 * 1000)], '不许改入参（调用方手里那份还要用）');
  assert.notEqual(out, old, '必须是新数组');
});

test('pushStamp：超过 maxKeep 时只留最新那批', () => {
  const out = pushStamp([ago(5000), ago(4000), ago(3000)], NOW, { windowMs: 10 * MIN, maxKeep: 3 });
  assert.deepEqual(out, [ago(4000), ago(3000), NOW]);
  assert.equal(out.length, 3);
});

test('pushStamp：maxKeep 填 0 = 没配，回落默认值（别把窗口清空）', () => {
  const out = pushStamp([ago(1000)], NOW, { windowMs: 10 * MIN, maxKeep: 0 });
  assert.deepEqual(out, [ago(1000), NOW], '0 不当成"一个都不留"：那样这个会话会永远攒不出密度，且静默无声');
  assert.deepEqual(pushStamp([ago(1000)], NOW, { windowMs: 10 * MIN, maxKeep: 'x' }), [ago(1000), NOW]);
});

test('pushStamp：坏数据不炸，也不把脏值灌进窗口', () => {
  assert.deepEqual(pushStamp(null, NOW, { windowMs: 10 * MIN, maxKeep: 300 }), [NOW]);
  assert.deepEqual(pushStamp([ago(1000), 'x', null], NOW, { windowMs: 10 * MIN, maxKeep: 300 }), [ago(1000), NOW]);
  const old = [ago(1000)];
  assert.deepEqual(pushStamp(old, NaN, { windowMs: 10 * MIN, maxKeep: 300 }), [ago(1000)], 'now 是 NaN 就只复制');
  assert.notEqual(pushStamp(old, NaN, {}), old);
});

// ---------- 时段 ----------
test('时段：恰好到阈值与差一条（边界的那一条要能决定成败）', () => {
  assert.equal(densityDecision(base({ stamps: stamps(25) })).reason, 'ok', '刚好 25 条 = 该有机会');
  assert.equal(densityDecision(base({ stamps: stamps(24) })).reason, 'too-few', '24 条 = 还差一条');
  assert.equal(densityDecision(base({ stamps: [] })).reason, 'too-few');
});

test('时段：窗口外的旧消息不算热闹（不能拿半小时前的热闹当现在）', () => {
  const list = [...stamps(20, 1000), ...Array.from({ length: 20 }, () => ago(20 * MIN))];
  assert.equal(densityDecision(base({ stamps: list })).reason, 'too-few', '窗口外的一律不计');
});

test('quiet-hours：不在允许时段（含跨午夜时段）', () => {
  assert.equal(densityDecision(base({ hour: 3 })).reason, 'quiet-hours');
  assert.equal(densityDecision(base({ hour: 9 })).reason, 'ok', '起点含头');
  assert.equal(densityDecision(base({ hour: 23 })).reason, 'ok');
  assert.equal(densityDecision(base({ hour: 23, cfg: { ...DENSITY_DEFAULTS, activeHourStart: 9, activeHourEnd: 24 } })).reason, 'ok');
  // 跨午夜 9→2：晚上 9 点到凌晨 2 点都算允许
  const cross = { ...DENSITY_DEFAULTS, activeHourStart: 9, activeHourEnd: 2 };
  assert.equal(densityDecision(base({ hour: 23, cfg: cross })).reason, 'ok');
  assert.equal(densityDecision(base({ hour: 1, cfg: cross })).reason, 'ok');
  assert.equal(densityDecision(base({ hour: 2, cfg: cross })).reason, 'quiet-hours', '终点不含尾');
  assert.equal(densityDecision(base({ hour: 5, cfg: cross })).reason, 'quiet-hours');
  // 没传 hour 一律静默：宁可少叫一次，也不要在纯函数里偷读机器时钟
  assert.equal(densityDecision(base({ hour: undefined })).reason, 'quiet-hours');
  assert.equal(inActiveHours(20, 9, 24), true);
  assert.equal(inActiveHours(8, 9, 24), false);
});

test('cooldown：冷却中不触发，冷却刚好到期就放行', () => {
  const cd = DENSITY_DEFAULTS.cooldownMs;
  assert.equal(densityDecision(base({ lastTriggerAt: ago(cd - 1000) })).reason, 'cooldown');
  assert.equal(densityDecision(base({ lastTriggerAt: ago(cd) })).reason, 'ok', '隔满 30 分钟就放行');
  assert.equal(densityDecision(base({ lastTriggerAt: 0 })).reason, 'ok', '从没触发过');
});

test('daily-cap：当天用满就不再给机会', () => {
  assert.equal(densityDecision(base({ triggeredToday: DENSITY_DEFAULTS.dailyCap })).reason, 'daily-cap');
  assert.equal(densityDecision(base({ triggeredToday: DENSITY_DEFAULTS.dailyCap - 1 })).reason, 'ok', '还剩最后一次');
  assert.equal(densityDecision(base({ triggeredToday: 0, cfg: { ...DENSITY_DEFAULTS, dailyCap: 0 } })).reason, 'daily-cap', 'cap 填 0 = 关掉');
});

test('dice：达标也要掷中才叫她（0.5 时 0.49 中、0.5 不中）', () => {
  assert.equal(densityDecision(base({ random: 0.49 })).reason, 'ok');
  assert.equal(densityDecision(base({ random: 0.5 })).reason, 'dice');
  assert.equal(densityDecision(base({ random: 0.99 })).reason, 'dice');
  // probability=1 必中、=0 必不中（主人把骰子关掉时语义要干净）
  assert.equal(densityDecision(base({ random: 0.99, cfg: { ...DENSITY_DEFAULTS, probability: 1 } })).reason, 'ok');
  assert.equal(densityDecision(base({ random: 0.0001, cfg: { ...DENSITY_DEFAULTS, probability: 0 } })).reason, 'dice');
});

test('disabled：关掉就是关掉，谁来都不叫（reason 也不许变成别的）', () => {
  // 其它闸门全都满足，仍然只能得到 disabled —— 关闭开关必须是最高优先级
  assert.deepEqual(
    densityDecision(base({ cfg: { ...DENSITY_DEFAULTS, enabled: false } })),
    { wake: false, reason: 'disabled' }
  );
  assert.equal(densityDecision(base({ hour: 3, cfg: { ...DENSITY_DEFAULTS, enabled: false } })).reason, 'disabled');
});

test('判定顺序：disabled → quiet-hours → too-few → cooldown → daily-cap → dice', () => {
  // 多个闸门同时不满足时，reason 要报**最靠前**的那一道（日志据此排障，报错了就会白查半天）
  const off = { ...DENSITY_DEFAULTS, enabled: false };
  assert.equal(densityDecision(base({ cfg: off, hour: 3, stamps: [], lastTriggerAt: NOW, triggeredToday: 99, random: 0.99 })).reason, 'disabled');
  assert.equal(densityDecision(base({ hour: 3, stamps: [], lastTriggerAt: NOW, triggeredToday: 99, random: 0.99 })).reason, 'quiet-hours');
  assert.equal(densityDecision(base({ stamps: [], lastTriggerAt: NOW, triggeredToday: 99, random: 0.99 })).reason, 'too-few');
  assert.equal(densityDecision(base({ lastTriggerAt: NOW, triggeredToday: 99, random: 0.99 })).reason, 'cooldown');
  assert.equal(densityDecision(base({ triggeredToday: 99, random: 0.99 })).reason, 'daily-cap');
  assert.equal(densityDecision(base({ random: 0.99 })).reason, 'dice');
  assert.deepEqual(densityDecision(base()), { wake: true, reason: 'ok' });
});

test('缺 cfg / 坏 cfg 都按默认值走，不炸', () => {
  assert.equal(densityDecision({ stamps: stamps(25), now: NOW, hour: 12, random: 0 }).reason, 'ok');
  assert.equal(densityDecision({ stamps: stamps(25), now: NOW, hour: 12, random: 0, cfg: null }).reason, 'ok');
  assert.equal(densityDecision({ stamps: stamps(25), now: NOW, hour: 12, random: 0, cfg: 'nonsense' }).reason, 'ok');
  assert.equal(densityDecision({}).reason, 'quiet-hours', '全空也要给一个明确的 reason');
});

test('默认值：阈值/上限/时段就是规格里那几个数', () => {
  // 这些数是主人定的成本闸门，改它们等于改她的花钱速度 —— 钉住，改的时候必须是有意的
  assert.equal(DENSITY_DEFAULTS.windowMs, 10 * MIN);
  assert.equal(DENSITY_DEFAULTS.minMessages, 25);
  assert.equal(DENSITY_DEFAULTS.cooldownMs, 30 * MIN);
  assert.equal(DENSITY_DEFAULTS.dailyCap, 6);
  assert.equal(DENSITY_DEFAULTS.activeHourStart, 9);
  assert.equal(DENSITY_DEFAULTS.activeHourEnd, 24);
  assert.equal(DENSITY_DEFAULTS.probability, 0.5);
  assert.equal(DENSITY_DEFAULTS.maxKeep, 300);
});
