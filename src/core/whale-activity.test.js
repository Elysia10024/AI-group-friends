// core/whale-activity.js 单测（公共活动日志：规范化/去重/裁剪/材料块）
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEntry, appendEntry, formatActivityBlock, ACTIVITY_MAX } from './whale-activity.js';

test('makeEntry：只记群里/私聊，不带群号；文本去空白并截断', () => {
  const e = makeEntry({ kind: 'video', text: '  刷到《星布谷地》定档PV  ', key: 'group:20000001', at: 1793368531221 });
  assert.equal(e.where, 'group');
  assert.equal(e.text, '刷到《星布谷地》定档PV');
  assert.equal(e.kind, 'video');
  assert.ok(!JSON.stringify(e).includes('20000001'));
});

test('appendEntry：同文本 2 秒内去重，超出上限裁掉最旧', () => {
  const base = [{ kind: 'message', where: 'group', text: '旧', at: 1 }];
  const a = makeEntry({ text: '新', at: 100000 });
  const once = appendEntry(base, a);
  const twice = appendEntry(once, makeEntry({ text: '新', at: 100500 }));
  assert.equal(twice.filter((e) => e.text === '新').length, 1);
  const many = Array.from({ length: ACTIVITY_MAX + 5 }, (_, i) => ({ kind: 'message', where: 'group', text: 'x' + i, at: i }));
  const cut = appendEntry(many, makeEntry({ text: 'last', at: 999999 }));
  assert.equal(cut.length, ACTIVITY_MAX);
  assert.equal(cut[cut.length - 1].text, 'last');
});

test('formatActivityBlock：空则空串；有内容按旧→新，标群里/私聊', () => {
  assert.equal(formatActivityBlock([]), '');
  const block = formatActivityBlock([
    { kind: 'video', where: 'group', text: '刷到A', at: 0 },
    { kind: 'image', where: 'private', text: '发了图B', at: 0 }
  ]);
  assert.match(block, /【你最近做过的事】/);
  assert.match(block, /群里：刷到A/);
  assert.match(block, /私聊里：发了图B/);
  assert.ok(block.indexOf('刷到A') < block.indexOf('发了图B'));
});
