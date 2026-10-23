// src/core/subscribe.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscribeArg, looksLikeQq, addSpeakerId, removeSpeakerId, SPEAKER_IDS_CAP } from './subscribe.js';

test('parseSubscribeArg：第一个纯数字 token 当群号，其余是目标', () => {
  assert.deepEqual(parseSubscribeArg('20000001 讨厌偏头痛'), { groupId: '20000001', target: '讨厌偏头痛' });
  assert.deepEqual(parseSubscribeArg('  20000001   2815316979  '), { groupId: '20000001', target: '2815316979' });
  assert.deepEqual(parseSubscribeArg('讨厌偏头痛'), { groupId: '', target: '讨厌偏头痛' });
  assert.deepEqual(parseSubscribeArg(''), { groupId: '', target: '' });
  assert.deepEqual(parseSubscribeArg(null), { groupId: '', target: '' });
  // 太短的数字不当群号（避免把 QQ 号误判成群）
  assert.deepEqual(parseSubscribeArg('12345 小明'), { groupId: '', target: '12345 小明' });
});

test('looksLikeQq：5~12 位纯数字才算', () => {
  assert.equal(looksLikeQq('2815316979'), true);
  assert.equal(looksLikeQq('12345'), true);
  assert.equal(looksLikeQq('1234'), false);
  assert.equal(looksLikeQq('讨厌偏头痛'), false);
  assert.equal(looksLikeQq(''), false);
});

test('addSpeakerId：去重、保序、封顶，且不改原数组', () => {
  const a = ['1'];
  const b = addSpeakerId(a, '2');
  assert.deepEqual(b, ['1', '2']);
  assert.deepEqual(a, ['1'], '原数组不能被改（她/命令两边都可能持有同一份引用）');
  assert.deepEqual(addSpeakerId(['1', '2'], '1'), ['1', '2'], '重复不叠加');
  assert.deepEqual(addSpeakerId([], ''), []);
  const many = Array.from({ length: SPEAKER_IDS_CAP + 5 }, (_, i) => String(i));
  assert.equal(addSpeakerId(many, '999').length, SPEAKER_IDS_CAP, '封顶');
});

test('removeSpeakerId：删单个 / 清空', () => {
  assert.deepEqual(removeSpeakerId(['1', '2'], '1'), { list: ['2'], removed: true });
  assert.deepEqual(removeSpeakerId(['1', '2'], '3'), { list: ['1', '2'], removed: false });
  assert.deepEqual(removeSpeakerId(['1', '2'], ''), { list: [], removed: true });
  assert.deepEqual(removeSpeakerId(['1', '2'], '全部'), { list: [], removed: true });
  assert.deepEqual(removeSpeakerId([], '全部'), { list: [], removed: false });
  assert.deepEqual(removeSpeakerId(null, '1'), { list: [], removed: false });
});
