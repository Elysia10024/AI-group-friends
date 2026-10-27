// core/send-tool-gate.js 的单测（第 22 轮）：发送工具闸门的七条判断与顺序。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSendToolAccess } from './send-tool-gate.js';

const base = {
  agentToken: 'T',
  key: 'group:20000003',
  tool: 'sendSticker',
  label: '工具未启用：qq_send_sticker',
  currentMode: 'reserved2',
  cfg: {},
  agentTokenOk: () => true,
  v2SessionAllowed: () => true,
  v2ToolEnabled: () => true,
  modeAllowed: () => true,
};

test('全部通过：解析出 kind/id', () => {
  assert.deepEqual(checkSendToolAccess(base), { action: 'handle', gate: { kind: 'group', id: 20000003 } });
  assert.deepEqual(checkSendToolAccess({ ...base, key: 'private:10000001' }), { action: 'handle', gate: { kind: 'private', id: 10000001 } });
});

test('token 无效 → 403 agent token 无效', () => {
  const r = checkSendToolAccess({ ...base, agentTokenOk: () => false });
  assert.deepEqual(r, { action: 'json', status: 403, error: 'agent token 无效' });
});

test('会话不在模式范围 → 403', () => {
  const r = checkSendToolAccess({ ...base, v2SessionAllowed: () => false });
  assert.deepEqual(r, { action: 'json', status: 403, error: '目标不在当前模式允许范围内' });
});

test('工具开关关闭 → 403 带 label 原文', () => {
  const r = checkSendToolAccess({ ...base, v2ToolEnabled: () => false });
  assert.deepEqual(r, { action: 'json', status: 403, error: '工具未启用：qq_send_sticker' });
});

test('非 reserved2 → 403（先于缺 token 判断）', () => {
  const r = checkSendToolAccess({ ...base, currentMode: 'closed-agent', agentToken: undefined, label: 'x' });
  assert.deepEqual(r, { action: 'json', status: 403, error: '该接口仅 reserved2 模式可用' });
});

test('reserved2 但没带 token → 403', () => {
  const r = checkSendToolAccess({ ...base, agentToken: undefined });
  assert.deepEqual(r, { action: 'json', status: 403, error: 'reserved2 模式发送必须携带 agent token' });
});

test('key 格式非法 → 400', () => {
  for (const key of ['group:', 'group:abc', 'x:1']) {
    const r = checkSendToolAccess({ ...base, key, modeAllowed: () => true });
    assert.equal(r.action, 'json', key);
    assert.equal(r.status, 400, key);
    assert.match(r.error, /key 格式/);
  }
  // group:0 格式合法但 id 非正 → 归入 403（见下一条用例）
  assert.equal(checkSendToolAccess({ ...base, key: 'group:0' }).status, 403);
});

test('目标不在允许范围（modeAllowed=false 或 id 非正） → 403', () => {
  const r = checkSendToolAccess({ ...base, modeAllowed: () => false });
  assert.deepEqual(r, { action: 'json', status: 403, error: '目标不在当前模式允许范围内' });
});

test('无 token 时不做 token/session/tool 三查（直接进模式判断）', () => {
  // 无 token + reserved2 + 合法 key：因为第 5 条会拒，所以这里应报"必须携带 agent token"
  assert.match(checkSendToolAccess({ ...base, agentToken: undefined }).error, /必须携带 agent token/);
  // 无 token + 非 reserved2：报模式错误而不是 token 错误
  assert.match(checkSendToolAccess({ ...base, agentToken: undefined, currentMode: 'closed-agent' }).error, /仅 reserved2/);
});
