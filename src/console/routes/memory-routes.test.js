// handlePeopleMemoryRoutes · 记忆写入/删除/清空 路由的 hermetic 测试（2026-10-28 第 27 轮）。
//
// 这组路由是唯一能改她记忆的入口（qq_memory_*）。测试重点：
//   · 参数/类别校验；
//   · **破坏性操作前先落快照**（memory-remove / memory-clear）——真实写进临时 ROOT 的 state/backups；
//   · 角色扮演期间不污染真实记忆/心情/关系（2026-10-19 事故的防线）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handlePeopleMemoryRoutes } from './memory.js';
import { atomicWriteJson } from '../../core/state-io.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memroutes-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

function makeCtx(root, pathname, { method = 'GET', body = {}, role = '小鲸鱼', st: stOverride } = {}) {
  const sentJson = [];
  const calls = { setMood: [], setPersonRelation: [], setPersonTag: [], appendMemoryV2: [], saves: 0 };
  const st = stOverride ?? {
    activeTopics: [{ text: '话题A' }, { text: '话题B' }],
    pendingThoughts: [{ text: '想法A' }],
    memberImpressions: {},
  };
  const ctx = {
    agentTokenOk: () => true,
    appendMemoryV2: (s, category, content, extra, opts) => { calls.appendMemoryV2.push({ category, content, extra, opts }); },
    atomicWriteJson,
    cfg: { ownerQQ: 1 },
    formatMemoryV2: () => 'MEM',
    fs,
    getMood: () => ({ tone: '平静', intensity: 1 }),
    setMood: (m) => calls.setMood.push(m),
    setPersonTag: (qq, tag) => calls.setPersonTag.push({ qq, tag }),
    setPersonRelation: (qq, rel) => calls.setPersonRelation.push({ qq, rel }),
    getPeople: () => ({}),
    getSocialV2State: () => st,
    path,
    readBody: async () => body,
    readRoleState: () => ({ role }),
    redactKnownTokensOnly: (s) => s,
    req: { method, headers: {}, on: () => {} },
    ROOT: root,
    saveSocialV2State: () => { calls.saves += 1; },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    log: () => {},
  };
  return { ctx, st, sentJson, calls };
}

test('memory-append：缺字段/坏类别/memberImpression 缺 target → 400', async (t) => {
  const root = tempRoot(t);
  for (const [body, expect] of [
    [{}, /不能为空/],
    [{ key: 'group:1', category: 'mood', content: '' }, /不能为空/],
    [{ key: 'group:1', category: 'bogus', content: 'x' }, /category 必须是/],
    [{ key: 'group:1', category: 'memberImpression', content: 'x' }, /extra\.target/],
  ]) {
    const { ctx, sentJson } = makeCtx(root, '/api/socialV2/memory-append', { method: 'POST', body });
    await handlePeopleMemoryRoutes(ctx);
    assert.equal(sentJson.at(-1).status, 400, JSON.stringify(body));
    assert.match(sentJson.at(-1).body.error, expect);
  }
});

test('memory-append：角色扮演期间不写心情（拒绝并标 roleplay）', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson, calls } = makeCtx(root, '/api/socialV2/memory-append', {
    method: 'POST', role: '宠物',
    body: { key: 'group:1', category: 'mood', content: '开心' },
  });
  await handlePeopleMemoryRoutes(ctx);
  assert.equal(sentJson.at(-1).body.roleplay, true);
  assert.match(sentJson.at(-1).body.error, /角色扮演期间不改心情/);
  assert.equal(calls.setMood.length, 0);
});

test('memory-append：正常心情写入 → 调 setMood 并回显新心情', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson, calls } = makeCtx(root, '/api/socialV2/memory-append', {
    method: 'POST',
    body: { key: 'group:1', category: 'mood', content: '有点累', extra: { intensity: 2, because: '加班' } },
  });
  await handlePeopleMemoryRoutes(ctx);
  const last = sentJson.at(-1);
  assert.equal(last.body.ok, true);
  assert.equal(calls.setMood.length, 1);
  assert.equal(calls.setMood[0].sourceKey, 'group:1');
  assert.equal(calls.setMood[0].because, '加班');
  assert.ok(last.body.mood);
});

test('memory-append：角色扮演期间的印象带 [扮演:角色] 标签，且不改真实关系', async (t) => {
  const root = tempRoot(t);
  const { ctx, calls } = makeCtx(root, '/api/socialV2/memory-append', {
    method: 'POST', role: '宠物',
    body: { key: 'group:1', category: 'memberImpression', content: '他很温柔', extra: { target: '小明', relation: '喜欢' } },
  });
  await handlePeopleMemoryRoutes(ctx);
  assert.equal(calls.appendMemoryV2.length, 1);
  assert.equal(calls.appendMemoryV2[0].content, '[扮演:宠物] 他很温柔');
  assert.equal(calls.setPersonRelation.length, 0, '扮演期间不许改真实关系');
  assert.equal(calls.setPersonTag.length, 0);
});

test('memory-remove：删话题前先落快照，再按原文精确删除并落盘', async (t) => {
  const root = tempRoot(t);
  const { ctx, st, sentJson, calls } = makeCtx(root, '/api/socialV2/memory-remove', {
    method: 'POST',
    body: { key: 'group:1', category: 'activeTopic', content: '话题A' },
  });
  await handlePeopleMemoryRoutes(ctx);
  assert.equal(sentJson.at(-1).body.ok, true);
  assert.deepEqual(st.activeTopics.map((x) => x.text), ['话题B']);
  assert.ok(calls.saves >= 1);
  const backups = fs.readdirSync(path.join(root, 'state', 'backups'));
  assert.equal(backups.length, 1, '破坏性写入前必须有快照');
  assert.match(backups[0], /^memory-.*-remove-group_1\.json$/);
});

test('memory-remove：类别非法 / memberImpression 缺 target / 原型污染名 → 400', async (t) => {
  const root = tempRoot(t);
  for (const [body, expect] of [
    [{ key: 'group:1', category: 'mood', content: 'x' }, /category 必须是/],
    [{ key: 'group:1', category: 'memberImpression' }, /需要 target/],
    [{ key: 'group:1', category: 'memberImpression', target: '__proto__' }, /非法的群友名字/],
    [{ key: 'group:1', category: 'activeTopic' }, /需要 content/],
  ]) {
    const { ctx, sentJson } = makeCtx(root, '/api/socialV2/memory-remove', { method: 'POST', body });
    await handlePeopleMemoryRoutes(ctx);
    assert.equal(sentJson.at(-1).status, 400, JSON.stringify(body));
    assert.match(sentJson.at(-1).body.error, expect);
  }
});

test('memory-clear：不带 category 清空三类记忆，且先落快照', async (t) => {
  const root = tempRoot(t);
  const st = { activeTopics: [{ text: 'a' }], pendingThoughts: [{ text: 'b' }], memberImpressions: { 10001: { text: 'c' } } };
  const { ctx, sentJson } = makeCtx(root, '/api/socialV2/memory-clear', { method: 'POST', body: { key: 'group:1' }, st });
  await handlePeopleMemoryRoutes(ctx);
  assert.equal(sentJson.at(-1).body.ok, true);
  assert.equal(sentJson.at(-1).body.category, 'all');
  assert.deepEqual(st.activeTopics, []);
  assert.deepEqual(st.pendingThoughts, []);
  assert.deepEqual(st.memberImpressions, {});
  assert.equal(fs.readdirSync(path.join(root, 'state', 'backups')).length, 1);
});

test('memory-clear：指定类别只清该类；缺 key → 400', async (t) => {
  const root = tempRoot(t);
  const st = { activeTopics: [{ text: 'a' }], pendingThoughts: [{ text: 'b' }], memberImpressions: { 10001: {} } };
  const { ctx, sentJson } = makeCtx(root, '/api/socialV2/memory-clear', { method: 'POST', body: { key: 'group:1', category: 'pendingThought' }, st });
  await handlePeopleMemoryRoutes(ctx);
  assert.deepEqual(st.pendingThoughts, []);
  assert.equal(st.activeTopics.length, 1, '别类不动');
  assert.equal(Object.keys(st.memberImpressions).length, 1, '别类不动');

  const noKey = makeCtx(root, '/api/socialV2/memory-clear', { method: 'POST', body: {} });
  await handlePeopleMemoryRoutes(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);
});
