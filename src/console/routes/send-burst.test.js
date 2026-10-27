// handleSendCore · send-burst 路由的回归测试（2026-10-28，第 4 期收尾前置）。
//
// 钉住 D-01（2026-10-27 修复）：原实现里 `st`/`now` 声明在 try 块内，catch 里回滚额度时
// 触发 ReferenceError → 额度永不回滚 → 之后所有发送被假 429 拦住，而且真实错误被吞掉。
// 这条测试走真实路由代码（不起服务），覆盖三种结局的回滚语义：
//   ① 部分失败：预占 2 条、发出 1 条 → 只回滚 1 条（已发的仍记账）；
//   ② 全失败：一条都没发出去 → 两条全回滚；
//   ③ 成功：预占保留。
// 依赖全部由 ctx 注入；reserveSlots / rollbackSlots 用真实实现（它们才是回滚语义的真相）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSendCore } from './send.js';
import { reserveSlots, rollbackSlots } from '../../core/ratelimit.js';

function makeCtx({ messages = ['一', '二'], sentOutcome } = {}) {
  const sentJson = [];
  const recorded = [];
  const st = { sendTimes: [], lastWakeReason: 'atMention', wakeConfig: { mode: 'active', triggers: {} } };
  const ctx = {
    SENSITIVE_RE: /secret/i,
    agentTokenOk: () => true,
    appendActivity: () => {},
    bot: {},
    capList: (x) => x,
    cfg: { socialV2: { send: { maxSendPerMinute: 100, maxSendPerHour: 1000, burstMaxMessages: 8, maxMessageChars: 500 } } },
    computeGapsV2: (msgs) => msgs.map(() => 0),
    deps: { flags: { currentMode: 'reserved2' } },
    findCjkSpaceWarning: () => null,
    findSplitBoundaryWarning: () => null,
    gateSendTool: () => ({ kind: 'group', id: '1' }),
    getSocialV2State: () => st,
    hourCapFor: () => 1000,
    log: () => {},
    markAiSpoke: () => {},
    modeAllowed: () => true,
    rateLimitCheck: () => ({ ok: true }),
    readBody: async () => ({ key: 'group:1', messages }),
    recentLimitOf: () => 20,
    recordSentMessagesV2: (_k, sent) => recorded.push(sent),
    redactSensitiveText: (s) => s,
    req: { method: 'POST', headers: { 'x-agent-token': 'T' }, on: () => {} },
    reserveSlots,
    resetPreSleepWait: () => {},
    resolveReplyTargetV2: async () => null,
    rollbackSlots,
    saveSocialV2State: () => {},
    scheduleReplyCheckV2: () => {},
    sendJson: (body, status) => sentJson.push({ body, status }),
    sendMessagesV2: async () => {
      if (sentOutcome instanceof Error) throw sentOutcome;
      return sentOutcome;
    },
    shouldBlockSilentReply: () => false,
    socialV2: { paused: false },
    url: new URL('http://127.0.0.1:3100/api/socialV2/send-burst'),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
  };
  return { ctx, st, sentJson, recorded };
}

test('部分失败：预占 2 条只发出 1 条 → 只回滚 1 条，额度不泄漏（D-01 回归）', async () => {
  const err = Object.assign(new Error('第 2 条超时'), { sent: ['m1'] });
  const { ctx, st, sentJson, recorded } = makeCtx({ sentOutcome: err });
  const handled = await handleSendCore(ctx);
  assert.equal(handled, true, '路由应声明已处理');
  assert.equal(sentJson.at(-1).body.ok, false);
  assert.equal(sentJson.at(-1).status, 500);
  assert.deepEqual(recorded, [['m1']], '已发的那条仍要记账');
  assert.equal(st.sendTimes.length, 1, '2 预占 - 1 回滚 = 1');
});

test('全失败（一条都没发出去）→ 两条额度全部回滚', async () => {
  const { ctx, st } = makeCtx({ sentOutcome: new Error('网关挂了') });
  await handleSendCore(ctx);
  assert.equal(st.sendTimes.length, 0);
});

test('成功路径：预占保留，返回 sent/failed 计数', async () => {
  const { ctx, st, sentJson } = makeCtx({ sentOutcome: ['m1', 'm2'] });
  const handled = await handleSendCore(ctx);
  assert.equal(handled, true);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.equal(last.body.sent, 2);
  assert.equal(last.body.failed, 0);
  assert.equal(st.sendTimes.length, 2);
});

test('带引用参数的 burst 请求被拒（提示改用 qq_reply），不产生预占', async () => {
  const sentJson = [];
  const st = { sendTimes: [], lastWakeReason: '', wakeConfig: {} };
  const ctx = {
    ...makeCtx().ctx,
    readBody: async () => ({ key: 'group:1', messages: ['一', '二'], replyToMessageId: '123' }),
    getSocialV2State: () => st,
    sendJson: (body, status) => sentJson.push({ body, status }),
  };
  await handleSendCore(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /暂不支持引用/);
  assert.equal(st.sendTimes.length, 0);
});
