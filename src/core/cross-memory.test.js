// core/cross-memory.js 单测（跨会话共享 + 代号脱敏）
import test from 'node:test';
import assert from 'node:assert/strict';
import { codeFor, redactText, pickCrossEntries, formatCrossBlock, CODE_POOL } from './cross-memory.js';

const people = {
  10000001: { names: { 'private:10000001': '老秦', 'group:20000001': 'Chihaya Anon' } },
  1797151424: { names: { 'group:20000001': '群三水' } }
};

test('codeFor：自定义代号优先，否则稳定命中代号池', () => {
  assert.equal(codeFor('10000001', { 10000001: '阿鲸' }), '阿鲸');
  assert.equal(codeFor('10000001'), codeFor('10000001'));
  assert.ok(CODE_POOL.includes(codeFor('10000001')));
  assert.equal(codeFor(''), '某群友');
});

test('redactText：群号/QQ/昵称都换成代号或占位', () => {
  const out = redactText('群三水在 group:20000001 说 10000001 和老秦 1797151424 都来了', { people });
  assert.ok(!out.includes('20000001'));
  assert.ok(!out.includes('10000001'));
  assert.ok(!out.includes('1797151424'));
  assert.ok(!out.includes('群三水'));
  assert.ok(!out.includes('老秦'));
  assert.match(out, /某个群/);
});

test('redactText：长昵称优先，不把名字的一部分漏出来', () => {
  const p = { 111111: { names: { 'group:1': '小明同学' } } };
  const out = redactText('小明同学说明天见', { people: p });
  assert.ok(!out.includes('小明'));
});

test('pickCrossEntries：排除当前会话、按相关度、受条数/字数限制', () => {
  const snaps = [
    { key: 'group:1', activeTopics: [{ text: '今天吃了顿火锅，很开心', lastMentionAt: 3 }] },
    { key: 'group:2', activeTopics: [{ text: '在聊周末去爬山的事', lastMentionAt: 2 }] },
    { key: 'group:3', activeTopics: [{ text: '无关的另一个话题', lastMentionAt: 1 }] }
  ];
  const lines = pickCrossEntries({ currentKey: 'group:1', snapshots: snaps, people, recentText: '周末 爬山', max: 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /爬山/);
  assert.ok(!lines[0].includes('group:'));
});

test('formatCrossBlock：空则空串，有内容带标题', () => {
  assert.equal(formatCrossBlock([]), '');
  const block = formatCrossBlock(['甲提到过火锅']);
  assert.match(block, /【你在别处记得的事】/);
  assert.match(block, /甲提到过火锅/);
});

test('pickCrossEntries：私聊记下的要求能进群聊材料，且昵称脱敏', () => {
  const p = { 10000001: { names: { 'private:1': '群三水' } } };
  const traits = [{ qq: '10000001', text: '【喜好】群三水说群里说话记得加颜文字，他觉得可爱', at: 100 }];
  const lines = pickCrossEntries({ currentKey: 'group:1', snapshots: [], traits, people: p, recentText: '群三水 在群里说话' });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('群三水'));
  assert.match(lines[0], /颜文字/);
});