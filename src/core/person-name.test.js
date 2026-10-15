// src/core/person-name.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { personShortName, matchExistingKey } from './person-name.js';

test('长名片砍成短名（这就是"来来"事故的根）', () => {
  assert.equal(personShortName('群友丁（！？来来？！）'), '群友丁', '括号里的梗不算名字');
  assert.equal(personShortName('群友丙（50/128）'), '群友丙');
  assert.equal(personShortName('群友丑，时不时来群里讲道（128/128）'), '群友丑', '逗号后的整段都不是名字');
  assert.equal(personShortName('群友壬，至丑，至绷的化身'), '群友壬');
  assert.equal(personShortName('群友甲，🌿私你们这群烧货'), '群友甲');
});

test('短名本来就干净的不动', () => {
  for (const n of ['群友乙', 'UserB', 'UserA', '群友辛', '群友戊', '群友庚', '群友卯']) {
    assert.equal(personShortName(n), n);
  }
  assert.equal(personShortName(''), '');
});

test('砍太狠就退回原名（别把名字砍没了）', () => {
  assert.equal(personShortName('（无）'), '（无）');
  assert.equal(personShortName('A（1）'), 'A（1）', '砍到只剩一个字 → 保留原名');
});

test('matchExistingKey：同一个人不再开第二个 key', () => {
  const keys = ['群友丁', '群友甲', '群友乙'];
  assert.equal(matchExistingKey('群友丁（！？来来？！）', keys), '群友丁', '长名片命中已有短名');
  assert.equal(matchExistingKey('群友甲，🌿私你们这群烧货', keys), '群友甲');
  assert.equal(matchExistingKey('群友乙', keys), '群友乙');
  assert.equal(matchExistingKey('来来', keys), null, '光"来来"两个字不硬猜是谁');
  assert.equal(matchExistingKey('新人甲', keys), null);
});
