// src/core/tool-result.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { isToolResultError, toolResultErrorText } from './tool-result.js';

// 真实形状（从 state/tool-calls.jsonl 里失败的那几条挖出来的原文，逐字抄）
const REAL_FAIL = {
  content: [{
    type: 'tool-result',
    toolCallId: 'call_01_94CWGWmQ8UnpodxkGvkT8865',
    content: [{ type: 'text', text: 'Error: 发送表情失败：找不到表情 蓝色鼠鼠比赞，好耶，请先用 qq_list_stickers 获取有效 id' }],
    isError: true
  }]
};
const REAL_OK = {
  content: [{
    type: 'tool-result',
    content: [{ type: 'text', text: '{\n  "ok": true\n}' }],
    isError: false
  }]
};

test('isToolResultError：按 content[0].isError 判定', () => {
  assert.equal(isToolResultError(REAL_FAIL), true);
  assert.equal(isToolResultError(REAL_OK), false);
  assert.equal(isToolResultError({}), false);
  assert.equal(isToolResultError(null), false);
});

test('toolResultErrorText：从 content[0].content[0].text 取到真实错误（旧代码读浅一层，永远是 null）', () => {
  assert.match(toolResultErrorText(REAL_FAIL), /找不到表情 蓝色鼠鼠比赞/);
  assert.equal(toolResultErrorText(REAL_OK), '', '成功结果没有错误文本');
});

test('toolResultErrorText：兼容扁平形状与 message.error', () => {
  assert.equal(toolResultErrorText({ content: [{ isError: true, text: 'Error: 扁平形状' }] }), 'Error: 扁平形状');
  assert.equal(toolResultErrorText({ content: [{ isError: true, error: 'Error: error 字段' }] }), 'Error: error 字段');
  assert.equal(toolResultErrorText({ isError: true, error: 'Error: 顶层' }), 'Error: 顶层');
  assert.equal(toolResultErrorText({ content: [{ isError: true, content: [{ text: '   ' }] }] }), '', '空白不算文本');
  assert.equal(toolResultErrorText({ content: [{ isError: true }] }), '', '没有任何文本就返回空');
});
