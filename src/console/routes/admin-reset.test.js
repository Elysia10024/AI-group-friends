// handleAdminDestructive · session-reset / workspace-reset 的 hermetic 测试（2026-10-28 第 43 轮）。
//
// 这两条是真正"清空上下文"的破坏性路由。测试重点不是逐个字段复述，而是：
//   · 该清的清了（代表性键各一条：反向映射、采集器、待办、social 状态、会话令牌）；
//   · 该留的没动（别的会话）；
//   · 归档/保存这些副作用被调用；
//   · workspace-reset 的 archivedCount 只统计成功归档的会话。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAdminDestructive } from './admin.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adminreset-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

function makeCtx(root, pathname, { body = {}, archiveImpl } = {}) {
  const sentJson = [];
  const calls = { savesV2: 0, saves: 0, archives: [], cancelled: 0, drains: [], logs: [] };
  const deps = {
    flags: { sessionEpoch: 0 },
    state: { sessions: { 'group:1': 'sid-1', 'group:2': 'sid-2' } },
    pending: new Map(),
  };
  deps.pending.set('group:1', { timer: setTimeout(() => {}, 1000), kind: 'approval' });
  deps.pending.get('group:1').timer.unref?.();
  const social = {
    states: new Map([['group:1', {}], ['group:2', {}]]),
    recentMessages: new Map([['group:1', []], ['group:2', []]]),
    pendingSummaries: new Map([['group:1', []]]),
    silentContext: new Map([['group:1', {}]]),
    silentTurns: new Map([['sid-1', []]]),
    exitingSessions: new Set(['sid-1']),
  };
  const socialV2 = {
    conversations: new Map([['group:1', { agentToken: 'tok-1' }], ['group:2', { agentToken: 'tok-2' }]]),
  };
  const ctx = {
    ACTIVITY_LOG: path.join(root, 'activity.log'),
    KNOWN_AGENT_TOKENS: new Set(['tok-1', 'tok-2']),
    api: {
      workspace: {
        archiveSession: async ({ sessionId }) => { calls.archives.push(sessionId); if (archiveImpl) return archiveImpl(sessionId); return {}; },
        list: async () => ({ items: [{ title: 'qq', workspaceId: 'w1', sessionIds: ['sid-1', 'sid-2-slow'] }] }),
        delete: async () => ({}),
      },
    },
    cancelAllSocialTimers: () => {},
    cancelPendingEntry: async () => { calls.cancelled += 1; },
    cancelSocialTimers: () => {},
    cfg: { workspaceTitle: 'qq' },
    clearAllSocialV2Timers: () => {},
    clearSocialV2Timers: () => {},
    collectors: new Map([['sid-1', {}], ['sid-2', {}]]),
    deps,
    drainAllPromptQueues: (why) => calls.drains.push(why),
    drainPromptQueue: (key, why) => calls.drains.push({ key, why }),
    fs,
    log: (s) => calls.logs.push(s),
    markReadCalledKeys: new Set(['group:1']),
    messageMediaStore: new Map([['group:1', []], ['group:2', []]]),
    pendingSendToolCalls: new Map([['sid-1', {}]]),
    pendingWakeKeys: new Set(['group:1']),
    queued: new Map([['group:1', {}]]),
    queuedHintAt: new Map([['group:1', 1]]),
    readBody: async () => body,
    releaseLock: () => {},
    req: { method: 'POST', headers: {}, on: () => {} },
    reverse: new Map([['sid-1', 'group:1'], ['sid-2', 'group:2']]),
    saveSocialV2State: () => { calls.savesV2 += 1; },
    saveState: () => { calls.saves += 1; },
    seenForwardIds: new Map([['group:1', new Set()]]),
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    sendToolSucceededSessions: new Set(['sid-1']),
    sessionPromises: new Map([['group:1', Promise.resolve()]]),
    slangExtractionCooldowns: new Map([['group:1', 1]]),
    slangSubmitTimes: new Map([['group:1', []]]),
    slangWindows: new Map([['group:1', []]]),
    social,
    socialV2,
    toolCallNames: new Map([['sid-1', new Map()]]),
    unwrap: (x) => x,
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    v2TurnStartAt: new Map([['sid-1', 1]]),
    wakeConfigMissCount: new Map([['group:1', 3]]),
    wakeConfigUpdatedKeys: new Set(['group:1']),
  };
  return { ctx, sentJson, calls, deps, social, socialV2 };
}

test('session-reset：未知会话 → 404；已知会话 → 只清这一个会话', async (t) => {
  const root = tempRoot(t);
  const miss = makeCtx(root, '/api/session/reset', { body: { key: 'group:9' } });
  await handleAdminDestructive(miss.ctx);
  assert.equal(miss.sentJson.at(-1).status, 404);

  const { ctx, sentJson, calls, deps, social, socialV2 } = makeCtx(root, '/api/session/reset', { body: { key: 'group:1' } });
  await handleAdminDestructive(ctx);
  const body = sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.archived, 'sid-1');
  assert.equal(deps.flags.sessionEpoch, 1);
  assert.equal(deps.state.sessions['group:1'], undefined, '会话映射被删');
  assert.equal(deps.state.sessions['group:2'], 'sid-2', '别的会话不动');
  assert.equal(ctx.reverse.has('sid-1'), false);
  assert.equal(ctx.collectors.has('sid-1'), false);
  assert.equal(ctx.pendingSendToolCalls.has('sid-1'), false);
  assert.equal(deps.pending.has('group:1'), false);
  assert.equal(calls.cancelled, 1, '挂起条目要被取消');
  assert.equal(social.states.has('group:1'), false);
  assert.equal(social.states.has('group:2'), true);
  assert.deepEqual(calls.drains, [{ key: 'group:1', why: '会话已重置' }]);
  assert.equal(socialV2.conversations.has('group:1'), false);
  assert.equal(ctx.KNOWN_AGENT_TOKENS.has('tok-1'), false, '旧令牌也要吊销');
  assert.equal(ctx.KNOWN_AGENT_TOKENS.has('tok-2'), true);
  assert.deepEqual(calls.archives, ['sid-1']);
  assert.equal(calls.savesV2, 1);
  assert.equal(calls.saves, 1);
});

test('workspace-reset：归档工作区会话（失败的不计入）、清空全部映射、清空活动日志', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'activity.log'), '旧活动记录', 'utf8');
  const { ctx, sentJson, calls, deps, social, socialV2 } = makeCtx(root, '/api/workspace/reset', {
    archiveImpl: (sid) => { if (sid === 'sid-2-slow') throw new Error('归档失败'); },
  });
  await handleAdminDestructive(ctx);
  const body = sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.archivedCount, 1, '只统计成功归档的会话');
  assert.equal(deps.flags.sessionEpoch, 1);
  assert.deepEqual(Object.keys(deps.state.sessions), [], '全部会话映射清空');
  assert.equal(deps.pending.size, 0);
  assert.equal(social.states.size, 0);
  assert.equal(social.recentMessages.size, 0);
  assert.equal(socialV2.conversations.size, 0);
  assert.equal(ctx.KNOWN_AGENT_TOKENS.size, 0, '所有令牌吊销');
  assert.equal(calls.drains.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'activity.log'), 'utf8'), '', '活动日志被清空');
});
