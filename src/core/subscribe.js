// 「订阅」的纯逻辑：解析指令参数 + 增删名单。
//
// 背景（2026-09-29 用户定的方向）：speakerIds 是她**正当的能力**，不删；
// 但要让管理员能通过私聊直接管（加/取消）。执行在 src/domains/admin-commands.js，
// 这里只做能离线单测的部分：参数怎么切、名单怎么改。
//
// 成本语义（写在这里当文档，别忘）：订阅一个人 = **他说任何话都唤醒她**。
// 老群实测：订阅 3 个人 → 占该群 36% 的唤醒量（≈¥1.5/天）。所以这是个"要管起来"的开关。

/** 名单上限：给她自己用留余地，但别无限挂（她自己的工具 schema 也是 20）。 */
export const SPEAKER_IDS_CAP = 20;

/**
 * 解析指令参数：`[群号] 目标`。
 * 第一个 token 是 6~12 位纯数字时当作群号；其余作为目标（QQ 号或昵称/名片）。
 * @returns {{ groupId: string, target: string }}
 */
export function parseSubscribeArg(raw) {
  const t = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!t) return { groupId: '', target: '' };
  const m = /^(\d{6,12})\s+(.+)$/.exec(t);
  if (m) return { groupId: m[1], target: m[2].trim() };
  return { groupId: '', target: t };
}

/** 目标像不像 QQ 号（纯数字，5~12 位）。 */
export function looksLikeQq(target) {
  return /^\d{5,12}$/.test(String(target ?? '').trim());
}

/** 加一个订阅（去重、保序、封顶）。返回新数组，不改原数组。 */
export function addSpeakerId(list, qq, cap = SPEAKER_IDS_CAP) {
  const id = String(qq ?? '').trim();
  if (!id) return [...(Array.isArray(list) ? list : [])];
  const cur = (Array.isArray(list) ? list : []).map(String);
  if (cur.includes(id)) return cur;
  return [...cur, id].slice(0, Math.max(1, cap));
}

/**
 * 去掉一个订阅；`qq` 传空/`all` 表示清空。
 * @returns {{ list: string[], removed: boolean }}
 */
export function removeSpeakerId(list, qq) {
  const cur = (Array.isArray(list) ? list : []).map(String);
  const want = String(qq ?? '').trim();
  if (!want || want === 'all' || want === '全部' || want === '清空') {
    return { list: [], removed: cur.length > 0 };
  }
  const next = cur.filter((x) => x !== want);
  return { list: next, removed: next.length !== cur.length };
}
