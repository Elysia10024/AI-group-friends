// DSH tool/result 消息的解析：失败判定 + 错误文本提取。
//
// 为什么要单独抽出来（真实踩坑 2026-09-29）：桥接把每次工具调用记进 state/tool-calls.jsonl，
// 但错误文本取的是 `message.content[0].text`，而 DSH 实际把正文放在
// `message.content[0].content[0].text`（浅了一层）→ 33 条失败记录里 error 全是 null，
// 等于"只记了失败次数，没记失败原因"。抽成纯函数才能被单测钉住。

/** 这条 tool/result 是不是失败。 */
export function isToolResultError(message) {
  const block = message?.content?.[0];
  return block?.isError === true || message?.isError === true;
}

/** 取出错误文本（成功结果/取不到都返回空串）。
 *  自己先判失败：名字叫 errorText 就别在成功结果上返回正文，免得调用方误用。 */
export function toolResultErrorText(message) {
  if (!isToolResultError(message)) return '';
  const block = message?.content?.[0];
  const inner = block?.content?.[0]?.text;          // 真实形状：content[0].content[0].text
  if (typeof inner === 'string' && inner.trim()) return inner;
  const flat = block?.text ?? block?.error;         // 兼容旧形状/其它适配器
  if (typeof flat === 'string' && flat.trim()) return flat;
  const msgErr = message?.error;
  if (typeof msgErr === 'string' && msgErr.trim()) return msgErr;
  return '';
}
