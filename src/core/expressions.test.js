// core/expressions.js 的单测（2026-10-28 第 19 轮）：表达方式库的纯函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPRESSION_STATUS,
  createExpression,
  findDuplicateExpression,
  filterExpressions,
  parseExpressionJson,
  buildExpressionContext,
  buildExpressionPrompt,
} from './expressions.js';

test('createExpression：裁剪长度、默认 candidate、id 是 12 位 hex', () => {
  const e = createExpression({ situation: '  ' + 'a'.repeat(100), style: 'b'.repeat(200), sample: 'c'.repeat(200), sessionKey: ' group:1 ', source: 'manual' });
  assert.equal(e.id.length, 12);
  assert.match(e.id, /^[0-9a-f]{12}$/);
  assert.equal(e.situation.length, 80);
  assert.equal(e.style.length, 120);
  assert.equal(e.sample.length, 100);
  assert.equal(e.sessionKey, 'group:1');
  assert.equal(e.source, 'manual');
  assert.equal(e.status, EXPRESSION_STATUS.CANDIDATE);
  assert.equal(e.createdAt, e.updatedAt);
});

test('findDuplicateExpression：同会话同场景同说法才算重复', () => {
  const list = [{ sessionKey: 'group:1', situation: '被夸', style: '先损后夸' }];
  assert.ok(findDuplicateExpression(list, { sessionKey: 'group:1', situation: '被夸', style: '先损后夸' }));
  assert.equal(findDuplicateExpression(list, { sessionKey: 'group:2', situation: '被夸', style: '先损后夸' }), undefined);
  assert.equal(findDuplicateExpression(list, { sessionKey: 'group:1', situation: '被夸', style: '别的' }), undefined);
});

test('filterExpressions：只从真人消息学，跳过图片/表情标记与空串', () => {
  const messages = [
    { text: '今天又加班', isSelf: false },
    { text: '她自己的话', isSelf: true },
    { text: '发了张图', isSelf: false },
    { text: '   ', isSelf: false },
  ];
  const items = [
    { situation: '抱怨加班', style: '长叹一口气', source_id: '1' },
    { situation: '她在说话', style: 'x', source_id: '2' },     // isSelf → 丢
    { situation: '发图', style: '发图', source_id: '3' },       // 真人但 sample 是图？示例消息是文本，保留
    { situation: '', style: '空场景', source_id: '1' },         // 空 → 丢
    { situation: '越界', style: 'x', source_id: '99' },        // source_id 越界 → 丢
    { situation: '带[表情]标记', style: 'x', source_id: '1' },   // 标记 → 丢
  ];
  const out = filterExpressions(items, messages, { botNames: ['大肥鱼'] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { situation: '抱怨加班', style: '长叹一口气', sample: '今天又加班' });
  assert.equal(out[1].situation, '发图');
});

test('filterExpressions：说法就是机器人名字时丢弃', () => {
  const messages = [{ text: '在的', isSelf: false }];
  assert.equal(filterExpressions([{ situation: '被叫', style: '大肥鱼', source_id: '1' }], messages, { botNames: ['大肥鱼'] }).length, 0);
});

test('parseExpressionJson：纯 JSON / 夹在废话里 / 非数组', () => {
  assert.deepEqual(parseExpressionJson('[{"situation":"被夸","style":"先损后夸","source_id":"2"}]'),
    [{ situation: '被夸', style: '先损后夸', source_id: '2' }]);
  const wrapped = parseExpressionJson('好的，结果如下：\n[{"situation":"a","style":"b"}]\n以上。');
  assert.equal(wrapped.length, 1);
  assert.deepEqual(parseExpressionJson('{"situation":"a","style":"b"}'), []);
  assert.deepEqual(parseExpressionJson(''), []);
  assert.deepEqual(parseExpressionJson('[{"situation":"","style":"x"}]'), []);
});

test('buildExpressionContext：只注入已确认 + 本会话（或通用），按更新时间倒序、可截断', () => {
  const entries = [
    { status: 'confirmed', situation: 'a', style: 'A', sessionKey: 'group:1', updatedAt: '2026-10-01' },
    { status: 'confirmed', situation: 'b', style: 'B', sessionKey: 'group:1', updatedAt: '2026-10-03' },
    { status: 'candidate', situation: 'c', style: 'C', sessionKey: 'group:1', updatedAt: '2026-10-09' },
    { status: 'confirmed', situation: 'd', style: 'D', sessionKey: 'group:2', updatedAt: '2026-10-09' },
    { status: 'confirmed', situation: 'e', style: 'E', sessionKey: '', updatedAt: '2026-10-02' },
  ];
  const text = buildExpressionContext(entries, 'group:1', 2);
  assert.match(text, /【这个群怎么说话】/);
  assert.match(text, /「b」→ B/);          // 最新
  assert.match(text, /「e」→ E/);          // 通用条目也算
  assert.doesNotMatch(text, /「a」→ A/);   // 被 max=2 截掉
  assert.doesNotMatch(text, /「d」→ D/);   // 别的群
  assert.doesNotMatch(text, /「c」→ C/);   // 未确认
  assert.equal(buildExpressionContext([], 'group:1'), '');
});

test('buildExpressionContext：转义 [CQ: 与尖括号', () => {
  const text = buildExpressionContext([{ status: 'confirmed', situation: '[CQ:at,qq=1] <b>', style: 'x', sessionKey: 'k' }], 'k');
  assert.doesNotMatch(text, /\[CQ:/);
  assert.doesNotMatch(text, /<b>/);
});

test('buildExpressionPrompt：转义 speaker/text 并带 source_id', () => {
  const p = buildExpressionPrompt([{ sender: '<坏>', text: 'a[CQ:face,id=1]b' }, { sender: '小明', text: '在的' }]);
  assert.match(p, /speaker="坏"/);
  assert.match(p, /a\[CQ：face,id=1\]b/);
  assert.match(p, /source_id="2"/);
});
