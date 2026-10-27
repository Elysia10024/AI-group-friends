// handleSlangAiAndExpressionRoutes · 黑话提交/查询 路由的 hermetic 测试（2026-10-28 第 30 轮）。
//
// 这条路径会写 state/slang.json（4887 条黑话的地方）。第 1 期修过"解析失败把 [] 写回"的事故，
// 这里钉住：重复词条只累计不重复建、被拒词条不许再提交、阈值命中才触发研究队列。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSlangAiAndExpressionRoutes } from './slang.js';

const SLANG_STATUS = { CANDIDATE: 'candidate', CONFIRMED: 'confirmed', REJECTED: 'rejected' };

function makeCtx(pathname, { method = 'GET', body = {}, query = '', entries = [], allow = true, enabled = true, autoResearch = true } = {}) {
  const sentJson = [];
  const calls = { save: 0, queued: 0, activity: [] };
  const flags = { slangEntries: entries };
  const ctx = {
    SLANG_STATUS,
    agentTokenOk: () => true,
    allowSlangSubmit: () => allow,
    appendActivity: (s) => calls.activity.push(s),
    buildSlangContext: (list, max) => `SLANG-BLOCK(${max})`,
    cfg: { slang: { enabled, autoResearch, inferenceThresholds: [2, 4, 8], injectMax: 8 } },
    confirmedSlangListV2: () => [{ content: '摸鱼', meaning: '偷懒', usage: '动词', example: '今天摸鱼' }],
    createSlangEntry: (o) => ({ id: 'new', count: 1, ...o, updatedAt: 'now' }),
    deleteExpressionById: () => {},
    deps: { flags },
    listExpressions: () => [],
    log: () => {},
    mergeEvidence: (old, add) => [...(old ?? []), ...add],
    publicSlangEntry: (e) => ({ content: e.content, status: e.status, count: e.count }),
    queueSlangTask: () => { calls.queued += 1; },
    readBody: async () => body,
    redactKnownTokensOnly: (s) => s.replace(/TOKEN-\d+/g, '[REDACTED]'),
    req: { method, headers: { 'x-agent-token': 'T' }, on: () => {} },
    runExpressionExtraction: async () => {},
    runSlangResearch: async () => {},
    saveSlangStore: () => { calls.save += 1; },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    setExpressionStatus: () => {},
    url: new URL(`http://127.0.0.1:3100${pathname}${query}`),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
  };
  return { ctx, sentJson, calls, flags };
}

test('slang/submit：缺 key / 空 content / 超 50 字 / 关闭 / 限流 → 各自拒绝', async () => {
  const cases = [
    [{ key: '', content: 'x' }, 400, /key 不能为空/],
    [{ key: 'group:1', content: '' }, 400, /content 不能为空/],
    [{ key: 'group:1', content: 'a'.repeat(51) }, 400, /过长/],
  ];
  for (const [body, status, expect] of cases) {
    const { ctx, sentJson } = makeCtx('/api/socialV2/slang/submit', { method: 'POST', body });
    await handleSlangAiAndExpressionRoutes(ctx);
    assert.equal(sentJson.at(-1).status, status, JSON.stringify(body));
    assert.match(sentJson.at(-1).body.error, expect);
  }
  const off = makeCtx('/api/socialV2/slang/submit', { method: 'POST', body: { key: 'group:1', content: 'x' }, enabled: false });
  await handleSlangAiAndExpressionRoutes(off.ctx);
  assert.equal(off.sentJson.at(-1).status, 403);
  const limited = makeCtx('/api/socialV2/slang/submit', { method: 'POST', body: { key: 'group:1', content: 'x' }, allow: false });
  await handleSlangAiAndExpressionRoutes(limited.ctx);
  assert.equal(limited.sentJson.at(-1).status, 429);
});

test('slang/submit：新词条 → 创建并入库；autoResearch 开启时进研究队列', async () => {
  const { ctx, sentJson, calls, flags } = makeCtx('/api/socialV2/slang/submit', {
    method: 'POST',
    body: { key: 'group:1', content: '绷不住了', context: '看到 TOKEN-9 了' },
  });
  await handleSlangAiAndExpressionRoutes(ctx);
  assert.equal(flags.slangEntries.length, 1);
  const entry = flags.slangEntries[0];
  assert.equal(entry.content, '绷不住了');
  assert.equal(entry.status, SLANG_STATUS.CANDIDATE);
  assert.equal(entry.evidence[0].text, '看到 [REDACTED] 了', '语境里的令牌要打码');
  assert.equal(calls.save, 1);
  assert.equal(calls.queued, 1);
  assert.equal(sentJson.at(-1).body.ok, true);
});

test('slang/submit：已确认词条 → duplicate confirmed，不再新建', async () => {
  const entries = [{ content: '摸鱼', status: SLANG_STATUS.CONFIRMED, count: 3 }];
  const { ctx, sentJson, calls } = makeCtx('/api/socialV2/slang/submit', { method: 'POST', body: { key: 'group:1', content: '摸鱼' }, entries });
  await handleSlangAiAndExpressionRoutes(ctx);
  const body = sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.duplicate, true);
  assert.equal(body.status, 'confirmed');
  assert.equal(entries.length, 1);
  assert.equal(calls.save, 0, '已确认词条不需要写盘');
});

test('slang/submit：被拒词条 → 403，不许再提交', async () => {
  const entries = [{ content: '烂梗', status: SLANG_STATUS.REJECTED }];
  const { ctx, sentJson } = makeCtx('/api/socialV2/slang/submit', { method: 'POST', body: { key: 'group:1', content: '烂梗' }, entries });
  await handleSlangAiAndExpressionRoutes(ctx);
  assert.equal(sentJson.at(-1).status, 403);
  assert.match(sentJson.at(-1).body.error, /已被管理员拒绝/);
});

test('slang/submit：候选重复 → 累计次数 + 追加证据；命中阈值才排队研究', async () => {
  const entries = [{ content: '抽象', status: SLANG_STATUS.CANDIDATE, count: 1, evidence: [], updatedAt: '' }];
  const { ctx, sentJson, calls } = makeCtx('/api/socialV2/slang/submit', {
    method: 'POST',
    body: { key: 'group:1', content: '抽象', context: '太抽象了' },
    entries,
  });
  await handleSlangAiAndExpressionRoutes(ctx);
  assert.equal(entries[0].count, 2);
  assert.equal(entries[0].evidence.length, 1);
  assert.equal(calls.save, 1);
  assert.equal(calls.queued, 1, 'count=2 命中阈值 [2,4,8]');
  assert.equal(sentJson.at(-1).body.status, 'candidate');

  // count=4 → 提交后 5，不是阈值 → 不排队
  entries[0].count = 4;
  const again = makeCtx('/api/socialV2/slang/submit', { method: 'POST', body: { key: 'group:1', content: '抽象' }, entries });
  await handleSlangAiAndExpressionRoutes(again.ctx);
  assert.equal(again.calls.queued, 0);
});

test('slang/query：缺 key 400；不传 q 返回全部并带注入块', async () => {
  const noKey = makeCtx('/api/socialV2/slang/query');
  await handleSlangAiAndExpressionRoutes(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const all = makeCtx('/api/socialV2/slang/query', { query: '?key=group:1' });
  await handleSlangAiAndExpressionRoutes(all.ctx);
  assert.equal(all.sentJson.at(-1).body.total, 1);
  assert.equal(all.sentJson.at(-1).body.block, 'SLANG-BLOCK(8)');
});

test('slang/query：按内容/含义/用法/例句过滤', async () => {
  for (const q of ['摸鱼', '偷懒', '动词', '今天摸鱼']) {
    const { ctx, sentJson } = makeCtx('/api/socialV2/slang/query', { query: `?key=group:1&q=${encodeURIComponent(q)}` });
    await handleSlangAiAndExpressionRoutes(ctx);
    assert.equal(sentJson.at(-1).body.total, 1, q);
  }
  const none = makeCtx('/api/socialV2/slang/query', { query: '?key=group:1&q=无此词' });
  await handleSlangAiAndExpressionRoutes(none.ctx);
  assert.equal(none.sentJson.at(-1).body.total, 0);
});
