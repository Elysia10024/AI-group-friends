// QQ 空间说说（她的"自言自语"）—— 纯逻辑层：判定 + 渲染，不碰网络、不碰文件。
//
// 为什么单独一层、为什么判据要这么紧（2026-10-12 主人要求"她自己想发就发"）：
//   说说是**公开发布**的（好友可见），发出去就收不回来，而且比群消息显眼得多 ——
//   群里说错一句最多被当场怼，说说发错一条是挂在空间里的。所以：
//     · 每日上限 + 两次最小间隔由**代码兜住**，不靠她自觉（跟语音输出同一套思路）；
//     · 正文要过长度/空白/密钥三道校验，其中"密钥"那道是防她把提示里的会话令牌抄进去；
//     · 判据全是纯函数，能在单测里把边界（本地日切口、刚发过、发满、太长、带令牌）全跑一遍。
//
// 度量的唯一真相是 `state.posts`（她真发出去过的记录）：今天发了几条 = 从 posts 里数，
// 不另存一个计数器 —— 两个真相迟早对不上（本仓吃过这个亏）。
import { fmtClock } from './mention-window.js';
import { localDayKey, DEFAULT_TZ_OFFSET_MINUTES } from './local-day.js';
import { cleanQzoneText } from './qzone-cgi.js';

/** 空间权限：1 所有人 / 4 好友 / 16 部分好友可见 / 64 仅自己 / 128 部分好友不可见。 */
export const QZONE_UGC_RIGHTS = new Set([1, 4, 16, 64, 128]);
export const QZONE_UGC_RIGHT_LABELS = {
  1: '所有人可见',
  4: '好友可见',
  16: '部分好友可见',
  64: '仅自己可见',
  128: '部分好友不可见'
};

/** 正文上限（字）：她写的是"自言自语"，不是长文；真写长了说明该拆或该进记忆。 */
export const MOOD_MAX_CHARS = 300;
/** 本地只留最近多少条说说记录（主人关心磁盘：这只是她的账本，不是空间本身）。 */
export const MOOD_POSTS_KEPT = 50;
/** 账本里单条正文的存留长度（提示行里还要再截）。 */
const MOOD_STORED_TEXT_CHARS = 200;
/** 提示行里回显上一条的字符数。 */
const MOOD_ECHO_CHARS = 40;

/** 把权限值规整成合法的那个（不认识就回落到 fallback）。 */
export function resolveUgcRight(value, fallback = 4) {
  const n = Number(value);
  if (QZONE_UGC_RIGHTS.has(n)) return n;
  const f = Number(fallback);
  return QZONE_UGC_RIGHTS.has(f) ? f : 4;
}

/** 收回模型输出的排版残留：CRLF、行尾空白、连续空行、连续空格（说说/评论共用）。 */
function cleanMoodBody(raw) {
  return String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 防她把提示词里的东西抄进公开内容（精确子串匹配，短于 12 字符的"秘密"不参与）。 */
function leakedSecret(text, secrets) {
  const list = (Array.isArray(secrets) ? secrets : [])
    .map((s) => String(s ?? ''))
    .filter((s) => s.length >= 12);
  return list.find((s) => text.includes(s)) ?? '';
}

/**
 * 正文规整 + 校验。**校验全部在这里**，域只负责"过了就发"。
 * @param {{content?:string, ugcRight?:number, targetUins?:Array, maxChars?:number, secrets?:string[], defaultUgcRight?:number}} input
 * @returns {{ok:true, value:{content:string,ugcRight:number,targetUins:string[]}} | {ok:false,error:string}}
 */
export function normalizeMoodInput(input = {}) {
  const maxChars = Number(input.maxChars) > 0 ? Number(input.maxChars) : MOOD_MAX_CHARS;
  const raw = String(input.content ?? '');
  if (!raw.trim()) return { ok: false, error: '说说不能是空的 —— 想说什么写一句再发' };

  const content = cleanMoodBody(raw);
  if (!content) return { ok: false, error: '说说不能是空的 —— 想说什么写一句再发' };

  const chars = [...content].length;
  if (chars > maxChars) {
    return { ok: false, error: `说说太长了（${chars} 字 > ${maxChars} 字）—— 说说是自言自语，短一点更真` };
  }

  if (leakedSecret(content, input.secrets)) {
    return { ok: false, error: '正文里带着不该公开的东西（令牌/口令）—— 删掉再发，空间里所有人可能都看得见' };
  }

  const ugcRight = resolveUgcRight(input.ugcRight, input.defaultUgcRight ?? 4);
  const targetUins = (Array.isArray(input.targetUins) ? input.targetUins : [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  if (ugcRight === 16 || ugcRight === 128) {
    if (!targetUins.length) return { ok: false, error: '权限选了"部分好友"时必须给出是哪些人（targetUins）' };
    if (targetUins.some((u) => !/^\d+$/.test(u))) return { ok: false, error: 'targetUins 只能是 QQ 号' };
  }

  return { ok: true, value: { content, ugcRight, targetUins: ugcRight === 16 || ugcRight === 128 ? targetUins : [] } };
}

/** 评论正文上限（字）：评论是"接一句"，不是写小作文。 */
export const MOOD_COMMENT_MAX_CHARS = 120;

/**
 * 评论正文规整 + 校验（与说说同一套清洗与密钥拦截，只是更短）。
 * @param {{content?:string, maxChars?:number, secrets?:string[], toName?:string}} input
 */
export function normalizeMoodComment(input = {}) {
  const maxChars = Number(input.maxChars) > 0 ? Number(input.maxChars) : MOOD_COMMENT_MAX_CHARS;
  const raw = String(input.content ?? '');
  if (!raw.trim()) return { ok: false, error: '评论不能是空的' };
  let content = cleanMoodBody(raw).replace(/\n+/g, ' ');
  if (!content) return { ok: false, error: '评论不能是空的' };
  if (leakedSecret(content, input.secrets)) {
    return { ok: false, error: '评论里带着不该公开的东西（令牌/口令）—— 删掉再说' };
  }
  // 界面上要 @ 谁：QQ 空间的 @ 语法是 `@{uin:…,nick:…,who:1,auto:1}`；
  // 但她自己会写"@某某"，那种朴素写法照样看得懂，所以这里**不强制**、也不改写她的话。
  const chars = [...content].length;
  if (chars > maxChars) {
    return { ok: false, error: `评论太长了（${chars} 字 > ${maxChars} 字）—— 回评论一两句就够` };
  }
  return { ok: true, value: { content } };
}

/** 一条评论的稳定身份（去重靠它）：QQ 的评论 id 不一定给（实测只有 `tid`=楼层序号），
 * 所以用 `评论人:时间:正文前 40 字` 拼一个 —— 同一秒同一个人发同样的内容会被当成同一条，
 * 这在本场景里正是我们想要的（"这条我回过了"）。
 */
export function commentKey(comment) {
  const uin = String(comment?.uin ?? '');
  const at = Number(comment?.at ?? 0);
  const text = String(comment?.text ?? '').replace(/\s+/g, ' ').slice(0, 40);
  return `${uin}:${at}:${text}`;
}

/**
 * 回评论时要不要替她补一个 @。
 * 网关的评论接口是**顶层评论**（`emotion_cgi_re_feeds`，没有"回复某条评论"的参数），
 * 所以想指向谁只能在正文里 @ 谁 —— 这是社区里通行的做法，QQ 自己也把回复渲染成 `@某某 …`。
 * 规则：她已经自己写了 `@` 开头就不动；名字空/太长（多半不是人名）也不动。
 */
export function withCommentMention(name, content) {
  const text = String(content ?? '').trim();
  const who = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20);
  if (!who || !text) return text;
  if (/^@/.test(text)) return text;
  return `@${who} ${text}`;
}

/** 从评论列表里挑出"还没见过的"（seen 是键的集合/数组）。 */
export function newComments(comments, seen) {
  const seenSet = seen instanceof Set ? seen : new Set(Array.isArray(seen) ? seen : []);
  return (Array.isArray(comments) ? comments : []).filter((c) => c && !seenSet.has(commentKey(c)));
}

/** 全部评论的键（用来记账"这些我看过了"，含楼中楼）。 */
export function allCommentKeys(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!c) continue;
    out.push(commentKey(c));
    for (const r of Array.isArray(c.replies) ? c.replies : []) out.push(commentKey(r));
  }
  return out;
}

/**
 * 唤醒提示里那份"有人评论了"的正文（**只给事实**：谁、什么时候、说了什么、tid 与 toUserId）。
 * 上限 5 条：再多也不该在这一轮里全看完（说说是生活，不是工单）。
 */
export function formatCommentNotice(tid, comments, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const max = Math.max(1, Number(opts.limit) || 5);
  const list = (Array.isArray(comments) ? comments : []).slice(0, max);
  if (!list.length) return '';
  const lines = list.map((c) => {
    const when = c.when || (c.at ? fmtClock(c.at, now) : '');
    const replies = Array.isArray(c.replies) && c.replies.length
      ? `（下面还挂着 ${c.replies.length} 条回复）` : '';
    return `- ${c.name || c.uin}${when ? `（${when}）` : ''}：${c.text}${replies}`;
  });
  const more = (Array.isArray(comments) ? comments.length : 0) > max ? `\n（还有 ${comments.length - max} 条没列）` : '';
  return `你的说说（tid=${tid}）下面有 ${Array.isArray(comments) ? comments.length : 0} 条新评论：\n${lines.join('\n')}${more}`;
}

/** 她发过的记录（最新的在后）。坏数据一律跳过，不让一条脏记录把账本整体打废。 */
export function moodPosts(state) {
  const list = Array.isArray(state?.posts) ? state.posts : [];
  return list.filter((p) => p && Number(p.at) > 0);
}

/** 最近一条（没有则 null）。 */
export function lastMoodPost(state) {
  const list = moodPosts(state);
  if (!list.length) return null;
  return list.reduce((a, b) => (Number(b.at) > Number(a.at) ? b : a));
}

/** 今天（本地日）已经发了几条 —— 额度的唯一真相。 */
export function moodDayCount(state, now = Date.now(), tzOffsetMinutes = DEFAULT_TZ_OFFSET_MINUTES) {
  const today = localDayKey(now, tzOffsetMinutes);
  return moodPosts(state).filter((p) => localDayKey(Number(p.at), tzOffsetMinutes) === today).length;
}

/**
 * 现在能不能发。
 * @param {{state?:object, now?:number, enabled?:boolean, dailyCap?:number, minGapMs?:number, tzOffsetMinutes?:number}} opts
 * @returns {{enabled:boolean, allowed:boolean, reason:'disabled'|'daily-cap'|'too-soon'|'ok', error:string, dailyCap:number, todayCount:number, remaining:number, lastAt:number|null, waitMs:number}}
 */
export function moodQuota(opts = {}) {
  const now = Number(opts.now) || Date.now();
  const tz = Number.isFinite(Number(opts.tzOffsetMinutes)) ? Number(opts.tzOffsetMinutes) : DEFAULT_TZ_OFFSET_MINUTES;
  const enabled = opts.enabled !== false;
  const dailyCap = Number.isFinite(Number(opts.dailyCap)) && Number(opts.dailyCap) > 0 ? Math.floor(Number(opts.dailyCap)) : 2;
  const minGapMs = Number.isFinite(Number(opts.minGapMs)) && Number(opts.minGapMs) > 0 ? Math.floor(Number(opts.minGapMs)) : 2 * 3600000;

  const todayCount = moodDayCount(opts.state, now, tz);
  const last = lastMoodPost(opts.state);
  const lastAt = last ? Number(last.at) : null;
  const base = { enabled, dailyCap, todayCount, remaining: Math.max(0, dailyCap - todayCount), lastAt, waitMs: 0 };

  if (!enabled) return { ...base, allowed: false, reason: 'disabled', error: '说说功能已关闭（socialV2.qzone.enabled = false）' };

  if (lastAt != null) {
    const elapsed = now - lastAt;
    if (elapsed >= 0 && elapsed < minGapMs) {
      const waitMs = minGapMs - elapsed;
      const min = Math.max(1, Math.round(waitMs / 60000));
      return {
        ...base,
        allowed: false,
        reason: 'too-soon',
        waitMs,
        error: `刚才发过说说了（${fmtClock(lastAt, now)}），再等 ${min} 分钟才能发下一条`
      };
    }
  }

  if (todayCount >= dailyCap) {
    return {
      ...base,
      allowed: false,
      reason: 'daily-cap',
      error: `今天已经发满 ${dailyCap} 条说说了 —— 空间里挂太多就不像"偶尔想说一句"了，明天再说`
    };
  }

  return { ...base, allowed: true, reason: 'ok', error: '' };
}

/**
 * 记一条发出去的说说（返回**新** state，不改原对象）。
 * 调用方负责落盘；顺序必须是"先真发出去、再记账" —— 反过来一旦发送失败，
 * 账本上就多一条根本没发出去的记录，她当天会被自己的账本挡住。
 */
export function appendMoodPost(state, post = {}, opts = {}) {
  const cap = Number(opts.cap) > 0 ? Math.floor(Number(opts.cap)) : MOOD_POSTS_KEPT;
  const at = Number(post.at) || Date.now();
  const entry = {
    tid: String(post.tid ?? ''),
    at,
    text: String(post.text ?? '').replace(/\s+/g, ' ').slice(0, MOOD_STORED_TEXT_CHARS),
    ugcRight: resolveUgcRight(post.ugcRight, 4)
  };
  // 配图只留"哪张图"（名字 + 谁放的），不留图片本身 —— 账本是账本，别长成第二个图库。
  const imgName = String(post.image?.name ?? '').trim().slice(0, 40);
  if (imgName) entry.image = { name: imgName, by: post.image?.by === 'her' ? 'her' : 'admin' };
  const kept = [...moodPosts(state), entry].slice(-cap);
  return { ...(state && typeof state === 'object' ? state : {}), posts: kept };
}

/** 从账本里删掉一条（她删说说成功后调用）。 */
export function removeMoodPost(state, tid) {
  const want = String(tid ?? '');
  const kept = moodPosts(state).filter((p) => String(p.tid ?? '') !== want);
  return { ...(state && typeof state === 'object' ? state : {}), posts: kept };
}

/** 间隔的人话：2 小时 / 90 分钟。 */
function gapText(ms) {
  const min = Math.round(Number(ms) / 60000);
  if (min < 60) return `${min} 分钟`;
  const hour = min / 60;
  return Number.isInteger(hour) ? `${hour} 小时` : `${hour.toFixed(1)} 小时`;
}

/**
 * 唤醒提示里的那一行（**只给事实，不给规矩** —— 规矩在角色卡里）。
 * 空串 = 这一轮不提（关掉了 / 没开提示）。
 *
 * 成本：这一行每轮都进提示词，所以刻意压在 ~100 字以内；但"今天还能不能发"必须说清，
 * 否则她会白调一次工具被拒（一次白调的价钱远超这一行的价钱）。
 * @returns {string} 形如 '【说说】…\n'（含结尾换行），或 ''
 */
export function moodPromptLine(opts = {}) {
  const enabled = opts.enabled !== false;
  if (!enabled) return '';
  if (opts.promptHint === false) return '';
  const now = Number(opts.now) || Date.now();
  const tz = Number.isFinite(Number(opts.tzOffsetMinutes)) ? Number(opts.tzOffsetMinutes) : DEFAULT_TZ_OFFSET_MINUTES;
  const quota = moodQuota({ state: opts.state, now, enabled: true, dailyCap: opts.dailyCap, minGapMs: opts.minGapMs, tzOffsetMinutes: tz });
  const last = lastMoodPost(opts.state);

  const bits = [];
  if (quota.reason === 'ok') {
    bits.push(quota.todayCount === 0 ? `今天还没发（每天最多 ${quota.dailyCap} 条）` : `今天发过 ${quota.todayCount} 条（每天最多 ${quota.dailyCap} 条）`);
  } else if (quota.reason === 'daily-cap') {
    bits.push(`今天已经发满 ${quota.dailyCap} 条了，今天别再发`);
  } else if (quota.reason === 'too-soon') {
    const min = Math.max(1, Math.round(quota.waitMs / 60000));
    bits.push(`现在还不能发（上一条 ${fmtClock(quota.lastAt, now)}，两次之间至少隔 ${gapText(Number(opts.minGapMs) > 0 ? Number(opts.minGapMs) : 2 * 3600000)}，还要等约 ${min} 分钟）`);
  }

  if (last) {
    const text = String(last.text ?? '').replace(/\s+/g, ' ').slice(0, MOOD_ECHO_CHARS);
    bits.push(`上一条 ${fmtClock(Number(last.at), now)}：「${text}」`);
  }

  const tail = quota.allowed
    ? '；想自言自语就用 qq_post_mood 发一条'
    : '';
  return `【说说】QQ 空间：${bits.join('；')}${tail}。\n`;
}

/**
 * 她自己的说说列表渲染（给 qq_list_moods 用）。
 * 兼容两种来源：QQ 空间的真实返回（有 tid/时间/评论数）和本地账本（只有我们记下的）。
 */
export function formatMoodPosts(list = [], opts = {}) {
  const now = Number(opts.now) || Date.now();
  const rows = (Array.isArray(list) ? list : []).slice(0, Math.max(1, Number(opts.limit) || 10)).map((p) => {
    const at = Number(p.at ?? p.time ?? 0);
    const when = at ? fmtClock(at < 1e12 ? at * 1000 : at, now) : '时间未知';
    // 正文过一遍清洗：空间里存的是 `[em]e400867[/em]` 这种表情码，原样给她会是一串数字。
    const text = cleanQzoneText(String(p.text ?? p.content ?? '')).slice(0, 80);
    const bits = [`[${when}]`, text];
    if (p.tid) bits.push(`tid=${p.tid}`);
    if (Number.isFinite(Number(p.commentCount ?? p.comment_num))) bits.push(`评论 ${Number(p.commentCount ?? p.comment_num)}`);
    if (Number(p.images) > 0) bits.push(`${Number(p.images)} 张图`);
    if (p.ugcRight) bits.push(QZONE_UGC_RIGHT_LABELS[resolveUgcRight(p.ugcRight, 4)] ?? '');
    return bits.filter(Boolean).join(' ');
  });
  return rows.length ? rows.join('\n') : '（空间里还没有说说）';
}

/**
 * 配图那条图注：让她在提示/回显里知道自己配的是哪张图（名字 + 来源），
 * 也让人在控制台账本里看得见"她拿哪张图发了空间"。
 */
export function moodImageLabel(image) {
  if (!image || typeof image !== 'object') return '';
  const name = String(image.name ?? '').trim();
  if (!name) return '';
  const by = image.by === 'her' ? '她自己存的' : image.by === 'admin' ? '管理员放的' : '';
  return by ? `${name}（${by}）` : name;
}
