import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bknFrom,
  cookieValue,
  qzoneKeys,
  parseQzoneJsonp,
  cleanQzoneText,
  cleanQzoneMention,
  mapMoodDetail,
  formatMoodDetail,
  formatQzoneFeeds
} from './qzone-cgi.js';

// ---------- g_tk ----------

test('g_tk：空 skey 就是种子值 5381（QQ 的老规矩）', () => {
  assert.equal(bknFrom(''), '5381');
  assert.equal(bknFrom(undefined), '5381');
});

test('g_tk：用 BigInt 独立算一遍，结果必须一致（不是自己验自己）', () => {
  const keys = ['@abcdefghij', 'dPon1*xyz', 'x', '一个中文不参与签名但也不能炸'];
  for (const k of keys) {
    // h = 5381 * 33^n + Σ char_i * 33^(n-i)；再用 & 0x7fffffff 截到 31 位
    let big = 5381n;
    for (const ch of k) big = big * 33n + BigInt(ch.codePointAt(0));
    assert.equal(bknFrom(k), String(big & 0x7fffffffn), `skey=${k}`);
  }
});

test('g_tk 一定是非负整数（& 0x7fffffff）', () => {
  for (const k of ['zzzzzzzzzzzzzzzzzzzz', '@' + '往'.repeat(20)]) {
    const v = Number(bknFrom(k));
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 2147483647, `${k} → ${v}`);
  }
});

test('cookie 取值：p_skey 优先，别用 skey 算签名（那个坑会 403）', () => {
  const str = 'pt2gguin=o3612473248; uin=o3612473248; skey=@SHORTskey; RK=abc; p_skey=LONGlivepskey; ptcz=z';
  assert.equal(cookieValue(str, 'skey'), '@SHORTskey');
  assert.equal(cookieValue(str, 'p_skey'), 'LONGlivepskey');
  assert.equal(cookieValue(str, '不存在'), '');
  const keys = qzoneKeys(str);
  assert.equal(keys.gtk, bknFrom('LONGlivepskey'));
  assert.equal(keys.skey, '@SHORTskey');
  assert.equal(keys.pSkey, 'LONGlivepskey');
  // 拿不到 p_skey 才退回 skey
  assert.equal(qzoneKeys('skey=@onlyskey').gtk, bknFrom('@onlyskey'));
  // 值里带正则元字符也不能把匹配搞坏
  assert.equal(cookieValue('a=x.y*z+1;', 'a'), 'x.y*z+1');
});

// ---------- JSONP ----------

test('JSONP：三种壳都拆得掉，裸 JSON 也认', () => {
  assert.deepEqual(parseQzoneJsonp('_Callback({"code":0,"n":1});'), { code: 0, n: 1 });
  assert.deepEqual(parseQzoneJsonp('callback({"code":0})'), { code: 0 });
  assert.deepEqual(parseQzoneJsonp('jsonhtml_callback({"code":0})'), { code: 0 });
  assert.deepEqual(parseQzoneJsonp('{"code":1}'), { code: 1 });
  assert.deepEqual(parseQzoneJsonp('  _Callback( {"a":[1,2]} ) ;  '), { a: [1, 2] });
});

test('JSONP：拆不掉就吵，不许静默当空数据', () => {
  assert.throws(() => parseQzoneJsonp(''), /空响应/);
  assert.throws(() => parseQzoneJsonp('<html>403 Forbidden</html>'), /无法识别/);
  assert.throws(() => parseQzoneJsonp('_Callback({坏掉的)'), /解析失败/);
  assert.throws(() => parseQzoneJsonp('{不是JSON}'), /不是合法 JSON/);
});

// ---------- 正文清洗 ----------

test('正文清洗：表情码、标签、实体、空白', () => {
  assert.equal(cleanQzoneText('没收了就老实了[em]e248[/em]'), '没收了就老实了[表情]');
  assert.equal(cleanQzoneText('<b>你好</b>&nbsp;世界&amp;大家'), '你好 世界&大家');
  assert.equal(cleanQzoneText('第一行<br/>第二行'), '第一行 第二行');
  assert.equal(cleanQzoneText('第一行<br/>第二行', { keepNewlines: true }), '第一行\n第二行');
  assert.equal(cleanQzoneText('<script>alert(1)</script>正文'), '正文');
  assert.equal(cleanQzoneText('&#x2764; &#65;'), '\u2764 A');
  assert.equal(cleanQzoneText(null), '');
});

test('@ 语法还原成人名（空间存的是 @{uin:…,nick:…}）', () => {
  assert.equal(cleanQzoneMention('@{uin:2413996651,nick:serendipity,who:1,auto:1}你也就配'), '@serendipity你也就配');
  assert.equal(cleanQzoneMention('@{uin:1036289741,nick:,who:1,auto:1}槽'), '@1036289741槽');
  assert.equal(cleanQzoneMention('没有人名'), '没有人名');
});

// ---------- 详情 + 评论 ----------

// 结构照抄 2026-10-12 真机返回的字段名（值都改过，不落真数据）
const DETAIL = {
  code: 0,
  subcode: 0,
  tid: '2f237892284d206906ca0700',
  content: '干杯孩子们[em]e400867[/em]',
  created_time: 1763724584,
  cmtnum: 3,
  fwdnum: 0,
  ugc_right: 1,
  secret: 0,
  source_name: 'iQOO 11 Pro (5G)',
  pic: [{ url1: 'http://x/1.jpg' }, { url1: 'http://x/2.jpg' }],
  commentlist: [
    {
      uin: 3214480872, name: '安琪.', content: '没收了就老实了[em]e248[/em]',
      create_time: 1763728336, createTime2: '2025-11-21 20:32:16', replyNum: 0
    },
    {
      uin: 2413996651, name: 'serendipity', content: '吃这么好我同意吗',
      create_time: 1763731396, createTime2: '2025-11-21 21:23:16', replyNum: 2,
      list_3: [
        { uin: 1036289741, name: '今天你吃饭了吗', content: '@{uin:2413996651,nick:serendipity,who:1,auto:1}你也就配吃大粪', create_time: 1763743407, createTime2: '2025-11-22 00:43:27' },
        { uin: 2413996651, name: 'serendipity', content: '@{uin:1036289741,nick:今天你吃饭了吗,who:1,auto:1}槽霓[em]e400340[/em]', create_time: 1763746384, createTime2: '2025-11-22 01:33:04' }
      ]
    },
    { uin: 3254752515, name: '月亮惹的祸', content: '666', create_time: 1765377470, createTime2: '2025-12-10 22:37:50' }
  ]
};

test('详情拍平：正文/图片数/评论数/来源/权限，评论含楼中楼', () => {
  const d = mapMoodDetail(DETAIL);
  assert.equal(d.tid, '2f237892284d206906ca0700');
  assert.equal(d.content, '干杯孩子们[表情]');
  assert.equal(d.images, 2);
  assert.equal(d.at, 1763724584000);
  assert.equal(d.ugcRight, 1);
  assert.equal(d.source, 'iQOO 11 Pro (5G)');
  assert.equal(d.commentCount, 3);
  assert.equal(d.comments.length, 3);
  assert.equal(d.comments[0].name, '安琪.');
  assert.equal(d.comments[0].text, '没收了就老实了[表情]');
  assert.equal(d.comments[0].when, '2025-11-21 20:32:16');
  assert.deepEqual(d.comments[0].replies, []);
  // 楼中楼：@ 语法还原、回复数 2 条
  assert.equal(d.comments[1].replies.length, 2);
  assert.equal(d.comments[1].replies[0].name, '今天你吃饭了吗');
  assert.match(d.comments[1].replies[0].text, /^@serendipity你也就配/);
  assert.equal(d.comments[1].replies[1].at, 1763746384000);
});

test('详情拍平：脏数据不炸，空评论/缺字段都给得出东西', () => {
  assert.equal(mapMoodDetail(null).comments.length, 0);
  assert.equal(mapMoodDetail({ content: null }).content, '');
  const onlyReplies = mapMoodDetail({ commentlist: [{ content: '', list_2: [{ content: '只有回复', name: 'x' }] }] });
  assert.equal(onlyReplies.comments.length, 1);
  assert.equal(onlyReplies.comments[0].replies.length, 1);
  // 空内容的评论被丢掉（空间里会有"只点了赞"之类没有正文的条目）
  assert.equal(mapMoodDetail({ commentlist: [{ content: '' }] }).comments.length, 0);
});

test('详情渲染：给她看的几行里有作者、时间、楼中楼缩进', () => {
  const text = formatMoodDetail(mapMoodDetail(DETAIL), { now: Date.parse('2025-12-11T00:00:00+08:00') });
  assert.match(text, /^【说说】干杯孩子们\[表情\]/);
  assert.match(text, /评论 3 条/);
  assert.match(text, /来自 iQOO 11 Pro \(5G\)/);
  assert.match(text, /- 安琪\.（2025-11-21 20:32:16）：没收了就老实了\[表情\]/);
  assert.match(text, /└ 今天你吃饭了吗（2025-11-22 00:43:27）：@serendipity你也就配吃大粪/);
  // 没评论时要说人话，不能给一片空白
  assert.match(formatMoodDetail({ content: 'x', comments: [] }), /还没有人评论/);
  // 条数上限
  const many = formatMoodDetail(mapMoodDetail(DETAIL), { maxComments: 2 });
  assert.match(many, /还有 1 条没列出来/);
});

// ---------- 好友动态 ----------

test('好友动态：洗掉预渲染 HTML，空的时候说清是"没有新动态"', () => {
  assert.match(formatQzoneFeeds([], {}), /好友动态是空的/);
  const text = formatQzoneFeeds([
    { uin: 10000001, nickname: '测试用户', time: 1763724584, html: '<div class="f">今天<b>挺好</b>的<br/>真的</div>' },
    { uin: 1, nickname: '某人', time: 0, html: '' }
  ], { now: Date.parse('2025-11-22T00:00:00+08:00') });
  assert.match(text, /测试用户：今天 挺好 的 真的/);
  assert.match(text, /\[时间未知\] 某人/);
});

// 单测里不写死真 skey（那是凭据）：只保证算法对得上 BigInt 那条独立实现。
