// 跨会话回忆：她**按需**去查"别的群发生过什么 / 某件事是什么时候的"。
//
// 需求（主人原话）：不同群的事不混淆，但要记得住 —— "我在 A 群说过的话，在 B 群问他能答出来"。
// 2026-10-12 追加（主人定）：记忆条目自带时间（印象看 traitMeta、话题看 lastMentionAt），
// **平时一个字的渲染都不加（省 token），被追问时才把时间带出来** —— 所以这里负责按人/按时间检索。
//
// 纯函数：输入"各会话的记忆对象"，输出若干行文本，方便单测与复用（路由只负责读文件）。
import { personShortName } from './person-name.js';

const cut = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 绝对时间（月-日）。**不写"3 天前"这种相对说法**：它每次算出来都不一样，事后也没法核对。 */
const fmtDay = (ms) => {
  const d = new Date(Number(ms));
  return `${d.getMonth() + 1}-${d.getDate()}`;
};

/** 会话 key → 给她看的名字（群里写"群 20000001"，私聊写"私聊 10000001"）。 */
export function convLabel(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? ''));
  if (!m) return String(key ?? '');
  return m[1] === 'group' ? `群 ${m[2]}` : `私聊 ${m[2]}`;
}

/**
 * 解析"从什么时候起"：`7d` / `12h` / `30m` / `3天` / `2小时` / 日期或 ISO 字符串。
 * 认不出就返回 0（= 不过滤）：宁可多给几条，也别因为一个写错的参数把记忆全滤掉。
 */
export function parseSinceMs(value, now = Date.now()) {
  const s = String(value ?? '').trim();
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m|天|小时|分钟)$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    const span = (u === 'd' || u === '天') ? 86400000 : (u === 'h' || u === '小时') ? 3600000 : 60000;
    return Math.max(0, now - n * span);
  }
  // 纯日期（2026-10-01）按**本地时间**当天零点算：她说的"10 月 1 号"是本地那天，
  // 不能按 ISO 的 UTC 午夜解析（那会差 8 小时，把当天凌晨的事漏掉）。
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime();
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

/**
 * 在各个会话的记忆里搜。
 * @param {object} p
 * @param {Array<{key:string, memory:object}>} p.conversations 所有会话的记忆
 * @param {string} p.requesterKey 谁在问（用于隔离私聊，并跳过本会话——那部分材料里已经有了）
 * @param {string} [p.query] 关键词
 * @param {string} [p.person] 只看某位群友的印象
 * @param {number} [p.sinceMs] 只看这个时间点之后的条目（0 = 不限）
 * @param {number} [p.max=8]
 * @returns {string[]} 每行一条，形如 `- [10-12] 在 群 20000001（对UserQ的）：他骂过我`
 */
export function recallAcrossConversations({ conversations = [], requesterKey = '', query = '', person = '', sinceMs = 0, max = 8 } = {}) {
  const q = String(query ?? '').trim();
  const who = String(person ?? '').trim();
  const hits = [];
  for (const conv of Array.isArray(conversations) ? conversations : []) {
    const key = String(conv?.key ?? '');
    if (!key) continue;
    // 私聊隔离：私聊的内容只在**它自己**被问到时能查（群里查不到别人的私聊）。
    if (key.startsWith('private:') && key !== requesterKey) continue;
    if (key === requesterKey) continue;   // 本会话的内容材料里已经有了，别重复列
    const mem = conv?.memory ?? {};
    for (const [name, v] of Object.entries(mem.memberImpressions ?? {})) {
      const traits = Array.isArray(v?.traits) ? v.traits : [];
      // 时间与 traits 同索引；两个数组对不上就当作没有时间（宁可没时间，也别给错位的时间）
      const meta = Array.isArray(v?.traitMeta) && v.traitMeta.length === traits.length ? v.traitMeta : [];
      const short = personShortName(name) || name;
      for (let i = 0; i < traits.length; i += 1) {
        hits.push({ key, kind: `对${short}的`, text: String(traits[i] ?? ''), at: Number(meta[i]?.lastAt) || 0, person: short });
      }
    }
    for (const t of Array.isArray(mem.activeTopics) ? mem.activeTopics : []) {
      hits.push({ key, kind: '话题', text: String(t?.text ?? ''), at: Number(t?.lastMentionAt) || 0, person: '' });
    }
    for (const t of Array.isArray(mem.pendingThoughts) ? mem.pendingThoughts : []) {
      hits.push({ key, kind: '想法', text: String(t?.text ?? ''), at: Number(t?.createdAt) || 0, person: '' });
    }
  }
  let out = hits.filter((h) => h.text);
  if (q) out = out.filter((h) => h.text.includes(q));
  if (who) out = out.filter((h) => h.person && (h.person.includes(who) || who.includes(h.person)));
  // 按时间查的时候，**没有时间的条目不出场**：不给假时间，也不拿 0 当"很久以前"。
  if (sinceMs > 0) out = out.filter((h) => h.at > 0 && h.at >= sinceMs);
  out.sort((a, b) => (b.at || 0) - (a.at || 0));   // 最近提过的排前面
  return out.slice(0, Math.max(1, max)).map((h) => `- ${h.at ? `[${fmtDay(h.at)}] ` : ''}在 ${convLabel(h.key)}（${h.kind}）：${cut(h.text, 120)}`);
}
