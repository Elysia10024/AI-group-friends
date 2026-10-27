// memory-update / memory 读取 路由的 hermetic 测试（2026-10-28 第 34 轮）。
//
// memory-update 是"2026-09-21 事故"的路由：一次测试把 traits 整体换成测试字符串，20 条日记丢了。
// 现在它：① 动手前**先落快照**；② traits 支持数组形式逐条写入（中文逗号正文不再被切碎）。
// 本文件把这两条语义钉住，同时覆盖按 oldContent 编辑与改名并档。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handlePeopleMemoryRoutes } from './memory.js';
import { atomicWriteJson } from '../../core/state-io.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memupd-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

function makeCtx(root, pathname, { method = 'POST', body = {}, query = '', role = '小鲸鱼', st: stOverride } = {}) {
  const sentJson = [];
  const st = stOverride ?? {
    activeTopics: [{ text: '话题A' }],
    pendingThoughts: [{ text: '想法A', motivation: '旧动机' }],
    memberImpressions: { 10001: { traits: ['旧印象'], traitMeta: {}, lastSeenAt: 1 } },
  };
  const ctx = {
    agentTokenOk: () => true,
    appendMemoryV2: () => {},
    atomicWriteJson,
    cfg: { ownerQQ: 1 },
    formatMemoryV2: (s, k) => `MEM(${k})`,
    fs,
    getMood: () => ({}),
    setMood: () => {},
    setPersonTag: () => {},
    setPersonRelation: () => {},
    getPeople: () => ({}),
    getSocialV2State: () => st,
    path,
    readBody: async () => body,
    readRoleState: () => ({ role }),
    redactKnownTokensOnly: (s) => s,
    req: { method, headers: {}, on: () => {} },
    ROOT: root,
    saveSocialV2State: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL(`http://127.0.0.1:3100${pathname}${query}`),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    log: () => {},
  };
  return { ctx, st, sentJson };
}

test('memory-update：参数校验四连（缺 key/坏类别/印象缺 target/非印象缺 oldContent）', async (t) => {
  const root = tempRoot(t);
  for (const [body, expect] of [
    [{ category: 'activeTopic', oldContent: 'x' }, /key\/category 不能为空/],
    [{ key: 'group:1', category: 'mood', oldContent: 'x' }, /category 必须是/],
    [{ key: 'group:1', category: 'memberImpression', newContent: 'x' }, /需要 target/],
    [{ key: 'group:1', category: 'activeTopic' }, /需要 oldContent/],
  ]) {
    const { ctx, sentJson } = makeCtx(root, '/api/socialV2/memory-update', { body });
    await handlePeopleMemoryRoutes(ctx);
    assert.equal(sentJson.at(-1).status, 400, JSON.stringify(body));
    assert.match(sentJson.at(-1).body.error, expect);
  }
});

test('memory-update：编辑 activeTopic（找不到 404；改文本并截断 200 字）', async (t) => {
  const root = tempRoot(t);
  const miss = makeCtx(root, '/api/socialV2/memory-update', { body: { key: 'group:1', category: 'activeTopic', oldContent: '不存在' } });
  await handlePeopleMemoryRoutes(miss.ctx);
  assert.equal(miss.sentJson.at(-1).status, 404);

  const ok = makeCtx(root, '/api/socialV2/memory-update', { body: { key: 'group:1', category: 'activeTopic', oldContent: '话题A', newContent: '新' + '话'.repeat(300) } });
  await handlePeopleMemoryRoutes(ok.ctx);
  assert.equal(ok.st.activeTopics[0].text.length, 200);
  assert.equal(ok.sentJson.at(-1).body.ok, true);
});

test('memory-update：pendingThought 的 motivation 截 50 字、expiresAtMs 换算成 expiresAt', async (t) => {
  const root = tempRoot(t);
  const { ctx, st } = makeCtx(root, '/api/socialV2/memory-update', {
    body: { key: 'group:1', category: 'pendingThought', oldContent: '想法A', newExtra: { motivation: '动'.repeat(80), expiresAtMs: 60000 } },
  });
  const before = Date.now();
  await handlePeopleMemoryRoutes(ctx);
  assert.equal(st.pendingThoughts[0].motivation.length, 50);
  assert.ok(st.pendingThoughts[0].expiresAt >= before + 59000, 'expiresAt 应约等于 now+60s');
});

test('memory-update：印象正文按中文逗号切 traits（事故语义）；动手前先落快照', async (t) => {
  const root = tempRoot(t);
  const { ctx, st } = makeCtx(root, '/api/socialV2/memory-update', {
    body: { key: 'group:1', category: 'memberImpression', target: '10001', newContent: '早七上课，课后还有实验' },
  });
  await handlePeopleMemoryRoutes(ctx);
  assert.deepEqual(st.memberImpressions['10001'].traits, ['早七上课', '课后还有实验']);
  assert.equal(st.memberImpressions['10001'].traitMeta, undefined, '换过 traits 要清时间');
  const backups = fs.readdirSync(path.join(root, 'state', 'backups'));
  assert.equal(backups.length, 1, '编辑前必须有快照');
  assert.match(backups[0], /-update-/);
});

test('memory-update：traits 数组形式逐条写入（不切分），每条约 300 字上限、最多 20 条', async (t) => {
  const root = tempRoot(t);
  const traits = ['今天早七上课，课后还有实验，累了来戳我撒娇', ...Array.from({ length: 25 }, (_, i) => `t${i}`)];
  const { ctx, st } = makeCtx(root, '/api/socialV2/memory-update', {
    body: { key: 'group:1', category: 'memberImpression', target: '10001', traits },
  });
  await handlePeopleMemoryRoutes(ctx);
  const got = st.memberImpressions['10001'].traits;
  assert.equal(got[0], '今天早七上课，课后还有实验，累了来戳我撒娇', '中文逗号正文不许被切碎');
  assert.equal(got.length, 20, '最多 20 条');
  assert.equal(got[1], 't0', '按原顺序保留');
});

test('memory-update：印象 target 是原型污染名 → 400', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeCtx(root, '/api/socialV2/memory-update', {
    body: { key: 'group:1', category: 'memberImpression', target: '__proto__', newContent: 'x' },
  });
  await handlePeopleMemoryRoutes(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /非法/);
});

test('memory 读取：缺 key 400；按类别收窄；person 按 QQ 过滤', async (t) => {
  const root = tempRoot(t);
  const noKey = makeCtx(root, '/api/socialV2/memory', { method: 'GET' });
  await handlePeopleMemoryRoutes(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const cat = makeCtx(root, '/api/socialV2/memory', { method: 'GET', query: '?key=group:1&category=activeTopic' });
  await handlePeopleMemoryRoutes(cat.ctx);
  const raw = cat.sentJson.at(-1).body.raw;
  assert.equal(raw.activeTopics.length, 1);
  assert.deepEqual(raw.pendingThoughts, []);
  assert.deepEqual(raw.memberImpressions, {});

  const person = makeCtx(root, '/api/socialV2/memory', { method: 'GET', query: '?key=group:1&person=10001' });
  await handlePeopleMemoryRoutes(person.ctx);
  // 对外一律用名字：没有名片缓存时显示成「（QQ 10001）」（面板/她看到的都不是纯数字）
  assert.deepEqual(Object.keys(person.sentJson.at(-1).body.raw.memberImpressions), ['（QQ 10001）']);
  assert.equal(person.sentJson.at(-1).body.formatted, 'MEM(group:1)');
});

test('memory 读取：角色扮演 + scope=all 时返回空并给提示', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeCtx(root, '/api/socialV2/memory', { method: 'GET', query: '?key=group:1&scope=all', role: '宠物' });
  await handlePeopleMemoryRoutes(ctx);
  const body = sentJson.at(-1).body;
  assert.equal(body.roleplay, true);
  assert.equal(body.formatted, '');
  assert.match(body.recallHint, /不查其他会话/);
});
