// 组装器（纯函数）：三件事必须钉住 —— 块的顺序（缓存前缀纪律）、每块上限、稳定前缀哈希。
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleContextV2, hash32, ASSEMBLER_DEFAULT_LIMITS } from './assembler.js';

const full = {
  facts: '阿明喜欢猫',
  memory: '上周答应过给她画头像',
  slang: 'yyds=永远的神',
  status: '你正在潜水，下一次唤醒条件：被 @',
  recent: '阿明：在吗\n小蓝：在',
  trigger: '阿明 @ 了你'
};

test('块的顺序：稳定块在前、易变块在后（缓存前缀纪律）', () => {
  const r = assembleContextV2(full);
  assert.deepEqual(r.blocks.map((b) => b.name), ['facts', 'memory', 'slang', 'status', 'recent', 'trigger']);
  assert.deepEqual(r.blocks.filter((b) => b.stable).map((b) => b.name), ['facts', 'memory', 'slang']);
  // 前缀里只有稳定块，且顺序稳定
  assert.ok(r.prefix.includes('【关于群里的人与事】') && r.prefix.includes('【群里的黑话】'));
  assert.ok(!r.prefix.includes('【最近的群聊】'));
  assert.ok(r.text.startsWith(r.prefix));
});

test('稳定前缀哈希：事实没变 → 哈希不变；事实变了 → 哈希变（这就是缓存能不能命中的判据）', () => {
  const a = assembleContextV2(full);
  const b = assembleContextV2({ ...full, recent: '完全不同的最近消息', trigger: '不一样的原因' });
  assert.equal(a.prefixHash, b.prefixHash);          // 只动易变块 → 前缀哈希不变
  const c = assembleContextV2({ ...full, facts: '阿明喜欢狗' });
  assert.notEqual(a.prefixHash, c.prefixHash);        // 事实变了 → 必须变
});

test('每块都有上限，且截断时明确标注（不设上限就会把 3 万顶回 26 万）', () => {
  const long = '字'.repeat(20000);
  const r = assembleContextV2({ ...full, recent: long });
  const recent = r.blocks.find((b) => b.name === 'recent');
  assert.ok(recent.chars <= ASSEMBLER_DEFAULT_LIMITS.recent + 60, `实际 ${recent.chars}`);
  assert.ok(recent.text.includes('已截断'));
});

test('空块不出现（别塞【黑话】(空) 这种噪音）', () => {
  const r = assembleContextV2({ facts: '只有事实' });
  assert.deepEqual(r.blocks.map((b) => b.name), ['facts']);
});

test('入参乱给不炸：null/数字/对象都能吞下去', () => {
  const r = assembleContextV2({ facts: null, memory: 123, slang: { a: 1 }, recent: undefined, trigger: '' });
  assert.ok(r.text.includes('123'));
  assert.ok(r.text.includes('[object Object]') || r.text.length >= 0);   // 不抛错即可
  assert.equal(assembleContextV2().blocks.length, 0);
});

test('hash32：同输入同结果、不同输入不同结果、空串稳定', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
  assert.equal(hash32(''), '811c9dc5');
});
