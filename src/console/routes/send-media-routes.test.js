// handleSendRich · 表情发送 / 图库发图两条路由的直接测试（2026-10-28 第 18 轮）。
//
// 背景：这两条路由在第 17 轮迁移到 withSendQuota 时没有任何直接测试，行为正确性只靠推断。
// 本文件把关键边界钉住：开关/参数校验/静默拦截/成功路径记账/发送失败回滚。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSendRich } from './send.js';
import { reserveSlots, rollbackSlots } from '../../core/ratelimit.js';

function makeCtx(urlPath, { body = {}, stickerEnabled = () => true, sendOutcome, gateResult } = {}) {
  const sentJson = [];
  const st = { sendTimes: [], recentMessages: [], lastWakeReason: '', wakeConfig: {} };
  const ctx = {
    appendActivity: () => {},
    capList: (arr) => { if (arr.length > 20) arr.splice(0, arr.length - 20); },
    cfg: { socialV2: { send: { maxSendPerMinute: 100, maxSendPerHour: 1000 } } },
    gateSendTool: gateResult === undefined
      ? () => ({ kind: 'group', id: '1' })
      : gateResult,
    getSocialV2State: () => st,
    hourCapFor: () => 1000,
    reloadMemory: () => ({ sessions: 0 }),
    log: () => {},
    markAiSpoke: () => {},
    rateLimitCheck: () => ({ ok: true }),
    readBody: async () => body,
    recentLimitOf: () => 20,
    req: { method: 'POST', headers: { 'x-agent-token': 'T' }, on: () => {} },
    reserveSlots,
    resetPreSleepWait: () => {},
    resolveReplyTargetV2: async (st_, kind, id, rid) => ({ messageId: rid, info: { messageId: rid } }),
    rollbackSlots,
    saveSocialV2State: () => {},
    scheduleReplyCheckV2: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    sendLibraryImage: async (key, name) => {
      if (sendOutcome instanceof Error) throw sendOutcome;
      return sendOutcome ?? { ok: true, messageId: 'img1', image: { name, file: `image/${name}.png`, verdict: 'ok' } };
    },
    sendStickerV2: async (key, stickerId) => {
      if (sendOutcome instanceof Error) throw sendOutcome;
      return sendOutcome ?? { ok: true, messageId: 'st1', entry: { id: stickerId, desc: '摸鱼', localNote: '' } };
    },
    shouldBlockSilentReply: () => false,
    stickerEnabled,
    url: new URL(`http://127.0.0.1:3100${urlPath}`),
    voiceOut: { sendVoice: async () => ({ ok: true }) },
    v2ToolEnabled: () => true,
  };
  return { ctx, st, sentJson };
}

test('表情：体系关闭时 403，不占额度', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/send-sticker', { body: { key: 'group:1', stickerId: 's1' }, stickerEnabled: () => false });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 403);
  assert.match(sentJson.at(-1).body.error, /表情包体系已关闭/);
  assert.equal(st.sendTimes.length, 0);
});

test('表情：带 caption 直接拒（表情不能附带文字）', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/send-sticker', { body: { key: 'group:1', stickerId: 's1', message: '配一句话' } });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /不能附带文字/);
});

test('表情：成功 → 占 1 额度、记一条 [表情包] 消息、返回 entry', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/send-sticker', { body: { key: 'group:1', stickerId: 's1' } });
  const handled = await handleSendRich(ctx);
  assert.equal(handled, true);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.equal(last.body.sticker.desc, '摸鱼');
  assert.equal(st.sendTimes.length, 1);
  assert.equal(st.recentMessages.length, 1);
  assert.match(st.recentMessages[0].text, /^\[表情包:摸鱼\]/);
});

test('表情：发送失败 → 500 且额度回滚（withSendQuota 迁移后的行为）', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/send-sticker', {
    body: { key: 'group:1', stickerId: 's1' },
    sendOutcome: new Error('表情库读不到'),
  });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 500);
  assert.match(sentJson.at(-1).body.error, /发送表情失败/);
  assert.equal(st.sendTimes.length, 0, '失败的额度必须回滚');
});

test('图库：成功 → 占 1 额度、记一条 [图片] 消息、返回 image 元信息', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/send-image', { body: { key: 'group:1', name: '我涨价了' } });
  await handleSendRich(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.equal(last.body.image.name, '我涨价了');
  assert.equal(st.sendTimes.length, 1);
  assert.match(st.recentMessages[0].text, /^\[图片:我涨价了\]/);
});

test('图库：发送失败 → 500 且额度回滚', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/send-image', {
    body: { key: 'group:1', name: '我涨价了' },
    sendOutcome: new Error('图库文件丢了'),
  });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 500);
  assert.equal(st.sendTimes.length, 0);
});

test('图库：缺 key/name → 400', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/send-image', { body: { key: '', name: '' } });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 400);
});

test('表情：replyToMessageId 非整数 → 400（不占额度）', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/send-sticker', { body: { key: 'group:1', stickerId: 's1', replyToMessageId: 'abc' } });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /非零整数/);
  assert.equal(st.sendTimes.length, 0);
});
