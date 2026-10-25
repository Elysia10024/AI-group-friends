// src/core/bili-notes.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendNote, makeNote } from './bili-notes.js';

const bv = 'BV1xx411c7mD';
const long = '啊'.repeat(500);

test('makeNote：结构化 + 截断 + 评论清洗', () => {
  const n = makeNote({
    bv,
    title: '  标题  带空格 ',
    tname: '游戏',
    owner: 'UP主',
    duration: 130,
    desc: long,
    comments: [
      { like: 3097, content: '评论区一人一只大肥鱼' },
      { like: '8', content: '  ' },
      { content: long },
      null
    ],
    key: 'group:20000001',
    at: 1790000000000
  });
  assert.equal(n.bv, bv);
  assert.equal(n.title, '标题 带空格');
  assert.equal(n.duration, 130);
  assert.equal(n.desc.length, 200);
  assert.equal(n.comments.length, 2, '空评论被过滤');
  assert.equal(n.comments[0].like, 3097);
  assert.ok(n.comments[1].text.length <= 120);
  assert.equal(n.key, 'group:20000001');
  assert.equal(n.at, 1790000000000);
});

test('makeNote：不合法 bv 返回 null', () => {
  assert.equal(makeNote({ bv: '' }), null);
  assert.equal(makeNote({ bv: 'BV123' }), null);
  assert.equal(makeNote({ bv: 'av123' }), null);
  assert.equal(makeNote(null), null);
});

test('appendNote：同 bv 去重、上限截断、null 安全', () => {
  const a = appendNote([], makeNote({ bv, title: '一' }));
  const b = appendNote(a, makeNote({ bv, title: '二' }));
  assert.equal(b.length, 1, '同一个 bv 只留一条');
  assert.equal(b[0].title, '二', '新记录覆盖旧的');
  const other = appendNote(b, makeNote({ bv: 'BV1yy411c7mE' }));
  assert.deepEqual(other.map((n) => n.bv), [bv, 'BV1yy411c7mE']);
  const many = [];
  for (let i = 0; i < 5; i++) many.push(makeNote({ bv: `BV1xx411c7m${'ABCDE'[i]}` }));
  const capped = appendNote(many, makeNote({ bv: 'BV1zz411c7mF' }), 3);
  assert.equal(capped.length, 3);
  assert.equal(capped[capped.length - 1].bv, 'BV1zz411c7mF');
  assert.deepEqual(appendNote(null, makeNote({ bv })).length, 1, 'null 池也安全');
  assert.equal(appendNote([], null).length, 0);
});
