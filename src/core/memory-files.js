// 记忆的**分文件存储**：每个会话一个文件（群 A 的事和群 B 的事不在同一个文件里）。
//
// 为什么拆（用户要求 + 真实需求）：
//   · 她要"记得不同群发生的事"，但**不能把不同群的记忆混淆**；
//   · 原来 4 个会话的记忆全挤在 state/social-v2.json 里（282KB），读写是一次全量序列化；
//   · 拆开之后：群 A 的记忆损坏/写坏不会波及群 B，单文件也小得多。
//
// 边界（防屎山）：
//   · 这里**只管文件读写与字段裁剪**，不认识"印象/话题"的语义（那在 core/memory.js）；
//   · 运行时状态（unread / wakeConfig / 令牌 / 水位线）**仍然留在 social-v2.json**——
//     定时器、限流、控制台都依赖它，不动它，爆炸半径最小；
//   · 字段表和上限只有一份（MEMORY_FIELDS），addMemory 与读盘共用。
import path from 'node:path';

/** 记忆字段（落在会话记忆文件里的三样）。上限与 social-state 的字段表保持一致。 */
export const MEMORY_FIELDS = [
  ['activeTopics', { cap: 20 }],
  ['pendingThoughts', { cap: 20 }],
  ['memberImpressions', { obj: true }]
];

/** 会话 key → 记忆文件名：group:20000001 → group-20000001.json（只接受规范 key）。 */
export function memoryFileName(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return '';
  return `${m[1]}-${m[2]}.json`;
}

/** 记忆文件路径（目录由调用方保证存在）。 */
export function memoryFilePath(dir, key) {
  const name = memoryFileName(key);
  return name ? path.join(dir, name) : '';
}

/** 从会话状态里取出要落盘的记忆字段（按字段表裁剪）。 */
export function pickMemory(st) {
  const out = {};
  for (const [field, spec] of MEMORY_FIELDS) {
    const v = st?.[field];
    if (spec?.cap) out[field] = Array.isArray(v) ? v.slice(-spec.cap) : [];
    else if (spec?.obj) out[field] = v && typeof v === 'object' ? v : {};
    else out[field] = v;
  }
  return out;
}

/** 把读到的记忆字段塞回会话状态（缺失的给空值，保证形状稳定）。 */
export function applyMemory(st, data) {
  if (!st) return st;
  for (const [field, spec] of MEMORY_FIELDS) {
    const v = data?.[field];
    if (spec?.cap) st[field] = Array.isArray(v) ? v.slice(-spec.cap) : [];
    else if (spec?.obj) st[field] = v && typeof v === 'object' ? v : {};
    else st[field] = v;
  }
  return st;
}

/** 这个会话的记忆是不是空的（不用写盘/不用建文件）。 */
export function isMemoryEmpty(st) {
  const topics = Array.isArray(st?.activeTopics) ? st.activeTopics.length : 0;
  const thoughts = Array.isArray(st?.pendingThoughts) ? st.pendingThoughts.length : 0;
  const people = st?.memberImpressions && typeof st.memberImpressions === 'object' ? Object.keys(st.memberImpressions).length : 0;
  return topics + thoughts + people === 0;
}
