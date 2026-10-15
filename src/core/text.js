// 中文排版相关的判定与改写：CJK-like 字符、示例里的空格改写、以及给 AI 的两条软提醒。
// 从 bridge.js 抽出来（R1' 第 7 步，R1' 的收尾）。
//
// 抽出来的理由：这四个函数是纯粹的字符扫描，但输入空间极大（中英混排、标点、
// 表情、URL、多语言），靠人工在群里试根本覆盖不到。抽出来之后可以穷举边界。
//
// 与 core/send.js 里 isCjkChar 的区别（**刻意不同，别合并**）：
//   · isCjkChar     只认汉字（0x4E00-0x9FFF / 0x3400-0x4DBF / 0xF900-0xFAFF）
//                   —— 用于"空格分条"判据，不认中文标点，避免"你好， 世界"被误拆。
//   · isCjkLikeChar 额外认中文标点（0x3000-0x303F）
//                   —— 用于"中文之间夹空格"这类排版检查。
import { isCjkChar } from './send.js';

/** 汉字 **或** 中文标点（U+3000–U+303F）。 */
export function isCjkLikeChar(ch) {
  if (!ch) return false;
  if (isCjkChar(ch)) return true;
  const code = ch.codePointAt(0);
  return code >= 0x3000 && code <= 0x303F;
}

// 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
// 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
// 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
export function convertExampleSpacesToComma(line) {
  const chars = Array.from(String(line ?? ''));
  const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '\t') {
      const prev = chars[i - 1];
      const next = chars[i + 1];
      const prevCjk = !!prev && isCjkLikeChar(prev);
      const nextCjk = !!next && isCjkLikeChar(next);
      const prevBlocked = !!prev && NO_REPLACE.has(prev);
      const nextBlocked = !!next && NO_REPLACE.has(next);
      if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
        out += '，';
        continue;
      }
    }
    out += ch;
  }
  return out;
}

// 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
// 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
export function findCjkSpaceWarning(messages) {
  const bad = [];
  for (let i = 0; i < (messages || []).length; i++) {
    const chars = Array.from(String(messages[i] ?? ''));
    for (let j = 0; j < chars.length; j++) {
      const ch = chars[j];
      if (ch !== ' ' && ch !== '\t') continue;
      const prev = chars[j - 1];
      const next = chars[j + 1];
      if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
        bad.push(i + 1);
        break;
      }
    }
  }
  if (!bad.length) return null;
  const list = [...new Set(bad)];
  const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
  return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
}

// 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
// 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
// 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
export function findSplitBoundaryWarning(messages) {
  if (!Array.isArray(messages) || messages.length <= 1) return null;
  const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
  // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
  const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
  const bad = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const prev = String(messages[i] ?? '').trim();
    const next = String(messages[i + 1] ?? '').trim();
    if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
    const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
    const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
    const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
    if (nonTerminalPunct || incompleteTail) {
      bad.push(`${i + 1}、${i + 2}`);
    }
  }
  if (!bad.length) return null;
  return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
}
