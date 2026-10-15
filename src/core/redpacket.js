// 红包识别（真 / 假）与群聊风格判断 —— 纯函数，无 I/O、无时间依赖。
//
// 从 bridge.js 的 main() 闭包里抽出来（R1' 整合第一步）。抽出来的理由：
// ① 它改得频繁（真假判据、火力调过好几轮）；
// ② 它是纯逻辑，能离线单测 —— 改完跑 `npm test` 就行，不用重启桥与内核、不用等真实群消息；
// ③ 之前的改动每次都要写"字符串锚点替换"补丁脚本，那正是引号翻车的来源。
//
// 判据为什么可靠：
// 真红包会被 SnowLuma 解成 `redbag` 段（带留言）；假红包是群友手打的模仿文本，没有该段。
// QQ 对真红包的兜底文案「[QQ红包]请使用新版手机QQ查收红包。」在 SnowLuma 补丁后已被
// `redbag` 段取代，所以「带红括号但没 redbag 段」= 一定是手打的。

/** 手打假红包的括号特征：[QQ红包]、【微信红包】…… */
const BRACKET_RE = /(\[QQ红包|【QQ红包|\[微信红包|【微信红包|\[红包\]|【红包】|\(红包\)|（红包）)/;
/** 「红包」+ 金额 → 也是嘴炮红包 */
const AMOUNT_RE = /\d+(\.\d+)?\s*(元|块钱|块|毛|角|分|rmb|RMB|¥|￥)/;
/** QQ 红包的默认留言，这条不值得回应 */
const DEFAULT_GREETING_RE = /^恭喜发财[!！。.，,~～、\s]*$/;
/** SnowLuma 解不出真红包时，QQ 给的兜底文案 */
const QQ_FALLBACK_TEXT = '请使用新版手机QQ';

/**
 * 判定一条消息是不是红包（真或假）。
 * @param {{message?: Array<{type: string, data?: Record<string, unknown>}>}} event OneBot 消息事件
 * @returns {null | {
 *   kind: 'real'|'fake',
 *   greeting: string,
 *   isDefaultGreeting: boolean,
 *   text?: string,
 *   url?: string,
 *   billNo?: string,
 *   degraded?: boolean
 * }}
 */
export function detectRedPacket(event) {
  const segs = Array.isArray(event?.message) ? event.message : [];

  // ① 真红包：SnowLuma 解出的 redbag 段
  const realSeg = segs.find((s) => s && s.type === 'redbag');
  if (realSeg) {
    const greeting = String(realSeg.data?.greeting ?? '').trim();
    return {
      kind: 'real',
      greeting,
      // QQ 红包默认留言就是「恭喜发财」，这条不给反应。
      isDefaultGreeting: !greeting || DEFAULT_GREETING_RE.test(greeting),
      url: String(realSeg.data?.url ?? ''),
      billNo: String(realSeg.data?.bill_no ?? '')
    };
  }

  const text = segs
    .filter((s) => s && s.type === 'text')
    .map((s) => String(s.data?.text ?? ''))
    .join('')
    .trim();
  if (!text) return null;

  // ② 兜底文案 = "有个真红包，但解码器没解出来"（QQ 改了元素格式时会这样）。
  //    宁可当成真红包（只是不知道留言），也绝不能误判成手打的假红包去嘲讽。
  if (text.includes(QQ_FALLBACK_TEXT)) {
    return { kind: 'real', greeting: '', isDefaultGreeting: true, url: '', billNo: '', degraded: true };
  }

  // ③ 假红包：手打的模仿文本
  const looksFake = BRACKET_RE.test(text) || (/红包/.test(text) && AMOUNT_RE.test(text));
  if (!looksFake) return null;
  return { kind: 'fake', text: text.slice(0, 120), greeting: '', isDefaultGreeting: false };
}

/**
 * 根据最近的群聊判断氛围，用来决定红包反应的火力。
 * 她自己也看得到【最近的群聊】，这里只是给一句明确提示。
 * @param {Array<{text?: string, plain?: string}>} messages
 * @returns {string} 一行提示；无内容时返回空串
 */
export function groupStyleHint(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const text = list.map((m) => String((m && (m.text ?? m.plain)) ?? '')).join('\n');
  if (!text) return '';

  const n = Math.max(1, list.length);
  const harshRe = /(傻逼|煞笔|弱智|智障|白痴|尼玛|你妈|妈的|滚蛋|滚啊|闭嘴|废物|垃圾|去死|草泥马|fuck|傻狗)/g;
  const playfulRe = /(哈哈|嘿嘿|笑死|乐死|绷不住|玩梗|乐子|笑不活|梗)/g;
  const mediaRe = /(\[图片\]|\[表情\d*\]|\[动画表情\]|\[真红包)/g;

  const harsh = (text.match(harshRe) || []).length / n;
  const playful = ((text.match(playfulRe) || []).length + (text.match(mediaRe) || []).length) / n;

  let label;
  if (harsh >= 0.15) label = '群里正在互怼对骂，说话很冲';
  else if (playful >= 0.35) label = '群里在玩梗开玩笑，气氛很松';
  else label = '群里气氛比较平和，正常插科打诨';

  return `【当前群聊风格】${label}。按这个风格决定火力：群里越冲你越可以放开损；气氛温和就俏皮点，别真扎人。\n`;
}
