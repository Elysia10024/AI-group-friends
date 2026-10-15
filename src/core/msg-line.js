// 材料里**消息行**的唯一渲染入口。
//
// 为什么要抽出来：同一行格式（`【管理员】名字：内容+媒体提示`）原来在好几处各写了一遍
// （assembler 的"最近群聊"和"未读"、social-flow 的群聊上下文）。加一个"关系档位标签"就要改好几处，
// 改漏一处她看到的材料就不一致 —— 这正是"同一件事写在多处"的老毛病。
//
// 档位标签的取舍（2026-10-12 主人定）：**只给非默认档加**（讨厌 / 好朋友 / 家人），
// 路人和熟人不加 —— 每行都挂档位既费 token 又吵，而这三种才是真正会影响她语气的。
export const TAG_TIERS = new Set(['讨厌', '好朋友', '家人']);

/** 这个 QQ 在当前关系下要不要在名字后面挂标签；不需要就返回 ''。 */
export function relationTagOf(people, userId) {
  const id = String(userId ?? '').trim();
  if (!id) return '';
  const rel = String(people?.[id]?.relation ?? '').trim();
  return TAG_TIERS.has(rel) ? rel : '';
}

/**
 * 渲染一行消息。
 * @param {{sender?:string, text?:string, isOwner?:boolean, isSelf?:boolean}} m
 * @param {object} [opts]
 * @param {string} [opts.mediaHint] 媒体提示（domains/media.js 提供）
 * @param {string} [opts.tag] 关系档位标签（relationTagOf 算，空串=不挂）
 * @param {string} [opts.clock] 时刻前缀（如 `10-12 00:11`；assembler 的材料带，旧格式不带）
 * @param {string} [opts.selfLabel] 她自己发言时的称呼（assembler 里写"你"）
 * @param {string} [opts.text] 覆盖正文（assembler 用 plain 优先于 text）
 */
export function renderMessageLine(m, { mediaHint = '', tag = '', clock = '', selfLabel = '你', text } = {}) {
  const owner = m?.isOwner ? '【管理员】' : '';
  const name = m?.isSelf ? selfLabel : (m?.sender ?? '?');
  const suffix = tag ? `（${tag}）` : '';
  // 正文优先用 plain（不带引用/CQ 码的干净文本），没有才退回 text ——
  // 内置这个优先级，省得每个调用方各写一遍、漏一个就漏出 CQ 码。
  const body = text !== undefined ? text : (m?.plain ?? m?.text ?? '');
  return `${clock ? `[${clock}] ` : ''}${owner}${name}${suffix}：${body}${mediaHint}`;
}
