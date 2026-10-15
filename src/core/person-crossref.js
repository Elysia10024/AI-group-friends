// 跨会话人物补充：本会话里提到的人，如果在**别的会话**里记过印象，就补一小块给她。
//
// 为什么需要（2026-10-02 实测）：三水在私聊里提"群友乙"，她回**「群友乙又是谁啊」**——
// 因为人物印象是**按会话存**的，群里那 15 个人的印象在私聊里完全不可见，看起来像"连朋友都不认识"。
//
// 设计取舍（防屎山）：
//   · 纯函数、只读；不改记忆结构、不新增存储 —— 只是把"别处已经记过的"搬一行过来；
//   · 触发条件是"本会话的消息里真的出现了这个名字"（不是无脑全塞），最多 3 人 × 2 条；
//   · 命中用**短名**比对（person-name），避免长名片/别名漏配。

import { personShortName } from './person-name.js';

const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * @param {object} p
 * @param {string} p.text        本会话的可见文本（最近消息 + 未读，用来找"提到了谁"）
 * @param {Iterable<string>} p.ownNames  本会话**已有**印象的人（这些人不用补，材料里本来就有）
 * @param {Array<{key:string, memberImpressions?:object}>} p.others 其它会话
 * @param {number} [p.maxPeople=3]
 * @param {number} [p.maxTraits=2]
 * @returns {string[]} 每个元素是一行（不含标题）
 */
export function foreignPersonLines({ text, ownNames = [], others = [], maxPeople = 3, maxTraits = 2 } = {}) {
  const hay = String(text ?? '');
  if (!hay) return [];
  const own = new Set([...ownNames].map((n) => personShortName(n)).filter(Boolean));
  const picked = new Map(); // 短名 -> { name, traits }
  for (const conv of Array.isArray(others) ? others : []) {
    for (const [name, val] of Object.entries(conv?.memberImpressions ?? {})) {
      const short = personShortName(name) || name;
      if (!short || own.has(short)) continue;
      if (picked.has(short)) continue;
      if (!hay.includes(short)) continue; // 只有"本会话真的提到"才补
      const traits = (Array.isArray(val?.traits) ? val.traits : []).map(String).filter(Boolean);
      if (!traits.length) continue;
      picked.set(short, { name: short, traits });
      if (picked.size >= maxPeople) break;
    }
    if (picked.size >= maxPeople) break;
  }
  const out = [];
  for (const { name, traits } of picked.values()) {
    const rel = traits.find((t) => /^关系：/.test(t));
    const facts = traits.filter((t) => !/^关系：/.test(t)).slice(-maxTraits);
    const body = [rel, ...facts].filter(Boolean).map((t) => cut(t, 90)).join('；');
    out.push(`- ${name}（你在别的会话里记过他）：${body}`);
  }
  return out;
}
