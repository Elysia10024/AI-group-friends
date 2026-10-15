import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDayKey, isSameLocalDay, nextLocalMidnight, fmtLocalNow, relativeDayLabel, RELATIVE_DAY_MIN_DAYS } from './local-day.js';

// 本地时区在测试机上可能是任意值，所以所有断言都**显式带偏移量**（UTC+8），不依赖机器时区。
const TZ = 480;

test('localDayKey 按 UTC+8 切日，而不是 UTC 日', () => {
  // 2026-10-12 07:30 本地 = 2026-10-11 23:30 UTC
  const t = Date.parse('2026-10-11T23:30:00Z');
  assert.equal(localDayKey(t, TZ), '2026-10-12');
  // 同一时刻按 UTC 算还是前一天 —— 这正是老写法的错
  assert.equal(new Date(t).toISOString().slice(0, 10), '2026-10-11');
});

test('localDayKey 边界：本地零点前是前一天，零点后是新一天', () => {
  const beforeMidnight = Date.parse('2026-10-11T15:59:59Z');   // 本地 23:59:59
  const afterMidnight = Date.parse('2026-10-11T16:00:00Z');    // 本地 00:00:00
  assert.equal(localDayKey(beforeMidnight, TZ), '2026-10-11');
  assert.equal(localDayKey(afterMidnight, TZ), '2026-10-12');
});

test('isSameLocalDay 承认跨 UTC 日的同一本地日', () => {
  const a = Date.parse('2026-10-11T16:10:00Z');   // 本地 10-12 00:10
  const b = Date.parse('2026-10-12T14:00:00Z');   // 本地 10-12 22:00
  assert.equal(isSameLocalDay(a, b, TZ), true);
  assert.equal(isSameLocalDay(a, Date.parse('2026-10-12T16:00:00Z'), TZ), false);  // 本地 10-13 00:00
});

test('nextLocalMidnight 指向本地零点（不是 UTC 零点）', () => {
  const now = Date.parse('2026-10-12T01:00:00Z');   // 本地 09:00
  const next = nextLocalMidnight(now, TZ);
  assert.equal(localDayKey(next, TZ), '2026-10-13');
  assert.equal(localDayKey(next - 1000, TZ), '2026-10-12');
  assert.equal(new Date(next).toISOString(), '2026-10-12T16:00:00.000Z');
});

test('nextLocalMidnight 正好在零点时指向下一个零点（不会返回自己）', () => {
  const midnight = Date.parse('2026-10-11T16:00:00Z');   // 本地 10-12 00:00:00
  const next = nextLocalMidnight(midnight, TZ);
  assert.ok(next > midnight);
  assert.equal(localDayKey(next, TZ), '2026-10-13');
});

test('传入垃圾值不炸：退回当前时间/默认时区', () => {
  assert.match(localDayKey(Number.NaN, TZ), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(localDayKey(Date.now(), 'x'), /^\d{4}-\d{2}-\d{2}$/);
});

// ── 材料里的【现在】与印象的相对时间（2026-10-14，修"她对时间没感知"）──
test('fmtLocalNow：带年份、星期与分钟（星期是"早八"这类事的坐标系）', () => {
  // 2026-10-14 是周三（和任务描述里写的"周二"对不上，以真实日历为准）
  assert.equal(fmtLocalNow(Date.parse('2026-10-14T23:07:00+08:00'), TZ), '2026-10-14 周三 23:07');
  assert.equal(fmtLocalNow(Date.parse('2026-10-11T16:00:00Z'), TZ), '2026-10-12 周一 00:00', '本地零点整');
  assert.equal(fmtLocalNow(Date.parse('2025-01-01T08:30:00+08:00'), TZ), '2025-01-01 周三 08:30', '跨年也要带年份');
  assert.match(fmtLocalNow(Number.NaN, TZ), /^\d{4}-\d{2}-\d{2} 周[日一二三四五六] \d{2}:\d{2}$/, '垃圾输入退回当前时间');
});

test('relativeDayLabel：默认门限 2 —— 今天和昨天都不标（印象那处的口径）', () => {
  const now = Date.parse('2026-10-14T23:07:00+08:00');
  assert.equal(relativeDayLabel(now - 5 * 60 * 1000, now), '', '刚刚');
  assert.equal(relativeDayLabel(now - 20 * 3600 * 1000, now), '', '今天凌晨');
  assert.equal(relativeDayLabel(Date.parse('2026-10-13T09:00:00+08:00'), now), '', '昨天');
  assert.equal(relativeDayLabel(Date.parse('2026-10-13T23:59:00+08:00'), now), '', '昨天最后一分钟');
});

test('relativeDayLabel：前天起才有标记，按日历天数（不是 24 小时）', () => {
  const now = Date.parse('2026-10-14T23:07:00+08:00');
  assert.equal(relativeDayLabel(Date.parse('2026-10-12T23:59:00+08:00'), now), '前天', '差 1 分钟不到 48 小时，仍是日历 2 天');
  assert.equal(relativeDayLabel(Date.parse('2026-10-12T00:05:00+08:00'), now), '前天');
  assert.equal(relativeDayLabel(Date.parse('2026-10-11T10:00:00+08:00'), now), '3 天前');
  assert.equal(relativeDayLabel(Date.parse('2026-10-02T10:00:00+08:00'), now), '12 天前', '早八那条样例的量级');
  assert.equal(relativeDayLabel(Date.parse('2026-09-15T10:00:00+08:00'), now), '29 天前');
});

test('relativeDayLabel：门限传 1（消息行用）—— 昨天也要标出来', () => {
  const now = Date.parse('2026-10-14T23:07:00+08:00');
  const M = 1;
  assert.equal(relativeDayLabel(Date.parse('2026-10-13T23:59:00+08:00'), now, TZ, M), '昨天');
  assert.equal(relativeDayLabel(Date.parse('2026-10-13T00:05:00+08:00'), now, TZ, M), '昨天');
  assert.equal(relativeDayLabel(Date.parse('2026-10-12T23:59:00+08:00'), now, TZ, M), '前天');
  assert.equal(relativeDayLabel(now - 5 * 60 * 1000, now, TZ, M), '', '今天不标：时钟前缀已经写了 HH:MM');
  assert.equal(relativeDayLabel(Date.parse('2026-10-11T10:00:00+08:00'), now, TZ, M), '3 天前');
  assert.equal(relativeDayLabel(Date.parse('2026-09-14T10:00:00+08:00'), now, TZ, M), '1 个月前');
});

test('relativeDayLabel：门限非法时落回默认（0 不当"每行都挂标记"）', () => {
  const now = Date.parse('2026-10-14T23:07:00+08:00');
  const yesterday = Date.parse('2026-10-13T10:00:00+08:00');
  for (const bad of [0, NaN, null, 'x', -3]) {
    assert.equal(relativeDayLabel(yesterday, now, TZ, bad), '', `门限 ${String(bad)} 该落回 2（昨天不标）`);
  }
  assert.equal(relativeDayLabel(Date.parse('2026-10-12T10:00:00+08:00'), now, TZ, 0), '前天', '落回 2 后前天照常显示');
});

test('relativeDayLabel：一个月往上换单位，跨月按日历算', () => {
  const now = Date.parse('2026-10-14T23:07:00+08:00');
  assert.equal(relativeDayLabel(Date.parse('2026-09-14T10:00:00+08:00'), now), '1 个月前', '正好 30 天');
  assert.equal(relativeDayLabel(Date.parse('2026-08-14T10:00:00+08:00'), now), '2 个月前');
});

test('relativeDayLabel：时间为 0 / 无效 / 未来一律不显示（老数据不动，也不编时间）', () => {
  const now = Date.parse('2026-10-14T23:07:00+08:00');
  assert.equal(relativeDayLabel(0, now), '', '老印象的 traitMeta 就是 0');
  assert.equal(relativeDayLabel(null, now), '');
  assert.equal(relativeDayLabel(undefined, now), '');
  assert.equal(relativeDayLabel('nonsense', now), '');
  assert.equal(relativeDayLabel(now + 3600000, now), '', '脏数据里时间比现在还晚 → 不显示');
  assert.equal(RELATIVE_DAY_MIN_DAYS, 2);
});

test('relativeDayLabel：本地午夜统一翻页（不是每条印象各自 24 小时翻）', () => {
  // 同一批印象在午夜前后判出来的天数应当整体 +1 —— 这正是"这个块一天最多变一次"的依据
  const before = Date.parse('2026-10-14T23:59:00+08:00');
  const after = Date.parse('2026-10-15T00:01:00+08:00');
  const traitAt = Date.parse('2026-10-02T10:00:00+08:00');
  assert.equal(relativeDayLabel(traitAt, before), '12 天前');
  assert.equal(relativeDayLabel(traitAt, after), '13 天前');
});
