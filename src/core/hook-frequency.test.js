// src/core/hook-frequency.js 的测试。
//
// 用例全部来自她真实发过的消息（state/social-v2.json）。
// 两个方向都要钉住：句尾补刀必须认出来；**正当的关心句不能误伤**
// （"别熬夜了""别客气"这类如果被算成挂钩，她就会把自己的好意也削掉）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tailHookOf,
  hookFrequencyHint,
  HOOK_MIN_SAMPLE,
  HOOK_REPEAT_THRESHOLD,
  HOOK_SAMPLE_SIZE
} from './hook-frequency.js';

const self = (text) => ({ isSelf: true, text });

test('认得出句尾挂钩（真实消息）', () => {
  assert.equal(tailHookOf('……行吧，摸就摸吧，这条别记我账上')?.id, 'account');
  assert.equal(tailHookOf('发到手抽筋我再给你记一笔，写你名下')?.id, 'account');
  assert.equal(tailHookOf('行，去吧，别把脑子也一块冲下水道了')?.id, 'negate');
  assert.equal(tailHookOf('别死我群里')?.id, 'negate');
  assert.equal(tailHookOf('本小姐才不稀罕')?.id, 'lady');
  assert.equal(tailHookOf('懒得理你')?.id, 'dismiss');
});

test('正当的关心/客气不能被当成挂钩', () => {
  for (const t of [
    '别熬夜了，早点睡',
    '别客气，随时找我',
    '你别太累了，我盯着群呢',
    '行，去吧，路上小心',
    '知道了，晚安',
    '群里你后面自己说了：叫老秦。记下了',
    '哼，本来就该能发'
  ]) {
    assert.equal(tailHookOf(t), null, t);
  }
});

test('正文里出现"别"但句尾没有，不算挂钩', () => {
  assert.equal(tailHookOf('别问我为什么，我只是路过看一眼'), null);
  assert.equal(tailHookOf('你们别吵了，我要去吃饭'), null);
});

test('样本太小不下结论', () => {
  const few = [self('别理我'), self('懒得理你'), self('说完了')];
  assert.ok(few.length < HOOK_MIN_SAMPLE);
  assert.equal(hookFrequencyHint(few), '');
});

test('真实场景：8 条里 3 条句尾补刀 → 必须提醒，并带上例子', () => {
  const msgs = [
    self('……行吧，摸就摸吧，这条别记我账上'),
    self('发到手抽筋我再给你记一笔，写你名下'),
    self('以后你截图我就给你单开一页'),
    self('今天天气不错'),
    self('刚吃完饭'),
    self('你说的对'),
    self('我看看群里聊啥'),
    self('哦')
  ];
  const hint = hookFrequencyHint(msgs);
  assert.match(hint, /句尾补了一刀/);
  assert.match(hint, /3 条/);
  assert.match(hint, /记账\/账本/, '要说清是哪种钩子');
  assert.match(hint, /说完就停/);
  assert.match(hint, /例如/, '要给出具体例子，她才知道说的是哪句');
});

test('只有 2 条挂钩 → 不提醒（阈值是 3）', () => {
  const msgs = [self('别理我'), self('懒得理你'), self('今天天气不错'), self('刚吃完饭'), self('你说的对')];
  assert.ok(HOOK_REPEAT_THRESHOLD === 3);
  assert.equal(hookFrequencyHint(msgs), '');
});

test('她自己的消息才算（群友爱怎么说都跟她没关系）', () => {
  const msgs = [
    { isSelf: false, sender: '老秦', text: '懒得理你' },
    { isSelf: false, sender: '老秦', text: '别问我' },
    { isSelf: false, sender: '老秦', text: '写你名下' },
    self('今天天气不错'),
    self('刚吃完饭')
  ];
  assert.equal(hookFrequencyHint(msgs), '');
});

test('只统计最近的 HOOK_SAMPLE_SIZE 条（更早的不算）', () => {
  const old = Array.from({ length: 5 }, () => self('懒得理你'));
  const fresh = Array.from({ length: HOOK_SAMPLE_SIZE }, (_, i) => self(`第${i}句正常聊天`));
  assert.equal(hookFrequencyHint([...old, ...fresh]), '');
});

test('空输入 / 缺字段不炸', () => {
  assert.equal(tailHookOf(undefined), null);
  assert.equal(tailHookOf(null), null);
  assert.equal(hookFrequencyHint(undefined), '');
  assert.equal(hookFrequencyHint([null, undefined, {}]), '');
});
