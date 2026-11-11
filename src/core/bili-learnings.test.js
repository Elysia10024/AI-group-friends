// core/bili-learnings.js 单测
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLearning, appendLearning, formatLearningsBlock } from './bili-learnings.js';

const BV = 'BV1eFW16VEnP';

test('makeLearning：bv 不合法/summary 为空返回 null；正常裁剪', () => {
  assert.equal(makeLearning({ bv: 'bad', summary: 'x' }), null);
  assert.equal(makeLearning({ bv: BV, summary: '   ' }), null);
  const l = makeLearning({ bv: BV, title: ' 标题 ', summary: ' 学到了 A  ', key: 'group:1', source: 'self', at: 123 });
  assert.equal(l.bv, BV);
  assert.equal(l.title, '标题');
  assert.equal(l.summary, '学到了 A');
  assert.equal(l.source, 'self');
  assert.equal(l.at, 123);
});

test('appendLearning：同 bv 覆盖，超出上限留最近', () => {
  const a = makeLearning({ bv: BV, summary: '旧要点', at: 1 });
  const b = makeLearning({ bv: BV, summary: '新要点', at: 2 });
  const list = appendLearning(appendLearning([], a), b);
  assert.equal(list.length, 1);
  assert.equal(list[0].summary, '新要点');
  const many = Array.from({ length: 205 }, (_, i) => makeLearning({ bv: 'BV' + String(i).padStart(10, '0'), summary: 's' + i, at: i }));
  const cut = appendLearning(many, makeLearning({ bv: 'BV9999999999', summary: 'last', at: 999 }), 200);
  assert.equal(cut.length, 200);
  assert.equal(cut[cut.length - 1].summary, 'last');
});

test('formatLearningsBlock：空则空串；有内容带标题和要点', () => {
  assert.equal(formatLearningsBlock([]), '');
  const block = formatLearningsBlock([makeLearning({ bv: BV, title: '大肥鱼小课堂', summary: 'DSH 的插件能自己装' })]);
  assert.match(block, /【你最近学到的东西】/);
  assert.match(block, /大肥鱼小课堂/);
  assert.match(block, /插件能自己装/);
});
