// deepMerge：配置文件"默认值 + 覆盖"的语义。
// 这些 case 全部来自真实事故：旧代码用浅 spread 合并，旧 config.json 里只要出现过
// `socialV2.wake` 这一层，整个 wake 段的默认值就被替换成 undefined。
import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge, isPlainObject } from './deep-merge.js';

test('嵌套对象递归合并：覆盖一个子键不会丢掉同段其他默认值', () => {
  const base = { wake: { a: 1, b: 2, deep: { x: 1, y: 2 } } };
  const got = deepMerge(base, { wake: { b: 9, deep: { y: 8 } } });
  assert.deepEqual(got, { wake: { a: 1, b: 9, deep: { x: 1, y: 8 } } });
});

test('数组整体替换（不按元素合并）', () => {
  const got = deepMerge({ k: ['a', 'b', 'c'] }, { k: ['z'] });
  assert.deepEqual(got.k, ['z']);
});

test('null / undefined 视为"没配"，保留默认', () => {
  const got = deepMerge({ a: 1, o: { x: 1 } }, { a: null, o: undefined });
  assert.deepEqual(got, { a: 1, o: { x: 1 } });
});

test('标量覆盖 + 新键进来', () => {
  assert.deepEqual(deepMerge({ a: 1 }, { a: 2, b: 3 }), { a: 2, b: 3 });
});

test('纯函数：不与入参共享引用，改返回值不影响默认值', () => {
  const base = { o: { x: 1 }, arr: [1] };
  const over = { o: { y: 2 } };
  const got = deepMerge(base, over);
  got.o.x = 99; got.arr.push(2);
  assert.equal(base.o.x, 1);
  assert.deepEqual(base.arr, [1]);
  assert.deepEqual(over, { o: { y: 2 } });
});

test('over 不是普通对象（null/数组/标量）时等于克隆 base', () => {
  const base = { a: { b: 1 } };
  for (const over of [null, undefined, [], 5, 'x']) {
    const got = deepMerge(base, over);
    assert.deepEqual(got, base);
    assert.notEqual(got.a, base.a);
  }
});

test('类型不同则以 over 为准（对象 vs 标量/数组）', () => {
  assert.deepEqual(deepMerge({ k: { a: 1 } }, { k: 5 }).k, 5);
  assert.deepEqual(deepMerge({ k: 5 }, { k: { a: 1 } }).k, { a: 1 });
  assert.deepEqual(deepMerge({ k: { a: 1 } }, { k: [1] }).k, [1]);
});

test('isPlainObject 不把数组/null 当对象', () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject('x'), false);
});
