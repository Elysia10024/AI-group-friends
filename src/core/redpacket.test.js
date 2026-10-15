// 红包识别的契约测试。跑法：npm test
//
// 这些用例是从 bridge.js 里那版临时脚本（test-redpacket-detect.mjs）搬过来的 ——
// 那次它靠正则从 8586 行的 bridge.js 里"抽取"函数来测，本身就是屎山的症状。
// 现在被测代码是真正的模块，直接 import 即可。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRedPacket, groupStyleHint } from './redpacket.js';

const REAL = (greeting) => [{ type: 'redbag', data: { greeting, bill_no: '10000466' } }];
const TEXT = (text) => [{ type: 'text', data: { text } }];

// ---------- detectRedPacket：真红包 ----------
test('真红包 / 带 redbag 段 → real', () => {
  const r = detectRedPacket({ message: REAL('祝小鲸鱼天天开心') });
  assert.equal(r.kind, 'real');
  assert.equal(r.greeting, '祝小鲸鱼天天开心');
  assert.equal(r.isDefaultGreeting, false, '自定义留言不该算默认');
});

test('真红包 / 默认留言「恭喜发财」→ isDefaultGreeting=true', () => {
  for (const g of ['恭喜发财', '恭喜发财！', '恭喜发财。', '恭喜发财~', '恭喜发财，', '']) {
    const r = detectRedPacket({ message: REAL(g) });
    assert.equal(r.kind, 'real', `留言 ${JSON.stringify(g)} 应判为真红包`);
    assert.equal(r.isDefaultGreeting, true, `留言 ${JSON.stringify(g)} 应判为默认留言`);
  }
});

test('真红包 / 空 data → 不崩，且算默认留言', () => {
  const r = detectRedPacket({ message: [{ type: 'redbag', data: {} }] });
  assert.equal(r.kind, 'real');
  assert.equal(r.greeting, '');
  assert.equal(r.isDefaultGreeting, true);
});

test('真红包 / 带上 url 与 bill_no → 原样带出', () => {
  const r = detectRedPacket({
    message: [{ type: 'redbag', data: { greeting: 'x', url: 'red?id=123', bill_no: '123' } }]
  });
  assert.equal(r.url, 'red?id=123');
  assert.equal(r.billNo, '123');
});

// ---------- detectRedPacket：漏解兜底 ----------
test('兜底文案（解码器没解出真红包）→ 必须判为 real，不能判成假红包', () => {
  const r = detectRedPacket({ message: TEXT('[QQ红包]请使用新版手机QQ查收红包。') });
  assert.equal(r.kind, 'real', '把真红包当假红包去嘲讽是最难自查的回归');
  assert.equal(r.degraded, true);
  assert.equal(r.isDefaultGreeting, true);
});

// ---------- detectRedPacket：假红包 ----------
test('假红包 / 各种括号写法 → fake', () => {
  const cases = [
    '[QQ红包] 祝小鲸鱼永远开心',
    '[QQ红包]50元',
    '【QQ红包】恭喜发财',
    '[微信红包] 拿去',
    '【微信红包】恭喜发财',
    '[红包] 拿去',
    '【红包】给你',
    '(红包) 意思一下',
    '（红包）意思一下'
  ];
  for (const text of cases) {
    const r = detectRedPacket({ message: TEXT(text) });
    assert.equal(r?.kind, 'fake', `「${text}」应判为假红包`);
    assert.equal(r.text, text.slice(0, 120));
  }
});

test('假红包 / 「红包」+ 金额也算 → fake', () => {
  for (const text of ['我发个5块红包给你们', '红包 50元', '发个1毛红包']) {
    assert.equal(detectRedPacket({ message: TEXT(text) })?.kind, 'fake', `「${text}」应判为假红包`);
  }
});

// ---------- detectRedPacket：不该误判 ----------
test('普通聊天提到红包 → null', () => {
  const cases = [
    '红包自己留着买夜宵吧',
    '恭喜发财',
    '微信红包怎么发啊',
    '你这红包多少钱',
    '红包功能做好了吗'
  ];
  for (const text of cases) {
    assert.equal(detectRedPacket({ message: TEXT(text) }), null, `「${text}」不该被判成红包`);
  }
});

test('引用别人的消息 + 普通回复 → null（回复段不是 text 段）', () => {
  const msg = [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '哈哈' } }];
  assert.equal(detectRedPacket({ message: msg }), null);
});

test('非文本消息 / 空消息 → null', () => {
  assert.equal(detectRedPacket({ message: [{ type: 'image', data: {} }] }), null);
  assert.equal(detectRedPacket({ message: [] }), null);
  assert.equal(detectRedPacket({}), null);
  assert.equal(detectRedPacket(null), null);
  assert.equal(detectRedPacket(undefined), null);
});

test('多个 text 段会被拼起来再判断', () => {
  const msg = [{ type: 'text', data: { text: '[QQ红包]' } }, { type: 'text', data: { text: '恭喜发财' } }];
  assert.equal(detectRedPacket({ message: msg })?.kind, 'fake');
});

test('真红包优先于同条消息里的文本（不会被文本带偏）', () => {
  const msg = [{ type: 'text', data: { text: '[QQ红包]手打的' } }, { type: 'redbag', data: { greeting: '真红包' } }];
  const r = detectRedPacket({ message: msg });
  assert.equal(r.kind, 'real');
  assert.equal(r.greeting, '真红包');
});

// ---------- groupStyleHint ----------
test('群聊风格 / 互怼 → 判为很冲', () => {
  const s = groupStyleHint([{ text: '你他妈傻逼吧' }, { text: '滚啊弱智' }, { text: '闭嘴垃圾' }, { text: 'nm 废物' }]);
  assert.match(s, /互怼对骂/);
});

test('群聊风格 / 玩梗 → 判为很松', () => {
  const s = groupStyleHint([{ text: '哈哈哈哈笑死我了' }, { text: '[图片]' }, { text: '绷不住了这梗' }, { text: '嘿嘿' }]);
  assert.match(s, /玩梗开玩笑/);
});

test('群聊风格 / 平和 → 判为平和', () => {
  const s = groupStyleHint([{ text: '今天课好多' }, { text: '我明天要交作业' }, { text: '老师说要查重' }]);
  assert.match(s, /平和/);
});

test('群聊风格 / 空数组与 null → 空串（不要注入无意义的提示）', () => {
  assert.equal(groupStyleHint([]), '');
  assert.equal(groupStyleHint(null), '');
  assert.equal(groupStyleHint(undefined), '');
});

test('群聊风格 / 【已登记的怪癖】全是空文本时仍会给出「平和」提示', () => {
  // 原实现用 `if (!text) return ''` 判断，而 [{text:''},{}] 拼出来是 '\n'（真值），不会短路。
  // R1' 抽取时严格保留原行为 —— 这样 git diff 才能证明"只搬不改"。
  // 该怪癖在真实调用点不可达（ctxSlice 的消息文本不会是空串），已记入 已知问题.md。
  assert.match(groupStyleHint([{ text: '' }, {}]), /平和/);
});

test('群聊风格 / 兼容 plain 字段', () => {
  const s = groupStyleHint([{ plain: '哈哈笑死' }, { plain: '绷不住了' }, { plain: '[表情3]' }]);
  assert.match(s, /玩梗开玩笑/);
});

// ---------- 回归护栏 ----------
test('判据表必须稳定：真/假/无关 三类都覆盖到', () => {
  const table = [
    [{ message: REAL('恭喜发财') }, 'real'],
    [{ message: REAL('自定义') }, 'real'],
    [{ message: TEXT('[QQ红包]请使用新版手机QQ查收红包。') }, 'real'],
    [{ message: TEXT('[QQ红包] 打错了') }, 'fake'],
    [{ message: TEXT('红包 5元') }, 'fake'],
    [{ message: TEXT('随便聊两句') }, null]
  ];
  for (const [event, expected] of table) {
    const got = detectRedPacket(event);
    assert.equal(got ? got.kind : null, expected, JSON.stringify(event));
  }
});
