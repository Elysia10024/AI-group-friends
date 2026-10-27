// handleSocialV2ReadWrite · 状态/未读/最近/已读 四条路由的 hermetic 测试（2026-10-28 第 24 轮）。
//
// 这是 AI 读写她状态的主通路。测试全部走真实路由代码；mark-read 用**真实**的
// settleV2ReadState（core/wake-policy.js），因为"哪些算已读"的语义在它里面。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSocialV2ReadWrite } from './socialV2.js';
import { createWakePolicyModule } from '../../domains/wake-policy.js';

// 真实的 settleV2ReadState 在 wake-policy 工厂里；用最小 ctx 实例化一次拿真函数
// （"哪些算已读"的语义在它里面，stub 掉就测不到真语义）。
let settleReal;
function makeCtx(pathname, { query = '', body = {}, agentToken, method = 'GET', st: stOverride } = {}) {
  const sentJson = [];
  const st = stOverride ?? {
    wakeConfig: { mode: 'active', triggers: {} },
    unread: [{ seq: 1, text: '在吗' }, { seq: 2, text: '刚在吗' }],
    recentMessages: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
    lastWakeReason: 'atMention',
    lastAiReplyAt: 123,
    lastUnreadSeq: 2,
    lastFetchedSeq: 0,
    pendingMentions: [],
    lastIncomingAt: 0,
  };
  const ctx = {
    agentTokenOk: () => true,
    allowedKeywordsRawV2: () => [],
    allowedKeywordsV2: () => [],
    buildSlangContext: () => '',
    buildStickerContext: () => '',
    buildStickerStrategyHint: () => '',
    cancelReplyCheckV2: () => {},
    cfg: { socialV2: { wake: { preSleepWaitMs: 120000 } } },
    computeWakeSafetyV2: () => ({ guaranteed: true }),
    confirmedSlangListV2: () => [],
    currentRoleHint: () => '',
    currentRoleHintV2: () => '',
    deps: { flags: { currentMode: 'reserved2' } },
    ensureWakeableV2: () => true,
    formatMemoryV2: () => '',
    formatParticipationV2: () => '',
    getSocialV2State: () => st,
    isSleepingConfigV2: () => false,
    log: () => {},
    markReadCalledKeys: new Set(),
    mentionsOnlyV2: () => ({}),
    normalizeSpeakerIdsV2: () => '',
    preSleepWaitBlockedV2: () => false,
    readBody: async () => body,
    readRoleState: () => ({ role: '小鲸鱼' }),
    readShadowAssemblies: (limit) => ({ assemblies: [{ limit }] }),
    req: { method, headers: agentToken ? { 'x-agent-token': agentToken } : {}, on: () => {} },
    resetPreSleepWait: () => {},
    saveSocialV2State: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    settleV2ReadState: (st, opts) => settleReal(st, opts),
    setupSleepTimerV2: () => {},
    stickerEnabled: () => true,
    syncStickerLibrary: async () => {},
    url: new URL(`http://127.0.0.1:3100${pathname}${query}`),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    wakeConfigMissCount: new Map(),
    wakeConfigUpdatedKeys: new Set(),
  };
  return { ctx, st, sentJson };
}

test('GET /state：缺 key → 400；成功返回计数与唤醒原因', async () => {
  settleReal = createWakePolicyModule({
    allowedKeywords: () => [],
    allowedKeywordsRaw: () => [],
    armFollowUp: () => {},
    cfg: { socialV2: { wake: {} } },
    followUpState: new Map(),
    log: () => {},
    mentionsOnly: () => false,
    normalizeSpeakerIdsV2: () => '',
    setupSleepTimerV2: () => {},
    socialV2: { conversations: new Map() },
    wakePolicy: () => ({}),
  }).settleV2ReadState;
  const noKey = makeCtx('/api/socialV2/state');
  await handleSocialV2ReadWrite(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const ok = makeCtx('/api/socialV2/state', { query: '?key=group:1' });
  await handleSocialV2ReadWrite(ok.ctx);
  const body = ok.sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.key, 'group:1');
  assert.equal(body.unreadCount, 2);
  assert.equal(body.recentCount, 3);
  assert.equal(body.lastWakeReason, 'atMention');
  assert.equal(body.lastAiReplyAt, 123);
});

test('GET /state：带 agent token 但 token 无效/会话越界 → 403', async () => {
  const bad = makeCtx('/api/socialV2/state', { query: '?key=group:1', agentToken: 'X' });
  bad.ctx.agentTokenOk = () => false;
  await handleSocialV2ReadWrite(bad.ctx);
  assert.equal(bad.sentJson.at(-1).status, 403);
  assert.match(bad.sentJson.at(-1).body.error, /agent token 无效/);

  const out = makeCtx('/api/socialV2/state', { query: '?key=group:1', agentToken: 'X' });
  out.ctx.v2SessionAllowed = () => false;
  await handleSocialV2ReadWrite(out.ctx);
  assert.match(out.sentJson.at(-1).body.error, /不在当前模式允许范围内/);
});

test('GET /unread：看了就推进水位线（deliveredSeq / lastFetchedSeq）并落盘', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/unread', { query: '?key=group:1&limit=1' });
  let saved = 0;
  ctx.saveSocialV2State = () => { saved += 1; };
  await handleSocialV2ReadWrite(ctx);
  const body = sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.unreadCount, 2);
  assert.equal(body.messages.length, 1, 'limit=1 只给最后 1 条');
  assert.equal(st.deliveredSeq, 2);
  assert.equal(st.lastFetchedSeq, 2);
  assert.equal(saved, 1);
});

test('GET /recent：offset/limit 切片（从末尾往前数）', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/recent', { query: '?key=group:1&limit=1&offset=1' });
  await handleSocialV2ReadWrite(ctx);
  const body = sentJson.at(-1).body;
  assert.deepEqual(body.messages.map((m) => m.text), ['b']);
});

test('POST /mark-read：沉睡前观察窗口没等够 → 400 并给出剩余分钟', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/mark-read', { method: 'POST', body: { key: 'group:1' } });
  ctx.isSleepingConfigV2 = () => true;
  ctx.preSleepWaitBlockedV2 = () => true;
  await handleSocialV2ReadWrite(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.status, 400);
  assert.match(last.body.error, /还不能通过 qq_mark_read/);
  assert.equal(last.body.preSleepWaitMs, 120000);
});

test('POST /mark-read：有@她但没看过 → 第一次拦下并把这些消息标 nudged', async () => {
  const { ctx, st, sentJson } = makeCtx('/api/socialV2/mark-read', { method: 'POST',
    body: { key: 'group:1' },
    st: {
      wakeConfig: { mode: 'active', triggers: {} },
      unread: [], recentMessages: [], lastUnreadSeq: 5, lastFetchedSeq: 0, lastIncomingAt: 0,
      pendingMentions: [{ seq: 4, at: Date.now(), sender: '小明', kind: 'atMention', text: '在吗' }],
    },
  });
  await handleSocialV2ReadWrite(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.status, 400);
  assert.match(last.body.error, /先别收尾/);
  assert.equal(last.body.pendingMentions.length, 1);
  assert.equal(st.pendingMentions[0].nudged, true, '拦过一次后要标 nudged 防死锁');
});

test('POST /mark-read：正常清未读 → 返回 markedCount 与唤醒安全', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/mark-read', { method: 'POST', body: { key: 'group:1' } });
  await handleSocialV2ReadWrite(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.equal(typeof last.body.markedCount, 'number');
  assert.equal(last.body.wakeGuaranteed, true);
  assert.ok(last.body.wakeSafety);
});

test('GET /context-shadow：透传 readShadowAssemblies 的 limit', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/context-shadow', { query: '?limit=5' });
  await handleSocialV2ReadWrite(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.deepEqual(last.body.assemblies, [{ limit: 5 }]);
});
