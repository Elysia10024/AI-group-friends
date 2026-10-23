// src/core/wake-reason-label.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeReasonLabel, wakeReasonLine } from './wake-reason-label.js';

test('订阅唤醒必须写清"不是 @ 你"（那次幻觉的根因）', () => {
  const t = wakeReasonLabel('speaker:讨厌偏头痛');
  assert.match(t, /你订阅的「讨厌偏头痛」/);
  assert.match(t, /不是 @ 你/);
});

test('跟进/检查类唤醒也明说不是被点名', () => {
  // densityWake 必须在这个名单里：它和 proactiveCheck 一样是"不是冲她来的"，
  // 漏了就会出现"群里正热闹"被她读成"有人叫我"。
  for (const r of ['followUp', 'replyCheck', 'proactiveCheck', 'densityWake', 'timeout', 'anyMessage', 'probability']) {
    assert.match(wakeReasonLabel(r), /不是 @ 你/, `${r} 该说明不是被叫`);
  }
  assert.match(wakeReasonLabel('probability'), /随机抽查/, '概率唤醒别透出裸代号');
});

test('两个方向不许写反：proactiveCheck 是安静，densityWake 是热闹', () => {
  assert.match(wakeReasonLabel('proactiveCheck'), /安静/);
  assert.match(wakeReasonLabel('densityWake'), /热闹/);
  assert.ok(!wakeReasonLabel('densityWake').includes('安静'), '"正热闹"绝不能写成"安静了一阵"');
});

test('真被叫的几种照实说', () => {
  assert.match(wakeReasonLabel('atMention'), /@ 了你/);
  assert.match(wakeReasonLabel('nameMention'), /叫了你的名字/);
  assert.match(wakeReasonLabel('poke'), /拍了一拍\*\*你\*\*/);
});

test('关键词与未知原因', () => {
  assert.match(wakeReasonLabel('keyword:DS'), /「DS」/);
  assert.equal(wakeReasonLabel(''), '');
  assert.equal(wakeReasonLabel('某个新代号'), '某个新代号', '没见过的原因原样透出，别吞掉');
  assert.equal(wakeReasonLine(''), '', '没原因就不出这一行');
  assert.match(wakeReasonLine('followUp'), /^唤醒原因：/);
});
