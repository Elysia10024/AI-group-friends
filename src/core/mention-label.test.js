// src/core/mention-label.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionLabel } from './mention-label.js';

test('mentionLabel：只有确实拍你才写"拍了一拍你"', () => {
  assert.equal(mentionLabel({ kind: 'poke', pokeTargetIsSelf: true }), '拍了一拍你');
  assert.equal(mentionLabel({ kind: 'poke', pokeTargetIsSelf: false }), '拍了别人');
});

test('mentionLabel：老记录没有字段时按正文兜底，默认不认成"拍你"', () => {
  // social-log 对"拍你"写的是「…戳了戳 你」，对拍别人写的是「…戳了戳 <QQ>」
  assert.equal(mentionLabel({ kind: 'poke', text: '[拍一拍] UserA 戳了戳 你' }), '拍了一拍你');
  assert.equal(mentionLabel({ kind: 'poke', text: '[拍一拍] UserA 戳了戳 945327621 的初华，被神人化了' }), '拍了别人');
  assert.equal(mentionLabel({ kind: 'poke', text: '' }), '拍了别人', '没证据就别说是拍你（这正是那次事故）');
});

test('mentionLabel：@ 与叫名字照旧', () => {
  assert.equal(mentionLabel({ kind: 'atMention' }), '@ 了你');
  assert.equal(mentionLabel({ kind: 'nameMention' }), '叫了你的名字');
  assert.equal(mentionLabel({}), '叫了你的名字');
});
