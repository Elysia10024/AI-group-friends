// src/core/group-admin.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { isGroupAdmin, adminGroupsOf, checkGroupAdminCommand, GROUP_ADMIN_COMMANDS, OWNER_ONLY_COMMANDS } from './group-admin.js';

const CFG = { groupAdmins: { '20000002': ['12345'], '20000001': ['12345', '999'] } };

test('授权形式：按群列人，一个人可管多个群', () => {
  assert.equal(isGroupAdmin(CFG, 'group:20000002', '12345'), true);
  assert.equal(isGroupAdmin(CFG, 'group:20000001', '999'), true);
  assert.equal(isGroupAdmin(CFG, 'group:20000001', '12345'), true);
  assert.equal(isGroupAdmin(CFG, 'group:20000002', '999'), false, '不在这个群的名单里');
  assert.equal(isGroupAdmin(CFG, 'group:20000002', 'owner'), false);
  assert.deepEqual(adminGroupsOf(CFG, '12345').sort(), ['20000001', '20000002'], '顺序不重要（JS 会把整数样式的 key 排序）');
  assert.deepEqual(adminGroupsOf(CFG, '999'), ['20000001']);
});

test('在群里：只能管自己那个群，可用指令走白名单', () => {
  assert.equal(checkGroupAdminCommand({ cfg: CFG, key: 'group:20000002', qq: '12345', command: 'subscribe' }).ok, true);
  const other = checkGroupAdminCommand({ cfg: CFG, key: 'group:999999999', qq: '12345', command: 'subscribe' });
  assert.equal(other.ok, false);
  assert.match(other.reason, /只能管你自己那个群/);
  const unknown = checkGroupAdminCommand({ cfg: CFG, key: 'group:20000002', qq: '12345', command: 'whatever' });
  assert.equal(unknown.ok, false);
});

test('危险指令一律拒绝，并说清"只有主人能用"', () => {
  for (const cmd of OWNER_ONLY_COMMANDS) {
    const r = checkGroupAdminCommand({ cfg: CFG, key: 'group:20000002', qq: '12345', command: cmd });
    assert.equal(r.ok, false, `${cmd} 不该放行`);
    assert.match(r.reason, /只有主人/);
  }
  assert.ok(!GROUP_ADMIN_COMMANDS.includes('role'));
  assert.ok(!GROUP_ADMIN_COMMANDS.includes('silent'));
});

test('私聊：必须显式带群号，且只能是他管的群', () => {
  const noGid = checkGroupAdminCommand({ cfg: CFG, key: 'private:12345', qq: '12345', command: 'subscribe' });
  assert.equal(noGid.ok, false);
  assert.match(noGid.reason, /要带群号/);
  const notMine = checkGroupAdminCommand({ cfg: CFG, key: 'private:12345', qq: '12345', command: 'subscribe', targetGroupId: '888888888' });
  assert.equal(notMine.ok, false);
  assert.match(notMine.reason, /不归你管/);
  const ok = checkGroupAdminCommand({ cfg: CFG, key: 'private:12345', qq: '12345', command: 'subscribe', targetGroupId: '20000002' });
  assert.deepEqual(ok, { ok: true, groupId: '20000002' });
});

test('私聊：「订阅列表」不带群号 = 我管的那些群（只读，漏不出别人的群）', () => {
  const bare = checkGroupAdminCommand({ cfg: CFG, key: 'private:12345', qq: '12345', command: 'subscribe-list' });
  assert.deepEqual(bare, { ok: true, groupId: '' }, '回空串由调用方展开成他的群列表');
  const withGid = checkGroupAdminCommand({ cfg: CFG, key: 'private:12345', qq: '12345', command: 'subscribe-list', targetGroupId: '20000002' });
  assert.deepEqual(withGid, { ok: true, groupId: '20000002' });
  // 例外只给只读的列表：写操作（订阅/安静）在私聊里仍然必须带群号
  for (const cmd of ['subscribe', 'unsubscribe', 'quiet', 'resume', 'status']) {
    const r = checkGroupAdminCommand({ cfg: CFG, key: 'private:12345', qq: '12345', command: cmd });
    assert.equal(r.ok, false, `${cmd} 不带群号不该放行`);
    assert.match(r.reason, /要带群号/);
  }
});

test('没被授权的人：连指令都别想用（含陌生群友）', () => {
  const r = checkGroupAdminCommand({ cfg: CFG, key: 'group:20000002', qq: '666', command: 'subscribe' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /不是被授权的群管理员/);
  assert.deepEqual(adminGroupsOf({}, '666'), []);
  assert.equal(isGroupAdmin({}, 'group:1', '666'), false);
});

test('脏配置不炸', () => {
  assert.equal(isGroupAdmin({ groupAdmins: { '1': 'not-an-array' } }, 'group:1', '2'), false);
  assert.deepEqual(adminGroupsOf({ groupAdmins: null }, '2'), []);
  assert.equal(checkGroupAdminCommand({}).ok, false);
});
