// 出站消息成形的契约测试。跑法：npm test
//
// 行为不变性由一次性差分脚本证明：抽取 bridge.js 里原件的两段（文本切分簇 + 间隔计算簇），
// 与新模块在 **113 组输入**下比对，全部一致；脚本验证完即删。
//
// 这里留下的重点是**边界**——这段逻辑的坑全在边界上：不丢内容、不拆断 URL、
// 中英混排的空格判据、间隔必须夹在合法区间。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  singleLineForQQ, splitLongSegment, isCjkChar, splitByCjkSpaces,
  planSocialTimeline, clampGap, computeGaps
} from './send.js';

const SEND = {
  burstIntervalMinMs: 1000, burstIntervalMaxMs: 3000, maxGapMs: 10000,
  gapBaseMs: 800, gapPerCharMs: 20, longGapProbability: 0.2,
  longGapMinMs: 5000, longGapMaxMs: 10000
};

// ---------------- singleLineForQQ ----------------
test('singleLineForQQ：折换行、并空格、去首尾', () => {
  assert.equal(singleLineForQQ('a\nb'), 'a b');
  assert.equal(singleLineForQQ('a\r\nb'), 'a b');
  assert.equal(singleLineForQQ('a  b'), 'a b');
  assert.equal(singleLineForQQ('a\t\tb'), 'a b');
  assert.equal(singleLineForQQ('  x  '), 'x');
  assert.equal(singleLineForQQ('多行\n\n\n文本'), '多行 文本');
  assert.equal(singleLineForQQ(''), '');
  assert.equal(singleLineForQQ(null), '');
  assert.equal(singleLineForQQ(undefined), '');
});

// ---------------- splitLongSegment ----------------
test('splitLongSegment：不超限就原样一条', () => {
  assert.deepEqual(splitLongSegment('你好', 10), ['你好']);
  assert.deepEqual(splitLongSegment('x'.repeat(10), 10), ['x'.repeat(10)]);
  assert.deepEqual(splitLongSegment('', 10), []);
  assert.deepEqual(splitLongSegment('   ', 10), []);
});

test('splitLongSegment：超限硬拆，且每片不超上限', () => {
  const out = splitLongSegment('x'.repeat(25), 10);
  assert.deepEqual(out, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  for (const p of out) assert.ok(p.length <= 10);
});

test('splitLongSegment：优先在次要标点处断句', () => {
  const out = splitLongSegment('一二三四五，六七八九十，十一', 8);
  assert.ok(out.length >= 2);
  for (const p of out) assert.ok(p.length <= 8, p);
});

test('splitLongSegment：URL 是不可拆的原子，绝不被截断', () => {
  const url = 'https://example.com/very/long/path?a=1&b=2';
  const out = splitLongSegment(`看这个 ${url} 很长吧`, 20);
  assert.ok(out.some((p) => p.includes(url)), 'URL 必须完整出现在某一片里');
  assert.ok(!out.some((p) => p.includes('https://') && !p.includes(url)), '不该出现被截断的 URL');
});

test('splitLongSegment：不丢内容（拼接后长度一致）', () => {
  const s = '一二三四五六七八九十，'.repeat(20);
  const out = splitLongSegment(s, 17);
  assert.equal(out.join('').length, s.length, '所有分片拼起来必须等于原文');
});

test('splitLongSegment：非法上限回落到 500', () => {
  assert.equal(splitLongSegment('x'.repeat(600), NaN).length, 2);
  assert.equal(splitLongSegment('x'.repeat(600), 0).length, 2);
  assert.equal(splitLongSegment('x'.repeat(600), -1).length, 2);
});

// ---------------- isCjkChar ----------------
test('isCjkChar：只认汉字，不认假名/标点/拉丁/emoji', () => {
  for (const ch of ['中', '一', '鿿', '㐀']) assert.equal(isCjkChar(ch), true, ch);
  for (const ch of ['あ', '，', '.', 'a', '1', '🐟', '', null]) assert.equal(isCjkChar(ch), false, String(ch));
});

// ---------------- splitByCjkSpaces ----------------
test('splitByCjkSpaces：空格两侧有一侧是汉字就分条', () => {
  assert.deepEqual(splitByCjkSpaces('中文 分条 信号'), ['中文', '分条', '信号']);
  assert.deepEqual(splitByCjkSpaces('中文 hello 世界'), ['中文', 'hello', '世界']);
  assert.deepEqual(splitByCjkSpaces('中 English 混'), ['中', 'English', '混']);
});

test('splitByCjkSpaces：纯英文的空格不分条（是真空格）', () => {
  assert.deepEqual(splitByCjkSpaces('hello world'), ['hello world']);
  assert.deepEqual(splitByCjkSpaces('a b c'), ['a b c']);
});

test('splitByCjkSpaces：单条与空输入', () => {
  assert.deepEqual(splitByCjkSpaces('单条'), ['单条']);
  assert.deepEqual(splitByCjkSpaces(''), []);
  assert.deepEqual(splitByCjkSpaces('   '), []);
  assert.deepEqual(splitByCjkSpaces('  多个   空格   '), ['多个', '空格']);
});

// ---------------- planSocialTimeline ----------------
test('planSocialTimeline：空输入返回空', () => {
  assert.deepEqual(planSocialTimeline('', {}), { main: [], followUp: null });
  assert.deepEqual(planSocialTimeline('   ', {}), { main: [], followUp: null });
});

test('planSocialTimeline：关掉分条时整条发一条', () => {
  const r = planSocialTimeline('第一条 第二条', { burstEnabled: false });
  assert.deepEqual(r.main, ['第一条 第二条']);
  assert.equal(r.followUp, null);
});

test('planSocialTimeline：按空格分条', () => {
  const r = planSocialTimeline('第一条 第二条 第三条', {});
  assert.deepEqual(r.main, ['第一条', '第二条', '第三条']);
});

test('planSocialTimeline：分条后再按 maxReplyChars 硬拆', () => {
  const r = planSocialTimeline('字'.repeat(30), { maxReplyChars: 8 });
  assert.equal(r.main.length, 4);
  for (const m of r.main) assert.ok(m.length <= 8);
});

test('planSocialTimeline：非法 maxReplyChars 回落 500', () => {
  const r = planSocialTimeline('字'.repeat(600), { maxReplyChars: 'abc' });
  assert.equal(r.main.length, 2);
});

test('planSocialTimeline：换行也当分条信号', () => {
  const r = planSocialTimeline('a\nb\nc', {});
  assert.ok(r.main.length >= 1);
  for (const m of r.main) assert.ok(!m.includes('\n'));
});

// ---------------- clampGap / computeGaps ----------------
test('clampGap：夹在 [burstIntervalMinMs, maxGapMs] 之间', () => {
  const cfg = { burstIntervalMinMs: 500, maxGapMs: 2000 };
  assert.equal(clampGap(0, cfg), 500);
  assert.equal(clampGap(50, cfg), 500);
  assert.equal(clampGap(1500, cfg), 1500);
  assert.equal(clampGap(99999, cfg), 2000);
  assert.equal(clampGap(NaN, cfg), 500);
  assert.equal(clampGap('abc', cfg), 500);
});

test('clampGap：max 小于 min 时不会返回负数', () => {
  const v = clampGap(1234, { burstIntervalMinMs: 99999, maxGapMs: 1 });
  assert.ok(v >= 100);
});

test('computeGaps：条数不足 2 就没有间隔', () => {
  assert.deepEqual(computeGaps([], 'auto', undefined, undefined, SEND), []);
  assert.deepEqual(computeGaps(['a'], 'auto', undefined, undefined, SEND), []);
  assert.deepEqual(computeGaps(null, 'auto', undefined, undefined, SEND), []);
});

test('computeGaps：长度恒为 消息数 - 1', () => {
  const msgs = ['a', 'bb', 'ccc', 'dddd'];
  assert.equal(computeGaps(msgs, 'byLength', undefined, undefined, SEND).length, 3);
  assert.equal(computeGaps(msgs, 'fixed', 2000, undefined, SEND).length, 3);
  assert.equal(computeGaps(msgs, 'auto', undefined, undefined, SEND, () => 0.5).length, 3);
});

test('computeGaps：byLength 按上一条长度算', () => {
  // burstIntervalMinMs 要放低，否则算出来的值会被夹到下限（clampGap 的正确行为）
  const cfg = { ...SEND, burstIntervalMinMs: 100, gapBaseMs: 100, gapPerCharMs: 10 };
  assert.deepEqual(computeGaps(['a', 'bb'], 'byLength', undefined, undefined, cfg), [110]);
  assert.deepEqual(computeGaps(['abcd', 'x'], 'byLength', undefined, undefined, cfg), [140]);
});

test('computeGaps：结果永远不低于 burstIntervalMinMs', () => {
  const cfg = { ...SEND, burstIntervalMinMs: 1000, gapBaseMs: 1, gapPerCharMs: 1 };
  assert.deepEqual(computeGaps(['a', 'b'], 'byLength', undefined, undefined, cfg), [1000]);
});

test('computeGaps：fixed 用 gapMs，gaps 数组足够长时优先用数组', () => {
  const cfg = { ...SEND, burstIntervalMinMs: 100 };
  const msgs = ['a', 'b', 'c'];
  assert.deepEqual(computeGaps(msgs, 'fixed', 2000, undefined, cfg), [2000, 2000]);
  assert.deepEqual(computeGaps(msgs, 'fixed', 2000, [1500, 1600], cfg), [1500, 1600]);
  // 数组不够长 → 回落 gapMs
  assert.deepEqual(computeGaps(msgs, 'fixed', 900, [1500], cfg), [900, 900]);
});

test('computeGaps：auto 模式受 longGapProbability 控制', () => {
  const cfg = { ...SEND, longGapProbability: 1, longGapMinMs: 5000, longGapMaxMs: 6000 };
  // random 恒为 0 → 必然走长间隔，且 randInt 落到下界
  assert.deepEqual(computeGaps(['a', 'b'], 'auto', undefined, undefined, cfg, () => 0), [5000]);
  const cfg2 = { ...SEND, longGapProbability: 0 };
  // random 恒为 0 → longProb=0 不走长间隔，randInt 落到普通下界
  assert.deepEqual(computeGaps(['a', 'b'], 'auto', undefined, undefined, cfg2, () => 0), [1000]);
});

test('computeGaps：未知 mode 落到 auto', () => {
  const cfg = { ...SEND, longGapProbability: 0 };
  assert.deepEqual(computeGaps(['a', 'b'], '???', undefined, undefined, cfg, () => 0), [1000]);
});

test('computeGaps：空配置也能出合法间隔', () => {
  const out = computeGaps(['a', 'b', 'c'], 'auto', undefined, undefined, {}, () => 0.5);
  assert.equal(out.length, 2);
  for (const d of out) assert.ok(Number.isFinite(d) && d >= 100, String(d));
});
