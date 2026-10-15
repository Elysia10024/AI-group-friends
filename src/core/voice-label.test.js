import assert from 'node:assert/strict';
import test from 'node:test';
import { voiceLabel, voiceFailureNote } from './voice-label.js';

test('voiceLabel：有转写就写成「语音：文字」，并标明这是说出来的', () => {
  assert.equal(voiceLabel('喂喂，能听到吗？'), '[语音：「喂喂，能听到吗？」]');
  assert.equal(voiceLabel('  我要给你装上耳朵。 '), '[语音：「我要给你装上耳朵。」]');
});

test('voiceLabel：没转出来就退回 [语音]，绝不编造', () => {
  assert.equal(voiceLabel(''), '[语音]');
  assert.equal(voiceLabel(null), '[语音]');
  assert.equal(voiceLabel(undefined), '[语音]');
  assert.equal(voiceLabel('   '), '[语音]');
});

test('voiceLabel：内部引号换成单引号，避免括号套娃', () => {
  assert.equal(voiceLabel('他说「你好」'), "[语音：「他说'你好'」]");
});

test('voiceLabel：超长转写截断，防止一条语音把提示词撑爆', () => {
  const long = '啊'.repeat(500);
  const out = voiceLabel(long);
  assert.ok(out.length < 230, `太长：${out.length}`);
  assert.ok(out.endsWith('…」]'));
});

test('voiceFailureNote：失败原因进日志，不进内容', () => {
  assert.equal(voiceFailureNote('transcribe timeout'), '语音转写失败：transcribe timeout');
  assert.equal(voiceFailureNote(''), '语音转写失败');
});
