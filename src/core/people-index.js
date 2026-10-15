// 人物身份索引：**按 QQ 认人**（跨群同一个人）。
//
// 为什么是 QQ（用户要求 + 数据事实）：
//   · 群名片会变（三水在 A 群叫「群友甲，🌿私你们这群烧货」，在 B 群叫「杨森」），QQ 不变；
//   · 每条消息都带 userId（实测 118/118、42/42），所以"名字 ↔ QQ"能可靠建立，不用猜。
//
// 设计边界（防屎山）：
//   · 这是**派生索引**，不是第二份记忆：事实（印象/话题）仍然只存在各会话的记忆文件里；
//   · 纯函数：输入各会话的状态，输出"谁在哪个会话叫什么"；
//   · 只做三件事：建索引、查别名、生成"他在别的群叫 X"的提示行。
import { personShortName } from './person-name.js';

/**
 * 从各会话的 recentMessages（sender + userId）建索引。
 * @param {Array<{key:string, recentMessages?:Array}>} conversations
 * @returns {{ [qq: string]: { names: { [convKey: string]: string }, lastSeenAt: number } }}
 */
export function buildPeopleIndex(conversations = []) {
  const index = {};
  for (const conv of Array.isArray(conversations) ? conversations : []) {
    const key = String(conv?.key ?? '');
    if (!key) continue;
    // 只用**群**里的名字当别名：私聊里的 sender 是"私聊/对方"这种占位标签，不是名字，
    // 拿它当别名会写出「他在私聊叫「私聊」」这种废话。
    if (!key.startsWith('group:')) continue;
    for (const m of Array.isArray(conv?.recentMessages) ? conv.recentMessages : []) {
      if (!m || m.isSelf) continue;
      const qq = String(m.userId ?? m.user_id ?? '').trim();
      const name = String(m.sender ?? '').trim();
      if (!qq || !name) continue;
      const rec = index[qq] ?? { names: {}, lastSeenAt: 0 };
      rec.names[key] = name;                       // 同一会话里以**最新**的名字为准
      rec.lastSeenAt = Math.max(rec.lastSeenAt, Number(m.time) || 0);
      index[qq] = rec;
    }
  }
  return index;
}

/** 这个 QQ 在**别的**会话里叫什么（可能多个）。 */
export function otherNames(index, qq, exceptKey) {
  const rec = index?.[String(qq ?? '')];
  if (!rec) return [];
  return Object.entries(rec.names)
    .filter(([k, n]) => k !== exceptKey && n)
    .map(([k, n]) => ({ key: k, name: n }));
}

/**
 * 生成"同一个人跨群"的提示行：本会话里说话的人，如果在别的会话还有别的名字。
 * @param {object} p
 * @param {object} p.index buildPeopleIndex 的产物
 * @param {string} p.convKey 当前会话
 * @param {Array<{userId?:string,user_id?:string,sender?:string}>} p.speakers 本会话最近说话的人
 * @param {number} [p.max=3]
 * @returns {string[]}
 */
export function crossGroupAliasLines({ index, convKey, speakers = [], max = 3 } = {}) {
  const seen = new Set();
  const lines = [];
  for (const s of Array.isArray(speakers) ? speakers : []) {
    const qq = String(s?.userId ?? s?.user_id ?? '').trim();
    if (!qq || seen.has(qq)) continue;
    seen.add(qq);
    const others = otherNames(index, qq, convKey);
    if (!others.length) continue;
    const here = personShortName(String(s?.sender ?? '')) || String(s?.sender ?? qq);
    // ⚠️ **不写别的群号**（用户 2026-10-02 的规矩）：不同群的人未必知道对方群存在，
    // 她也只该知道"这是同一个人的另一个名字"，不该知道"她还待在哪些群"。
    // 曾经这里写成「在群 20000001 叫…」——等于把群号印在她材料里，一顺嘴就漏出去。
    const where = others.some((o) => String(o.key).startsWith('group:')) ? '别的群' : '私聊';
    const names = others.map((o) => `「${o.name}」`).join('、');
    lines.push(`- ${here}（QQ ${qq}）在${where}叫${names}——**是同一个人**，别当成两个人；别提是哪个群`);
    if (lines.length >= max) break;
  }
  return lines;
}
