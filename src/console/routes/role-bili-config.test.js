// role 状态/预设 + B 站订阅配置 的 hermetic 测试（2026-10-28 第 41 轮）。
// 两条 B 站写路径都写 config.json（临时 ROOT + 真实 atomicWriteJson），验证：
// 参数夹取、模板校验、目标归一、需要重启的判定（enabled/interval 变化才 restart）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleRoleModeRoutes } from './role.js';
import { handleBilibili } from './bilibili.js';
import { atomicWriteJson, atomicWriteText } from '../../core/state-io.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rolebili-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

function makeRoleCtx(root, pathname, { presetsImpl } = {}) {
  const sentJson = [];
  const ctx = {
    ROOT: root,
    STATE_DIR: path.join(root, 'state'),
    api: { agentPresets: { list: async () => { if (presetsImpl) return presetsImpl(); return { presets: [{ id: 'qq-chat', trust: 'system' }, { id: 'qq-chat-v2' }] }; } } },
    atomicWriteJson,
    atomicWriteText,
    cfg: { ownerQQ: 10000001, allow: { groups: [20000003], private: [1] } },
    cleanupSocialForModeChange: () => {},
    clearAllSocialV2Timers: () => {},
    deps: { flags: { currentMode: 'reserved2', closedAgentPreset: 'router-standard', dshReady: true } },
    drainAllPromptQueues: () => {},
    fs,
    listRoles: () => ['小鲸鱼'],
    roleExists: () => true,
    log: () => {},
    path,
    readActivityTail: (n) => [{ n }],
    readBody: async () => ({}),
    readJsonSafe: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
    readRoleState: () => ({ role: '小鲸鱼', mode: 'active' }),
    req: { method: 'GET', headers: {}, on: () => {} },
    sanitizeRoleName: (s) => String(s),
    scheduleProactiveCheckV2: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    setupSleepTimerV2: () => {},
    socialV2: { paused: true, conversations: new Map() },
    unwrap: (x) => x,
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    writeRoleState: () => {},
  };
  return { ctx, sentJson };
}

test('GET /api/status：返回模式/角色/白名单/暂停/活动尾', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeRoleCtx(root, '/api/status');
  await handleRoleModeRoutes(ctx);
  const b = sentJson.at(-1).body;
  assert.equal(b.mode, 'reserved2');
  assert.equal(b.closedAgentPreset, 'router-standard');
  assert.equal(b.role, '小鲸鱼');
  assert.equal(b.dshReady, true);
  assert.equal(b.ownerQQ, 10000001);
  assert.deepEqual(b.allowGroups, [20000003]);
  assert.equal(b.socialV2Paused, true);
  assert.deepEqual(b.activity, [{ n: 100 }]);
});

test('GET /api/presets：映射 id/trust；列表接口抛错时返回空列表', async (t) => {
  const root = tempRoot(t);
  const ok = makeRoleCtx(root, '/api/presets');
  await handleRoleModeRoutes(ok.ctx);
  assert.deepEqual(ok.sentJson.at(-1).body.presets, [{ id: 'qq-chat', trust: 'system' }, { id: 'qq-chat-v2', trust: 'system' }]);

  const fail = makeRoleCtx(root, '/api/presets', { presetsImpl: () => { throw new Error('DSH 没起来'); } });
  await handleRoleModeRoutes(fail.ctx);
  assert.deepEqual(fail.sentJson.at(-1).body.presets, []);
});

function makeBiliCtx(root, pathname, { body = {}, cfgBili = {}, restart } = {}) {
  const sentJson = [];
  const calls = { restarts: 0 };
  const ctx = {
    cfg: { allow: { groups: ['20000003', '1'] }, bilibili: { ...cfgBili } },
    req: { method: pathname === '/api/bilibili' ? 'GET' : 'POST', headers: {}, on: () => {} },
    url: new URL(`http://127.0.0.1:3100${pathname}`),
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    readBody: async () => body,
    readJsonSafe: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } },
    atomicWriteJson,
    ROOT: root,
    path,
    log: () => {},
    bilibili: {
      status: () => ({ running: true }),
      restart: () => { calls.restarts += 1; if (restart) restart(); },
    },
  };
  return { ctx, sentJson, calls };
}

test('GET /api/bilibili：状态 + 白名单群（数字化）', async (t) => {
  const root = tempRoot(t);
  const { ctx, sentJson } = makeBiliCtx(root, '/api/bilibili');
  await handleBilibili(ctx);
  assert.deepEqual(sentJson.at(-1).body, { ok: true, status: { running: true }, allowedGroups: [20000003, 1] });
});

test('POST /api/bilibili/config：模板三类校验（空/超长/缺 {url}）', async (t) => {
  const root = tempRoot(t);
  for (const [template, expect] of [
    ['', /不能为空/],
    ['x'.repeat(501), /不能超过 500/],
    ['没有占位符', /必须包含 \{url\}/],
  ]) {
    const { ctx, sentJson } = makeBiliCtx(root, '/api/bilibili/config', { body: { template } });
    await handleBilibili(ctx);
    assert.equal(sentJson.at(-1).status, 400, template.slice(0, 10));
    assert.match(sentJson.at(-1).body.error, expect);
  }
});

test('POST /api/bilibili/config：夹取间隔/时段、写盘热更新、目标归一', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ownerQQ: 1 }), 'utf8');
  const { ctx, sentJson, calls } = makeBiliCtx(root, '/api/bilibili/config', {
    body: { enabled: true, intervalMs: 1, activeHours: [10, 5], pages: 99, maxPerRun: 0, template: '新视频 {url}', targets: [{ uid: 5, alias: '某UP', groups: [20000003], enabled: true }] },
  });
  await handleBilibili(ctx);
  const b = sentJson.at(-1).body;
  assert.equal(b.ok, true);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).bilibili;
  assert.equal(saved.intervalMs, 120000, '间隔下限 2 分钟');
  assert.deepEqual(saved.activeHours, [10, 10], '结束早于开始就抬到开始');
  assert.equal(saved.pages, 3, '页数上限 3');
  assert.equal(saved.maxPerRun, 1, '每轮最少 1 条');
  assert.equal(saved.template, '新视频 {url}');
  assert.equal(saved.targets.length, 1);
  assert.equal(saved.targets[0].uid, 5);
  assert.equal(ctx.cfg.bilibili.intervalMs, 120000, '内存热更新');
  assert.equal(calls.restarts, 1, 'enabled/interval 变化要重启轮询');
});

test('POST /api/bilibili/config：只改模板不触动重启', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ ownerQQ: 1 }), 'utf8');
  const { ctx, sentJson, calls } = makeBiliCtx(root, '/api/bilibili/config', {
    body: { template: '改个模板 {url}' },
    cfgBili: { enabled: true, intervalMs: 600000 },
  });
  await handleBilibili(ctx);
  assert.equal(sentJson.at(-1).body.ok, true);
  assert.equal(calls.restarts, 0, '没动 enabled/interval 就不重启');
});
