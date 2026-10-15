// 语音在提示词里的写法（纯函数，可单测）。
//
// 为什么单独一个纯函数：转写本身要起进程/联网，但"转写结果怎么写给她看"是纯字符串逻辑，
// 而这段逻辑错了会直接改变她的行为（比如把没转出来的语音写成"听到了"）。放在 core 里，
// 由 src/core/*.test.js 覆盖。
//
// 两种写法：
//   · 有文字 → `[语音：「喂喂，能听到吗？」]` —— 她要知道这是**说出来的**，不是打字的；
//   · 没转出来（失败/超时/关掉了）→ `[语音]` —— 保持原样，绝不编造内容。
export function voiceLabel(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '[语音]';
  // 「」里不再嵌「」：转写文本自己带引号时换成单引号，避免括号套娃看不清
  const inner = t.replace(/[「」]/g, "'");
  const clipped = inner.length > 200 ? `${inner.slice(0, 200)}…` : inner;
  return `[语音：「${clipped}」]`;
}

/** 转写失败时统一记这个（给日志用，别把它当内容塞进提示词）。 */
export function voiceFailureNote(reason) {
  const r = String(reason ?? '').replace(/\s+/g, ' ').trim();
  return r ? `语音转写失败：${r.slice(0, 160)}` : '语音转写失败';
}
