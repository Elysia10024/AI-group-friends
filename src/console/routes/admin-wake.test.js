// admin 里「叫醒她 / 测试发送」三条路由的 hermetic 测试（2026-10-28 第 35 轮）。
//
// 这三个口是日常运维与冒烟脚本天天打的：/api/console/notify-ai（后台提醒投递）、
// /api/test-send（强制走白名单的测试发送）、/api/socialV2/wake（手动唤醒）。
// 它们决定"她现在会不会被叫起来"，所以把每道前置与成功路径都钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAdminConfigSecurity, handleAdminStateInspect } from './admin.js';

function makeConfigCtx(pathname, { body = {}, mode = 'closed-agent', dshReady = true, sessions = {}, allowed = () => true, modeOk = () => true, deliver = async () => ({ ok: true }), sendImpl } = {}) {
  const sentJson = [];
  const calls = { delivered: [], escape: [], activity: [], silent: 0 };
  const ctx = {
    SENSITIVE_RE: /secret/i,
    ROOT: 'C:/tmp',
    allowed,
    appendActivity: (s) => calls.activity.push(s),
    atomicWriteJson: () => {},
    atomicWriteText: () => {},
    bot: {
      sendPrivateMessage: async (id, msg) => { if (sendImpl) return sendImpl(id, msg); return { message_id: 'm1' }; },
      sendGroupMessage: async (id, msg) => { if (sendImpl) return sendImpl(id, msg); return { message_id: 'm2' }; },
    },
    cfg: { ownerQQ: 1, security: {} },
    deps: { flags: { currentMode: mode, dshReady }, state: { sessions } },
    ensureSession: async (key) => `sid-${key}`,
    escapeCqText: (s) => { calls.escape.push(s); return s.replace(/\[/g, '［'); },
    getSocialV2State: () => ({ agentToken: 'TOKEN-X' }),
    log: () => {},
    modeAllowed: modeOk,
    readBody: async () => body,
    readJsonSafe: () => ({}),
    readRoleState: () => ({ role: '小鲸鱼' }),
    redactKnownTokensOnly: (s) => s,
    req: { method: 'POST', headers: {}, on: () => {} },
    saveSocialV2State: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    social: { silentTurns: new Map() },
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    deliverPrompt: async (key, text, opts) => { calls.delivered.push({ key, text, opts }); return deliver(key, text, opts); },
  };
  calls.silent = () => [...ctx.social.silentTurns.values()].flat().length;
  return { ctx, sentJson, calls };
}

test('notify-ai：缺参/坏 key/模式/白名单/DSH 未就绪 各前置拒绝', async () => {
  const noMsg = makeConfigCtx('/api/console/notify-ai', { body: { key: 'group:1' } });
  await handleAdminConfigSecurity(noMsg.ctx);
  assert.equal(noMsg.sentJson.at(-1).status, 400);

  const badKey = makeConfigCtx('/api/console/notify-ai', { body: { key: 'x:1', message: 'hi' } });
  await handleAdminConfigSecurity(badKey.ctx);
  assert.equal(badKey.sentJson.at(-1).status, 400);

  const wrongMode = makeConfigCtx('/api/console/notify-ai', { body: { key: 'group:1', message: 'hi' }, modeOk: () => false });
  await handleAdminConfigSecurity(wrongMode.ctx);
  assert.equal(wrongMode.sentJson.at(-1).status, 403);

  const notAllowed = makeConfigCtx('/api/console/notify-ai', { body: { key: 'group:1', message: 'hi' }, allowed: () => false });
  await handleAdminConfigSecurity(notAllowed.ctx);
  assert.equal(notAllowed.sentJson.at(-1).status, 403);
  assert.match(notAllowed.sentJson.at(-1).body.error, /白名单/);

  const noDsh = makeConfigCtx('/api/console/notify-ai', { body: { key: 'group:1', message: 'hi' }, dshReady: false });
  await handleAdminConfigSecurity(noDsh.ctx);
  assert.equal(noDsh.sentJson.at(-1).status, 503);
});

test('notify-ai：closed-agent 提醒不含会话令牌；reserved2 提醒带令牌与发送指引', async () => {
  const c1 = makeConfigCtx('/api/console/notify-ai', { body: { key: 'private:1', message: '记得喝水' }, mode: 'closed-agent' });
  await handleAdminConfigSecurity(c1.ctx);
  const p1 = c1.calls.delivered[0];
  assert.equal(p1.opts.silent, true);
  assert.match(p1.text, /【后台控制端提醒】/);
  assert.match(p1.text, /记得喝水/);
  assert.doesNotMatch(p1.text, /TOKEN-X/, 'closed-agent 不能把会话令牌真值塞进提醒');
  assert.equal(c1.sentJson.at(-1).body.ok, true);
  assert.equal(c1.sentJson.at(-1).body.sessionId, 'sid-private:1');

  const c2 = makeConfigCtx('/api/console/notify-ai', { body: { key: 'private:1', message: '记得喝水' }, mode: 'reserved2' });
  await handleAdminConfigSecurity(c2.ctx);
  const p2 = c2.calls.delivered[0];
  assert.match(p2.text, /【会话令牌】TOKEN-X/);
  assert.match(p2.text, /你的文本输出不会自动发送到 QQ/);
});

test('notify-ai：投递失败 → 500 且清掉 silent 标记（不留悬挂回合）', async () => {
  const { ctx, sentJson, calls } = makeConfigCtx('/api/console/notify-ai', {
    body: { key: 'group:1', message: 'hi' },
    deliver: async () => ({ ok: false, error: 'DSH 没响应' }),
  });
  await handleAdminConfigSecurity(ctx);
  assert.equal(sentJson.at(-1).status, 500);
  assert.match(sentJson.at(-1).body.error, /DSH 没响应/);
  assert.equal(calls.silent(), 0, '失败要把刚登记的 silent 标记 pop 掉');
});

test('test-send：id/内容/敏感/白名单/模式 各前置拒绝', async () => {
  const cases = [
    [{ id: 'abc', message: 'x' }, 400],
    [{ id: 1, message: '' }, 400],
    [{ id: 1, message: 'my secret' }, 403],
  ];
  for (const [body, status] of cases) {
    const { ctx, sentJson } = makeConfigCtx('/api/test-send', { body });
    await handleAdminConfigSecurity(ctx);
    assert.equal(sentJson.at(-1).status, status, JSON.stringify(body));
  }
  const notAllowed = makeConfigCtx('/api/test-send', { body: { id: 1, message: 'x' }, allowed: () => false });
  await handleAdminConfigSecurity(notAllowed.ctx);
  assert.match(notAllowed.sentJson.at(-1).body.error, /不在白名单/);

  const wrongMode = makeConfigCtx('/api/test-send', { body: { id: 1, message: 'x' }, modeOk: () => false });
  await handleAdminConfigSecurity(wrongMode.ctx);
  assert.match(wrongMode.sentJson.at(-1).body.error, /不允许向/);
});

test('test-send：成功走 CQ 转义并回 message_id；网关失败 500', async () => {
  const ok = makeConfigCtx('/api/test-send', { body: { kind: 'group', id: 20000003, message: '看[CQ:at,qq=1]' } });
  await handleAdminConfigSecurity(ok.ctx);
  assert.deepEqual(ok.calls.escape, ['看[CQ:at,qq=1]']);
  assert.equal(ok.sentJson.at(-1).body.message_id, 'm2');
  assert.equal(ok.sentJson.at(-1).body.ok, true);

  const fail = makeConfigCtx('/api/test-send', { body: { kind: 'private', id: 1, message: 'x' }, sendImpl: () => { throw new Error('网关 500'); } });
  await handleAdminConfigSecurity(fail.ctx);
  assert.equal(fail.sentJson.at(-1).status, 500);
  assert.match(fail.sentJson.at(-1).body.error, /发送失败/);
});

function makeStateCtx(pathname, { body = {}, mode = 'reserved2', modeOk = () => true } = {}) {
  const sentJson = [];
  const st = { pendingWakeTimer: setTimeout(() => {}, 1000), bootstrapSent: false };
  const calls = { wake: [], saves: 0, cleared: 0 };
  const ctx = {
    cfg: {},
    deps: { flags: { currentMode: mode } },
    getSocialV2State: () => st,
    log: () => {},
    modeAllowed: modeOk,
    readBody: async () => body,
    req: { method: 'POST', headers: {}, on: () => {} },
    saveSocialV2State: () => { calls.saves += 1; },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    sendWakePromptV2: (key, reason) => { calls.wake.push({ key, reason }); },
    socialV2: { conversations: new Map() },
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    clearTimeout: (t) => { calls.cleared += 1; clearTimeout(t); },
  };
  return { ctx, st, sentJson, calls };
}

test('socialV2/wake：缺 key/bad key/非 reserved2/模式不允许 → 拒绝', async () => {
  const noKey = makeStateCtx('/api/socialV2/wake', { body: {} });
  await handleAdminStateInspect(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const badKey = makeStateCtx('/api/socialV2/wake', { body: { key: 'x:1' } });
  await handleAdminStateInspect(badKey.ctx);
  assert.equal(badKey.sentJson.at(-1).status, 400);

  const closed = makeStateCtx('/api/socialV2/wake', { body: { key: 'group:1' }, mode: 'closed-agent' });
  await handleAdminStateInspect(closed.ctx);
  assert.equal(closed.sentJson.at(-1).body.error, '该接口仅 reserved2 模式可用');

  const noMode = makeStateCtx('/api/socialV2/wake', { body: { key: 'group:1' }, modeOk: () => false });
  await handleAdminStateInspect(noMode.ctx);
  assert.match(noMode.sentJson.at(-1).body.error, /不在当前模式允许范围/);
});

test('socialV2/wake：成功清定时器、置 bootstrap、落盘并唤醒', async () => {
  const { ctx, st, sentJson, calls } = makeStateCtx('/api/socialV2/wake', { body: { key: 'group:1', reason: 'admin' } });
  await handleAdminStateInspect(ctx);
  assert.equal(st.bootstrapSent, true);
  assert.equal(st.pendingWakeTimer, null);
  assert.equal(calls.saves, 1);
  assert.deepEqual(calls.wake, [{ key: 'group:1', reason: 'admin' }]);
  assert.equal(sentJson.at(-1).body.ok, true);
});
