// 记忆的读（渲染进 prompt）与写（追加条目）—— 纯逻辑，零 I/O。
//
// 从 bridge.js 的 main() 闭包里抽出来（R1' 第 3 步）。抽它的理由最充分：
// 这块**已经栽过三次坑**，而且三次都是"静默写错"：
//   ① memberImpression 用 traits.slice(0, 10) 取的是**最旧**的 10 条，
//      超过 10 条之后新写的观察永远存不进去；
//   ② 观察截断到 50 字，把她写的一半内容砍掉；
//   ③ 渲染时 Object.keys().slice(-10) 按"写入顺序"取最后 10 位群友，
//      存了 50 位也只有 10 位能看到。
// 抽出来配单测之后，这三类错误会在 npm test 阶段就被抓住，不用等群里表现出来。
//
// 时钟与脱敏都由调用方注入：
//   - now：一次调用内只取一次时间戳（原实现多次调 Date.now()，毫秒级不可感知差异）
//   - redact：入库前必须脱敏 agent token。**缺失就抛错**，宁可炸也不要静默把 token
//     写进 social-v2.json 再被注入到 prompt 里。
import { matchExistingKey, personShortName } from './person-name.js';
import { relativeDayLabel } from './local-day.js';

/** 把配置值夹到合法区间；非法/缺失时用默认值（与原实现 `Number(x) || d` 语义一致）。 */
function clampInt(value, lo, hi, dflt) {
  return Math.max(lo, Math.min(hi, Number(value) || dflt));
}

/**
 * 把记忆渲染成注入 prompt 的文本块。
 * @param {object} st 二代社交状态
 * @param {object} [opts]
 * @param {number} [opts.now] 当前毫秒时间戳（默认 Date.now()）
 * @param {number} [opts.memoryMaxMembers] 最多展开多少位群友（默认 24，夹在 1..60）
 * @param {number} [opts.memoryMaxTraits] 每人最多几条印象（默认 3，夹在 1..20）
 * @param {number} [opts.memoryTraitChars] 每条印象截断长度（默认 170，夹在 40..300）
 * @returns {string} 空串表示无可渲染内容
 */
export function formatMemory(st, opts = {}) {
  if (!st) return '';
  const now = opts.now != null ? Number(opts.now) : Date.now();
  const lines = [];

  const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
  if (topics.length) {
    lines.push('【进行中的话题】');
    // 按**最近被提及**排序，不是按写入位置：命中已有话题时只更新 lastMentionAt、不挪数组位置，
    // 所以 slice(-10) 拿到的是"最早写入的 10 条"，而她真正在聊的可能全被挤掉（2026-09-30 修）。
    const fresh = [...topics].sort((a, b) => Number(b.lastMentionAt || 0) - Number(a.lastMentionAt || 0)).slice(0, 10);
    for (const t of fresh) {
      const ago = t.lastMentionAt ? Math.round((now - t.lastMentionAt) / 60000) : 0;
      const stale = t.lastMentionAt && now - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
      const text = String(t.text).replace(/（已搁置）/g, '').trim();
      lines.push(`- ${text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
    }
  }

  const thoughts = Array.isArray(st.pendingThoughts)
    ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || now < t.expiresAt))
    : [];
  if (thoughts.length) {
    lines.push('【你想说但还没说的】');
    for (const t of thoughts.slice(-10)) {
      lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
    }
  }

  const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  // 按 lastSeenAt（最近互动）排序展开，而不是按写入顺序取最后 N 个 ——
  // 否则存了 50 位群友也只有 10 位能看到，第 11 位之后等于白记。
  const impEntries = Object.entries(impressions)
    .filter(([, im]) => im && typeof im === 'object')
    .sort((a, b) => (Number(b[1].lastSeenAt) || 0) - (Number(a[1].lastSeenAt) || 0));
  if (impEntries.length) {
    const memMaxMembers = clampInt(opts.memoryMaxMembers, 1, 60, 24);
    const memMaxTraits = clampInt(opts.memoryMaxTraits, 1, 20, 3);
    const memTraitChars = clampInt(opts.memoryTraitChars, 40, 300, 170);
    lines.push('【对群友的印象】（只列最近互动的，记新的会挤掉旧的）');
    for (const [name, im] of impEntries.slice(0, memMaxMembers)) {
      const rawTraits = Array.isArray(im.traits) ? im.traits : [];
      const rawMeta = Array.isArray(im.traitMeta) ? im.traitMeta : [];
      // 时间戳与 traits **同索引**（由 mergeTraitWithMeta 维护）。长度不一致说明中间被动过
      // （比如整体替换过 traits），这时**整条印象都不标时间** —— 写入侧就是这个 fail-safe
      // （宁可没时间，也不给错位的时间），渲染侧必须用同一条判据：把别人的日子贴到这条印象后面，
      // 比不显示更糟 —— 她会照着错的日子去接话（"你昨天不是说过…"）。
      const metaOk = rawMeta.length === rawTraits.length;
      // 时间只显示"多久以前"（今天/昨天不标，见 relativeDayLabel）：这块是组装器的稳定前缀块，
      // 标了就得每天变一次，所以只在真的看得出年头时才值这几个 token。
      const from = Math.max(0, rawTraits.length - memMaxTraits);
      const traits = rawTraits.slice(from).map((t, k) => {
        const s = String(t ?? '');
        const clipped = s.length > memTraitChars ? s.slice(0, memTraitChars) + '…' : s;
        const ago = metaOk ? relativeDayLabel(rawMeta[from + k]?.lastAt, now) : '';
        return ago ? `${clipped}（${ago}）` : clipped;
      });
      lines.push(`- ${name}：${traits.length ? traits.join('；') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
    }
    if (impEntries.length > memMaxMembers) {
      lines.push(`（还有 ${impEntries.length - memMaxMembers} 位群友的印象没展开）`);
    }
  }

  return lines.join('\n');
}

/**
 * 归一化一条印象：去掉标点/空白/表情装饰，只留实质字符，用于"是不是同一件事"的比较。
 * 不用于存储，只用于比较。
 */
export function normalizeTrait(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''（）()【】\[\]…—～~·,.!?;:'"`-]/g, '');
}

/**
 * 两条印象的相似度 0..1（**包含度**口径：共有 bigram / 较短那条的 bigram 数）。
 *
 * 为什么不用 Dice：中文改写会被长度稀释。用真实语料标过（2026-09-20）：
 *   同一件事的 4 种说法两两：Dice 0.17~0.35，包含度 0.195~0.378；
 *   不相干的几对（不同人/不同事）：两者都是 0.000。
 * 所以取包含度 + 阈值 0.28（见 TRAIT_DUPLICATE_THRESHOLD 的说明）。
 */
export function traitSimilarity(a, b) {
  const A = normalizeTrait(a);
  const B = normalizeTrait(b);
  if (!A || !B) return 0;
  if (A === B || A.includes(B) || B.includes(A)) return 1;
  const ga = gramCounts(A);
  const gb = gramCounts(B);
  const shared = sharedGrams(ga, gb);
  const shorter = Math.min(A.length, B.length) - 1;
  return shorter > 0 ? shared / shorter : 0;
}

/** 字符 bigram 计数。 */
function gramCounts(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** 两条字符串共有的 bigram 数（按重复次数取较小值）。 */
function sharedGrams(ga, gb) {
  let n = 0;
  for (const [g, c] of ga) n += Math.min(c, gb.get(g) || 0);
  return n;
}

/**
 * 相似度到这个程度就算"同一条观察的新说法"。
 * 标定依据：真实重复对最低 0.195、不相干对 0.000；取 0.28 是为了让"同一件反复发生的事"
 * 在多次追加中**收敛**（每条新的只需要和保留下来的那条对上），而不是靠单点相似度。
 */
export const TRAIT_DUPLICATE_THRESHOLD = 0.28;
/** 短印象（少于这么多字）要更像才算同一条：短句之间偶然撞词的概率高得多。 */
export const TRAIT_SHORT_CHARS = 14;
/** 短印象的相似度门槛。 */
export const TRAIT_SHORT_THRESHOLD = 0.5;
/** 共有的 bigram 少于这么多就不算重复（防"两个短词恰好共享几个字"）。 */
export const TRAIT_MIN_SHARED_GRAMS = 6;
/** 每条群友印象最多保留几条（与渲染的 memoryMaxTraits 上限同量级）。 */
export const TRAIT_CAP = 20;

/** 这两条印象是不是"同一件事"。 */
export function isSameTrait(a, b) {
  const A = normalizeTrait(a);
  const B = normalizeTrait(b);
  if (!A || !B) return false;
  if (A === B || A.includes(B) || B.includes(A)) return true;
  const shorterChars = Math.min(A.length, B.length);
  const isShort = shorterChars < TRAIT_SHORT_CHARS;
  const shared = sharedGrams(gramCounts(A), gramCounts(B));
  // 长印象要求绝对共有量够多（防"凑巧共享几个字"）；短印象交给下面更严的**相对**阈值管，
  // 否则「他爱吃辣。」这种短句永远够不到 6 个 bigram，就永远合不进长句里。
  if (!isShort && shared < TRAIT_MIN_SHARED_GRAMS) return false;
  const gramsOfShorter = shorterChars - 1;
  if (gramsOfShorter <= 0) return false;
  return shared / gramsOfShorter >= (isShort ? TRAIT_SHORT_THRESHOLD : TRAIT_DUPLICATE_THRESHOLD);
}

/**
 * 把一条新印象并进已有列表：**太像就合并**（保留信息更多的那句、并挪到最新），否则追加。
 * 返回新数组，不改入参。
 *
 * @param {string[]} traits 旧印象（旧 → 新）
 * @param {string} text 新印象
 * @returns {string[]}
 */
export function mergeTrait(traits, text, { cap = TRAIT_CAP } = {}) {
  const list = (Array.isArray(traits) ? traits : []).map((t) => String(t ?? '')).filter(Boolean);
  const fresh = String(text ?? '').trim();
  if (!fresh) return list;

  // 【事实卡槽位】"【作息】他早七上课"这类带槽位前缀的条目 = 这个人在这方面的**当前状态**，
  // 同槽位**覆盖**而不是追加（人不会同时有两个作息、两个雷点）。
  // 为什么要有这条：以前一律追加，同一个意思会被写十几遍（实测某人 20 条里三件事重复了 20 遍），
  // 既挤占预算又让"重复"变成结构性问题。槽位让"同一件事只有一条"成为默认结果。
  const slotOf = (s) => {
    const m = /^【([^】]{1,6})】/.exec(String(s).trim());
    return m ? m[1] : '';
  };
  const freshSlot = slotOf(fresh);
  if (freshSlot) {
    const idxs = [];
    for (let i = 0; i < list.length; i += 1) if (slotOf(list[i]) === freshSlot) idxs.push(i);
    if (idxs.length) {
      // 同槽位：删掉旧的全部，写新的，并挪到末尾（末尾 = 最新）
      for (let i = idxs.length - 1; i >= 0; i -= 1) list.splice(idxs[i], 1);
      list.push(fresh);
      return list.length > cap ? list.slice(-cap) : list;
    }
  }

  let bestIdx = -1;
  for (let i = 0; i < list.length; i++) {
    if (isSameTrait(list[i], fresh)) {
      bestIdx = i;
      break;
    }
  }
  if (bestIdx >= 0) {
    const old = list[bestIdx];
    list.splice(bestIdx, 1);
    // 更长的旧描述往往信息更多（比如带上了"我回过什么"）；但更新版代表当前状态。
    // 取更长的那句，并统一挪到末尾（末尾 = 最新，渲染优先取末尾）。
    list.push(old.length > fresh.length * 1.3 ? old : fresh);
  } else {
    list.push(fresh);
  }
  return list.length > cap ? list.slice(-cap) : list;
}

/**
 * `mergeTrait` 的带时间版本：一边合并，一边维护**与 traits 同索引**的 traitMeta。
 *
 * 为什么旁挂一个数组，而不是把 traits 改成 `{t, at}` 对象：
 * traits 是纯字符串数组 —— 渲染（formatMemory）、跨会话回忆（memory-recall）、人物交叉引用
 * （person-crossref）、控制台前端、一堆单测，全都按字符串在用。改结构 = 十几处一起动，
 * 那正是"屎山"的来源；旁挂一份 meta，旧代码一行都不用改。
 *
 * 语义（2026-10-12 主人定：**只存不渲染**，时间只在被追问时查）：
 *   · 同一件事反复提 → `firstAt` 保留最早、`lastAt` 更新到这次、`hits` 累加，
 *     于是"这事什么时候开始的"和"最近一次提是什么时候"都答得出；
 *   · 槽位（`【作息】…`）表示"当前状态"而不是历史事件 → 覆盖时时间就是这次；
 *   · meta 与 traits **长度不一致就整体丢弃**（fail-safe）：宁可没时间，也不给错位的时间。
 *
 * @returns {{traits: string[], traitMeta: Array<{firstAt:number,lastAt:number,hits:number}>}}
 */
export function mergeTraitWithMeta(traits, traitMeta, text, { cap = TRAIT_CAP, now = Date.now() } = {}) {
  const rawList = Array.isArray(traits) ? traits : [];
  const rawMeta = Array.isArray(traitMeta) ? traitMeta : [];
  // 两个数组长度不一致 = 中间可能被动过（例如 memory-update 整体替换过 traits）→ **整体丢弃时间**。
  // 宁可"没时间"，也不给错位的时间：错的时间比没有时间更糟。
  const aligned = rawMeta.length === rawList.length ? rawMeta : [];
  const pairs = [];
  for (let i = 0; i < rawList.length; i += 1) {
    const t = String(rawList[i] ?? '').trim();
    if (!t) continue;                       // 空条目跳过；meta 仍按**原始索引**取，不影响别人
    const m = aligned[i];
    pairs.push({ t, m: m && typeof m === 'object' ? m : null });
  }
  const empty = { firstAt: 0, lastAt: 0, hits: 0 };
  const pack = (arr) => {
    const t = arr.map((p) => p.t);
    const m = arr.map((p) => p.m ?? empty);
    return { traits: t.length > cap ? t.slice(-cap) : t, traitMeta: m.length > cap ? m.slice(-cap) : m };
  };
  const fresh = String(text ?? '').trim();
  if (!fresh) return pack(pairs);

  /** 命中已有条目时的 meta：保留最早的 firstAt，更新 lastAt，hits 累加。 */
  const touched = (old) => ({
    firstAt: Number(old?.firstAt) || now,
    lastAt: now,
    hits: (Number(old?.hits) || 0) + 1
  });
  const slotOf = (s) => {
    const m = /^【([^】]{1,6})】/.exec(String(s).trim());
    return m ? m[1] : '';
  };

  // ① 槽位：同槽位覆盖（人不会同时有两个作息、两个雷点）→ 时间就是这次
  const freshSlot = slotOf(fresh);
  if (freshSlot) {
    const kept = pairs.filter((p) => slotOf(p.t) !== freshSlot);
    kept.push({ t: fresh, m: { firstAt: now, lastAt: now, hits: 1 } });
    return pack(kept);
  }

  // ② 近似重复：合并成一条（保留信息更多的那句，与 mergeTrait 同口径），并挪到末尾
  let hitIdx = -1;
  for (let i = 0; i < pairs.length; i += 1) {
    if (isSameTrait(pairs[i].t, fresh)) { hitIdx = i; break; }
  }
  if (hitIdx >= 0) {
    const oldText = pairs[hitIdx].t;
    const oldMeta = pairs[hitIdx].m;
    const keptText = oldText.length > fresh.length * 1.3 ? oldText : fresh;
    const rest = pairs.filter((_, i) => i !== hitIdx);
    rest.push({ t: keptText, m: touched(oldMeta) });
    return pack(rest);
  }

  // ③ 新信息：追加
  pairs.push({ t: fresh, m: { firstAt: now, lastAt: now, hits: 1 } });
  return pack(pairs);
}

/**
 * 追加一条记忆。**就地修改 st**（与原实现一致），返回"是否需要落盘"。
 *
 * @param {object} st 二代社交状态（会被就地修改）
 * @param {object} args
 * @param {'activeTopic'|'pendingThought'|'memberImpression'} args.category
 * @param {string} args.content
 * @param {object} [args.extra] memberImpression 用 target；topic/thought 用 participants/pendingQuestion/motivation/expiresAtMs
 * @param {number} [args.now] 当前毫秒时间戳（默认 Date.now()）
 * @param {(s: string) => string} args.redact **必填**：入库前脱敏
 * @returns {boolean} true = 调用方应落盘；false = 无事发生（与原实现的提前 return 对齐）
 */
export function appendMemory(st, { category, content, extra = {}, now, redact } = {}) {
  if (typeof redact !== 'function') {
    throw new TypeError('appendMemory: 必须传入 redact 函数（记忆入库前要脱敏 agent token）');
  }
  if (!st) return false;

  const ts = now != null ? Number(now) : Date.now();
  const text = redact(String(content ?? '')).trim();
  const cat = String(category || '').trim();

  // 轻量清理：过期想法移除；超过 72h 未提起的话题移除（避免无限膨胀）。
  if (Array.isArray(st.pendingThoughts)) {
    st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || ts < Number(t.expiresAt)));
  }
  if (Array.isArray(st.activeTopics)) {
    // 24h 太短——群里隔天接着聊很常见，话题不该一天就蒸发。
    st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || ts - Number(t.lastMentionAt) < 72 * 60 * 60 * 1000));
  }

  if (cat === 'activeTopic' && text) {
    if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
    const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
    if (existing) {
      existing.lastMentionAt = ts;
      if (Array.isArray(extra.participants)) {
        const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redact(String(p)))]);
        existing.participants = [...set].slice(0, 10);
      }
      if (extra.pendingQuestion) existing.pendingQuestion = redact(String(extra.pendingQuestion)).slice(0, 200);
    } else {
      st.activeTopics.push({
        text: text.slice(0, 200),
        lastMentionAt: ts,
        participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redact(String(p))).slice(0, 10) : [],
        pendingQuestion: redact(String(extra.pendingQuestion || '')).slice(0, 200)
      });
    }
    if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
  } else if (cat === 'pendingThought' && text) {
    if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
    const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
    if (existing) {
      existing.createdAt = ts;
      existing.expiresAt = ts + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
      if (extra.motivation) existing.motivation = redact(String(extra.motivation)).slice(0, 120);
    } else {
      st.pendingThoughts.push({
        text: text.slice(0, 200),
        createdAt: ts,
        expiresAt: ts + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
        motivation: redact(String(extra.motivation || 'curiosity')).slice(0, 120)
      });
    }
    if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
  } else if (cat === 'memberImpression') {
    const rawTarget = String(extra.target || '').trim();
    if (!rawTarget || ['__proto__', 'constructor', 'prototype'].includes(rawTarget)) return false;
    if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
    // **名字归一**：key 用短名（长名片的后缀/梗不算名字的一部分），并且命中已有的人就不再开第二个 key。
    // 真实事故（2026-10-02）：key 是「群友丁（！？来来？！）」，她把"来来"当成了另一个人的名字，
    // 在群里把 群友乙 和 来来 答成同一个人。
    const existing = matchExistingKey(rawTarget, Object.keys(st.memberImpressions));
    const target = existing || personShortName(rawTarget) || rawTarget;
    const old = st.memberImpressions[target] || {};
    // 保留**最新**的 20 条，超限丢最旧的 —— 原实现 slice(0, 10) 保留最旧的 10 条，
    // 结果超过 10 条之后新写的观察永远存不进去。
    // 去重：不只是"完全相等"，近似重复（同一件事换个说法）也合并，见 mergeTrait。
    const merged = mergeTraitWithMeta(
      Array.isArray(old.traits) ? old.traits.slice(-TRAIT_CAP) : [],
      old.traitMeta,
      text.slice(0, 300),
      { cap: TRAIT_CAP, now: ts }
    );
    st.memberImpressions[target] = {
      traits: merged.traits,
      // 与 traits 同索引的时间（firstAt/lastAt/hits）。**只存不渲染** —— 材料里不写时间，
      // 被追问时才由 qq_memory_query / 控制台把时间带出来（2026-10-12 主人定）。
      traitMeta: merged.traitMeta,
      interactionCount: (Number(old.interactionCount) || 0) + 1,
      lastSeenAt: ts
    };
    // 群友总数上限 80，超限丢最久没互动的
    const impressionEntries = Object.entries(st.memberImpressions);
    if (impressionEntries.length > 80) {
      impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
      for (let i = 0; i < impressionEntries.length - 80; i++) {
        delete st.memberImpressions[impressionEntries[i][0]];
      }
    }
  }

  return true;
}
