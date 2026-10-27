// B 站相关路由的 hermetic 测试（2026-10-28 第 33 轮）：
//   · POST /api/socialV2/bili-scroll（她自刷视频，写 state/bili-*.json）；
//   · POST /api/socialV2/bili-look（看一个视频/动态）；
//   · GET /api/bili-look/status（控制台面板：今天看了什么 + 分享配额）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleBiliScroll } from './bili-scroll.js';
import { handleBiliLook } from './bili-look.js';

function makeCtx(pathname, { method = 'POST', body = {}, token = 'T', agentTokenOk = () => true, sessionOk = () => true, impl } = {}) {
  const sentJson = [];
  const calls = { scroll: [], look: [] };
  const ctx = {
    readBody: async () => body,
    req: { method, headers: token ? { 'x-agent-token': token } : {}, on: () => {} },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    agentTokenOk,
    v2SessionAllowed: sessionOk,
    getSocialV2State: () => ({ recentMessages: [{ userId: 10000001, sender: '主人' }] }),
    biliScroll: {
      scroll: async (key) => { calls.scroll.push(key); if (impl?.scroll) return impl.scroll(key); return { watched: 2, shared: 1 }; },
      status: () => ({ history: [{ bvid: 'B1' }], quotas: [] }),
    },
    biliLook: {
      look: async (key, url, opts) => { calls.look.push({ key, url, opts }); if (impl?.look) return impl.look(key, url, opts); return { title: '视频标题', moments: [] }; },
      status: () => ({
        history: [{ bvid: 'BV1' }],
        quotas: [{ key: 'group:20000003', who: 10000001, used: 1, limit: 3 }],
        ownerQQ: 10000001,
      }),
    },
  };
  return { ctx, sentJson, calls };
}

test('bili-scroll：缺 key 400；无 token 403；坏 token 403；会话越界 403', async () => {
  const noKey = makeCtx('/api/socialV2/bili-scroll', { body: {} });
  await handleBiliScroll(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const noToken = makeCtx('/api/socialV2/bili-scroll', { body: { key: 'group:1' }, token: '' });
  await handleBiliScroll(noToken.ctx);
  assert.equal(noToken.sentJson.at(-1).status, 403);

  const badToken = makeCtx('/api/socialV2/bili-scroll', { body: { key: 'group:1' }, agentTokenOk: () => false });
  await handleBiliScroll(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const noSession = makeCtx('/api/socialV2/bili-scroll', { body: { key: 'group:1' }, sessionOk: () => false });
  await handleBiliScroll(noSession.ctx);
  assert.match(noSession.sentJson.at(-1).body.error, /不在当前模式允许范围/);
});

test('bili-scroll：成功展开结果；失败 400 原样透出', async () => {
  const ok = makeCtx('/api/socialV2/bili-scroll', { body: { key: 'group:1' } });
  await handleBiliScroll(ok.ctx);
  assert.deepEqual(ok.sentJson.at(-1).body, { ok: true, watched: 2, shared: 1 });
  assert.deepEqual(ok.calls.scroll, ['group:1']);

  const fail = makeCtx('/api/socialV2/bili-scroll', { body: { key: 'group:1' }, impl: { scroll: () => { throw new Error('今日刷视频额度已用完'); } } });
  await handleBiliScroll(fail.ctx);
  assert.equal(fail.sentJson.at(-1).status, 400);
  assert.match(fail.sentJson.at(-1).body.error, /额度已用完/);
});

test('bili-look 状态面板：配额映射群号、回填名字、标 owner', async () => {
  const { ctx, sentJson } = makeCtx('/api/bili-look/status', { method: 'GET' });
  await handleBiliLook(ctx);
  const body = sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.history[0].bvid, 'BV1');
  const q = body.quotas[0];
  assert.equal(q.group, '20000003', 'key 前缀剥掉');
  assert.equal(q.name, '主人', '从最近消息回填名字');
  assert.equal(q.owner, true, 'who 等于 ownerQQ 时标 owner');
});

test('bili-look：缺 key/缺 token/坏 token 的拒绝', async () => {
  const noKey = makeCtx('/api/socialV2/bili-look', { body: {} });
  await handleBiliLook(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const noToken = makeCtx('/api/socialV2/bili-look', { body: { key: 'group:1' }, token: '' });
  await handleBiliLook(noToken.ctx);
  assert.equal(noToken.sentJson.at(-1).status, 403);

  const bad = makeCtx('/api/socialV2/bili-look', { body: { key: 'group:1' }, agentTokenOk: () => false });
  await handleBiliLook(bad.ctx);
  assert.match(bad.sentJson.at(-1).body.error, /agent token 无效/);
});

test('bili-look：withFrames 三态（缺省 null / true / false）与成功展开', async () => {
  for (const [input, expect] of [[undefined, null], [true, true], [false, false]]) {
    const { ctx, sentJson, calls } = makeCtx('/api/socialV2/bili-look', { body: { key: 'group:1', url: 'https://b23.tv/x', withFrames: input } });
    await handleBiliLook(ctx);
    assert.equal(calls.look[0].opts.withFrames, expect, `withFrames=${input}`);
    assert.equal(sentJson.at(-1).body.ok, true);
    assert.equal(sentJson.at(-1).body.title, '视频标题');
  }
});

test('bili-look：失败 400 原样透出', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/bili-look', {
    body: { key: 'group:1', url: 'x' },
    impl: { look: () => { throw new Error('链接解析不出来'); } },
  });
  await handleBiliLook(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /解析不出来/);
});
