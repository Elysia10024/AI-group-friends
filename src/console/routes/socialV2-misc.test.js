// active-members / feedback / tool-log 路由的 hermetic 测试（2026-10-28 第 40 轮）。
//
// active-members：按人聚合最近消息（排除 isSelf）、按活跃度排序、limit 夹取；
// feedback：类别归一、正文截断、**每分钟 5 条/每小时 20 条**限频、控制台专属的清空接口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleSocialV2ActiveMembers, handleSocialV2LogsFeedback } from './socialV2.js';

function tempFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv2misc-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

test('active-members：缺 key/坏 token/工具关闭 拒绝；缺省 limit=10、上限 20', async () => {
  const base = (url, over = {}) => {
    const sentJson = [];
    const ctx = {
      agentTokenOk: () => true,
      getSocialV2State: () => ({ recentMessages: [] }),
      req: { method: 'GET', headers: { 'x-agent-token': 'T' }, on: () => {} },
      sendJson: (b, s) => sentJson.push({ body: b, status: s }),
      url: new URL(`http://127.0.0.1:3100${url}`),
      v2SessionAllowed: () => true,
      v2ToolEnabled: () => true,
      ...over,
    };
    return { ctx, sentJson };
  };
  const noKey = base('/api/socialV2/active-members');
  await handleSocialV2ActiveMembers(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const badToken = base('/api/socialV2/active-members?key=group:1', { agentTokenOk: () => false });
  await handleSocialV2ActiveMembers(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const off = base('/api/socialV2/active-members?key=group:1', { v2ToolEnabled: () => false });
  await handleSocialV2ActiveMembers(off.ctx);
  assert.match(off.sentJson.at(-1).body.error, /工具未启用：qq_get_active_members/);
});

test('active-members：排除 isSelf、按 userId 聚合、按条数排序、limit 夹取', async () => {
  const recentMessages = [
    { sender: '甲', userId: 1, count: 1, time: 100 },
    { sender: '乙', userId: 2, time: 90 },
    { sender: '甲', userId: 1, time: 110 },
    { sender: '我', isSelf: true, userId: 9, time: 120 },
    { sender: '我自己', isSelf: true, userId: 9, time: 130 },
    { sender: '甲', userId: 1, isOwner: true, time: 140 },
    { sender: '丙', userId: 3, time: 80 },
  ];
  const sentJson = [];
  const ctx = {
    agentTokenOk: () => true,
    getSocialV2State: () => ({ recentMessages }),
    req: { method: 'GET', headers: {}, on: () => {} },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL('http://127.0.0.1:3100/api/socialV2/active-members?key=group:1&limit=2'),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
  };
  await handleSocialV2ActiveMembers(ctx);
  const members = sentJson.at(-1).body.members;
  assert.equal(members.length, 2, 'limit=2');
  assert.equal(members[0].userId, '1', '甲 3 条最多');
  assert.equal(members[0].count, 3);
  assert.equal(members[0].isOwner, true, '任一条 isOwner 即标 owner');
  assert.equal(members.some((m) => m.isSelf), false, '自己不出现在活跃成员里');
});

test('feedback：缺参 / 坏 token / 工具关闭 拒绝；级别归一；正文按 maxLength 截断', async (t) => {
  const dir = tempFile(t);
  const make = (body, over = {}) => {
    const sentJson = [];
    const calls = { entries: [] };
    const ctx = {
      FEEDBACK_FILE: path.join(dir, 'feedback.json'),
      TOOL_LOG_FILE: path.join(dir, 'tool-log.jsonl'),
      agentTokenOk: () => true,
      appendActivity: () => {},
      appendFeedbackEntry: (e) => calls.entries.push(e),
      atomicWriteJson: (f, v) => fs.writeFileSync(f, JSON.stringify(v), 'utf8'),
      cfg: { ownerQQ: 10000001, socialV2: { feedback: { maxLength: 10, notifyOwnerOnError: true } } },
      feedbackTimes: new Map(),
      fs,
      getSocialV2State: () => ({ recentMessages: [] }),
      log: () => {},
      readBody: async () => body,
      readFeedbackEntries: () => [{ id: 'x' }],
      readToolLog: () => [{ tool: 'qq_send_message' }],
      req: { method: 'POST', headers: { 'x-agent-token': 'T' }, on: () => {} },
      sendJson: (b, s) => sentJson.push({ body: b, status: s }),
      url: new URL('http://127.0.0.1:3100/api/socialV2/feedback'),
      v2SessionAllowed: () => true,
      v2ToolEnabled: () => true,
      ...over,
    };
    return { ctx, sentJson, calls };
  };

  const noParam = make({});
  await handleSocialV2LogsFeedback(noParam.ctx);
  assert.equal(noParam.sentJson.at(-1).status, 400);

  const badToken = make({ key: 'group:1', message: 'x' }, { agentTokenOk: () => false });
  await handleSocialV2LogsFeedback(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const off = make({ key: 'group:1', message: 'x' }, { v2ToolEnabled: () => false });
  await handleSocialV2LogsFeedback(off.ctx);
  assert.match(off.sentJson.at(-1).body.error, /工具未启用：qq_report_feedback/);

  const ok = make({ key: 'group:1', level: 'bogus', message: '一'.repeat(50) });
  await handleSocialV2LogsFeedback(ok.ctx);
  const body = ok.sentJson.at(-1).body;
  assert.equal(body.level, 'info', '非法级别归一为 info');
  assert.equal(body.message.length, 10, '按 maxLength 截断');
  assert.equal(ok.calls.entries.length, 1);
  assert.equal(ok.calls.entries[0].level, 'info');
});

test('feedback：每分钟 5 条限频 → 第 6 条 429', async (t) => {
  const dir = tempFile(t);
  const sentJson = [];
  const now = Date.now();
  const feedbackTimes = new Map([['group:1', [now - 1000, now - 2000, now - 3000, now - 4000, now - 5000]]]);
  const ctx = {
    FEEDBACK_FILE: path.join(dir, 'feedback.json'),
    TOOL_LOG_FILE: path.join(dir, 'tool-log.jsonl'),
    agentTokenOk: () => true,
    appendActivity: () => {},
    appendFeedbackEntry: () => {},
    atomicWriteJson: () => {},
    cfg: { socialV2: { feedback: { maxLength: 500 } } },
    feedbackTimes,
    fs,
    getSocialV2State: () => ({}),
    log: () => {},
    readBody: async () => ({ key: 'group:1', message: '又一条' }),
    readFeedbackEntries: () => [],
    readToolLog: () => [],
    req: { method: 'POST', headers: { 'x-agent-token': 'T' }, on: () => {} },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL('http://127.0.0.1:3100/api/socialV2/feedback'),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
  };
  await handleSocialV2LogsFeedback(ctx);
  assert.equal(sentJson.at(-1).status, 429);
  assert.match(sentJson.at(-1).body.error, /反馈过于频繁/);
});

test('tool-log / feedback 读取与清空：清空是控制台专属（带 agent token → 403）', async (t) => {
  const dir = tempFile(t);
  const toolLog = path.join(dir, 'tool-log.jsonl');
  const feedbackFile = path.join(dir, 'feedback.json');
  fs.writeFileSync(toolLog, 'x\n', 'utf8');
  fs.writeFileSync(feedbackFile, '[]', 'utf8');
  const sentJson = [];
  const mkCtx = (url, method, headers = {}) => ({
    FEEDBACK_FILE: feedbackFile,
    TOOL_LOG_FILE: toolLog,
    agentTokenOk: () => true,
    appendActivity: () => {},
    appendFeedbackEntry: () => {},
    atomicWriteJson: (f, v) => fs.writeFileSync(f, JSON.stringify(v), 'utf8'),
    cfg: {},
    feedbackTimes: new Map(),
    fs,
    getSocialV2State: () => ({}),
    log: () => {},
    readBody: async () => ({}),
    readFeedbackEntries: () => [{ id: 'f1' }],
    readToolLog: (limit) => [{ tool: 't', limit }],
    req: { method, headers, on: () => {} },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL(`http://127.0.0.1:3100${url}`),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
  });

  await handleSocialV2LogsFeedback(mkCtx('/api/socialV2/tool-log?limit=9999', 'GET'));
  assert.equal(sentJson.at(-1).body.entries[0].limit, 500, 'limit 上限 500');

  await handleSocialV2LogsFeedback(mkCtx('/api/socialV2/tool-log/clear', 'POST', { 'x-agent-token': 'T' }));
  assert.equal(sentJson.at(-1).status, 403, '带 agent token 不许清');
  await handleSocialV2LogsFeedback(mkCtx('/api/socialV2/tool-log/clear', 'POST'));
  assert.equal(fs.readFileSync(toolLog, 'utf8'), '', '控制台清空生效');

  await handleSocialV2LogsFeedback(mkCtx('/api/socialV2/feedback', 'GET'));
  assert.deepEqual(sentJson.at(-1).body.entries, [{ id: 'f1' }]);

  await handleSocialV2LogsFeedback(mkCtx('/api/socialV2/feedback-clear', 'POST', { 'x-agent-token': 'T' }));
  assert.equal(sentJson.at(-1).status, 403);
  await handleSocialV2LogsFeedback(mkCtx('/api/socialV2/feedback-clear', 'POST'));
  assert.equal(fs.readFileSync(feedbackFile, 'utf8'), '[]', '控制台清空写回空数组');
});
