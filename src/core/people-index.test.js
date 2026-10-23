// src/core/people-index.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPeopleIndex, otherNames, crossGroupAliasLines } from './people-index.js';

const CONVS = [
  { key: 'group:20000001', recentMessages: [
    { sender: '群三水，🌿私你们这群烧货', userId: '10000001', time: 100 },
    { sender: '拾圆拾圆', userId: '10000003', time: 200 },
    { isSelf: true, sender: '你', userId: '3612473248', time: 300 }
  ] },
  { key: 'group:20000004', recentMessages: [
    { sender: '杨森', userId: '10000001', time: 400 }
  ] },
  { key: 'private:10000001', recentMessages: [
    { sender: '私聊', userId: '10000001', time: 500 }
  ] }
];

test('建索引：按 QQ 收集各会话的名字，自己不算', () => {
  const idx = buildPeopleIndex(CONVS);
  assert.deepEqual(Object.keys(idx).sort(), ['10000001', '10000003'], '自己的 QQ 不进索引');
  assert.equal(idx['10000001'].names['group:20000001'], '群三水，🌿私你们这群烧货');
  assert.equal(idx['10000001'].names['group:20000004'], '杨森');
  assert.equal(idx['10000001'].lastSeenAt, 400, '私聊不作为名字来源（sender 只是"私聊"这种占位标签）');
});

test('otherNames：给出"别的会话里叫什么"', () => {
  const idx = buildPeopleIndex(CONVS);
  const others = otherNames(idx, '10000001', 'group:20000001');
  assert.deepEqual(others.map((o) => o.name), ['杨森'], '私聊里的占位标签不算别名');
  assert.deepEqual(otherNames(idx, '10000003', 'group:20000001'), [], '只在当前群出现过的人没有跨群别名');
});

test('crossGroupAliasLines：同一个人跨群，明确写"是同一个人，别当成两个人"', () => {
  const idx = buildPeopleIndex(CONVS);
  const lines = crossGroupAliasLines({ index: idx, convKey: 'group:20000001', speakers: [{ sender: '群三水，🌿私你们这群烧货', userId: '10000001' }] });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /群三水/);
  assert.match(lines[0], /杨森/);
  assert.match(lines[0], /是同一个人/);
});

test('跨群别名行**不许出现别的群号**（她不该知道他还待在哪些群）', () => {
  const idx = buildPeopleIndex(CONVS);
  const lines = crossGroupAliasLines({ index: idx, convKey: 'group:20000001', speakers: [{ sender: '群三水，🌿私你们这群烧货', userId: '10000001' }] });
  assert.doesNotMatch(lines[0], /20000004/, '别的群号不能写进材料');
  assert.match(lines[0], /别的群/);
});

test('没跨群的人不产生噪音行；最多 max 条', () => {
  const idx = buildPeopleIndex(CONVS);
  assert.deepEqual(crossGroupAliasLines({ index: idx, convKey: 'group:20000001', speakers: [{ sender: '拾圆拾圆', userId: '10000003' }] }), []);
  const many = { '1': { names: { 'group:1': 'A', 'group:2': 'a2' } }, '2': { names: { 'group:1': 'B', 'group:2': 'b2' } }, '3': { names: { 'group:1': 'C', 'group:2': 'c2' } } };
  const lines = crossGroupAliasLines({ index: many, convKey: 'group:1', speakers: [{ sender: 'A', userId: '1' }, { sender: 'B', userId: '2' }, { sender: 'C', userId: '3' }], max: 2 });
  assert.equal(lines.length, 2);
});

test('脏数据不炸', () => {
  assert.deepEqual(buildPeopleIndex(null), {});
  assert.deepEqual(otherNames(null, '1', 'x'), []);
  assert.deepEqual(crossGroupAliasLines({}), []);
});
