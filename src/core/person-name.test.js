// src/core/person-name.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { personShortName, matchExistingKey, resolvePersonQq, displayNameForQq, extractQqMentions, QQ_KEY_RE } from './person-name.js';

test('长名片砍成短名（这就是"来来"事故的根）', () => {
  assert.equal(personShortName('请你吃酸橙（！？来来？！）'), '请你吃酸橙', '括号里的梗不算名字');
  assert.equal(personShortName('咲音是凯尔希大人的狗（50/128）'), '咲音是凯尔希大人的狗');
  assert.equal(personShortName('群卦师，时不时来群里讲道（128/128）'), '群卦师', '逗号后的整段都不是名字');
  assert.equal(personShortName('至招，至丑，至绷的化身'), '至招');
  assert.equal(personShortName('群三水，🌿私你们这群烧货'), '群三水');
});

test('短名本来就干净的不动', () => {
  for (const n of ['拾圆拾圆', 'Dmnu', 'AF', '讨厌偏头痛', '缄默张雪峰', '大祥老师', '世纪末彼岸花丛中的死之结界']) {
    assert.equal(personShortName(n), n);
  }
  assert.equal(personShortName(''), '');
});

test('砍太狠就退回原名（别把名字砍没了）', () => {
  assert.equal(personShortName('（无）'), '（无）');
  assert.equal(personShortName('A（1）'), 'A（1）', '砍到只剩一个字 → 保留原名');
});

test('matchExistingKey：同一个人不再开第二个 key', () => {
  const keys = ['请你吃酸橙', '群三水', '拾圆拾圆'];
  assert.equal(matchExistingKey('请你吃酸橙（！？来来？！）', keys), '请你吃酸橙', '长名片命中已有短名');
  assert.equal(matchExistingKey('群三水，🌿私你们这群烧货', keys), '群三水');
  assert.equal(matchExistingKey('拾圆拾圆', keys), '拾圆拾圆');
  assert.equal(matchExistingKey('来来', keys), null, '光"来来"两个字不硬猜是谁');
  assert.equal(matchExistingKey('新人甲', keys), null);
});

// ── 身份锚点：名字 → QQ（2026-10-15）──────────────────────────────────────────
const OWNER = '10000001';
const PEOPLE = {
  [OWNER]: { names: { 'private:10000001': '群三水', 'group:20000002': '测试用户' } },
  '1797151424': { names: { 'group:20000001': '至招，至丑，至绷的化身' } },
  '10000004': { names: { 'group:20000001': '管我什么人格' } },
  '10000003': { names: { 'group:20000001': '请你吃酸橙（！？来来？！）' } }
};

test('resolvePersonQq：直接给 QQ 号就是它（最可靠的那一档）', () => {
  assert.equal(resolvePersonQq(OWNER, {}), OWNER);
  assert.equal(resolvePersonQq(' 10000001 ', {}), OWNER);
});

test('resolvePersonQq：本会话名片最权威，别的群的名字也认', () => {
  // 私聊里他叫"群三水"
  assert.equal(resolvePersonQq('群三水', { key: 'private:10000001', people: PEOPLE }), OWNER);
  // 同一个 QQ 在另一个群叫"测试用户" → 在那个群问也要认出是同一个人
  assert.equal(resolvePersonQq('测试用户', { key: 'group:20000002', people: PEOPLE }), OWNER);
  assert.equal(resolvePersonQq('测试用户', { key: 'group:20000001', people: PEOPLE }), OWNER, '换个群问也认（跨群名片回退）');
});

test('resolvePersonQq：短名对上长名片（"至招"→「至招，至丑，至绷的化身」）', () => {
  assert.equal(resolvePersonQq('至招', { key: 'group:20000001', people: PEOPLE }), '1797151424');
  assert.equal(resolvePersonQq('管我什么人格', { key: 'group:20000001', people: PEOPLE }), '10000004');
  assert.equal(resolvePersonQq('请你吃酸橙', { key: 'group:20000001', people: PEOPLE }), '10000003');
});

test('resolvePersonQq：短名撞上两个人就放弃（不猜 —— 猜错比认不出更糟）', () => {
  const two = { '1': { names: { 'group:1': '群三水甲' } }, '2': { names: { 'group:1': '群三水乙' } } };
  assert.equal(resolvePersonQq('群三水', { key: 'group:1', people: two }), null);
});

test('resolvePersonQq：人物表查不到时靠会话消息救（孤儿 key 就是靠这条）', () => {
  const st = { recentMessages: [{ sender: 'Qruei', userId: '10000004' }, { sender: '我', userId: '1', isSelf: true }] };
  assert.equal(resolvePersonQq('Qruei', { key: 'group:20000001', people: {}, st }), '10000004');
  // 名片带装饰 → 短名匹配
  const st2 = { recentMessages: [{ sender: '咲音是凯尔希大人的狗（50/128）', userId: '2897362096' }] };
  assert.equal(resolvePersonQq('咲音是凯尔希大人的狗', { key: 'g', people: {}, st: st2 }), '2897362096');
  // 自己的发言不算（免得把自己认成别人）
  const st3 = { recentMessages: [{ sender: '小鲸鱼', userId: '999', isSelf: true }] };
  assert.equal(resolvePersonQq('小鲸鱼', { key: 'g', people: {}, st: st3 }), null);
});

test('resolvePersonQq：最后兜底 —— 她自己印象里记的「（QQ …）」，且只认唯一那个', () => {
  const st = { memberImpressions: { 群卦师: { traits: ['【身份】群卦师（QQ 236153286），爱在群里讲道'] } } };
  assert.equal(resolvePersonQq('群卦师', { key: 'group:20000001', people: {}, st }), '236153286');
  const two = { memberImpressions: { 某甲: { traits: ['（QQ 111111）和（QQ 222222）都提过'] } } };
  assert.equal(resolvePersonQq('某甲', { key: 'g', people: {}, st: two }), null, '两个 QQ 就不认（可能是在说两个人）');
});

test('resolvePersonQq：全都认不出就返回 null（调用方保留原名 + pendingQq）', () => {
  assert.equal(resolvePersonQq('保科柊史', { key: 'group:20000001', people: PEOPLE, st: {} }), null);
  assert.equal(resolvePersonQq('', {}), null);
  assert.equal(resolvePersonQq(undefined, {}), null);
});

test('extractQqMentions：只认带 QQ 前缀的写法（不把日期当 QQ）', () => {
  assert.deepEqual(extractQqMentions('群卦师（QQ 236153286）'), ['236153286']);
  assert.deepEqual(extractQqMentions('QQ:236153286 / qq 236153286'), ['236153286'], '重复的只留一个');
  assert.deepEqual(extractQqMentions('10月13日 11:47 说过话'), []);
  assert.deepEqual(extractQqMentions(''), []);
});

test('displayNameForQq：显示层永远用**当前名片**，查不到才用可读兜底', () => {
  assert.equal(displayNameForQq(OWNER, { key: 'private:10000001', people: PEOPLE }), '群三水');
  assert.equal(displayNameForQq(OWNER, { key: 'group:20000002', people: PEOPLE }), '测试用户');
  // people 没有这个会话的名片 → 用别的会话的（总比一串数字强）
  assert.equal(displayNameForQq(OWNER, { key: 'group:未知', people: PEOPLE }), '群三水');
  // 消息里最近一次怎么称呼他（名片可能比 people.json 新）
  const st = { recentMessages: [{ sender: '新名片', userId: OWNER }] };
  assert.equal(displayNameForQq(OWNER, { key: 'g', people: {}, st }), '新名片');
  // 全查不到：用记录里存的旧名兜底
  assert.equal(displayNameForQq(OWNER, { key: 'g', people: {}, fallback: '旧名字' }), '旧名字');
  // 连兜底都没有 → 可读的「（QQ …）」，而不是裸露的数字
  const bare = displayNameForQq(OWNER, { key: 'g', people: {} });
  assert.equal(bare, `（QQ ${OWNER}）`);
  assert.ok(!QQ_KEY_RE.test(bare), '不能只是一串数字');
  // 还没认领 QQ 的条目：key 本身就是名字
  assert.equal(displayNameForQq('保科柊史', { key: 'g' }), '保科柊史');
});
