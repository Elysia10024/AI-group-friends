// handleQzone1 · 说说路由的 hermetic 测试（2026-10-28 第 29 轮）。
//
// 说说是**公开发布**的破坏性面。路由本身只做参数/开关/错误透传，真正的边界（每日上限、间隔、
// 正文长度、密钥拦截）在 core/qzone.js（19 条测试）。这里验证路由把边界调用接对了：
// 会话令牌要作为 secrets 传进去（防止令牌跟着公开发出去），错误要以 400 原样透出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQzone1 } from './qzone.js';

function makeCtx(pathname, { method = 'GET', body = {}, query = '', gate = true, st = { agentToken: 'TOKEN-1' }, impl = {} } = {}) {
  const sentJson = [];
  const calls = { postMood: [], deleteMood: [], listMoods: [], comments: [], feeds: [] };
  const gateSendTool = gate === true
    ? () => ({ kind: 'group', id: 1 })
    : () => { sentJson.push({ body: { ok: false, error: '工具未启用：qq_post_mood' }, status: 403 }); return null; };
  const ctx = {
    gateSendTool,
    readBody: async () => body,
    req: { method, headers: {}, on: () => {} },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL(`http://127.0.0.1:3100${pathname}${query}`),
    postMood: async (content, opts) => { calls.postMood.push({ content, opts }); if (impl.postMood) return impl.postMood(content, opts); return { tid: 'T1', at: 'now', content, ugcRight: 1, todayCount: 1, remaining: 2 }; },
    deleteMood: async (tid) => { calls.deleteMood.push(tid); if (impl.deleteMood) return impl.deleteMood(tid); return { tid }; },
    listMoods: async (o) => { calls.listMoods.push(o); return { moods: [{ tid: 'T1' }] }; },
    getMoodComments: async (tid, o) => { calls.comments.push({ tid, o }); return { comments: [] }; },
    listQzoneFeeds: async (o) => { calls.feeds.push(o); return { feeds: [] }; },
    replyToComment: async () => ({ ok: true }),
    checkQzoneComments: async () => ({}),
    qzoneStatus: () => ({ todayCount: 0, remaining: 3 }),
    getSocialV2State: () => ({ agentToken: st.agentToken }),
    log: () => {},
  };
  return { ctx, sentJson, calls };
}

test('post-mood：缺 key → 400', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/post-mood', { method: 'POST', body: {} });
  await handleQzone1(ctx);
  assert.equal(sentJson.at(-1).status, 400);
});

test('post-mood：工具关闭 → 403 由闸门落地，不调 postMood', async () => {
  const { ctx, sentJson, calls } = makeCtx('/api/socialV2/post-mood', { method: 'POST', body: { key: 'group:1', content: 'x' }, gate: false });
  await handleQzone1(ctx);
  assert.equal(sentJson.at(-1).status, 403);
  assert.equal(calls.postMood.length, 0);
});

test('post-mood：会话令牌作为 secrets 传入，正文与额度原样返回', async () => {
  const { ctx, sentJson, calls } = makeCtx('/api/socialV2/post-mood', {
    method: 'POST',
    body: { key: 'group:1', content: '今天摸鱼', ugcRight: 1, targetUins: [1, 2] },
  });
  await handleQzone1(ctx);
  assert.equal(calls.postMood[0].content, '今天摸鱼');
  assert.deepEqual(calls.postMood[0].opts.secrets, ['TOKEN-1']);
  assert.equal(calls.postMood[0].opts.ugcRight, 1);
  const body = sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.tid, 'T1');
  assert.equal(body.todayCount, 1);
  assert.equal(body.remainingToday, 2);
});

test('post-mood：core 拒发（额度/敏感）→ 400 原样透出错误', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/post-mood', {
    method: 'POST',
    body: { key: 'group:1', content: 'x' },
    impl: { postMood: () => { throw new Error('今天的说说额度已用完'); } },
  });
  await handleQzone1(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /额度已用完/);
});

test('delete-mood：缺 tid → 400；删失败 → 400；成功回 tid', async () => {
  const noTid = makeCtx('/api/socialV2/delete-mood', { method: 'POST', body: { key: 'group:1' } });
  await handleQzone1(noTid.ctx);
  assert.equal(noTid.sentJson.at(-1).status, 400);

  const fail = makeCtx('/api/socialV2/delete-mood', {
    method: 'POST',
    body: { key: 'group:1', tid: 'T9' },
    impl: { deleteMood: () => { throw new Error('这条不是你的说说'); } },
  });
  await handleQzone1(fail.ctx);
  assert.equal(fail.sentJson.at(-1).status, 400);
  assert.match(fail.sentJson.at(-1).body.error, /不是你的/);

  const ok = makeCtx('/api/socialV2/delete-mood', { method: 'POST', body: { key: 'group:1', tid: 'T9' } });
  await handleQzone1(ok.ctx);
  assert.equal(ok.sentJson.at(-1).body.ok, true);
  assert.equal(ok.sentJson.at(-1).body.tid, 'T9');
});

test('mood-list：count 夹取到 1..50，targetUserId 透传', async () => {
  const { ctx, sentJson, calls } = makeCtx('/api/socialV2/mood-list', { query: '?key=group:1&count=999&targetUserId=123' });
  await handleQzone1(ctx);
  assert.equal(calls.listMoods[0].num, 50);
  assert.equal(calls.listMoods[0].targetUin, '123');
  assert.equal(sentJson.at(-1).body.ok, true);
});

test('mood-comments：maxComments 夹取，缺 tid → 400', async () => {
  const { ctx, calls } = makeCtx('/api/socialV2/mood-comments', { query: '?key=group:1&tid=T1&maxComments=999' });
  await handleQzone1(ctx);
  assert.equal(calls.comments[0].o.maxComments, 50);

  const noTid = makeCtx('/api/socialV2/mood-comments', { query: '?key=group:1' });
  await handleQzone1(noTid.ctx);
  assert.equal(noTid.sentJson.at(-1).status, 400);
});

test('qzone-feeds：count 夹取；mood-status 回本地账本', async () => {
  const feeds = makeCtx('/api/socialV2/qzone-feeds', { query: '?key=group:1&count=0' });
  await handleQzone1(feeds.ctx);
  assert.equal(feeds.calls.feeds[0].count, 10, '非法 count 回默认 10');

  const status = makeCtx('/api/socialV2/mood-status');
  await handleQzone1(status.ctx);
  assert.deepEqual(status.sentJson.at(-1).body, { ok: true, todayCount: 0, remaining: 3 });
});
