// 人物短名归一：记忆 key 与"名单"里只用短名，长名片的后缀/梗不算名字的一部分。
//
// 为什么要有它（2026-10-02 真实事故）：她在群里被问"群友乙和来来是一个人吗"，
// 答成"一个人，他名字里本来就带'来来'"——因为记忆 key 是**完整群名片**
// 「群友丁（！？来来？！）」，"来来"和"酸橙"同屏出现，没有任何一行说明
// 前者只是名片里的一部分，于是她把"来来"当成了群友乙的名字。
//
// 规则（保守，只砍明显的装饰）：
//   · 去掉**末尾**的括号补充：群友丁（！？来来？！） → 群友丁
//   · 去掉**第一个逗号之后**的内容：群友壬，至丑，至绷的化身 → 群友壬
//   · 两样都做，最后 trim；砍完太短（<2 字）就退回原名，别把名字砍没了
// 不做模糊匹配、不做拼音/相似度——那会制造新的"我以为他是谁"。

/** 取一个人的短名（用于记忆 key 与名单展示）。 */
export function personShortName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  let s = raw;
  // 1) 砍末尾的括号补充（中文/英文括号都算；可以连着砍）
  for (let i = 0; i < 3; i += 1) {
    const next = s.replace(/[（(][^（()）]*[)）]\s*$/u, '').trim();
    if (next === s) break;
    s = next;
  }
  // 2) 砍第一个逗号之后的内容（「群友壬，至丑，至绷的化身」→「群友壬」）
  const comma = s.search(/[，,]/u);
  if (comma > 0) s = s.slice(0, comma).trim();
  if (s.length < 2) return raw;
  return s;
}

/**
 * 在已有 key 里找"这个人"：短名相同即同一个；完全包含也算（避免同一人开两个 key）。
 * @returns {string|null} 命中的已有 key
 */
export function matchExistingKey(name, keys) {
  const short = personShortName(name);
  if (!short) return null;
  const list = Array.isArray(keys) ? keys.map(String) : [];
  for (const k of list) {
    if (k === name) return k;
  }
  for (const k of list) {
    if (personShortName(k) === short) return k;
  }
  for (const k of list) {
    if (short.length >= 2 && (k.includes(short) || short.includes(k))) return k;
  }
  return null;
}
