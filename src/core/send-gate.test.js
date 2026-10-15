// src/core/send-gate.js 的测试。
//
// 重点是**静默失败**这一类回归：2026-09-19 她跟群友对线时额度被烧完，
// 之后每条还嘴都被 429 拒掉而**日志里一个字都没有** —— 事后只能靠她自己那句
// "我这轮回复全被拒了"才知道发生过。所以这里的断言不是"返回 false"，
// 而是"被拒时必须留下能看见的痕迹 + 给模型一条出路"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateSendRate } from './send-gate.js';
import { rateLimitCheck, hourCapFor, RATE_LIMIT_ERROR } from './ratelimit.js';

const NOW = 1_700_000_000_000;
const CFG = { maxSendPerMinute: 8, maxSendPerHour: 80, replyBudgetPerHour: 30, replyBudgetWindowMs: 600000 };

function harness(st, cfg = CFG, count = 1) {
  const logs = [];
  const replies = [];
  const ok = gateSendRate({
    st,
    sendCfg: cfg,
    count,
    now: NOW,
    key: 'group:20000001',
    log: (m) => logs.push(m),
    sendJson: (body, status) => replies.push({ body, status }),
    rateLimitCheck,
    hourCapFor
  });
  return { ok, logs, replies };
}

/** 一小时内已经发满 80 条的会话状态。 */
const fullHour = (extra = {}) => ({
  sendTimes: Array.from({ length: 80 }, (_, i) => NOW - i * 10_000),
  ...extra
});

test('没超限：放行，且不写日志、不回 429', () => {
  const r = harness({ sendTimes: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.logs, []);
  assert.deepEqual(r.replies, []);
});

test('超限被拒：必须留日志（这就是那次事故里缺的东西）', () => {
  const r = harness(fullHour({ lastWakeReason: 'probability' }));
  assert.equal(r.ok, false);
  assert.equal(r.logs.length, 1, '被拒必须恰好留一条日志');
  assert.match(r.logs[0], /发送频率超限被拒 group:20000001/);
  assert.match(r.logs[0], /不许静默/);
  assert.match(r.logs[0], /小时 80\+1 > 80/);
});

test('超限被拒：429 要说明用量，并给出可执行出路', () => {
  const r = harness(fullHour({ lastWakeReason: 'probability' }));
  assert.equal(r.replies.length, 1);
  const { body, status } = r.replies[0];
  assert.equal(status, 429);
  assert.equal(body.ok, false);
  assert.equal(body.error, RATE_LIMIT_ERROR);
  assert.equal(body.rateLimit.hour, 80);
  assert.equal(body.rateLimit.maxPerHour, 80);
  assert.equal(body.rateLimit.replyExtra, 0);
  assert.match(body.hint, /没有发出去/, '必须明确告诉她这条没进群，否则她以为说过了');
  assert.match(body.hint, /合并成一条/);
});

test('事故复现：额度烧满时，被直接叫醒的回合仍能还嘴（走回复额度）', () => {
  const r = harness(fullHour({ lastWakeReason: 'atMention', wakeConfig: { lastWakeAt: NOW - 1000 } }));
  assert.equal(r.ok, true, '被 @ 时必须还能说话');
  assert.deepEqual(r.logs, []);
  assert.deepEqual(r.replies, []);
});

test('事故复现：同一时刻主动插话仍然被拦（刷屏保护没被削弱）', () => {
  const r = harness(fullHour({ lastWakeReason: 'probability', wakeConfig: { lastWakeAt: NOW - 1000 } }));
  assert.equal(r.ok, false);
  assert.match(r.logs[0], /不许静默/);
});

test('回复额度会写进日志与 429 里的上限数字（便于事后核对）', () => {
  const st = {
    sendTimes: Array.from({ length: 110 }, (_, i) => NOW - i * 10_000),
    lastWakeReason: 'atMention',
    wakeConfig: { lastWakeAt: NOW - 1000 }
  };
  const r = harness(st);
  assert.equal(r.ok, false, '110 条已经用满 80+30，再多一条就被拦');
  assert.match(r.logs[0], /小时 110\+1 > 110/, '上限应该是含回复额度的 110');
  assert.equal(r.replies[0].body.rateLimit.maxPerHour, 110);
  assert.equal(r.replies[0].body.rateLimit.replyExtra, 30);
});

test('多条一起发也按 count 判定（不是按"调一次算一条"）', () => {
  const st = { sendTimes: Array.from({ length: 78 }, (_, i) => NOW - i * 10_000) };
  assert.equal(harness(st, CFG, 2).ok, true, '78+2 = 80，正好不超');
  assert.equal(harness(st, CFG, 3).ok, false, '78+3 > 80，要拦在发出去之前');
});

test('分钟上限与小时上限都会各自触发', () => {
  const st = { sendTimes: Array.from({ length: 8 }, (_, i) => NOW - i * 1000) };
  const r = harness(st);
  assert.equal(r.ok, false);
  assert.match(r.logs[0], /分钟 8\+1 > 8/);
});

test('maxSendPerMinute / maxSendPerHour 为 0（不限）时不拦', () => {
  const st = { sendTimes: Array.from({ length: 500 }, (_, i) => NOW - i * 1000) };
  assert.equal(harness(st, { maxSendPerMinute: 0, maxSendPerHour: 0 }).ok, true);
});
