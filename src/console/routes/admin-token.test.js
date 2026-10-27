// admin 的 pending / console-token / socialV2 states 三条路由测试（2026-10-28 第 45 轮）。
//
// 写 token 测试时发现 `routeConsoleTokenPost` 里有一行 `consoleToken = newToken`，
// 而 consoleToken 是从 `const {...} = ctx` 解构出的**常量**——赋值会抛 TypeError。
// 本文件的「改令牌」用例就是验证这一点：如果它 500/抛错，那是真 bug；如果通过，说明我读错了。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAdminConfigSecurity, handleAdminStateInspect } from './admin.js';
import { atomicWriteJson, atomicWriteText } from '../../core/state-io.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admintok-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

function makeConfigCtx(root, pathname, { body = {} } = {}) {
  const sentJson = [];
  const calls = { setToken: [] };
  const ctx = {
    ROOT: root,
    STATE_DIR: path.join(root, 'state'),
    cfg: {},
    consoleToken: 'old-token-1234567890',
    setConsoleToken: (t) => { calls.setToken.push(t); },
    deps: {
      flags: { currentMode: 'reserved2' },
      pending: new Map([
        ['group:1', { kind: 'approval', sessionId: 's1', toolName: 'x', reason: 'r', approvalId: 'a1' }],
        ['group:2', { kind: 'question', sessionId: 's2', questions: [{ q: 1 }] }],
      ]),
      state: { sessions: {} },
    },
    fs,
    path,
    readBody: async () => body,
    readJsonSafe: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
    req: { method: 'POST', headers: {}, on: () => {} },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    atomicWriteJson,
    atomicWriteText,
    log: () => {},
    appendActivity: () => {},
    KNOWN_AGENT_TOKENS: new Set(),
    SENSITIVE_RE: /x/,
    SOCIAL_V2_FILE: path.join(root, 'state', 'social-v2.json'),
    allowed: () => true,
    bot: {},
    clearAllPendingWakeLeases: () => {},
    clearAllSocialV2Timers: () => {},
    collectors: new Map(),
    deliverPrompt: () => {},
    drainAllPromptQueues: () => {},
    ensureSession: async () => 'sid',
    escapeCqText: (s) => s,
    getSocialV2State: () => ({}),
    markReadCalledKeys: new Set(),
    modeAllowed: () => true,
    normalizeOwnerQQ: (v) => Number(v),
    pendingSendToolCalls: new Map(),
    pendingWakeKeys: new Set(),
    readRoleState: () => ({}),
    redactKnownTokensOnly: (s) => s,
    refreshAllDefaultWakeConfigsV2: () => {},
    reverse: new Map(),
    saveSocialV2State: () => {},
    scheduleProactiveCheckV2: () => {},
    seenForwardIds: new Map(),
    sendToolSucceededSessions: new Set(),
    sessionPromises: new Map(),
    setupSleepTimerV2: () => {},
    social: { silentTurns: new Map() },
    socialV2: { conversations: new Map() },
    toolCallNames: new Map(),
    v2TurnStartAt: new Map(),
    wakeConfigMissCount: new Map(),
    wakeConfigUpdatedKeys: new Set(),
  };
  return { ctx, sentJson, calls };
}

test('GET /api/pending：列出挂起项并按 kind 带不同字段', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeConfigCtx(root, '/api/pending');
  ctx.req.method = 'GET';
  await handleAdminConfigSecurity(ctx);
  const list = sentJson.at(-1).body.pending;
  assert.equal(list.length, 2);
  const approval = list.find((x) => x.kind === 'approval');
  assert.equal(approval.toolName, 'x');
  assert.equal(approval.approvalId, 'a1');
  const question = list.find((x) => x.kind === 'question');
  assert.deepEqual(question.questions, [{ q: 1 }]);
});

test('POST /api/console/token：手动令牌校验三连（太短/超长/非法字符）', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'config.json'), '{}', 'utf8');
  const cases = [
    ['short', /至少需要 16 位/],
    ['a'.repeat(129), /不能超过 128 位/],
    ['有中文的令牌abcdefghijkl', /只能包含字母/],
  ];
  for (const [token, expect] of cases) {
    const { ctx, sentJson } = makeConfigCtx(root, '/api/console/token', { body: { token } });
    await handleAdminConfigSecurity(ctx);
    assert.equal(sentJson.at(-1).status, 400, token.slice(0, 8));
    assert.match(sentJson.at(-1).body.error, expect);
  }
});

test('POST /api/console/token：合法手动令牌写 config.json + state/console-token', async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), '{}', 'utf8');
  const { ctx, sentJson, calls } = makeConfigCtx(root, '/api/console/token', { body: { token: 'new-token-abcdefghij' } });
  await handleAdminConfigSecurity(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true, '合法令牌必须成功（若这里 500，就是解构常量被赋值）');
  assert.equal(last.body.generated, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).consoleToken, 'new-token-abcdefghij');
  assert.equal(fs.readFileSync(path.join(root, 'state', 'console-token'), 'utf8'), 'new-token-abcdefghij');
  assert.deepEqual(calls.setToken, ['new-token-abcdefghij'], 'setter 被调用 → 后续请求立即用新令牌');
});

test('POST /api/console/token：留空则生成随机 48 位并把手动值清空', async (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ consoleToken: 'old-manual' }), 'utf8');
  const { ctx, sentJson } = makeConfigCtx(root, '/api/console/token', { body: {} });
  await handleAdminConfigSecurity(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.equal(last.body.generated, true);
  assert.equal(last.body.token.length, 48);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).consoleToken, '', '随机令牌不写进 config');
});

test('GET /api/socialV2/states：列出每个会话的唤醒配置与计数', async () => {
  const sentJson = [];
  const ctx = {
    cfg: {},
    deps: { flags: { currentMode: 'reserved2' } },
    getSocialV2State: () => ({}),
    log: () => {},
    modeAllowed: () => true,
    readBody: async () => ({}),
    req: { method: 'GET', headers: {}, on: () => {} },
    saveSocialV2State: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    sendWakePromptV2: () => {},
    socialV2: {
      conversations: new Map([
        ['group:1', { wakeConfig: { mode: 'diving', noActionCount: 2 }, unread: [1, 2], recentMessages: [1], lastWakeReason: 'atMention', lastAiReplyAt: 5 }],
      ]),
    },
    url: new URL('http://127.0.0.1:3100/api/socialV2/states'),
  };
  await handleAdminStateInspect(ctx);
  const c = sentJson.at(-1).body.conversations[0];
  assert.equal(c.key, 'group:1');
  assert.equal(c.unreadCount, 2);
  assert.equal(c.recentCount, 1);
  assert.equal(c.noActionCount, 2);
  assert.equal(c.lastWakeReason, 'atMention');
});
