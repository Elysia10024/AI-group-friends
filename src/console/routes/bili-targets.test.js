// bilibili targets/check 路由的 hermetic 测试（2026-10-28 第 44 轮）。
// 订阅目标是"她的账号去发群消息"的入口：白名单群过滤 + 启停切换不丢 alias/groups。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleBilibili } from './bilibili.js';
import { atomicWriteJson } from '../../core/state-io.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bilitargets-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  return dir;
}

function makeCtx(root, pathname, { body = {}, cfgBili = {}, checkImpl } = {}) {
  const sentJson = [];
  const ctx = {
    cfg: { allow: { groups: ['20000003', '1'] }, bilibili: { targets: [], ...cfgBili } },
    req: { method: 'POST', headers: {}, on: () => {} },
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
      restart: () => {},
      checkNow: async () => { if (checkImpl) return checkImpl(); return { checked: 3, newVideos: 1 }; },
    },
  };
  return { ctx, sentJson };
}

test('targets：UID 非正整数 / 群号不在白名单 → 400', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'config.json'), '{}', 'utf8');
  const badUid = makeCtx(root, '/api/bilibili/targets', { body: { uid: 'abc' } });
  await handleBilibili(badUid.ctx);
  assert.equal(badUid.sentJson.at(-1).status, 400);

  const badGroups = makeCtx(root, '/api/bilibili/targets', { body: { uid: 5, groups: [999] } });
  await handleBilibili(badGroups.ctx);
  assert.equal(badGroups.sentJson.at(-1).status, 400);
  assert.match(badGroups.sentJson.at(-1).body.error, /白名单/);
});

test('targets：新增 → 别名缺省用 uid、群号过滤到白名单、enabled 默认 true', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'config.json'), '{}', 'utf8');
  const { ctx, sentJson } = makeCtx(root, '/api/bilibili/targets', {
    body: { uid: 5, groups: ['20000003', '999', '20000003'] },
  });
  await handleBilibili(ctx);
  assert.equal(sentJson.at(-1).body.ok, true);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).bilibili;
  assert.equal(saved.targets.length, 1);
  assert.equal(saved.targets[0].uid, 5);
  assert.equal(saved.targets[0].alias, '5');
  assert.deepEqual(saved.targets[0].groups, [20000003], '白名单外过滤 + 去重');
  assert.equal(saved.targets[0].enabled, true);
});

test('targets：已存在时只切启停 → alias/groups 沿用原值', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'config.json'), '{}', 'utf8');
  const { ctx, sentJson } = makeCtx(root, '/api/bilibili/targets', {
    body: { uid: 5, enabled: false },
    cfgBili: { targets: [{ uid: 5, alias: '某UP', groups: [20000003], enabled: true }] },
  });
  await handleBilibili(ctx);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).bilibili;
  assert.equal(saved.targets[0].enabled, false);
  assert.equal(saved.targets[0].alias, '某UP', '不传 alias 就保留');
  assert.deepEqual(saved.targets[0].groups, [20000003], '不传 groups 就保留');
});

test('targets/remove：删掉指定 uid；非法 uid 400', async (t) => {
  const root = tempRoot(t);
  fs.writeFileSync(path.join(root, 'config.json'), '{}', 'utf8');
  const bad = makeCtx(root, '/api/bilibili/targets/remove', { body: { uid: 0 } });
  await handleBilibili(bad.ctx);
  assert.equal(bad.sentJson.at(-1).status, 400);

  const { ctx } = makeCtx(root, '/api/bilibili/targets/remove', {
    body: { uid: 5 },
    cfgBili: { targets: [{ uid: 5, alias: 'a', groups: [20000003] }, { uid: 6, alias: 'b', groups: [20000003] }] },
  });
  await handleBilibili(ctx);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).bilibili;
  assert.deepEqual(saved.targets.map((x) => x.uid), [6]);
});

test('check：checkNow 成功回结果；失败 400 透出', async (t) => {
  const root = tempRoot(t);
  const ok = makeCtx(root, '/api/bilibili/check');
  await handleBilibili(ok.ctx);
  assert.deepEqual(ok.sentJson.at(-1).body, { ok: true, result: { checked: 3, newVideos: 1 } });

  const fail = makeCtx(root, '/api/bilibili/check', { checkImpl: () => { throw new Error('网关 500'); } });
  await handleBilibili(fail.ctx);
  assert.equal(fail.sentJson.at(-1).status, 400);
  assert.match(fail.sentJson.at(-1).body.error, /网关 500/);
});
