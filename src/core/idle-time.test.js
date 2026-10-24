// src/core/idle-time.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { isIdleTime, idleHoursOnDay } from './idle-time.js';

// 北京时间 → 时间戳
const bj = (s) => Date.parse(`${s}+08:00`);

test('工作日高峰：9–12、14–18 不是空闲', () => {
  assert.equal(isIdleTime(bj('2026-10-23T09:00:00')).idle, false);
  assert.equal(isIdleTime(bj('2026-10-23T10:30:00')).idle, false);
  assert.equal(isIdleTime(bj('2026-10-23T14:00:00')).idle, false);
  assert.equal(isIdleTime(bj('2026-10-23T17:59:00')).idle, false);
});

test('工作日其余时段是空闲', () => {
  assert.equal(isIdleTime(bj('2026-10-23T08:59:00')).idle, true);
  assert.equal(isIdleTime(bj('2026-10-23T12:00:00')).idle, true);
  assert.equal(isIdleTime(bj('2026-10-23T12:30:00')).idle, true);
  assert.equal(isIdleTime(bj('2026-10-23T18:00:00')).idle, true);
  assert.equal(isIdleTime(bj('2026-10-23T23:30:00')).idle, true);
  assert.equal(isIdleTime(bj('2026-10-23T00:10:00')).idle, true);
});

test('周末全天空闲', () => {
  assert.equal(isIdleTime(bj('2026-10-24T10:00:00')).idle, true, '周六');
  assert.equal(isIdleTime(bj('2026-10-25T14:00:00')).idle, true, '周日');
});

test('法定节假日全天空闲', () => {
  assert.equal(isIdleTime(bj('2026-10-01T10:00:00')).idle, true, '国庆');
  assert.equal(isIdleTime(bj('2026-02-17T14:00:00')).idle, true, '春节');
  assert.equal(isIdleTime(bj('2026-04-06T10:00:00')).idle, true, '清明');
});

test('调休上班日按工作日算：10-10 周六 10 点是高峰', () => {
  assert.equal(isIdleTime(bj('2026-10-10T10:00:00')).idle, false);
  assert.equal(isIdleTime(bj('2026-10-10T12:30:00')).idle, true);
});

test('自定义时区/节假日表可覆盖默认', () => {
  const r = isIdleTime(bj('2026-10-23T10:00:00'), { holidays: ['2026-10-23'] });
  assert.equal(r.idle, true);
  assert.equal(r.reason, 'holiday');
});

test('idleHoursOnDay：当天空闲小时数（自刷配额按时间算）', () => {
  assert.equal(idleHoursOnDay(bj('2026-10-23T10:00:00')), 17, '工作日：24 - 高峰 7');
  assert.equal(idleHoursOnDay(bj('2026-10-24T10:00:00')), 24, '周六全天空闲');
  assert.equal(idleHoursOnDay(bj('2026-10-01T10:00:00')), 24, '国庆节假日');
  assert.equal(idleHoursOnDay(bj('2026-10-10T10:00:00')), 17, '调休上班日按工作日');
});
