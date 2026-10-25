// 「看过的视频」笔记：纯逻辑（清洗/去重/上限）。IO 在 domains/bili-scroll.js。
//
// 为什么要它（2026-10-25 用户定）：刷视频看到的东西只活在当轮上下文里，轮结束就没了。
// 把她看过的视频（标题/分区/简介/热评）落成结构化笔记，以后才能检索、回灌材料 ——
// 这是「不训练模型也能学」的第一步：先存下来，再决定怎么用。
//
// 注意：这里只存**客观内容摘要**（视频说了什么、评论区在聊什么）；她自己的看法仍然走
// qq_memory_append（activeTopic），两边分工，别混在一起。

export const BILI_NOTES_DEFAULTS = {
  maxNotes: 200,   // 长期保留最近 200 条
  maxDesc: 200,    // 简介截断
  maxComments: 3,  // 热评只记前 3 条
  maxComment: 120  // 每条热评截断
};

/**
 * 把一次观看整理成笔记条目。bv 不合法返回 null（宁可不记，不留垃圾）。
 * @param {{bv?:string,title?:string,tname?:string,owner?:string,duration?:number,desc?:string,comments?:Array,key?:string,at?:number}} input
 * @returns {object|null}
 */
export function makeNote(input) {
  const { bv, title, tname, owner, duration, desc, comments, key, at } = input ?? {};
  const b = String(bv ?? '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(b)) return null;
  const list = (Array.isArray(comments) ? comments : [])
    .map((c) => ({
      like: Math.max(0, Number(c?.like) || 0),
      text: String(c?.content ?? c?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, BILI_NOTES_DEFAULTS.maxComment)
    }))
    .filter((c) => c.text)
    .sort((a, b) => b.like - a.like)   // 不依赖上游顺序：笔记里的热评按赞数降序
    .slice(0, BILI_NOTES_DEFAULTS.maxComments);
  return {
    bv: b,
    title: String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    tname: String(tname ?? '').trim().slice(0, 20),
    owner: String(owner ?? '').trim().slice(0, 40),
    duration: Math.max(0, Number(duration) || 0),
    desc: String(desc ?? '').replace(/\s+/g, ' ').trim().slice(0, BILI_NOTES_DEFAULTS.maxDesc),
    comments: list,
    key: String(key ?? '').trim().slice(0, 40),
    at: Number(at) || Date.now()
  };
}

/**
 * 追加笔记：同一个 bv 只留一条（新记录覆盖旧的），超出上限留最近的。
 * @param {Array} notes
 * @param {object} note
 * @param {number} [max]
 * @returns {Array}
 */
export function appendNote(notes, note, max = BILI_NOTES_DEFAULTS.maxNotes) {
  if (!note || !note.bv) return Array.isArray(notes) ? notes : [];
  const list = (Array.isArray(notes) ? notes : []).filter((n) => n && String(n.bv ?? '') !== note.bv);
  list.push(note);
  return list.slice(-Math.max(1, Number(max) || BILI_NOTES_DEFAULTS.maxNotes));
}
