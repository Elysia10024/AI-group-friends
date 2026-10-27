// handleSendCheckWait · check-send / wait 路由的 hermetic 测试（2026-10-28 第 37 轮）。
//
// check-send 是**读 sendGroup / sendPrivate / reply 三个开关**的地方——这组测试正是
// "三个开关是活开关、不是死配置"的证据（审计曾误判它们没人读）。
// wait 只测不需要真等的那几条路径（暂停立即返回、并发 429、前置校验）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSendCheckWait } from './send.js';

function makeCtx(pathname, { method = 'POST', body = {}, agentToken, headerToken = 'T', toolEnabled = true, paused = false } = {}) {
  const sentJson = [];
  const enabledFlags = [];
  const st = { unread: [{ seq: 1 }, { seq: 2 }], wakeConfig: { mode: 'active', triggers: {} } };
  const ctx = {
    activeWaits: new Set(),
    agentTokenOk: () => true,
    cancelReplyCheckV2: () => {},
    cfg: { socialV2: { wait: { defaultMs: 30000, minMs: 5000, maxMs: 600000 } } },
    getSocialV2State: () => st,
    looksLikeUnfinished: () => false,
    preSleepWaitBlockedV2: () => false,
    readBody: async () => body,
    req: { method, headers: headerToken ? { 'x-agent-token': headerToken } : {}, on: () => {} },
    saveSocialV2State: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    sleep: async () => {},
    socialV2: { paused },
    suggestQuietMsV2: () => 30000,
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    v2SessionAllowed: () => true,
    v2ToolEnabled: (flag) => { enabledFlags.push(flag); return toolEnabled; },
  };
  return { ctx, sentJson, enabledFlags };
}

test('check-send：缺参 / 坏 token / 会话越界 / 未知 tool → 各前置拒绝', async () => {
  const noParam = makeCtx('/api/socialV2/check-send', { body: { key: 'group:1' } });
  await handleSendCheckWait(noParam.ctx);
  assert.equal(noParam.sentJson.at(-1).status, 400);

  const badToken = makeCtx('/api/socialV2/check-send', { body: { key: 'group:1', tool: 'sendGroup', token: 'T' } });
  badToken.ctx.agentTokenOk = () => false;
  await handleSendCheckWait(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const noSession = makeCtx('/api/socialV2/check-send', { body: { key: 'group:1', tool: 'sendGroup', token: 'T' } });
  noSession.ctx.v2SessionAllowed = () => false;
  await handleSendCheckWait(noSession.ctx);
  assert.match(noSession.sentJson.at(-1).body.error, /不在当前模式允许范围/);

  const badTool = makeCtx('/api/socialV2/check-send', { body: { key: 'group:1', tool: 'sendBurst', token: 'T' } });
  await handleSendCheckWait(badTool.ctx);
  assert.equal(badTool.sentJson.at(-1).status, 400);
  assert.match(badTool.sentJson.at(-1).body.error, /tool 必须是 sendGroup\/sendPrivate\/reply/);
});

test('check-send：三个开关各自生效且提示名不同（活开关证据）', async () => {
  const cases = [
    ['sendGroup', 'qq_send_group_message'],
    ['sendPrivate', 'qq_send_private_message'],
    ['reply', 'qq_reply'],
  ];
  for (const [tool, name] of cases) {
    const off = makeCtx('/api/socialV2/check-send', { body: { key: 'group:1', tool, token: 'T' }, toolEnabled: false });
    await handleSendCheckWait(off.ctx);
    assert.equal(off.sentJson.at(-1).status, 403, tool);
    assert.match(off.sentJson.at(-1).body.error, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(off.enabledFlags, [tool], '传进开关检查的正是该工具的 flag');

    const on = makeCtx('/api/socialV2/check-send', { body: { key: 'group:1', tool, token: 'T' } });
    await handleSendCheckWait(on.ctx);
    assert.deepEqual(on.sentJson.at(-1).body, { ok: true, key: 'group:1', tool });
  }
});

test('wait：缺 key / 坏 header token / 会话越界 / 工具关闭 → 前置拒绝', async () => {
  const noKey = makeCtx('/api/socialV2/wait', { body: {} });
  await handleSendCheckWait(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const badToken = makeCtx('/api/socialV2/wait', { body: { key: 'group:1' } });
  badToken.ctx.agentTokenOk = () => false;
  await handleSendCheckWait(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const noSession = makeCtx('/api/socialV2/wait', { body: { key: 'group:1' } });
  noSession.ctx.v2SessionAllowed = () => false;
  await handleSendCheckWait(noSession.ctx);
  assert.match(noSession.sentJson.at(-1).body.error, /不在当前模式允许范围/);

  const noTool = makeCtx('/api/socialV2/wait', { body: { key: 'group:1' }, toolEnabled: false });
  await handleSendCheckWait(noTool.ctx);
  assert.match(noTool.sentJson.at(-1).body.error, /工具未启用：qq_wait_for_messages/);
});

test('wait：暂停中立即返回（不挂起）；已有等待 429', async () => {
  const { ctx, sentJson } = makeCtx('/api/socialV2/wait', { body: { key: 'group:1' }, paused: true });
  await handleSendCheckWait(ctx);
  const body = sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.paused, true);
  assert.equal(body.arrived, false);
  assert.equal(body.unreadCount, 2);

  const busy = makeCtx('/api/socialV2/wait', { body: { key: 'group:1' } });
  busy.ctx.activeWaits.add('group:1');
  await handleSendCheckWait(busy.ctx);
  assert.equal(busy.sentJson.at(-1).status, 429);
  assert.match(busy.sentJson.at(-1).body.error, /已有一个等待中/);
});
