// 跨会话记忆共享 · 纯逻辑：取条 + 代号脱敏（零 I/O，可单测）。
// 2026-10-29 主人要求：私聊/群聊记忆共享，但跨会话提到别人时不得出现真实 QQ/群号/昵称，用甲乙丙代号。
export const CODE_POOL = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛'];

/** QQ → 代号：自定义优先（小鲸鱼可决定），否则按稳定哈希落到代号池。 */
export function codeFor(qq, aliases = {}) {
  const id = String(qq ?? '').trim();
  if (!id) return '某群友';
  const custom = String(aliases?.[id] ?? '').trim();
  if (custom) return custom;
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CODE_POOL[h % CODE_POOL.length];
}

/** 全部已知昵称 → QQ（用于把名字换代号；长名优先避免部分匹配）。 */
export function knownNames(people) {
  const m = new Map();
  for (const [qq, rec] of Object.entries(people ?? {})) {
    for (const n of Object.values(rec?.names ?? {})) {
      const s = String(n ?? '').trim();
      if (s.length >= 2) m.set(s, String(qq));
    }
  }
  return m;
}

/** 脱敏：群/私聊 key、已知昵称、已知 QQ、兜底长数字 → 代号或占位。 */
export function redactText(text, { people = {}, aliases = {} } = {}) {
  let s = String(text ?? '');
  s = s.replace(/group:\d+/g, '某个群').replace(/private:\d+/g, '私聊');
  const names = [...knownNames(people).entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [name, qq] of names) {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    s = s.replace(re, () => codeFor(qq, aliases));
  }
  for (const qq of Object.keys(people ?? {})) s = s.split(qq).join(codeFor(qq, aliases));
  s = s.replace(/\b\d{5,12}\b/g, '[号码]');
  return s;
}

/**
 * 从别的会话里挑 2–4 条相关记忆（只读）。
 * 相关度：当前会话最近文本里出现的人/词；平手按新近。
 */
export function pickCrossEntries({ currentKey, snapshots = [], traits = [], people = {}, aliases = {}, max = 4, maxChars = 240, recentText = '' } = {}) {
  const words = new Set(String(recentText ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
  const hay = String(recentText ?? '').toLowerCase();
  const scored = [];
  for (const snap of Array.isArray(snapshots) ? snapshots : []) {
    if (!snap || !snap.key || snap.key === currentKey) continue;
    for (const t of Array.isArray(snap.activeTopics) ? snap.activeTopics : []) {
      const raw = String(t?.text ?? '').trim();
      if (raw.length < 4) continue;
      const low = raw.toLowerCase();
      let score = 0;
      for (const w of words) if (low.includes(w)) score += 2;
      const at = Number(t?.lastMentionAt) || 0;
      score += at / 1e13; // 新近只做微调，不压过相关度
      scored.push({ raw, at, score });
    }
  }
  // 跨会话"记忆条目"（memberImpressions.traits）：私聊里记下的喜好/要求也要能进群聊材料。
  // 只有"这个人在当前会话里出现"或关键词命中时才选，避免把无关隐私硬塞进来。
  for (const tr of Array.isArray(traits) ? traits : []) {
    const raw = String(tr?.text ?? '').trim();
    if (raw.length < 6) continue;
    let score = 0;
    const names = Object.values(people?.[tr?.qq]?.names ?? {}).map((n) => String(n ?? '')).filter((n) => n.length >= 2);
    if (names.some((n) => hay.includes(n.toLowerCase()))) score += 4;
    const low = raw.toLowerCase();
    for (const w of words) if (low.includes(w)) score += 2;
    if (!score) continue;
    const at = Number(tr?.at) || 0;
    score += at / 1e13;
    scored.push({ raw, at, score });
  }
  scored.sort((a, b) => b.score - a.score || b.at - a.at);
  const lines = [];
  let used = 0;
  for (const item of scored) {
    if (lines.length >= max) break;
    const text = redactText(item.raw, { people, aliases }).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!text) continue;
    if (used + text.length > maxChars) break;
    lines.push(text);
    used += text.length;
  }
  return lines;
}

/** 拼成材料块；没有内容返回空串。 */
export function formatCrossBlock(lines) {
  const list = (Array.isArray(lines) ? lines : []).filter(Boolean);
  if (!list.length) return '';
  return `【你在别处记得的事】（跨会话，已脱敏成代号）\n${list.map((l) => `- ${l}`).join('\n')}`;
}
