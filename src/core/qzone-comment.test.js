import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMoodComment,
  commentKey,
  newComments,
  allCommentKeys,
  formatCommentNotice,
  withCommentMention,
  MOOD_COMMENT_MAX_CHARS
} from './qzone.js';

const TZ_NOW = Date.parse('2026-10-13T12:00:00+08:00');
const c = (uin, at, text, extra = {}) => ({ uin: String(uin), at, text, name: `人${uin}`, replies: [], ...extra });

test('评论正文：空/纯空白拒，换行压成一行（评论不该带排版）', () => {
  assert.equal(normalizeMoodComment({ content: '' }).ok, false);
  assert.equal(normalizeMoodComment({ content: '  \n ' }).ok, false);
  const r = normalizeMoodComment({ content: '第一行\r\n\r\n第二行   有空格' });
  assert.equal(r.ok, true);
  assert.equal(r.value.content, '第一行 第二行 有空格');
});

test('评论正文：按字算长度（不是字节），默认 120 字', () => {
  assert.equal(MOOD_COMMENT_MAX_CHARS, 120);
  assert.equal(normalizeMoodComment({ content: '鲸'.repeat(120) }).ok, true);
  const over = normalizeMoodComment({ content: '鲸'.repeat(121) });
  assert.equal(over.ok, false);
  assert.match(over.error, /121 字 > 120 字/);
  assert.equal(normalizeMoodComment({ content: '鲸'.repeat(11), maxChars: 10 }).ok, false);
});

test('评论正文：令牌之类不许跟着评论发出去', () => {
  const token = 'POI-cAByJ4iWbHCl7UKW81KJ6m84eYW-0GzKr3ZMQ3I';
  const r = normalizeMoodComment({ content: `谢谢 ${token}`, secrets: [token] });
  assert.equal(r.ok, false);
  assert.match(r.error, /不该公开/);
  assert.equal(normalizeMoodComment({ content: '短口令 abc123', secrets: ['abc123'] }).ok, true);
});

test('评论身份：同人同秒同内容算同一条（这就是"回过了"的判据）', () => {
  const a = c(111, 1000, '你好');
  const b = c(111, 1000, '你好');
  const other = c(222, 1000, '你好');
  const later = c(111, 2000, '你好');
  assert.equal(commentKey(a), commentKey(b));
  assert.notEqual(commentKey(a), commentKey(other));
  assert.notEqual(commentKey(a), commentKey(later));
  // 空白差异不算差别（正文先被规整过）
  assert.equal(commentKey(c(1, 5, '你  好')), commentKey(c(1, 5, '你 好')));
  // 脏数据不炸
  assert.equal(typeof commentKey(null), 'string');
  assert.equal(typeof commentKey({}), 'string');
});

test('挑新评论：见过的（含楼中楼）不再算新的', () => {
  const list = [c(1, 100, 'a'), c(2, 200, 'b', { replies: [c(3, 300, 'r1')] })];
  const keys = allCommentKeys(list);
  assert.equal(keys.length, 3, '楼中楼的键也要记上');
  assert.deepEqual(newComments(list, keys), []);
  assert.equal(newComments(list, []).length, 2);
  assert.equal(newComments(list, [commentKey(list[0])]).length, 1);
  // seen 传 Set 或数组都行
  assert.equal(newComments(list, new Set(keys)).length, 0);
});

test('唤醒提示里的评论通知：列出来 + 楼中楼数量 + 超量截断', () => {
  const text = formatCommentNotice('tid123', [
    c(1, TZ_NOW - 3600000, '不是我干的', { when: '2026-10-13 11:24:12' }),
    c(2, TZ_NOW - 1800000, '可爱捏', { when: '2026-10-13 11:25:16', replies: [c(9, TZ_NOW, '？')] })
  ], { now: TZ_NOW });
  assert.match(text, /tid=tid123/);
  assert.match(text, /下面有 2 条新评论/);
  assert.match(text, /- 人1（2026-10-13 11:24:12）：不是我干的/);
  assert.match(text, /- 人2（2026-10-13 11:25:16）：可爱捏（下面还挂着 1 条回复）/);
  assert.equal(formatCommentNotice('t', []), '');
  const many = formatCommentNotice('t', Array.from({ length: 9 }, (_, i) => c(i, TZ_NOW, `x${i}`)), { now: TZ_NOW, limit: 5 });
  assert.match(many, /还有 4 条没列/);
});

test('回复时补 @：网关只能发顶层评论，指向谁靠正文里的 @', () => {
  assert.equal(withCommentMention('UserB', '想得美'), '@UserB 想得美');
  assert.equal(withCommentMention('UserB', '@UserB 想得美'), '@UserB 想得美', '她已经写了 @ 就别重复加');
  assert.equal(withCommentMention('', '想得美'), '想得美');
  assert.equal(withCommentMention('UserB', ''), '');
  assert.equal(withCommentMention(null, '想得美'), '想得美');
  // 名字太长（多半不是人名）不动它
  assert.equal(withCommentMention('这个名字长到不像人名的一串字', '好'), '@这个名字长到不像人名的一串字 好');
  assert.equal(withCommentMention('x'.repeat(40), '好'), `@${'x'.repeat(20)} 好`);
});
