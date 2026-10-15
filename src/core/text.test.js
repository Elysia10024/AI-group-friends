// 中文排版判定与改写的契约测试。跑法：npm test
//
// 行为不变性由一次性差分脚本证明：抽取 bridge.js 里原件的 4 个函数，
// 与新模块在 72 组输入下比对，全部一致；脚本验证完即删。
//
// 这里留下的重点是**两套 CJK 判据的区别**（很容易被后来人"顺手合并"，那就出 bug 了）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCjkLikeChar, convertExampleSpacesToComma, findCjkSpaceWarning, findSplitBoundaryWarning } from './text.js';
import { isCjkChar } from './send.js';

// ---------------- 两套判据的区别 ----------------
test('isCjkLikeChar 比 isCjkChar 多认中文标点（U+3000–U+303F）', () => {
  // 汉字：两者一致
  for (const ch of ['中', '一', '鿿', '㐀']) {
    assert.equal(isCjkChar(ch), true, ch);
    assert.equal(isCjkLikeChar(ch), true, ch);
  }
  // 中文标点：只有 isCjkLikeChar 认 —— 这是刻意的，别合并
  for (const ch of ['、', '。', '【', '】', '　', '〿']) {
    assert.equal(isCjkChar(ch), false, ch + ' 不该被 isCjkChar 认（否则"你好， 世界"会被误拆）');
    assert.equal(isCjkLikeChar(ch), true, ch);
  }
  // 注意：全角逗号「，」是 U+FF0C（Halfwidth and Fullwidth Forms），
  // 不在 0x3000-0x303F 里 —— 所以两套判据都不认它。别想当然。
  assert.equal(isCjkLikeChar('，'), false, '全角逗号不在 U+3000-303F 区间');
  assert.equal(isCjkLikeChar('；'), false);
  // 非 CJK：两者都不认
  for (const ch of ['あ', 'A', '1', '🐟', '', null]) {
    assert.equal(isCjkChar(ch), false, String(ch));
    assert.equal(isCjkLikeChar(ch), false, String(ch));
  }
});

// ---------------- convertExampleSpacesToComma ----------------
test('convertExampleSpacesToComma：中文之间的空格改成逗号', () => {
  assert.equal(convertExampleSpacesToComma('你好 世界'), '你好，世界');
  assert.equal(convertExampleSpacesToComma('一 二 三'), '一，二，三');
  assert.equal(convertExampleSpacesToComma('中\t文'), '中，文');
});

test('convertExampleSpacesToComma：纯英文的空格不动（是真空格）', () => {
  assert.equal(convertExampleSpacesToComma('hello world'), 'hello world');
  assert.equal(convertExampleSpacesToComma('DeepSeek V3 很强'), 'DeepSeek V3，很强');
  assert.equal(convertExampleSpacesToComma('1 2 3'), '1 2 3');
});

test('convertExampleSpacesToComma：被符号夹住的空格不改（保护 URL / 路径 / 括号）', () => {
  assert.equal(convertExampleSpacesToComma('路径 / a b'), '路径 / a b');
  assert.equal(convertExampleSpacesToComma('a ( b ) c'), 'a ( b ) c');
  assert.equal(convertExampleSpacesToComma('中 [方括号] 文'), '中 [方括号] 文');
  assert.equal(convertExampleSpacesToComma('中=文'), '中=文');
  assert.equal(convertExampleSpacesToComma('https://a.com/b c'), 'https://a.com/b c');
});

test('convertExampleSpacesToComma：空输入不炸', () => {
  assert.equal(convertExampleSpacesToComma(''), '');
  assert.equal(convertExampleSpacesToComma(null), '');
  assert.equal(convertExampleSpacesToComma('   '), '   ');
});

// ---------------- findCjkSpaceWarning ----------------
test('findCjkSpaceWarning：两侧都是中文才报，纯英文不报', () => {
  assert.match(findCjkSpaceWarning(['中文 空格']), /第 1 条消息内部有中文空格/);
  assert.equal(findCjkSpaceWarning(['hello world']), null);
  assert.equal(findCjkSpaceWarning(['DeepSeek V3']), null);
  assert.equal(findCjkSpaceWarning(['正常一条']), null);
  assert.equal(findCjkSpaceWarning([]), null);
  assert.equal(findCjkSpaceWarning(null), null);
});

test('findCjkSpaceWarning：多条时报条号并去重', () => {
  assert.match(findCjkSpaceWarning(['中文 空格', '第二条 也有']), /第 1、2 条/);
  assert.match(findCjkSpaceWarning(['中 文', '中 文', '中 文']), /第 1、2、3 条/);
  assert.match(findCjkSpaceWarning(['第一条没事', '第二条 有 空格']), /第 2 条消息内部/);
});

test('findCjkSpaceWarning：单条只报一次（break 生效）', () => {
  assert.match(findCjkSpaceWarning(['中 文 中 文']), /第 1 条消息内部/);
  assert.doesNotMatch(findCjkSpaceWarning(['中 文 中 文']), /第 1、1/);
});

// ---------------- findSplitBoundaryWarning ----------------
test('findSplitBoundaryWarning：单条或不完整输入不报', () => {
  assert.equal(findSplitBoundaryWarning([]), null);
  assert.equal(findSplitBoundaryWarning(['单条']), null);
  assert.equal(findSplitBoundaryWarning(null), null);
  assert.equal(findSplitBoundaryWarning('abc'), null);
});

test('findSplitBoundaryWarning：上一条以非终止标点结尾 → 报', () => {
  assert.match(findSplitBoundaryWarning(['第一条，', '第二条']), /第 1、2 条之间/);
  assert.match(findSplitBoundaryWarning(['中文结尾；', '下一条']), /第 1、2 条之间/);
});

test('findSplitBoundaryWarning：上一条以"半句话"的词结尾且下一条是中文 → 报', () => {
  assert.match(findSplitBoundaryWarning(['我今天想说的', '是另一件事']), /第 1、2 条之间/);
  assert.match(findSplitBoundaryWarning(['我知道了', '然后呢']), /第 1、2 条之间/);
});

test('findSplitBoundaryWarning：常见"短句但完整"的结尾不报', () => {
  for (const tail of ['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']) {
    assert.equal(findSplitBoundaryWarning([tail, '下一句']), null, tail);
  }
});

test('findSplitBoundaryWarning：完整句子结尾不报', () => {
  assert.equal(findSplitBoundaryWarning(['这是一句完整的话。', '第二句']), null);
  assert.equal(findSplitBoundaryWarning(['我很好', '谢谢']), null);
});

test('findSplitBoundaryWarning：下一条不是中文开头时，"半句话"判据不成立', () => {
  // incompleteTail 要求下一条以中文开头
  assert.equal(findSplitBoundaryWarning(['我今天想说的', 'abc']), null);
});

test('findSplitBoundaryWarning：非终止标点结尾不看下一条，一律报', () => {
  assert.match(findSplitBoundaryWarning(['中文结尾；', 'abc']), /第 1、2 条之间/);
  assert.match(findSplitBoundaryWarning(['中文结尾，', 'abc']), /第 1、2 条之间/);
  assert.match(findSplitBoundaryWarning(['hello,', 'world']), /第 1、2 条之间/);
});

test('findSplitBoundaryWarning：半句话判据要求上一条至少 3 个字', () => {
  assert.equal(findSplitBoundaryWarning(['短', '中文']), null, '太短不算半句话');
});

test('findSplitBoundaryWarning：多个断点会列出所有条号', () => {
  // 格式是 `第 ${bad.join('，')} 条之间`，bad 元素形如 "1、2"
  assert.match(findSplitBoundaryWarning(['第一条，', '第二条，', '第三条']), /第 1、2，2、3 条之间/);
});
