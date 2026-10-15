// src/core/msg-line.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMessageLine, relationTagOf, TAG_TIERS } from './msg-line.js';

const PEOPLE = {
  10000002: { relation: '讨厌' },
  3951361727: { relation: '好朋友' },
  10000001: { relation: '家人' },
  10000003: { relation: '熟人' },
  999: { relation: '路人' },
  111: {}
};

test('只给非默认档挂标签（讨厌 / 好朋友 / 家人）', () => {
  assert.deepEqual([...TAG_TIERS].sort(), ['家人', '好朋友', '讨厌'].sort());
  assert.equal(relationTagOf(PEOPLE, '10000002'), '讨厌');
  assert.equal(relationTagOf(PEOPLE, '3951361727'), '好朋友');
  assert.equal(relationTagOf(PEOPLE, '10000001'), '家人');
  assert.equal(relationTagOf(PEOPLE, '10000003'), '', '熟人不挂');
  assert.equal(relationTagOf(PEOPLE, '999'), '', '路人不挂');
  assert.equal(relationTagOf(PEOPLE, '111'), '', '没定档不挂');
  assert.equal(relationTagOf(PEOPLE, undefined), '', '缺 userId 不挂');
  assert.equal(relationTagOf(null, '1'), '', 'people 为空也不炸');
});

test('消息行：有标签/没标签/管理员三种形态', () => {
  assert.equal(renderMessageLine({ sender: 'UserQ', text: '你涝麻汁撕了' }, { tag: '讨厌' }), 'UserQ（讨厌）：你涝麻汁撕了');
  assert.equal(renderMessageLine({ sender: 'UserB', text: '在干嘛' }), 'UserB：在干嘛');
  assert.equal(renderMessageLine({ sender: '群友甲', text: '过来', isOwner: true }, { tag: '家人' }), '【管理员】群友甲（家人）：过来');
  assert.equal(renderMessageLine({ sender: 'A', text: '图' }, { mediaHint: '[图片]', tag: '好朋友' }), 'A（好朋友）：图[图片]');
});

test('字段缺失也不炸（材料渲染不能因为一条脏数据整块崩）', () => {
  assert.equal(renderMessageLine({}), '?：');
  assert.equal(renderMessageLine(null), '?：');
});

test('assembler 用的形态：时钟前缀 + 自己发言写"你" + 正文优先用 plain', () => {
  assert.equal(
    renderMessageLine({ sender: 'UserB', plain: '在干嘛', text: '在干嘛（CQ码版）' }, { clock: '10-12 00:11' }),
    '[10-12 00:11] UserB：在干嘛'
  );
  assert.equal(
    renderMessageLine({ isSelf: true }, { clock: '10-12 00:11', text: '我在这' }),
    '[10-12 00:11] 你：我在这',
    '她自己发言不挂标签、也不写名字'
  );
  assert.equal(
    renderMessageLine({ sender: 'UserQ' }, { clock: '10-12 00:12', text: '你涝麻汁撕了', tag: '讨厌' }),
    '[10-12 00:12] UserQ（讨厌）：你涝麻汁撕了'
  );
});
