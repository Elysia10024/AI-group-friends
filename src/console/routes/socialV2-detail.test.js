// my-recent / message-detail 路由的 hermetic 测试（2026-10-28 第 38 轮）。
//
// my-recent：只看她自己发的（isSelf），limit 夹取；
// message-detail：先查本地（seq 或 messageId 命中），本地没有才走 OneBot 解析；
// 本地命中时补 forwardIds/hasForward（提示词与实现一致性）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSocialV2MessageDetail, handleSocialV2LogsFeedback } from './socialV2.js';

function baseCtx(extra = {}) {
  const sentJson = [];
  const calls = { resolved: [] };
  const ctx = {
    agentTokenOk: () => true,
    getSocialV2State: () => ({ recentMessages: [] }),
    req: { method: 'GET', headers: { 'x-agent-token': 'T' }, on: () => {} },
    resolveReplyInfo: async (kind, id, messageId) => { calls.resolved.push({ kind, id, messageId }); return null; },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL('http://127.0.0.1:3100/api/socialV2/my-recent'),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    ...extra,
  };
  return { ctx, sentJson, calls };
}

test('my-recent：缺 key / 坏 token / 工具关闭 拒绝', async () => {
  const noKey = baseCtx();
  noKey.ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/my-recent');
  await handleSocialV2LogsFeedback(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const badToken = baseCtx({ agentTokenOk: () => false });
  badToken.ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/my-recent?key=group:1');
  await handleSocialV2LogsFeedback(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const off = baseCtx({ v2ToolEnabled: () => false });
  off.ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/my-recent?key=group:1');
  await handleSocialV2LogsFeedback(off.ctx);
  assert.match(off.sentJson.at(-1).body.error, /工具未启用：qq_get_my_recent_messages/);
});

test('my-recent：只回自己发的，limit 夹取到 1..50', async () => {
  const msgs = [
    { text: '群友a', isSelf: false },
    { text: '我说的1', isSelf: true },
    { text: '群友b', isSelf: false },
    { text: '我说的2', isSelf: true },
  ];
  const { ctx, sentJson } = baseCtx({ getSocialV2State: () => ({ recentMessages: msgs }) });
  ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/my-recent?key=group:1&limit=1');
  await handleSocialV2LogsFeedback(ctx);
  const body = sentJson.at(-1).body;
  assert.deepEqual(body.messages.map((m) => m.text), ['我说的2'], '只要 isSelf 且 limit=1');

  const clamp = baseCtx({ getSocialV2State: () => ({ recentMessages: Array.from({ length: 60 }, (_, i) => ({ text: `我${i}`, isSelf: true })) }) });
  clamp.ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/my-recent?key=group:1&limit=999');
  await handleSocialV2LogsFeedback(clamp.ctx);
  assert.equal(clamp.sentJson.at(-1).body.messages.length, 50, 'limit 上限 50');
});

test('message-detail：缺参 / 坏 token / 工具关闭 / key 格式 拒绝', async () => {
  const noParam = baseCtx();
  noParam.ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/message-detail');
  await handleSocialV2MessageDetail(noParam.ctx);
  assert.equal(noParam.sentJson.at(-1).status, 400);

  const badToken = baseCtx({ agentTokenOk: () => false });
  badToken.ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/message-detail?key=group:1&messageId=5');
  await handleSocialV2MessageDetail(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const off = baseCtx({ v2ToolEnabled: () => false });
  off.ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/message-detail?key=group:1&messageId=5');
  await handleSocialV2MessageDetail(off.ctx);
  assert.match(off.sentJson.at(-1).body.error, /工具未启用：qq_get_message_detail/);

  const badKey = baseCtx();
  badKey.ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/message-detail?key=x&messageId=5');
  await handleSocialV2MessageDetail(badKey.ctx);
  assert.match(badKey.sentJson.at(-1).body.error, /key 格式/);
});

test('message-detail：本地 seq 命中且带真实 messageId → 不回源 OneBot，补转发字段', async () => {
  const found = { seq: 5, messageId: '999', sender: '小明', text: '本地正文', userId: 10001, forwardIds: ['f1'], hasForward: true };
  const { ctx, sentJson, calls } = baseCtx({ getSocialV2State: () => ({ recentMessages: [found] }) });
  ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/message-detail?key=group:1&messageId=5');
  await handleSocialV2MessageDetail(ctx);
  const info = sentJson.at(-1).body.info;
  assert.equal(info.text, '本地正文');
  assert.equal(info.messageId, '999');
  assert.deepEqual(info.forwardIds, ['f1']);
  assert.equal(info.hasForward, true);
  assert.equal(calls.resolved.length, 0, '本地优先，不打 OneBot');
});

test('message-detail：本地没有 → 走 resolveReplyInfo；两边都没有 → info=null', async () => {
  const { ctx, sentJson, calls } = baseCtx();
  ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/message-detail?key=group:1&messageId=777');
  await handleSocialV2MessageDetail(ctx);
  assert.equal(calls.resolved.length, 1);
  assert.equal(calls.resolved[0].messageId, '777');
  assert.equal(sentJson.at(-1).body.info, null);
  assert.equal(sentJson.at(-1).body.ok, true);

  const hit = baseCtx({ resolveReplyInfo: async () => ({ sender: '群友', text: '远端正文' }) });
  hit.ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/message-detail?key=private:1&messageId=888');
  await handleSocialV2MessageDetail(hit.ctx);
  assert.equal(hit.sentJson.at(-1).body.info.text, '远端正文');
});

test('message-detail：解析抛错 → 500', async () => {
  const { ctx, sentJson } = baseCtx({ resolveReplyInfo: async () => { throw new Error('网关超时'); } });
  ctx.url = new URL('http://127.0.0.1:3100/api/socialV2/message-detail?key=group:1&messageId=1');
  await handleSocialV2MessageDetail(ctx);
  assert.equal(sentJson.at(-1).status, 500);
  assert.match(sentJson.at(-1).body.error, /获取消息详情失败/);
});
