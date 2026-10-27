// media.js 读取路由的 hermetic 测试（2026-10-28 第 32 轮）：
//   · GET /api/images/message（按 messageId 找图片元数据再取图）；
//   · GET /api/socialV2/forward-message（合并转发 + 嵌套一层预览）；
//   · POST /api/socialV2/forward-media（转发里的媒体批量取图）。
// 都是只读面，重点是模式/token/工具开关的顺序与 fetch 失败时的错误落点。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleForwardMedia, handleImageMessageAndLegacySend } from './media.js';

function makeCtx(pathname, { method = 'GET', query = '', body = {}, agentToken, currentMode = 'reserved2', media = [], mediaImpl, forwardImpl, st } = {}) {
  const sentJson = [];
  const calls = { fetchMedia: [], raw: [], format: 0 };
  const ctx = {
    agentTokenOk: () => true,
    bot: { raw: async (action, params) => { calls.raw.push({ action, params }); return calls.raw.length === 1 ? { outer: true } : { __nested: true }; } },
    cfg: {},
    deps: { flags: { currentMode } },
    fetchMediaData: async (m, opts) => {
      calls.fetchMedia.push({ media: m, opts });
      if (mediaImpl) return mediaImpl(m, opts);
      return [{ url: 'http://img/1', name: '1.png' }];
    },
    findMessageMedia: () => media,
    formatForwardResponse: (data, opts) => {
      calls.format += 1;
      if (data?.__nested) return { messages: [{ text: '内层消息', nestedForwardIds: [] }] };
      if (forwardImpl) return forwardImpl(data, opts);
      return { messages: [{ text: '外层消息', nestedForwardIds: ['n1'] }] };
    },
    getSocialV2State: () => st ?? { agentToken: 'TOKEN', recentMessages: [{ forwardIds: ['9'] }], unread: [] },
    log: () => {},
    modeAllowed: () => true,
    readBody: async () => body,
    req: { method, headers: agentToken ? { 'x-agent-token': agentToken } : {}, on: () => {} },
    seenForwardIds: new Map(),
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL(`http://127.0.0.1:3100${pathname}${query}`),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
  };
  return { ctx, sentJson, calls };
}

test('/api/images/message：key 格式/缺 messageId → 400', async () => {
  const badKey = makeCtx('/api/images/message', { query: '?key=x:1&messageId=m1' });
  await handleImageMessageAndLegacySend(badKey.ctx);
  assert.equal(badKey.sentJson.at(-1).status, 400);
  assert.match(badKey.sentJson.at(-1).body.error, /key 格式/);

  const noId = makeCtx('/api/images/message', { query: '?key=group:1' });
  await handleImageMessageAndLegacySend(noId.ctx);
  assert.equal(noId.sentJson.at(-1).status, 400);
});

test('/api/images/message：reserved2 无 token → 403；坏 token → 403；模式不允许 → 403', async () => {
  const noToken = makeCtx('/api/images/message', { query: '?key=group:1&messageId=m1' });
  await handleImageMessageAndLegacySend(noToken.ctx);
  assert.equal(noToken.sentJson.at(-1).status, 403);

  const badToken = makeCtx('/api/images/message', { query: '?key=group:1&messageId=m1', agentToken: 'X' });
  badToken.ctx.agentTokenOk = () => false;
  await handleImageMessageAndLegacySend(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const noMode = makeCtx('/api/images/message', { query: '?key=group:1&messageId=m1', agentToken: 'X' });
  noMode.ctx.modeAllowed = () => false;
  await handleImageMessageAndLegacySend(noMode.ctx);
  assert.match(noMode.sentJson.at(-1).body.error, /不允许读取该会话/);
});

test('/api/images/message：没有媒体 → ok + note；有媒体 → 取图；full=1 透传', async () => {
  const none = makeCtx('/api/images/message', { query: '?key=group:1&messageId=m1', agentToken: 'X' });
  await handleImageMessageAndLegacySend(none.ctx);
  assert.equal(none.sentJson.at(-1).body.ok, true);
  assert.match(none.sentJson.at(-1).body.note, /没有可读取的图片/);

  const ok = makeCtx('/api/images/message', { query: '?key=group:1&messageId=m1&full=1', agentToken: 'X', media: [{ url: 'a' }] });
  await handleImageMessageAndLegacySend(ok.ctx);
  assert.equal(ok.sentJson.at(-1).body.ok, true);
  assert.equal(ok.sentJson.at(-1).body.images.length, 1);
  assert.equal(ok.calls.fetchMedia[0].opts.full, true, 'full=1 要透传给取图');

  const fail = makeCtx('/api/images/message', {
    query: '?key=group:1&messageId=m1', agentToken: 'X', media: [{ url: 'a' }],
    mediaImpl: () => { throw new Error('下载超时'); },
  });
  await handleImageMessageAndLegacySend(fail.ctx);
  assert.equal(fail.sentJson.at(-1).status, 500);
});

test('forward-message：key/id/模式/token 四道前置校验', async () => {
  const badKey = makeCtx('/api/socialV2/forward-message', { query: '?key=x&id=1' });
  await handleForwardMedia(badKey.ctx);
  assert.equal(badKey.sentJson.at(-1).status, 400);

  const noId = makeCtx('/api/socialV2/forward-message', { query: '?key=group:1' });
  await handleForwardMedia(noId.ctx);
  assert.equal(noId.sentJson.at(-1).status, 400);

  const wrongMode = makeCtx('/api/socialV2/forward-message', { query: '?key=group:1&id=1', agentToken: 'X', currentMode: 'closed-agent' });
  await handleForwardMedia(wrongMode.ctx);
  assert.match(wrongMode.sentJson.at(-1).body.error, /仅 reserved2/);

  const noToken = makeCtx('/api/socialV2/forward-message', { query: '?key=group:1&id=1' });
  await handleForwardMedia(noToken.ctx);
  assert.match(noToken.sentJson.at(-1).body.error, /必须携带 agent token/);
});

test('forward-message：不在本会话可见范围的 id → 404（安全边界）', async () => {
  const notSeen = makeCtx('/api/socialV2/forward-message', { query: '?key=group:1&id=999', agentToken: 'X', st: { recentMessages: [], unread: [] } });
  await handleForwardMedia(notSeen.ctx);
  assert.equal(notSeen.sentJson.at(-1).status, 404);
  assert.match(notSeen.sentJson.at(-1).body.error, /不在当前会话可见范围内/);
});

test('forward-message：成功 → 外层消息 + 嵌套预览一层；嵌套失败不影响主结果', async () => {
  const ok = makeCtx('/api/socialV2/forward-message', { query: '?key=group:1&id=9', agentToken: 'X' });
  await handleForwardMedia(ok.ctx);
  const body = ok.sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.messages[0].text, '外层消息');
  assert.equal(body.nestedPreviews.length, 1);
  assert.equal(body.nestedPreviews[0].id, 'n1');
  assert.equal(body.nestedPreviews[0].messages[0].text, '内层消息');
  assert.ok(ok.calls.raw.length >= 1, '嵌套预览要真的去拉');

  const nestedFail = makeCtx('/api/socialV2/forward-message', { query: '?key=group:1&id=9', agentToken: 'X' });
  let rawCount = 0;
  nestedFail.ctx.bot.raw = async () => { rawCount += 1; if (rawCount === 1) return { outer: true }; throw new Error('拉取失败'); };
  await handleForwardMedia(nestedFail.ctx);
  const b2 = nestedFail.sentJson.at(-1).body;
  assert.equal(b2.ok, true);
  assert.match(b2.nestedPreviews[0].error, /拉取失败/);
});

test('forward-media：缺 key 400、非 reserved2 403、空 media 直接 ok', async () => {
  const noKey = makeCtx('/api/socialV2/forward-media', { method: 'POST', body: {} });
  await handleForwardMedia(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const wrongMode = makeCtx('/api/socialV2/forward-media', { method: 'POST', body: { key: 'group:1' }, currentMode: 'closed-agent' });
  await handleForwardMedia(wrongMode.ctx);
  assert.match(wrongMode.sentJson.at(-1).body.error, /仅 reserved2/);

  const empty = makeCtx('/api/socialV2/forward-media', { method: 'POST', body: { key: 'group:1', media: [] } });
  await handleForwardMedia(empty.ctx);
  assert.deepEqual(empty.sentJson.at(-1).body, { ok: true, key: 'group:1', media: [], images: [] });
});

test('forward-media：成功取图 / 失败 500', async () => {
  const ok = makeCtx('/api/socialV2/forward-media', { method: 'POST', body: { key: 'group:1', media: [{ url: 'a' }, { url: 'b' }] } });
  await handleForwardMedia(ok.ctx);
  assert.equal(ok.sentJson.at(-1).body.ok, true);
  assert.equal(ok.sentJson.at(-1).body.images.length, 1);

  const fail = makeCtx('/api/socialV2/forward-media', {
    method: 'POST', body: { key: 'group:1', media: [{ url: 'a' }] },
    mediaImpl: () => { throw new Error('网关 500'); },
  });
  await handleForwardMedia(fail.ctx);
  assert.equal(fail.sentJson.at(-1).status, 500);
  assert.match(fail.sentJson.at(-1).body.error, /转发媒体读取失败/);
});
