// 「不理某人」名单的单测。
//
// 意义：这是**唯一**能让人从她视野里消失的开关，写错的两个方向都很糟 ——
//   · 太松（脏值被当成 QQ 号）：可能把整个群的人一起忽略掉，她不说话了；
//   · 太紧（数字/字符串不一致）：名单写了却不管用，主人以为拉黑了其实没拉黑。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isIgnoredUser, normalizeIgnoreUsers } from './ignore-users.js';

test('数字和字符串写法都要认（OneBot 的 id 两种都可能出现）', () => {
  assert.equal(isIgnoredUser([10000004], 10000004), true);
  assert.equal(isIgnoredUser([10000004], '10000004'), true);
  assert.equal(isIgnoredUser(['10000004'], 10000004), true);
  assert.equal(isIgnoredUser([' 10000004 '], '10000004'), true, '前后空白要容忍');
});

test('别人不受影响', () => {
  assert.equal(isIgnoredUser([10000004], 10000001), false);
  assert.equal(isIgnoredUser([10000004], '2923918119'), false, '差一位不能算命中');
});

test('名单为空 / 不是数组 = 谁都不忽略（默认安全）', () => {
  for (const v of [[], undefined, null, '', '10000004', 0, {}]) {
    assert.equal(normalizeIgnoreUsers(v).length, 0, String(v));
    assert.equal(isIgnoredUser(v, 10000004), false, String(v));
  }
});

test('脏值一律丢掉，不许被当成 QQ 号', () => {
  assert.deepEqual(normalizeIgnoreUsers(['abc', '', '  ', null, undefined, -1, '1e3', {}, []]), []);
  assert.deepEqual(normalizeIgnoreUsers([10000004, '10000004', 10000004]), ['10000004'], '去重');
  assert.deepEqual(normalizeIgnoreUsers(['abc', 10000004, '0']), ['10000004', '0']);
});

test('空/缺失的说话人一律不判为忽略', () => {
  for (const id of ['', '   ', null, undefined]) {
    assert.equal(isIgnoredUser([10000004], id), false, String(id));
  }
});
