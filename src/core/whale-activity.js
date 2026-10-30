// 「她的活动」公共日志 · 纯逻辑（零 I/O，可单测）。
// 2026-10-30 主人要求：她自己的行为（刷视频/发图/分享/说话）要存在公共文件里，跨会话可见；
// 换群/私聊不能"失忆"。条目只记"群里/私聊"，不记 QQ、群号；文本写入材料前做代号脱敏。
export const ACTIVITY_MAX = 200;
const TEXT_MAX = 80;

/** 规范化一条活动：kind=message|video|image|voice|share|post；where=group|private。 */
export function makeEntry({ kind = 'message', text = '', key = '', at = Date.now(), meta = {} } = {}) {
  const where = String(key).startsWith('group:') ? 'group' : String(key).startsWith('private:') ? 'private' : '';
  return {
    kind: String(kind),
    where,
    text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX),
    at: Number(at) || Date.now(),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
}

/** 追加并裁剪（保留最近 max 条）；同一秒内同文本去重（防止同一条被记两遍）。 */
export function appendEntry(entries, entry, { max = ACTIVITY_MAX } = {}) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  if (!entry || !entry.text) return list;
  const dup = list.some((e) => e && e.text === entry.text && Math.abs(Number(e.at) - Number(entry.at)) < 2000);
  if (!dup) list.push(entry);
  return list.slice(-Math.max(1, Number(max) || ACTIVITY_MAX));
}

/** 材料块：最近 N 条，按时间正序（旧→新），标"群里/私聊"；不写群号/QQ。 */
export function formatActivityBlock(entries, { limit = 5, now = Date.now() } = {}) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.text)
    .slice(-Math.max(1, Math.min(20, Number(limit) || 5)));
  if (!list.length) return '';
  const lines = list.map((e) => {
    const d = new Date(Number(e.at) || now);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const where = e.where === 'group' ? '群里' : e.where === 'private' ? '私聊里' : '';
    return `- ${hh}:${mm} ${where}：${e.text}`;
  });
  return `【你最近做过的事】（跨会话，你自己做过/发过的）\n${lines.join('\n')}`;
}
