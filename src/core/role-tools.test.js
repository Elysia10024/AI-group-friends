// src/core/role-tools.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { isRoleplayRole, roleplayToolAllowed } from './role-tools.js';

test('isRoleplayRole：只有非小鲸鱼的角色才算扮演', () => {
  assert.equal(isRoleplayRole('小鲸鱼'), false);
  assert.equal(isRoleplayRole('鲸鲸宝宝'), true);
  assert.equal(isRoleplayRole(''), false);
  assert.equal(isRoleplayRole(null), false);
  assert.equal(isRoleplayRole(undefined), false);
});

test('roleplayToolAllowed：聊天/看消息/识图放行，其余拒绝', () => {
  for (const p of ['/api/socialV2/send-message', '/api/socialV2/recent', '/api/socialV2/message-detail', '/api/socialV2/wake-config', '/api/images/message']) {
    assert.equal(roleplayToolAllowed(p), true, p);
  }
  for (const p of [
    '/api/socialV2/send-image',
    '/api/socialV2/image-list',
    '/api/socialV2/send-sticker',
    '/api/socialV2/sticker-list',
    '/api/socialV2/send-voice',
    '/api/socialV2/send-poke',
    '/api/socialV2/bili-look',
    '/api/socialV2/bili-scroll',
    '/api/socialV2/slang/query',
    '/api/socialV2/memory-append',
    '/api/socialV2/post-mood',
    '/api/socialV2/self-image',
    '/api/socialV2/send-burst',
    '/api/socialV2/feedback'
  ]) {
    assert.equal(roleplayToolAllowed(p), false, p);
  }
  assert.equal(roleplayToolAllowed(''), false);
  assert.equal(roleplayToolAllowed('/api/socialV2/send-image?x=1'), false, '带 query 也不放行');
});
