import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMoodInput,
  resolveUgcRight,
  moodQuota,
  moodDayCount,
  lastMoodPost,
  moodPosts,
  appendMoodPost,
  removeMoodPost,
  moodPromptLine,
  formatMoodPosts,
  moodImageLabel,
  MOOD_POSTS_KEPT
} from './qzone.js';

// 所有时间显式给偏移量（UTC+8），不依赖测试机时区。
const TZ = 480;
const at = (iso) => Date.parse(iso);
// 本地 2026-10-12 23:00
const NOW = at('2026-10-12T15:00:00Z');

test('正文：空/纯空白直接拒', () => {
  assert.equal(normalizeMoodInput({ content: '' }).ok, false);
  assert.equal(normalizeMoodInput({ content: '   \n  \n ' }).ok, false);
  assert.equal(normalizeMoodInput({}).ok, false);
});

test('正文：收干净 CRLF、行尾空白、连续空行与连续空格，但保留换行', () => {
  const r = normalizeMoodInput({ content: '今天  挺累的\r\n\r\n\r\n  \r\n想躺一会  \r\n' });
  assert.equal(r.ok, true);
  assert.equal(r.value.content, '今天 挺累的\n\n想躺一会');
});

test('正文：超长按字算（不是按字节），报错里带两个数', () => {
  const r = normalizeMoodInput({ content: '鲸'.repeat(11), maxChars: 10 });
  assert.equal(r.ok, false);
  assert.match(r.error, /11 字 > 10 字/);
  // 10 个字正好可以
  assert.equal(normalizeMoodInput({ content: '鲸'.repeat(10), maxChars: 10 }).ok, true);
});

test('正文：把会话令牌之类的东西抄进去会被拦下', () => {
  const token = 'POI-cAByJ4iWbHCl7UKW81KJ6m84eYW-0GzKr3ZMQ3I';
  const r = normalizeMoodInput({ content: `今天很开心 ${token}`, secrets: [token] });
  assert.equal(r.ok, false);
  assert.match(r.error, /不该公开/);
  // 短"秘密"不参与匹配：不能因为一个短口令就把正常话拦下来
  assert.equal(normalizeMoodInput({ content: '我喜欢 abc123', secrets: ['abc123'] }).ok, true);
  assert.equal(normalizeMoodInput({ content: '没什么', secrets: [null, undefined, ''] }).ok, true);
});

test('权限：默认所有人可见，非法值回落，部分好友必须点名', () => {
  assert.equal(normalizeMoodInput({ content: '在' }).value.ugcRight, 4);   // 默认参数仍是 4（域会把配置里的默认值传进来）
  assert.equal(normalizeMoodInput({ content: '在', ugcRight: 64 }).value.ugcRight, 64);
  assert.equal(normalizeMoodInput({ content: '在', ugcRight: 7 }).value.ugcRight, 4);
  assert.equal(normalizeMoodInput({ content: '在', ugcRight: 99, defaultUgcRight: 1 }).value.ugcRight, 1);
  assert.equal(resolveUgcRight('1'), 1);
  assert.equal(resolveUgcRight(null, 64), 64);

  assert.equal(normalizeMoodInput({ content: '在', ugcRight: 16 }).ok, false);
  const ok16 = normalizeMoodInput({ content: '在', ugcRight: 16, targetUins: ['10000001'] });
  assert.equal(ok16.ok, true);
  assert.deepEqual(ok16.value.targetUins, ['10000001']);
  assert.equal(normalizeMoodInput({ content: '在', ugcRight: 128, targetUins: ['abc'] }).ok, false);
  // 非 16/128 时名单被丢掉，不往下传
  assert.deepEqual(normalizeMoodInput({ content: '在', ugcRight: 4, targetUins: ['10000001'] }).value.targetUins, []);
});

test('账本：只认有时间的记录，脏数据不把整本打废', () => {
  const state = { posts: [{ tid: 'a', at: 1, text: 'x' }, null, { tid: 'b' }, { tid: 'c', at: 2, text: 'y' }] };
  assert.equal(moodPosts(state).length, 2);
  assert.equal(lastMoodPost(state).tid, 'c');
  assert.equal(lastMoodPost({ posts: [] }), null);
  assert.equal(lastMoodPost(null), null);
});

test('额度：按本地日数今天发了几条（跨 UTC 日也算同一天）', () => {
  const state = { posts: [{ tid: '1', at: at('2026-10-11T16:30:00Z'), text: 'a' }] };  // 本地 10-12 00:30
  assert.equal(moodDayCount(state, NOW, TZ), 1);
  // 换成 UTC 日就是前一天了 —— 老写法的错
  assert.equal(moodDayCount(state, at('2026-10-12T16:30:00Z'), TZ), 0);
});

test('额度：关掉就是关掉', () => {
  const q = moodQuota({ state: { posts: [] }, now: NOW, enabled: false, tzOffsetMinutes: TZ });
  assert.equal(q.allowed, false);
  assert.equal(q.reason, 'disabled');
});

test('额度：今天还能发 / 发满 / 刚发过', () => {
  const empty = moodQuota({ state: { posts: [] }, now: NOW, dailyCap: 2, minGapMs: 3600000, tzOffsetMinutes: TZ });
  assert.equal(empty.allowed, true);
  assert.equal(empty.remaining, 2);

  // 今天 09:00 发过一条 → 还能发一条（间隔早过了）
  const one = moodQuota({ state: { posts: [{ tid: 'a', at: at('2026-10-12T01:00:00Z'), text: 'a' }] }, now: NOW, dailyCap: 2, minGapMs: 3600000, tzOffsetMinutes: TZ });
  assert.equal(one.allowed, true);
  assert.equal(one.todayCount, 1);
  assert.equal(one.remaining, 1);

  // 今天 09:00、10:00 各一条 → 满了（间隔早过了，所以是 daily-cap 而不是 too-soon）
  const full = moodQuota({
    state: { posts: [{ tid: 'a', at: at('2026-10-12T01:00:00Z'), text: 'a' }, { tid: 'b', at: at('2026-10-12T02:00:00Z'), text: 'b' }] },
    now: NOW, dailyCap: 2, minGapMs: 3600000, tzOffsetMinutes: TZ
  });
  assert.equal(full.allowed, false);
  assert.equal(full.reason, 'daily-cap');
  assert.match(full.error, /发满 2 条/);

  // 22:50 刚发过 → too-soon，并算出还要等多久
  const soon = moodQuota({ state: { posts: [{ tid: 'a', at: NOW - 10 * 60000, text: 'a' }] }, now: NOW, dailyCap: 5, minGapMs: 3600000, tzOffsetMinutes: TZ });
  assert.equal(soon.allowed, false);
  assert.equal(soon.reason, 'too-soon');
  assert.equal(soon.waitMs, 50 * 60000);
  assert.match(soon.error, /再等 50 分钟/);
});

test('额度：昨天的说说不算今天的，也不挡今天', () => {
  const state = { posts: [{ tid: 'a', at: at('2026-10-11T03:00:00Z'), text: 'a' }] };  // 本地 10-11 11:00
  const q = moodQuota({ state, now: NOW, dailyCap: 2, minGapMs: 2 * 3600000, tzOffsetMinutes: TZ });
  assert.equal(q.allowed, true);
  assert.equal(q.todayCount, 0);
  assert.equal(q.lastAt, at('2026-10-11T03:00:00Z'));
});

test('额度：默认上限 2 条、默认间隔 2 小时；垃圾配置不产生"永远发不了"', () => {
  const q = moodQuota({ state: { posts: [] }, now: NOW, dailyCap: 'x', minGapMs: -5, tzOffsetMinutes: TZ });
  assert.equal(q.dailyCap, 2);
  assert.equal(q.allowed, true);
});

test('记账：追加不乱序、有上限、不改原对象、正文只留一行', () => {
  const before = { note: '账本', posts: [{ tid: 'a', at: 1, text: 'a' }] };
  const after = appendMoodPost(before, { tid: 'b', at: 2, text: '第一行\n第二行', ugcRight: 64 });
  assert.equal(before.posts.length, 1, '原对象不能被改（纯函数）');
  assert.equal(after.note, '账本', '其它字段要留着');
  assert.equal(after.posts.length, 2);
  assert.equal(after.posts[1].ugcRight, 64);
  assert.equal(after.posts[1].text, '第一行 第二行');

  let many = { posts: [] };
  for (let i = 0; i < MOOD_POSTS_KEPT + 5; i += 1) many = appendMoodPost(many, { tid: `t${i}`, at: i + 1, text: 'x' });
  assert.equal(many.posts.length, MOOD_POSTS_KEPT);
  assert.equal(many.posts[many.posts.length - 1].tid, `t${MOOD_POSTS_KEPT + 4}`);
});

test('记账：配图只留"哪张图"（名字 + 谁放的），不留图片本身', () => {
  const after = appendMoodPost({ posts: [] }, { tid: 't', at: 5, text: '带图的', image: { name: '偷懒', by: 'her', verdict: '适合', buffer: '不该被存' } });
  assert.deepEqual(after.posts[0].image, { name: '偷懒', by: 'her' });
  // 名字缺失 / by 不认识 → 不收这个字段
  assert.equal(appendMoodPost({ posts: [] }, { tid: 't', at: 5, text: 'x', image: { name: '  ' } }).posts[0].image, undefined);
  assert.deepEqual(appendMoodPost({ posts: [] }, { tid: 't', at: 5, text: 'x', image: { name: '图', by: '??' } }).posts[0].image, { name: '图', by: 'admin' });
  assert.equal(moodImageLabel({ name: '偷懒', by: 'her' }), '偷懒（她自己存的）');
  assert.equal(moodImageLabel({ name: '偷懒', by: 'admin' }), '偷懒（管理员放的）');
  assert.equal(moodImageLabel(null), '');
  assert.equal(moodImageLabel({ name: '' }), '');
});

test('列表渲染：表情码洗成人话（别让她念一串数字）', () => {
  const text = formatMoodPosts([{ tid: 'a', at: NOW - 1000, text: '真好啊[em]e400867[/em]' }], { now: NOW });
  assert.match(text, /真好啊\[表情\]/);
  assert.ok(!text.includes('[em]'));
});

test('销账：删掉一条只删那一条', () => {
  const state = { posts: [{ tid: 'a', at: 1, text: 'a' }, { tid: 'b', at: 2, text: 'b' }] };
  const after = removeMoodPost(state, 'a');
  assert.deepEqual(after.posts.map((p) => p.tid), ['b']);
  assert.equal(removeMoodPost(state, '不存在').posts.length, 2);
});

test('提示行：能发时给"今天几条"和上一条回显，并点出工具名', () => {
  const line = moodPromptLine({
    state: { posts: [{ tid: 'a', at: at('2026-10-11T13:20:00Z'), text: '昨天那件事挺有意思' }] },   // 本地 10-11 21:20
    now: NOW, dailyCap: 2, minGapMs: 2 * 3600000, tzOffsetMinutes: TZ
  });
  assert.match(line, /^【说说】/);
  assert.match(line, /今天还没发（每天最多 2 条）/);
  assert.match(line, /上一条 昨天 21:20：「昨天那件事挺有意思」/);
  assert.match(line, /qq_post_mood/);
  assert.ok(line.endsWith('\n'));
});

test('提示行：发满/刚发过时**不再**叫她调工具（省一次白调）', () => {
  const full = moodPromptLine({
    state: { posts: [{ tid: 'a', at: at('2026-10-12T01:00:00Z'), text: 'a' }, { tid: 'b', at: at('2026-10-12T02:00:00Z'), text: 'b' }] },
    now: NOW, dailyCap: 2, minGapMs: 3600000, tzOffsetMinutes: TZ
  });
  assert.match(full, /今天已经发满 2 条了/);
  assert.ok(!full.includes('qq_post_mood'));

  const soon = moodPromptLine({
    state: { posts: [{ tid: 'a', at: NOW - 30 * 60000, text: 'a' }] },
    now: NOW, dailyCap: 5, minGapMs: 2 * 3600000, tzOffsetMinutes: TZ
  });
  assert.match(soon, /现在还不能发/);
  assert.match(soon, /还要等约 90 分钟/);
  assert.ok(!soon.includes('qq_post_mood'));
});

test('提示行：关掉或关掉提示就是空串（不能白花 token）', () => {
  assert.equal(moodPromptLine({ state: { posts: [] }, now: NOW, enabled: false }), '');
  assert.equal(moodPromptLine({ state: { posts: [] }, now: NOW, promptHint: false }), '');
  assert.match(moodPromptLine({ state: { posts: [] }, now: NOW, tzOffsetMinutes: TZ }), /【说说】/);
});

test('列表渲染：兼容空间返回（unix 秒）和本地账本（毫秒），空列表给人话', () => {
  assert.equal(formatMoodPosts([], { now: NOW }), '（空间里还没有说说）');
  const text = formatMoodPosts([
    { tid: 'abc', time: Math.floor(at('2026-10-12T02:00:00Z') / 1000), content: '今天天气不错', comment_num: 3 },
    { tid: 'd', at: NOW - 3600000, text: '有点累', ugcRight: 64 }
  ], { now: NOW, limit: 5 });
  assert.match(text, /\[10:00\] 今天天气不错 tid=abc 评论 3/);
  assert.match(text, /有点累 tid=d 仅自己可见/);
  assert.equal(formatMoodPosts([{ tid: 'x' }], { now: NOW }), '[时间未知] tid=x');
});
