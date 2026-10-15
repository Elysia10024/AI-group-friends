// src/core/person-crossref.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { foreignPersonLines } from './person-crossref.js';

const group = {
  key: 'group:20000001',
  memberImpressions: {
    群友乙: { traits: ['关系：好朋友', '他嫌纯爱"太健全"，连着两轮点名要我写扭曲恋情', '刷到贬低我形象的视频会来告诉我'] },
    群友甲: { traits: ['关系：家人', '爱拿我的配置当谈资'] }
  }
};

test('本会话提到、别处记过 → 补一行（这就是"私聊里不认识群友乙"的修法）', () => {
  const lines = foreignPersonLines({
    text: '三水：哦鲸鲸是群友乙给你起的',

    ownNames: ['群友甲', 'UserB'],
    others: [group]
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /群友乙/);
  assert.match(lines[0], /关系：好朋友/);
  assert.match(lines[0], /别的会话里记过/);
});

test('本会话已有印象的人不重复补', () => {
  const lines = foreignPersonLines({ text: '提到群友乙', ownNames: ['群友乙'], others: [group] });
  assert.deepEqual(lines, []);
});

test('本会话没提到的人不塞（不是无脑全量）', () => {
  const lines = foreignPersonLines({ text: '今天天气不错', ownNames: [], others: [group] });
  assert.deepEqual(lines, []);
});

test('最多 3 人 × 2 条，且长句被截断', () => {
  const many = {
    key: 'group:1',
    memberImpressions: Object.fromEntries(
      ['甲一', '乙二', '丙三', '丁四'].map((n, i) => [n, { traits: [`关系：熟人`, `第${i}条`, 'x'.repeat(200)] }])
    )
  };
  const lines = foreignPersonLines({ text: '甲一 乙二 丙三 丁四 都在这', ownNames: [], others: [many] });
  assert.equal(lines.length, 3, '最多 3 人');
  assert.ok(lines.every((l) => l.length < 260), '单行不会失控');
});

test('只按短名精确命中，不做模糊猜测（防"我以为他是谁"）', () => {
  const conv = { key: 'group:1', memberImpressions: { '群友丁（！？来来？！）': { traits: ['关系：熟人', '嘴上答应、身体先看'] } } };
  // 文本里写全了短名 → 命中（key 是长名片，比对时用短名）
  const hit = foreignPersonLines({ text: '群友丁又来了', ownNames: [], others: [conv] });
  assert.equal(hit.length, 1);
  assert.match(hit[0], /群友丁（你在别的会话里记过他）/);
  // 只写"酸橙"两个字 → **故意不命中**：模糊匹配会制造新的"他是谁"错误，宁可不补
  const miss = foreignPersonLines({ text: '酸橙又来了', ownNames: [], others: [conv] });
  assert.deepEqual(miss, [], '不做子串猜测——名字猜错比不补更糟');
});
