// src/core/mood.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMoodEvent, decayMood, moodLine, moodSourceLabel } from './mood.js';

const NOW = new Date('2026-10-02T20:00:00+08:00').getTime();

test('记一条心情：覆盖旧的（心情是状态不是流水账）', () => {
  const m = applyMoodEvent({ tone: '开心', since: 1 }, { tone: '有点闷', intensity: 2, because: '被说了一句', sourceKey: 'group:20000001', now: NOW });
  assert.equal(m.tone, '有点闷');
  assert.equal(m.intensity, 2);
  assert.equal(m.sourceKey, 'group:20000001');
  assert.equal(m.since, NOW);
  assert.ok(m.exchangesLeft >= 1);
});

test('跨群：心情带得走，但材料里**不写别的群的名字**', () => {
  const m = applyMoodEvent(null, { tone: '有点闷', intensity: 2, because: '在别的地方被否定了一句', sourceKey: 'group:20000001', now: NOW });
  const line = moodLine(m, 'group:20000004');   // 在**另一个**群里渲染
  assert.match(line, /有点闷/);
  assert.match(line, /别处/);
  assert.ok(!line.includes('20000001'), '不能泄露别的群的群号');
  assert.ok(!/群\s*\d+/.test(line), '不能出现任何群号');
});

test('来源是本会话时可以说"因为刚才那几句"', () => {
  const m = applyMoodEvent(null, { tone: '烦躁', intensity: 2, because: '被怼了', sourceKey: 'group:20000001', now: NOW });
  assert.match(moodLine(m, 'group:20000001'), /刚才那几句/);
});

test('随机情绪（没有来由）照实说"说不上为什么"', () => {
  const m = applyMoodEvent(null, { tone: '有点闷', intensity: 1, because: '', sourceKey: '', now: NOW });
  assert.match(moodLine(m, 'group:20000001'), /说不上为什么/);
});

test('平静不占材料（没心情就不写这行）', () => {
  assert.equal(moodLine(null, 'group:1'), '');
  assert.equal(moodLine({ tone: '平静' }, 'group:1'), '');
});

test('衰减：说几句就淡；睡一觉再淡一档；淡完回平静', () => {
  let m = applyMoodEvent(null, { tone: '难过', intensity: 3, because: '被否定了', sourceKey: 'group:1', now: NOW });
  assert.equal(m.exchangesLeft, 5);
  m = decayMood(m, { exchanges: 2 }).mood;
  assert.equal(m.exchangesLeft, 3);
  m = decayMood(m, { exchanges: 1, slept: true }).mood;   // 睡一觉
  assert.equal(m.exchangesLeft, 1);
  assert.equal(m.intensity, 2, '睡醒强度也降一档');
  const gone = decayMood(m, { exchanges: 1 });
  assert.equal(gone.mood, null, '淡完就是平静');
});

test('内部诊断：能看出这份心情来自哪个会话（但不进材料）', () => {
  const m = applyMoodEvent(null, { tone: '开心', intensity: 2, sourceKey: 'private:10000001', now: NOW });
  assert.equal(moodSourceLabel(m), '私聊 10000001');
});
