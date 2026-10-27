// handleRoleModeRoutes · 模式/角色 路由的 hermetic 测试（2026-10-28 第 28 轮）。
//
// 这组路由决定「她是谁、在哪个模式说话」——配置面里权限最高的部分。用临时 ROOT 验证：
// 写盘内容、内存 flags 热更新、模式切换时的定时器/排队投递清理与重建。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRoleModeRoutes } from './role.js';
import { atomicWriteJson, atomicWriteText } from '../../core/state-io.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roleroutes-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

function makeCtx(root, pathname, { method = 'GET', body = {}, role = null, roleMode = 'active', roles = ['小鲸鱼', '宠物'] } = {}) {
  const sentJson = [];
  const calls = { writeRoleState: [], clearTimers: 0, drain: [], sleepTimers: [], proactive: [] };
  const flags = { currentMode: 'closed-agent', lastMode: 'closed-agent', closedAgentPreset: 'router-standard' };
  const ctx = {
    ROOT: root,
    STATE_DIR: path.join(root, 'state'),
    api: {},
    atomicWriteJson,
    atomicWriteText,
    cfg: { ownerQQ: 1 },
    cleanupSocialForModeChange: () => {},
    clearAllSocialV2Timers: () => { calls.clearTimers += 1; },
    deps: { flags },
    drainAllPromptQueues: (why) => calls.drain.push(why),
    fs,
    listRoles: () => roles,
    roleExists: (n) => roles.includes(n),
    log: () => {},
    path,
    readActivityTail: () => [],
    readBody: async () => body,
    readJsonSafe: (file, dflt) => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return dflt; }
    },
    readRoleState: () => ({ role, mode: roleMode }),
    req: { method, headers: {}, on: () => {} },
    sanitizeRoleName: (s) => String(s ?? '').trim().replace(/[^\u4e00-\u9fa5A-Za-z0-9-]/g, ''),
    scheduleProactiveCheckV2: (k) => calls.proactive.push(k),
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    setupSleepTimerV2: (k) => calls.sleepTimers.push(k),
    socialV2: { conversations: new Map([['group:1', {}], ['private:2', {}]]) },
    unwrap: (x) => x,
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    writeRoleState: (r, m) => calls.writeRoleState.push({ role: r, mode: m }),
  };
  return { ctx, sentJson, calls, flags };
}

test('POST /api/mode：非法模式 → 400；不写盘', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeCtx(root, '/api/mode', { method: 'POST', body: { mode: 'chat' } });
  await handleRoleModeRoutes(ctx);
  assert.equal(sentJson.at(-1).status, 400);
  assert.equal(fs.existsSync(path.join(root, 'state', 'mode.json')), false);
});

test('POST /api/mode：进 reserved2 → 写 mode.json、更新 flags、给每个会话重建定时器', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson, calls, flags } = makeCtx(root, '/api/mode', { method: 'POST', body: { mode: 'reserved2' } });
  await handleRoleModeRoutes(ctx);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'state', 'mode.json'), 'utf8'));
  assert.equal(saved.mode, 'reserved2');
  assert.equal(saved.closedAgentPreset, 'router-standard', '没传则保留旧值/默认');
  assert.equal(flags.currentMode, 'reserved2');
  assert.equal(flags.lastMode, 'reserved2');
  assert.deepEqual(calls.sleepTimers.sort(), ['group:1', 'private:2']);
  assert.deepEqual(calls.proactive.sort(), ['group:1', 'private:2']);
  assert.equal(sentJson.at(-1).body.ok, true);
});

test('POST /api/mode：离开 reserved2 → 清定时器 + 取消排队投递', async (t) => {
  const root = tempRoot(t);
  const { ctx, calls, flags } = makeCtx(root, '/api/mode', { method: 'POST', body: { mode: 'closed-agent', closedAgentPreset: 'router-fast' } });
  flags.currentMode = 'reserved2';
  await handleRoleModeRoutes(ctx);
  assert.equal(calls.clearTimers, 1);
  assert.equal(calls.drain.length, 1);
  assert.match(calls.drain[0], /模式切换/);
  assert.equal(flags.closedAgentPreset, 'router-fast');
});

test('POST /api/role：角色不存在 → 400；存在 → 写状态；空 role → 清除', async (t) => {
  const root = tempRoot(t);
  const bad = makeCtx(root, '/api/role', { method: 'POST', body: { role: '不存在的角色' } });
  await handleRoleModeRoutes(bad.ctx);
  assert.equal(bad.sentJson.at(-1).status, 400);
  assert.match(bad.sentJson.at(-1).body.error, /不存在/);

  const ok = makeCtx(root, '/api/role', { method: 'POST', body: { role: '宠物' } });
  await handleRoleModeRoutes(ok.ctx);
  assert.deepEqual(ok.calls.writeRoleState, [{ role: '宠物', mode: 'active' }]);

  const clear = makeCtx(root, '/api/role', { method: 'POST', body: {} });
  await handleRoleModeRoutes(clear.ctx);
  assert.deepEqual(clear.calls.writeRoleState, [{ role: null, mode: 'active' }]);
  assert.equal(clear.sentJson.at(-1).body.role, null);
});

test('POST /api/role-mode：silent 开启 / 其他值一律 active', async (t) => {
  const root = tempRoot(t);
  const silent = makeCtx(root, '/api/role-mode', { method: 'POST', body: { mode: 'silent' }, role: '小鲸鱼' });
  await handleRoleModeRoutes(silent.ctx);
  assert.deepEqual(silent.calls.writeRoleState, [{ role: '小鲸鱼', mode: 'silent' }]);

  const active = makeCtx(root, '/api/role-mode', { method: 'POST', body: { mode: 'whatever' }, role: '小鲸鱼' });
  await handleRoleModeRoutes(active.ctx);
  assert.equal(active.sentJson.at(-1).body.roleMode, 'active');
});

test('GET /api/roles：列出角色与当前角色', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeCtx(root, '/api/roles', { role: '宠物' });
  await handleRoleModeRoutes(ctx);
  assert.deepEqual(sentJson.at(-1).body, { roles: ['小鲸鱼', '宠物'], current: '宠物' });
});

test('POST /api/roles/create：空名/空内容/保留名/重名 → 400；成功写文件并补换行', async (t) => {
  const root = tempRoot(t);
  const cases = [
    [{ name: '', content: 'x' }, /角色名不能为空/],
    [{ name: '新角色', content: '  ' }, /角色内容不能为空/],
    [{ name: 'README', content: 'x' }, /被保留/],
  ];
  for (const [body, expect] of cases) {
    const { ctx, sentJson } = makeCtx(root, '/api/roles/create', { method: 'POST', body });
    await handleRoleModeRoutes(ctx);
    assert.equal(sentJson.at(-1).status, 400, JSON.stringify(body));
    assert.match(sentJson.at(-1).body.error, expect);
  }
  // 重名：只认单文件式 roles/<name>.md（注意：目录式 roles/<name>/core.md 不在检查范围，
  // 是既有缺口——测试只钉现状，不改行为）。
  fs.mkdirSync(path.join(root, 'roles'), { recursive: true });
  fs.writeFileSync(path.join(root, 'roles', '宠物.md'), '旧内容\n', 'utf8');
  const dup = makeCtx(root, '/api/roles/create', { method: 'POST', body: { name: '宠物', content: 'x' } });
  await handleRoleModeRoutes(dup.ctx);
  assert.equal(dup.sentJson.at(-1).status, 400);
  assert.match(dup.sentJson.at(-1).body.error, /已存在/);
  fs.rmSync(path.join(root, 'roles', '宠物.md'));

  const { ctx, sentJson } = makeCtx(root, '/api/roles/create', { method: 'POST', body: { name: '新角色', content: '你是新角色' } });
  await handleRoleModeRoutes(ctx);
  assert.equal(sentJson.at(-1).body.ok, true);
  const written = fs.readFileSync(path.join(root, 'roles', '新角色.md'), 'utf8');
  assert.equal(written, '你是新角色\n', '要补结尾换行');
});
