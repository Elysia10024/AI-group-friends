// core/agent-access.js 的单测（第 21 轮）：七道 agent 闸门的顺序与消息逐条钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAgentAccess } from './agent-access.js';

const base = {
  headers: {},
  pathname: '/api/status',
  method: 'GET',
  queryKey: null,
  mode: 'normal',
  role: '',
  paused: false,
  socialV2EnabledOff: false,
  currentMode: 'reserved2',
  isChatMuted: () => false,
  isRoleplayRole: () => false,
  roleplayToolAllowed: () => true,
};
const agent = { ...base, headers: { 'x-agent-token': 'T' } };
const allow = { action: 'allow' };

test('无 agent token：所有闸门都不拦（控制台自己的请求）', () => {
  assert.deepEqual(checkAgentAccess(base), allow);
  assert.deepEqual(checkAgentAccess({ ...base, paused: true, pathname: '/api/socialV2/x' }), allow);
});

test('空 agent token 字符串：一律 403（防 MCP 传空串绕过）', () => {
  const r = checkAgentAccess({ ...base, headers: { 'x-agent-token': '' } });
  assert.deepEqual(r, { action: 'json', status: 403, error: 'agent token 不能为空' });
});

test('静音模式：社会会话 + ?key= 命中 → 403', () => {
  const r = checkAgentAccess({ ...agent, pathname: '/api/socialV2/send-message', queryKey: 'group:1', isChatMuted: (mode, key) => key === 'group:1' });
  assert.equal(r.status, 403);
  assert.match(r.error, /静默模式已开启/);
  // 没传 key 或没命中 → 放行
  assert.deepEqual(checkAgentAccess({ ...agent, pathname: '/api/socialV2/x', isChatMuted: () => true }), allow);
  assert.deepEqual(checkAgentAccess({ ...agent, pathname: '/api/socialV2/x', queryKey: 'group:9', isChatMuted: () => false }), allow);
});

test('角色扮演白名单：角色扮演 + 非白名单路径 → 403；白名单/非角色 → 放行', () => {
  const rp = { ...agent, pathname: '/api/socialV2/send-sticker', queryKey: 'group:1', role: '宠物', isRoleplayRole: (r) => r === '宠物', roleplayToolAllowed: () => false };
  assert.equal(checkAgentAccess(rp).status, 403);
  assert.match(checkAgentAccess(rp).error, /只能聊天和看图片/);
  assert.deepEqual(checkAgentAccess({ ...rp, roleplayToolAllowed: () => true }), allow);
  assert.deepEqual(checkAgentAccess({ ...rp, role: '小鲸鱼' }), allow);
});

test('暂停：v2 三类前缀 + agent token → 403；其他路径放行', () => {
  for (const p of ['/api/socialV2/x', '/api/send/group', '/api/images/message']) {
    const r = checkAgentAccess({ ...agent, pathname: p, paused: true });
    assert.equal(r.status, 403, p);
    assert.match(r.error, /AI 已暂停/);
  }
  assert.deepEqual(checkAgentAccess({ ...agent, pathname: '/api/status', paused: true }), allow);
});

test('二代总开关关闭：v2 三类前缀 + agent token → 403', () => {
  const r = checkAgentAccess({ ...agent, pathname: '/api/socialV2/x', socialV2EnabledOff: true });
  assert.equal(r.status, 403);
  assert.match(r.error, /二代模式已关闭/);
});

test('模式隔离：非 reserved2 时带 token 的 socialV2 一律 403', () => {
  const r = checkAgentAccess({ ...agent, pathname: '/api/socialV2/state', currentMode: 'closed-agent' });
  assert.equal(r.status, 403);
  assert.match(r.error, /仅 reserved2 模式可用/);
  // 不带 token 的控制台请求不受影响
  assert.deepEqual(checkAgentAccess({ ...base, pathname: '/api/socialV2/state', currentMode: 'closed-agent' }), allow);
});

test('管理端专用 v2 路径 / stickers：带 token → 403', () => {
  for (const p of ['/api/socialV2/config', '/api/socialV2/reset', '/api/socialV2/states', '/api/stickers', '/api/stickers/list']) {
    const r = checkAgentAccess({ ...agent, pathname: p, method: 'GET' });
    assert.equal(r.status, 403, p);
    assert.match(r.error, /仅控制台可用/);
  }
  // tool-log 只在 GET 时拦；POST 不拦
  assert.equal(checkAgentAccess({ ...agent, pathname: '/api/socialV2/tool-log', method: 'GET' }).status, 403);
  assert.deepEqual(checkAgentAccess({ ...agent, pathname: '/api/socialV2/tool-log', method: 'POST' }), allow);
});

test('顺序：空 token 先于静音/暂停判定', () => {
  const r = checkAgentAccess({ ...base, headers: { 'x-agent-token': '' }, pathname: '/api/socialV2/x', paused: true, queryKey: 'group:1', isChatMuted: () => true });
  assert.match(r.error, /agent token 不能为空/);
});
