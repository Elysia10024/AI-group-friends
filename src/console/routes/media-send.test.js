// handleImageMessageAndLegacySend · 旧发送路由（/api/send/group|private|reply）的回归测试。
//
// 2026-10-28（第 16 轮）：写测试时发现**这里还留着 D-01 的同一类 bug**——`st`/`now` 声明在
// try 块内，catch 回滚额度时触发 ReferenceError（当初只修了 send.js 的 burst 那条）。
// 本文件的「全失败」用例就是负控：修复前它红，修复后绿。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleImageMessageAndLegacySend } from './media.js';
import { reserveSlots, rollbackSlots } from '../../core/ratelimit.js';

function makeCtx(pathname, { body = {}, sendOutcome, toolEnabled = true } = {}) {
  const sentJson = [];
  const recorded = [];
  const st = { sendTimes: [], recentMessages: [], lastWakeReason: 'atMention', wakeConfig: { mode: 'active', triggers: {} } };
  const ctx = {
    SENSITIVE_RE: /secret/i,
    agentTokenOk: () => true,
    appendActivity: () => {},
    cfg: { socialV2: { send: { maxSendPerMinute: 100, maxSendPerHour: 1000, maxMessageChars: 500 } } },
    deps: { flags: { currentMode: 'reserved2' } },
    fetchMediaData: async () => ({}),
    findMessageMedia: () => null,
    getSocialV2State: () => st,
    hourCapFor: () => 1000,
    log: () => {},
    markAiSpoke: () => {},
    modeAllowed: () => true,
    rateLimitCheck: () => ({ ok: true }),
    readBody: async () => ({ token: 'T', groupId: '1', userId: '2', message: '在的', ...body }),
    recordSentMessagesV2: (_k, sent) => recorded.push(sent),
    req: { method: 'POST', headers: { 'x-agent-token': 'T' }, on: () => {} },
    reserveSlots,
    resolveReplyTargetV2: async (st_, kind, id, rid) => ({ messageId: rid, info: { messageId: rid } }),
    rollbackSlots,
    saveSocialV2State: () => {},
    scheduleReplyCheckV2: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    sendMessagesV2: async () => {
      if (sendOutcome instanceof Error) throw sendOutcome;
      return sendOutcome;
    },
    shouldBlockSilentReply: () => false,
    socialV2: { paused: false },
    unquoteJsonString: (s) => s,
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    v2ToolEnabled: () => toolEnabled,
  };
  return { ctx, st, sentJson, recorded };
}

test('成功：/api/send/group 一条，占 1 个额度并返回 quoted=null', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/send/group', { sendOutcome: ['m1'] });
  const handled = await handleImageMessageAndLegacySend(ctx);
  assert.equal(handled, true);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.equal(last.body.sent, 1);
  assert.equal(last.body.quoted, null);
  assert.equal(st.sendTimes.length, 1);
});

test('全失败（一条都没发出）→ 额度回滚为 0（修复前这里是 ReferenceError，D-01 同类）', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/send/group', { sendOutcome: new Error('网关挂了') });
  await handleImageMessageAndLegacySend(ctx);
  assert.equal(sentJson.at(-1).status, 500, '必须如实报错，不能崩成未处理异常');
  assert.equal(st.sendTimes.length, 0, '失败的额度要回滚');
});

test('部分失败（error.sent 有 1 条）→ 已发的仍记账，额度保留', async () => {
  const err = Object.assign(new Error('第 2 步失败'), { sent: ['m1'] });
  const { ctx, st, sentJson, recorded } = makeCtx('/api/send/group', { sendOutcome: err });
  await handleImageMessageAndLegacySend(ctx);
  assert.equal(sentJson.at(-1).status, 500);
  assert.deepEqual(recorded, [['m1']]);
  assert.equal(st.sendTimes.length, 1);
});

test('private 路径走 sendPrivate 开关：关掉即 403', async () => {
  const { ctx, sentJson } = makeCtx('/api/send/private', { toolEnabled: false });
  await handleImageMessageAndLegacySend(ctx);
  assert.equal(sentJson.at(-1).status, 403);
  assert.match(sentJson.at(-1).body.error, /未启用/);
});

test('reply 路径：replyToMessageId 为空 → 400', async () => {
  const { ctx, sentJson } = makeCtx('/api/send/reply', { body: { replyToMessageId: '' } });
  await handleImageMessageAndLegacySend(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /replyToMessageId 不能为空/);
});

test('reserved2 模式不带 agent token → 403', async () => {
  const { ctx, sentJson } = makeCtx('/api/send/group', { body: { token: '' } });
  await handleImageMessageAndLegacySend(ctx);
  assert.equal(sentJson.at(-1).status, 403);
  assert.match(sentJson.at(-1).body.error, /必须携带 agent token/);
});
