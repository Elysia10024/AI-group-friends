// src/core/memory-files.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_FIELDS, memoryFileName, memoryFilePath, pickMemory, applyMemory, isMemoryEmpty } from './memory-files.js';

test('会话 key → 记忆文件名（每个会话一个文件）', () => {
  assert.equal(memoryFileName('group:20000001'), 'group-20000001.json');
  assert.equal(memoryFileName('private:10000001'), 'private-10000001.json');
  assert.equal(memoryFileName('group:abc'), '', '非法 key 不给文件名');
  assert.equal(memoryFileName(''), '');
  assert.equal(memoryFilePath('C:/x/state/memory', 'group:1').replace(/\\/g, '/'), 'C:/x/state/memory/group-1.json');
});

test('pickMemory 只取记忆字段并裁剪上限（不把运行时状态写进记忆文件）', () => {
  const st = {
    activeTopics: Array.from({ length: 25 }, (_, i) => ({ text: 'T' + i })),
    pendingThoughts: [{ text: '想说' }],
    memberImpressions: { 群三水: { traits: ['关系：家人'] } },
    memoryVersion: 2,
    unread: [{ text: '不该进记忆文件' }],
    wakeConfig: { mode: 'diving' }
  };
  const mem = pickMemory(st);
  assert.deepEqual(Object.keys(mem).sort(), ['activeTopics', 'memberImpressions', 'memoryVersion', 'pendingThoughts']);
  assert.equal(mem.memoryVersion, 2, '格式版本要跟着记忆一起落盘（迁移脚本靠它判断迁过没有）');
  assert.equal(mem.activeTopics.length, 20, '按 cap 裁到 20');
  assert.equal(mem.activeTopics[19].text, 'T24', '保留最新的一批');
  assert.equal('unread' in mem, false);
  assert.equal('wakeConfig' in mem, false);
});

test('applyMemory 回填并保证形状稳定（缺字段给空值/默认值）', () => {
  const st = {};
  applyMemory(st, { activeTopics: [{ text: 'a' }] });
  assert.deepEqual(st.activeTopics, [{ text: 'a' }]);
  assert.deepEqual(st.pendingThoughts, []);
  assert.deepEqual(st.memberImpressions, {});
  assert.equal(st.memoryVersion, 0, '没写版本号 = 0 = 还没迁移（不是 undefined）');
  applyMemory(st, null);
  assert.deepEqual(st, { activeTopics: [], pendingThoughts: [], memberImpressions: {}, memoryVersion: 0 });
});

test('MEMORY_FIELDS 与字段表一致（防两处漂移）', () => {
  assert.deepEqual(MEMORY_FIELDS.map(([f]) => f), ['activeTopics', 'pendingThoughts', 'memberImpressions', 'memoryVersion']);
});

test('isMemoryEmpty：三样都空才算空（空会话不建文件）', () => {
  assert.equal(isMemoryEmpty({}), true);
  assert.equal(isMemoryEmpty({ activeTopics: [], pendingThoughts: [], memberImpressions: {} }), true);
  assert.equal(isMemoryEmpty({ memberImpressions: { AF: { traits: ['x'] } } }), false);
  assert.equal(isMemoryEmpty({ activeTopics: [{ text: 'x' }] }), false);
});
