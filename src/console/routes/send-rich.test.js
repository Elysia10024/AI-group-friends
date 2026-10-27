// handleSendRich · 语音/图库/reload-memory 路由的回归测试（2026-10-28，第 15 轮）。
//
// 为什么补这组：
//  ① `reload-memory` 曾被审计误判为「恒 500 未接线」——实测是好的；这条测试把接线钉死，
//     以后谁再把它断掉，测试立刻红；
//  ② 语音路由的额度顺序与 burst 相反（**先发成功、再预占两个额度**），且带引用必须提前拒——
//     这两个语义都只在真实路由代码里，纯函数测不到。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSendRich } from './send.js';
import { reserveSlots, rollbackSlots } from '../../core/ratelimit.js';

function makeCtx(urlPath, { body = {}, voiceOut, reloadMemory = () => ({ sessions: 3 }) } = {}) {
  const sentJson = [];
  const st = { sendTimes: [], recentMessages: [], lastWakeReason: 'atMention', wakeConfig: { mode: 'active', triggers: {} } };
  const ctx = {
    appendActivity: () => {},
    capList: (arr) => { if (arr.length > 20) arr.splice(0, arr.length - 20); },
    cfg: { socialV2: { send: { maxSendPerMinute: 100, maxSendPerHour: 1000 } } },
    gateSendTool: () => ({ kind: 'group', id: '1' }),
    getSocialV2State: () => st,
    hourCapFor: () => 1000,
    reloadMemory,
    log: () => {},
    markAiSpoke: () => {},
    rateLimitCheck: () => ({ ok: true }),
    readBody: async () => body,
    recentLimitOf: () => 20,
    req: { method: 'POST', headers: { 'x-agent-token': 'T' }, on: () => {} },
    reserveSlots,
    resetPreSleepWait: () => {},
    resolveReplyTargetV2: async () => null,
    rollbackSlots,
    saveSocialV2State: () => {},
    scheduleReplyCheckV2: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    sendLibraryImage: async () => ({ ok: true }),
    sendStickerV2: async () => ({ ok: true }),
    shouldBlockSilentReply: () => false,
    stickerEnabled: () => true,
    url: new URL(`http://127.0.0.1:3100${urlPath}`),
    voiceOut,
    v2ToolEnabled: () => true,
  };
  return { ctx, st, sentJson };
}

test('reload-memory：接线完整时返回 {ok:true, sessions:N}（钉住审计误判的那条）', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/reload-memory');
  const handled = await handleSendRich(ctx);
  assert.equal(handled, true);
  assert.deepEqual(sentJson.at(-1).body, { ok: true, sessions: 3 });
});

test('reload-memory：reloadMemory 缺失时报「重载未接线」500（防御探针行为不变）', async () => {
  // 注意用 null 而不是 undefined：解构默认值会把 undefined 换回默认函数（测试自己踩过）。
  const { ctx, sentJson } = makeCtx('/api/socialV2/reload-memory', { reloadMemory: null });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 500);
  assert.match(sentJson.at(-1).body.error, /重载未接线/);
});

test('发送语音：带引用必须提前拒（400），且不合成、不占额度', async () => {
  let called = 0;
  const voiceOut = { sendVoice: async () => { called += 1; return { ok: true }; } };
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/send-voice', {
    body: { key: 'group:1', text: '在的', replyToMessageId: '123' },
    voiceOut,
  });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /语音要单独发/);
  assert.equal(called, 0, '不应真的去合成');
  assert.equal(st.sendTimes.length, 0);
});

test('发送语音：voiceOut 拒绝时返回 400，且不占额度（先发后记的顺序）', async () => {
  const voiceOut = { sendVoice: async () => ({ ok: false, error: '今日语音额度已用完' }) };
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/send-voice', {
    body: { key: 'group:1', text: '在的' },
    voiceOut,
  });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /额度已用完/);
  assert.equal(st.sendTimes.length, 0, '发送失败不占额度');
});

test('发送语音：成功后占两个额度、记一条 recentMessages、返回 seconds', async () => {
  const voiceOut = { sendVoice: async () => ({ ok: true, seconds: 3, messageId: 'm1', notes: ['逐字稿一致'] }) };
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/send-voice', {
    body: { key: 'group:1', text: '在的' },
    voiceOut,
  });
  const handled = await handleSendRich(ctx);
  assert.equal(handled, true);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.equal(last.body.seconds, 3);
  assert.deepEqual(last.body.notes, ['逐字稿一致']);
  assert.equal(st.sendTimes.length, 2, '语音占两个额度');
  assert.equal(st.recentMessages.length, 1);
  assert.match(st.recentMessages[0].text, /^\[语音\]/);
});

test('发送图库图：带 caption 直接拒（图文不能混在一个气泡）', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/send-image', {
    body: { key: 'group:1', name: '我涨价了', message: '配一句话' },
  });
  await handleSendRich(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /不能附带文字/);
});
