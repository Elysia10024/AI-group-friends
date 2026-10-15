// src/core/topic-end.js 的测试。
//
// 用例全部取自 2026-09-19 群里那场架的真实消息（state/social-v2.json 的 recentMessages），
// 因为这条判断的价值就在"那次没接住"上：他把台阶递出来（我要洗澡了），
// 她补了一刀（别把脑子也一块冲下水道了），一小时后架就续上了。
import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeTopicEnd } from './topic-end.js';

test('真实收尾信号：认出来', () => {
  for (const text of [
    'nonono我要洗澡了，回来再跟你唠',   // 那次冲突里他递的台阶
    '洗澡去了',
    '我先睡了',
    '那我吃饭去了',
    '不聊了',
    '算了',
    '行吧',
    '行行行',
    '你赢了',
    '到此为止',
    '换个话题',
    '晚点再说',
    '回头聊',
    '拜拜',
    '晚安',
    '我上班去了',
    '今天真的累了，先睡了',      // 状态词在前：是"因为累所以走了"，仍然算收尾
    '困了，先休息了'
  ]) {
    assert.equal(looksLikeTopicEnd(text), true, text);
  }
});

test('普通群聊消息：不能误判成要走', () => {
  for (const text of [
    '刚吃了一顿烤肉',
    'nonono我发的都是新鲜的',
    '我有提过我有任何作品吗',
    '幻觉是你这辈子也摆脱不了的东西',
    '我想问你除了人身攻击还会什么',
    '没听懂，你们ai的语言逻辑还是高深',
    '我今天上班好累',            // 状态词在动作后面：在抱怨状态，不是要走
    '上课好烦',
    '刚洗完澡回来',              // 已经回来了，不是要走
    '所以你得靠我们说话来获取素材嘛',
    '哈喽',
    '来测',
    ''
  ]) {
    assert.equal(looksLikeTopicEnd(text), false, text);
  }
});

test('长消息不当作收尾信号（正文里出现"算了"不算要走）', () => {
  const long = '我跟你讲，昨天那事我想了半天，真的挺无语的，算了，其实也没什么好说的，就是觉得你这样不太行，以后再说吧，反正我也不急，你看着办，我这边还有事要忙，先不跟你多说了，回头有空再聊这个事情。';
  assert.ok(long.length > 60, `测试用的长消息得有 60 字以上，实际 ${long.length}`);
  assert.equal(looksLikeTopicEnd(long), false);
});

test('没带第一人称的评价不算离场（"你先睡吧"这种对别人说的仍算收尾）', () => {
  assert.equal(looksLikeTopicEnd('上班好累'), false, '缺第一人称/意愿词');
  assert.equal(looksLikeTopicEnd('你先睡吧'), true, '这句话本身就是在收尾');
});

test('非字符串输入不炸', () => {
  assert.equal(looksLikeTopicEnd(undefined), false);
  assert.equal(looksLikeTopicEnd(null), false);
  assert.equal(looksLikeTopicEnd(12345), false);
});
