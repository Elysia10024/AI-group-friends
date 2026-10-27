// handleAdminConfigSecurity · 安全/白名单/会话 路由的 hermetic 测试（2026-10-28 第 25 轮）。
//
// 这几条路由会**真的改 config.json**（安全拦截、白名单、管理员 QQ），所以用临时 ROOT 目录 +
// 真实的 atomicWriteJson 测：既验证"写进去了什么"，也验证"配置损坏时不许回写"（fail-fast）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleAdminConfigSecurity } from './admin.js';
import { atomicWriteJson } from '../../core/state-io.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admincfg-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

function makeCtx(root, pathname, { method = 'GET', body = {}, cfgOverrides = {}, normalizeOwnerQQ } = {}) {
  const sentJson = [];
  const cfg = { security: {}, allow: { private: [], groups: [] }, deny: { private: [], groups: [] }, ownerQQ: 10000001, socialV2: {}, ...cfgOverrides };
  const ctx = {
    ROOT: root,
    allowed: [],
    appendActivity: () => {},
    atomicWriteJson,
    atomicWriteText: () => {},
    bot: {},
    cfg,
    clearAllPendingWakeLeases: () => {},
    clearAllSocialV2Timers: () => {},
    collectors: new Map(),
    consoleToken: 'T',
    deps: { flags: { sessionEpoch: 0, currentMode: 'reserved2' }, state: { sessions: { 'private:10000001': 'sid-1' } } },
    deliverPrompt: () => {},
    ensureSession: () => {},
    escapeCqText: (s) => s,
    getSocialV2State: () => ({}),
    log: () => {},
    markReadCalledKeys: new Set(),
    modeAllowed: () => true,
    normalizeOwnerQQ: normalizeOwnerQQ ?? ((v) => Number(v)),
    path,
    pendingSendToolCalls: new Map(),
    pendingWakeKeys: new Set(),
    readBody: async () => body,
    readJsonSafe: (file, dflt, throwOnCorrupt) => {
      const raw = fs.readFileSync(file, 'utf8');
      try { return JSON.parse(raw.replace(/^\uFEFF/, '')); } catch (error) { if (throwOnCorrupt) throw error; return dflt; }
    },
    readRoleState: () => ({}),
    redactKnownTokensOnly: (s) => s,
    refreshAllDefaultWakeConfigsV2: () => {},
    req: { method, headers: {}, on: () => {} },
    reverse: (s) => s,
    saveSocialV2State: () => {},
    scheduleProactiveCheckV2: () => {},
    seenForwardIds: new Set(),
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    sendToolSucceededSessions: new Set(),
    sessionPromises: new Map(),
    setupSleepTimerV2: () => {},
    social: { states: new Map() },
    socialV2: { conversations: new Map() },
    toolCallNames: new Map(),
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    v2TurnStartAt: new Map(),
    wakeConfigMissCount: new Map(),
    wakeConfigUpdatedKeys: new Set(),
  };
  return { ctx, cfg, sentJson };
}

test('GET /api/security：没有配置时默认 interceptNotify=true', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeCtx(root, '/api/security', { cfgOverrides: { security: undefined } });
  await handleAdminConfigSecurity(ctx);
  assert.deepEqual(sentJson.at(-1).body, { security: { interceptNotify: true } });
});

test('POST /api/security：写进 config.json 与内存 cfg，响应回显', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ownerQQ: 10000001, security: { interceptNotify: true } }), 'utf8');
  const { ctx, cfg, sentJson } = makeCtx(root, '/api/security', { method: 'POST', body: { interceptNotify: false } });
  await handleAdminConfigSecurity(ctx);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(saved.security.interceptNotify, false);
  assert.equal(cfg.security.interceptNotify, false);
  assert.deepEqual(sentJson.at(-1).body, { ok: true, security: { interceptNotify: false } });
});

test('POST /api/security：config.json 损坏时抛错、不回写（fail-fast）', async (t) => {
  const root = tempRoot(t);
  const p = path.join(root, 'config.json');
  fs.writeFileSync(p, '{ 坏掉的 JSON', 'utf8');
  const { ctx } = makeCtx(root, '/api/security', { method: 'POST', body: { interceptNotify: false } });
  await assert.rejects(() => handleAdminConfigSecurity(ctx));
  assert.equal(fs.readFileSync(p, 'utf8'), '{ 坏掉的 JSON', '不允许把坏配置覆盖掉');
});

test('GET /api/whitelist：回显 allow/deny/ownerQQ', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeCtx(root, '/api/whitelist', { cfgOverrides: { allow: { private: [1], groups: [2] }, ownerQQ: 42 } });
  await handleAdminConfigSecurity(ctx);
  assert.deepEqual(sentJson.at(-1).body, { allow: { private: [1], groups: [2] }, deny: { private: [], groups: [] }, ownerQQ: 42 });
});

test('POST /api/whitelist：数字归一 + 去重 + 过滤非法值，并写盘/热更新', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ allow: {}, deny: {} }), 'utf8');
  const { ctx, cfg, sentJson } = makeCtx(root, '/api/whitelist', {
    method: 'POST',
    // 注意：'' 会被 Number('') 折成 0 并被保留（既有怪癖，本次只钉现状不改行为）
    body: { allow: { groups: ['2', 2, 'x', '3'], private: ['7'] }, deny: { groups: ['9'] } },
  });
  await handleAdminConfigSecurity(ctx);
  const body = sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.deepEqual(body.allow.groups, [2, 3], '字符串归一、去重、非法值过滤');
  assert.deepEqual(body.allow.private, [7]);
  assert.deepEqual(body.deny.groups, [9]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.deepEqual(saved.allow.groups, [2, 3]);
  assert.deepEqual(cfg.allow.groups, [2, 3], '内存也要热更新');
});

test('POST /api/whitelist：ownerQQ 非法 → 400 且不写盘', async (t) => {
  const root = tempRoot(t);
  const p = path.join(root, 'config.json');
  fs.writeFileSync(p, JSON.stringify({ allow: {} }), 'utf8');
  const { ctx, sentJson } = makeCtx(root, '/api/whitelist', {
    method: 'POST',
    body: { ownerQQ: 'abc' },
    normalizeOwnerQQ: () => { throw new Error('ownerQQ 必须是 QQ 号'); },
  });
  await handleAdminConfigSecurity(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.match(sentJson.at(-1).body.error, /ownerQQ/);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).ownerQQ, undefined);
});

test('GET /api/sessions：标出 owner 会话', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeCtx(root, '/api/sessions');
  await handleAdminConfigSecurity(ctx);
  const list = sentJson.at(-1).body.sessions;
  assert.equal(list.length, 1);
  assert.equal(list[0].key, 'private:10000001');
  assert.equal(list[0].owner, true);
});
