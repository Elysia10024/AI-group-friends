// src/core/qq-card.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardToText } from './qq-card.js';

test('structmsg 卡片：抠出标题和 jumpUrl', () => {
  const card = {
    app: 'com.tencent.structmsg',
    meta: { news: { title: '【明日方舟】宣传PV', desc: '月行水上', jumpUrl: 'https://www.bilibili.com/video/BV1zCtA6mEay' } }
  };
  const out = cardToText({ data: JSON.stringify(card) });
  assert.ok(out.includes('【明日方舟】宣传PV'));
  assert.ok(out.includes('BV1zCtA6mEay'));
});

test('小程序卡片：qqdocurl 是 b23 短链', () => {
  const card = { app: 'com.tencent.miniapp_01', meta: { detail_1: { title: '哔哩哔哩', desc: '视频', qqdocurl: 'https://b23.tv/abc123' } } };
  const out = cardToText({ data: card });
  assert.ok(out.includes('哔哩哔哩'));
  assert.ok(out.includes('b23.tv/abc123'));
});

test('没有链接/标题时兜底为 [卡片消息]', () => {
  assert.equal(cardToText({ data: '{"app":"x"}' }), '[卡片消息]');
  assert.equal(cardToText(null), '[卡片消息]');
});

test('非 JSON 字符串不崩', () => {
  assert.equal(cardToText({ data: 'not json' }), '[卡片消息]');
});
