// QQ 空间说说域：她"自己发一条"的通道（发表 / 删除 / 看她发过的）。
//
// 链路（2026-10-12 打通）：
//   工具 qq_post_mood → 控制台路由 /api/socialV2/post-mood → 本模块
//     → OneBot `send_qzone_msg`（SnowLuma 原生动作，走 taotao 的 emotion_cgi_publish_v6，带 g_tk 签名）
//
// 为什么边界放在 core/qzone.js 而不是这里：判据（能不能发、正文行不行）必须是纯函数、有单测；
// 这里只做三件事 —— 调 OneBot、读写账本、把失败说清楚。
//
// **账本**（state/qzone.json）是本地的一本小账，跟 QQ 空间**不是**一回事：
//   · 它只记"她发过什么、什么时候、什么权限"，用来算每日额度和在提示里回显上一条；
//   · 空间里删了一条，这里也销账；空间里多了管理员手动发的，这里不会知道 —— 这是刻意的，
//     额度管的是"她"发多少，不是空间里总共有多少。
//   · 落盘顺序：**先真发出去，再记账**（见 appendMoodPost 注释里说的失败顺序）。
//
// 空空间的坑（实测）：账号一条说说都没有时，`get_qzone_msg_list` 返回 `msglist: null`，
// SnowLuma 把 null 当成"响应结构异常"**抛错**（它的判据是"必须有数组"）。她第一条说说之前，
// 读列表必然是这句错，所以这里按签名识别并当成"空列表"，见 isEmptySpaceError()。
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeMoodInput,
  normalizeMoodComment,
  moodQuota,
  appendMoodPost,
  removeMoodPost,
  lastMoodPost,
  moodDayCount,
  moodPromptLine,
  formatMoodPosts,
  moodImageLabel,
  withCommentMention,
  commentKey,
  newComments,
  allCommentKeys,
  formatCommentNotice,
  resolveUgcRight,
  MOOD_MAX_CHARS,
  MOOD_COMMENT_MAX_CHARS,
  MOOD_POSTS_KEPT,
  QZONE_UGC_RIGHT_LABELS
} from '../core/qzone.js';
import { qzoneKeys, parseQzoneJsonp, mapMoodDetail, formatMoodDetail, formatQzoneFeeds } from '../core/qzone-cgi.js';

import { createOneBotClient } from '../core/onebot.js';

export function createQzoneModule(ctx) {
  const { cfg, log } = ctx;
  const stateDir = String(ctx.stateDir || path.join(ctx.ROOT, 'state'));
  const file = path.join(stateDir, 'qzone.json');
  const q = cfg.socialV2?.qzone ?? {};

  let cache = null;   // { mtimeMs, state }

  function emptyState() {
    return {
      note: '小鲸鱼发过的 QQ 空间说说（账本：额度、提示回显、看过的评论、回过的评论）。',
      posts: [],
      seenComments: {},     // tid -> [评论键]（"这些我看过了"，去重的依据）
      repliedComments: []   // [{tid, key, at, toName, text}]（"这些我回过了"，每条只回一次）
    };
  }

  /** 读账本（按 mtime 缓存：手工改过文件下一轮就生效，不用重启）。 */
  function loadState() {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* 还没有账本 */ }
    if (cache && cache.mtimeMs === mtimeMs) return cache.state;
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = null; }
    const state = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : emptyState();
    if (!Array.isArray(state.posts)) state.posts = [];
    if (!Array.isArray(state.repliedComments)) state.repliedComments = [];
    if (!state.seenComments || typeof state.seenComments !== 'object' || Array.isArray(state.seenComments)) state.seenComments = {};
    cache = { mtimeMs, state };
    return state;
  }

  function saveState(next) {
    ctx.atomicWriteJson(file, next);
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* 刚写完理论上一定在 */ }
    cache = { mtimeMs, state: next };
  }

  // 第 5 期 5b：OneBot 请求实现统一在 core/onebot.js，这里只保留域差异参数（超时/426 措辞）。
  const onebot = createOneBotClient({ cfg });
  async function postOneBot(action, params, timeoutMs = 30000) {
    return onebot.call(action, params, { timeoutMs, hint426: 'short' });
  }

  function enabled() {
    return q.enabled !== false;
  }
  function imagesEnabled() {
    return q.imageEnabled !== false;
  }

  // ── 直连空间 CGI 的那一半（读评论 / 好友动态）──────────────────────────────
  // 为什么不用 OneBot action：网关**没暴露读评论的动作**（SnowLuma 内部有 msgdetail，没开成 action）。
  // 所以我们用她自己的 cookie 直连 —— cookie 从网关拿（`get_cookies`），签名算法在 core/qzone-cgi.js。
  const ZONE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  let cookieCache = { at: 0, str: '' };

  /** 拿 qzone.qq.com 的 cookie 串（缓存 60 秒：空间 CGI 一次请求一个，没必要每次重问网关）。 */
  async function qzoneCookies() {
    const now = Date.now();
    if (cookieCache.str && now - cookieCache.at < 60000) return cookieCache.str;
    const data = await postOneBot('get_cookies', { domain: 'qzone.qq.com' }, 15000);
    const str = String(data?.cookies ?? '');
    if (!str) throw new Error('拿不到 qzone.qq.com 的 cookie（网关返回空）：她可能掉线了');
    cookieCache = { at: now, str };
    return str;
  }

  /** 她自己的 QQ 号（从 cookie 里读，省得再要一份 ctx）。 */
  function selfUinFrom(cookieStr) {
    const raw = /(?:^|;\s*)(?:pt2gguin|uin)=o?(\d+)/.exec(cookieStr)?.[1] ?? '';
    return raw;
  }

  /** 直连空间 CGI：把失败说清楚（cookie 废了 / 风控 / 结构变了，三种都别静默）。 */
  async function qzoneGet(url, cookieStr, timeoutMs = 20000) {
    const res = await fetch(url, {
      headers: { Cookie: cookieStr, 'User-Agent': ZONE_UA, Referer: 'https://user.qzone.qq.com/' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 403 ? '（403：多半是 cookie 过期，或那个 CGI 需要 p_skey 算出的 g_tk）' : '';
      throw new Error(`空间 CGI HTTP ${res.status}${hint}：${text.slice(0, 120)}`);
    }
    return text;
  }

  let friendCache = { at: 0, uins: null };

  /** 好友列表（缓存 5 分钟）——"只读好友的空间"这条边界靠它兜住。 */
  async function friendUins() {
    const now = Date.now();
    if (friendCache.uins && now - friendCache.at < 300000) return friendCache.uins;
    const list = await postOneBot('get_friend_list', {}, 20000);
    const uins = new Set((Array.isArray(list) ? list : []).map((f) => String(f?.user_id ?? '')).filter(Boolean));
    friendCache = { at: now, uins };
    return uins;
  }

  /** 只允许看好友的空间（陌生人一律拒，理由说清）。 */
  async function assertFriend(uin, who = '那个人') {
    const id = String(uin ?? '').trim();
    if (!/^\d+$/.test(id)) throw new Error(`${who}的 QQ 号不合法`);
    const self = selfUinFrom(cookieCache.str || '');
    if (self && id === self) return id;
    const uins = await friendUins();
    if (!uins.has(id)) {
      throw new Error(`${who}（${id}）不是她的好友，看不了空间 —— 她只读好友的说说（陌生人的空间不看）`);
    }
    return id;
  }

  /**
   * 读一条说说的详情 + 评论（含楼中楼）。
   * @param {string} tid
   * @param {{targetUin?:string}} [opts] 说说是谁的（省略 = 她自己）
   */
  async function getMoodComments(tid, opts = {}) {
    const id = String(tid ?? '').trim();
    if (!id) throw new Error('要读哪一条？需要 tid（用 qq_list_moods 看）');
    const cookieStr = await qzoneCookies();
    const self = selfUinFrom(cookieStr);
    const hostUin = String(opts.targetUin ?? '').trim() || self;
    if (!hostUin) throw new Error('认不出说说是谁的（cookie 里没有 uin）');
    if (hostUin !== self) await assertFriend(hostUin, '说说主人');
    const { gtk } = qzoneKeys(cookieStr);
    const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?${new URLSearchParams({
      tid: id,
      uin: hostUin,
      t1_source: '1',
      not_trunc_con: '1',
      need_right: '1',
      not_adapt_outpic: '1',
      g_tk: gtk
    })}`;
    const text = await qzoneGet(url, cookieStr);
    const data = parseQzoneJsonp(text);
    const code = Number(data?.subcode ?? data?.code ?? -1);
    if (code !== 0) {
      throw new Error(`读说说详情失败：code=${code} ${String(data?.message ?? data?.msg ?? '').slice(0, 60)}`
        + '（tid 不对、不是好友的说说、或者被风控挡了）');
    }
    const detail = mapMoodDetail(data);
    log?.(`[说说] 读了详情 tid=${id}（评论 ${detail.comments.length} 条）`);
    return { detail, text: formatMoodDetail(detail, { maxComments: Number(opts.maxComments) || 20 }) };
  }

  /** 好友动态（多数时候是空的 —— 她那几个好友经常不发说说，空是事实不是故障）。 */
  async function listFeeds(opts = {}) {
    const count = Math.max(1, Math.min(50, Number(opts.count) || 10));
    const data = await postOneBot('get_qzone_feeds', { page_num: 1, count }, 25000);
    const feeds = Array.isArray(data?.feeds) ? data.feeds : [];
    return {
      count: feeds.length,
      hasMore: data?.has_more === true,
      feeds: feeds.map((f) => ({
        uin: String(f?.uin ?? ''),
        nickname: String(f?.nickname ?? ''),
        at: Number(f?.time ?? 0) * 1000
      })),
      text: formatQzoneFeeds(feeds, { limit: count })
    };
  }

  // ── 回评论（2026-10-13 主人要"有人评论她会回吗"→ 不会，所以补上）────────────────
  // 三条硬边界，全在代码里兜着，不靠她自觉：
  //   ① **只回她自己说说下面的评论** —— 别人的空间只读不留言（去别人空间留言比在自己空间说话显眼得多，
  //      而且这次根本没让她做）；
  //   ② **每条评论只回一次**（按 `评论人:时间:正文` 的键去重存进账本）；
  //   ③ **窗口限频**（默认 30 分钟内最多 2 条）—— 一晚上把四条评论全回一遍不像人，像客服。
  const SEEN_PER_POST = 80;      // 每条说说最多记多少"看过的评论"
  const REPLIED_KEPT = 50;       // 账本最多记多少"回过的评论"

  function seenKeysFor(tid) {
    return new Set(loadState().seenComments?.[String(tid)] ?? []);
  }

  /** 记账：这些评论"她看过了"（去重靠它）。 */
  function markCommentsSeen(tid, keys) {
    const id = String(tid ?? '');
    if (!id || !Array.isArray(keys) || !keys.length) return;
    const state = loadState();
    const merged = [...new Set([...(state.seenComments?.[id] ?? []), ...keys])].slice(-SEEN_PER_POST);
    saveState({ ...state, seenComments: { ...(state.seenComments ?? {}), [id]: merged } });
  }

  /**
   * 认出"她想回的是哪条评论"，顺便回答"这条说说是不是她自己的"。
   *
   * 为什么不让模型自己传一个长键：她看到的评论是 `- Dmnu（11:26）：你喜欢我` 这种，
   * 让她去拼 `uin:时间:正文` 既难为人又容易错。所以：
   *   · 传了 commentKey → 就用它（但仍然会查一次详情，见下）；
   *   · 只传 toUserId/toName（可再给一段正文）→ 这里认出最近一条**还没回过**的；
   *   · 什么都没传 → 认最新那条评论。
   *
   * 归属判据用**空间返回的 uin**，不用本地账本：账本可能被清掉/丢过一次，
   * 那时她会莫名其妙"连自己的说说都不能回"。一次 CGI 读同时解决"谁的"和"哪条"。
   * @returns {Promise<{key:string, name:string, comment:object|null, detail:object}>}
   */
  async function resolveCommentTarget(tid, options = {}) {
    const { detail } = await getMoodComments(tid, { maxComments: 40 });
    const cookieStr = await qzoneCookies();
    const self = selfUinFrom(cookieStr);
    if (self && String(detail?.uin ?? '') && String(detail.uin) !== self) {
      throw new Error('只能回**你自己**说说下面的评论 —— 别人的空间只读、不留言');
    }
    const list = Array.isArray(detail?.comments) ? detail.comments : [];
    const given = String(options.commentKey ?? '').trim();
    const name0 = String(options.toName ?? '').trim();
    if (given) return { key: given, name: name0, comment: list.find((c) => commentKey(c) === given) ?? null, detail };
    if (!list.length) throw new Error('这条说说下面还没有评论，没得回');
    const uin = String(options.toUserId ?? '').trim();
    const wantText = String(options.commentText ?? '').replace(/\s+/g, ' ').trim();
    // 优先别人写的评论：她自己回出去的那几条在空间里也是"评论"，
    // 不加这一层的话，她第二次不指定对象时会把**自己上一条回复**当成"最新评论"去回（自己跟自己套娃）。
    // 但如果这条说说下面只有她自己写的（自问自答 / 测试夹具），就退回全量，别把路堵死。
    const others = self ? list.filter((c) => String(c.uin ?? '') !== self) : list;
    let pool = others.length ? others : list;
    if (uin) pool = pool.filter((c) => String(c.uin ?? '') === uin);
    if (!pool.length && name0) pool = list.filter((c) => String(c.name ?? '') === name0);
    if (!pool.length) throw new Error(`这条说说的评论里没有 ${uin || name0 || '那个人'} —— 先用 qq_mood_comments 看一眼`);
    if (wantText) {
      const hit = pool.filter((c) => c.text.includes(wantText) || wantText.includes(c.text));
      if (hit.length) pool = hit;
    }
    const replied = new Set(loadState().repliedComments.map((r) => String(r.key ?? '')));
    const fresh = pool.filter((c) => !replied.has(commentKey(c)));
    // 评论按时间升序 → 取"最近一条还没回过的"，都回过了就取最近一条（下面会拦"已经回过"）。
    const pick = fresh.length ? fresh[fresh.length - 1] : pool[pool.length - 1];
    return { key: commentKey(pick), name: name0 || String(pick.name ?? ''), comment: pick, detail };
  }

  /**
   * 回一条评论。**它本身评的是"说说"，不是某条评论**（网关的评论接口是顶层的 `emotion_cgi_re_feeds`，
   * 没有"回复某条评论"的参数），所以想指向谁就在正文里 @ 谁 —— 见 core/qzone.js 的 withCommentMention。
   * @param {string} tid 她自己的说说
   * @param {string} content 回的话
   * @param {{toName?:string, toUserId?:string, commentText?:string, commentKey?:string, secrets?:string[]}} [options]
   */
  async function replyToComment(tid, content, options = {}) {
    if (!enabled()) throw new Error('说说功能已关闭（socialV2.qzone.enabled = false）');
    const id = String(tid ?? '').trim();
    if (!id) throw new Error('要回哪条说说下面的评论？需要 tid（用 qq_list_moods 看）');
    const checked = normalizeMoodComment({
      content,
      maxChars: Number(q.commentMaxChars) > 0 ? Number(q.commentMaxChars) : MOOD_COMMENT_MAX_CHARS,
      secrets: options.secrets
    });
    if (!checked.ok) throw new Error(checked.error);

    // ① 认出是哪条评论（顺带确认这条说说是她自己的）② 每条只回一次
    const state = loadState();
    const target = await resolveCommentTarget(id, options);
    if (state.repliedComments.some((r) => String(r.key ?? '') === target.key)) {
      throw new Error('这条评论你已经回过了（每条我只回一次，别刷）');
    }

    // ③ 窗口限频
    const windowMs = Number(q.commentReplyWindowMs) > 0 ? Number(q.commentReplyWindowMs) : 30 * 60000;
    const cap = Number(q.commentReplyCap) > 0 ? Number(q.commentReplyCap) : 2;
    const now = Date.now();
    const recent = state.repliedComments.filter((r) => now - Number(r.at || 0) < windowMs);
    if (recent.length >= cap) {
      const oldest = Math.min(...recent.map((r) => Number(r.at || 0)));
      const wait = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 60000));
      throw new Error(`刚回过 ${recent.length} 条了（${Math.round(windowMs / 60000)} 分钟内最多 ${cap} 条），约 ${wait} 分钟后再回`);
    }

    const text = withCommentMention(target.name, checked.value.content);
    const data = await postOneBot('comment_qzone', { tid: id, content: text }, 45000);
    let note;
    try {
      const fresh = loadState();
      const next = {
        ...fresh,
        repliedComments: [...fresh.repliedComments, {
          tid: id, key: target.key, at: now, toName: String(target.name ?? '').slice(0, 30), text
        }].slice(-REPLIED_KEPT)
      };
      saveState(next);
      // 回过的那条评论也算"看过"，别再当新评论提醒她
      markCommentsSeen(id, [target.key]);
    } catch (error) {
      // 评论已经发出去了，这时候抛错只会让她以为没回、再回一条 —— 照实返回成功 + 大声记一笔。
      const msg = error?.message ?? String(error);
      log(`[说说] 评论已发出但账本写入失败（tid=${id}）：${msg}`);
      note = `已回出去，但本地账本没记上（${msg}）——不影响这条评论`;
    }
    log(`[说说] 回了评论（tid=${id}${target.name ? `，@${target.name}` : ''}）：${text.slice(0, 40)}`);
    return { tid: id, commentId: String(data?.comment_id ?? ''), text, at: now, toName: target.name, ...(note ? { note } : {}) };
  }

  // 待通知的评论（内存态，读一次就清 —— 与红包那条"最近一次红包"同一个套路）。
  let pendingNotice = null;

  /**
   * 查一次"她的说说下面有没有新评论"。**只读、不叫醒**：叫不叫醒由桥侧决定。
   * @returns {Promise<{tid:string, comments:Array, notice:string, total:number}>}
   */
  async function checkComments() {
    if (!enabled() || q.commentWake === false) return { tid: '', comments: [], notice: '', total: 0 };
    let latest = null;
    try {
      const list = await postOneBot('get_qzone_msg_list', { num: 1 }, 20000);
      latest = Array.isArray(list?.msglist) ? list.msglist[0] : null;
    } catch (error) {
      if (isEmptySpaceError(error)) return { tid: '', comments: [], notice: '', total: 0 };
      throw error;
    }
    const tid = String(latest?.tid ?? '');
    if (!tid) return { tid: '', comments: [], notice: '', total: 0 };
    const { detail } = await getMoodComments(tid, { maxComments: 40 });
    const fresh = newComments(detail.comments, seenKeysFor(tid));
    if (!fresh.length) return { tid, comments: [], notice: '', total: detail.comments.length };
    // 上一次的通知还没送出去（会话忙/静默/被限频）→ 别每 10 分钟重算一遍、也别重复叫：
    // 通知留在 pendingNotice 里，等它真被取走。半小时后仍未送达才刷新一次（评论可能又多了几条）。
    if (pendingNotice && Date.now() - pendingNotice.at < 30 * 60000) {
      return { tid, comments: [], notice: '', total: detail.comments.length, pending: pendingNotice.count };
    }
    const notice = formatCommentNotice(tid, fresh);
    // keys 一起挂上：真送进她的回合时才销账（见 takeCommentNotice 的注释）。
    pendingNotice = { tid, count: fresh.length, notice, at: Date.now(), keys: fresh.map((c) => commentKey(c)) };
    // 对外每个评论都带上 `key`（她的回合里要拿它去回评论；面板/诊断也用得上）——
    // 认评论这条路径只写在这里一处，别让调用方自己去拼键。
    return {
      tid,
      total: detail.comments.length,
      notice,
      comments: fresh.map((c) => ({ ...c, key: commentKey(c) }))
    };
  }

  /**
   * 取走待通知的评论（读一次就清）——唤醒提示要用的那一段。
   * **标记"看过了"放在这里**（而不是 checkComments 里）：只有真把通知送进她的回合，
   * 才算她知道了；叫不醒（会话繁忙/静默）时留着下一轮继续叫，不会丢。
   * 她看到通知后**选择不回**的那几条也算"看过"——不再反复提醒（只通知一次，回不回由她）。
   */
  function takeCommentNotice() {
    const hit = pendingNotice;
    if (!hit) return null;
    pendingNotice = null;
    try {
      markCommentsSeen(hit.tid, hit.keys ?? []);
    } catch { /* 记不上不影响这次通知 */ }
    return hit;
  }

  let watchTimer = null;

  /** 起一个"看有没有新评论"的轮询（**纯 HTTP、不花模型钱**；只在真发现新评论时才回调）。 */
  function startCommentWatch({ intervalMs, onFound } = {}) {
    if (q.commentWake === false) return null;
    if (watchTimer) return watchTimer;
    const every = Math.max(60000, Number(intervalMs) || Number(q.commentCheckMs) || 10 * 60000);
    const tick = async () => {
      try {
        const out = await checkComments();
        if (!out.comments.length) return;
        log(`[说说] 发现 ${out.comments.length} 条新评论（tid=${out.tid}）`);
        await onFound?.(out);
      } catch (error) {
        log(`[说说] 查评论失败：${error?.message ?? error}`);
      }
    };
    // 起来后先查一次（延迟 20 秒，等 DSH 那边就绪）——不然刚重启完要等满一个周期才会发现"有人评论了"。
    const kickoff = setTimeout(() => { void tick(); }, 20000);
    kickoff.unref?.();
    watchTimer = setInterval(() => { void tick(); }, every);
    watchTimer.unref?.();
    log(`[说说] 评论监听已启动：每 ${Math.round(every / 60000)} 分钟查一次（只读，不花 token）`);
    return watchTimer;
  }

  function stopCommentWatch() {
    if (!watchTimer) return;
    clearInterval(watchTimer);
    watchTimer = null;
  }

  /** 现在能不能发（给工具/面板看的完整判据）。 */
  function quota(now = Date.now()) {
    return moodQuota({
      state: loadState(),
      now,
      enabled: enabled(),
      dailyCap: q.dailyCap,
      minGapMs: q.minGapMs,
      tzOffsetMinutes: q.tzOffsetMinutes
    });
  }

  /** 唤醒提示里那一行事实（关掉/没开提示时是空串）。 */
  function promptText(now = Date.now()) {
    return moodPromptLine({
      state: loadState(),
      now,
      enabled: enabled(),
      promptHint: q.promptHint,
      dailyCap: q.dailyCap,
      minGapMs: q.minGapMs,
      tzOffsetMinutes: q.tzOffsetMinutes
    });
  }

  /**
   * 发一条说说。
   * @param {string} content
   * @param {{ugcRight?:number, targetUins?:string[], secrets?:string[], image?:string}} [options]
   *   image = 本地图库里的**名字**（"名字就是它的意思"）。配图只从图库取：她那 57 张规范图 ≤240KB，
   *   正好是空间上传接口喜欢的尺寸，也不用她去"生成"图片。
   * @returns {Promise<{tid:string, at:number, ugcRight:number, content:string, image?:object, todayCount:number, remaining:number, note?:string}>}
   */
  async function postMood(content, options = {}) {
    if (!enabled()) throw new Error('说说功能已关闭（socialV2.qzone.enabled = false）');
    const checked = normalizeMoodInput({
      content,
      ugcRight: options.ugcRight,
      targetUins: options.targetUins,
      maxChars: Number(q.maxChars) > 0 ? Number(q.maxChars) : MOOD_MAX_CHARS,
      secrets: options.secrets,
      defaultUgcRight: q.ugcRight
    });
    if (!checked.ok) throw new Error(checked.error);

    const now = Date.now();
    const limit = quota(now);
    if (!limit.allowed) throw new Error(limit.error);

    // 配图：先把图取出来（取不到就**别发** —— 发出一条"只有正文"的说说跟她的意图不符），
    // 再交给网关上传。`不是不允许发`的图（verdict=不适合）在图库那一层就会被拒。
    let image = null;
    let richval = null;
    const wantImage = String(options.image ?? '').trim();
    if (wantImage) {
      if (!imagesEnabled()) throw new Error('说说配图已关闭（socialV2.qzone.imageEnabled = false）');
      if (!ctx.readLibraryImage) throw new Error('图库没接进来（readLibraryImage），配图不可用');
      const got = ctx.readLibraryImage(wantImage);      // 抛错 = 名字不对/图太大/被标成不许发
      image = { name: String(got.image?.name ?? wantImage), by: got.image?.by === 'her' ? 'her' : 'admin', verdict: got.image?.verdict ?? '' };
      richval = `base64://${got.buffer.toString('base64')}`;
      if (got.buffer.length > 6 * 1024 * 1024) {
        throw new Error(`这张图太大（${Math.round(got.buffer.length / 1024)}KB），空间上传会失败`);
      }
    }

    const params = { content: checked.value.content, ugc_right: checked.value.ugcRight };
    if (checked.value.targetUins.length) params.target_uins = checked.value.targetUins;
    if (richval) params.images = [richval];
    const data = await postOneBot('send_qzone_msg', params, 60000);
    const tid = String(data?.tid ?? '');
    if (!tid) {
      // 网关说"成功"却没给 tid，等于我们无法定位这条说说（也就删不掉）——说出来，别当成功糊过去。
      log(`[说说] 发表返回里没有 tid（内容「${checked.value.content.slice(0, 20)}」）——这条可能发出去了但删不掉`);
    }

    const at = Date.now();
    const entry = { tid, at, text: checked.value.content, ugcRight: checked.value.ugcRight, ...(image ? { image } : {}) };
    let note;
    let saved = loadState();
    try {
      saved = appendMoodPost(saved, entry, { cap: MOOD_POSTS_KEPT });
      saveState(saved);
    } catch (error) {
      // 说说已经在空间里了，这时候抛错只会让她以为没发出去、再发一条 ——
      // 所以照实返回成功，并把"账没记上"这件事大声说出来（额度会少算一条）。
      const msg = error?.message ?? String(error);
      log(`[说说] 已发出但账本写入失败（tid=${tid || '无'}）：${msg}`);
      note = `已发出，但本地账本没记上（${msg}）——不影响这条说说`;
    }
    log(`[说说] 已发表（${QZONE_UGC_RIGHT_LABELS[checked.value.ugcRight] ?? checked.value.ugcRight}｜${checked.value.content.length} 字`
      + `${image ? `｜配图「${moodImageLabel(image)}」` : ''}）tid=${tid || '无'}`);
    // 额度从**账本**重算（写失败时不能假装记上了）；dailyCap 取刚才那次判定里的同一个数。
    const todayCount = moodDayCount(saved, at, q.tzOffsetMinutes);
    return {
      tid,
      at,
      ugcRight: checked.value.ugcRight,
      content: checked.value.content,
      ...(image ? { image } : {}),
      todayCount,
      remaining: Math.max(0, limit.dailyCap - todayCount),
      ...(note ? { note } : {})
    };
  }

  /**
   * 删掉空间里的一条说说（只能删自己的）。删成功后销账。
   * @param {string} tid
   */
  async function deleteMood(tid) {
    const id = String(tid ?? '').trim();
    if (!id) throw new Error('要删哪一条？需要 tid（用 qq_list_moods 看）');
    await postOneBot('delete_qzone_msg', { tid: id });
    let note;
    try {
      saveState(removeMoodPost(loadState(), id));
    } catch (error) {
      const msg = error?.message ?? String(error);
      log(`[说说] 已删除但账本销账失败（tid=${id}）：${msg}`);
      note = `空间里已删除，但本地账本没更新（${msg}）`;
    }
    log(`[说说] 已删除 tid=${id}`);
    // 删掉的那条正好有"待通知的评论"→ 一并作废（否则下一轮唤醒会让她去看一条已经不存在的说说）。
    if (pendingNotice?.tid === id) pendingNotice = null;
    return { tid: id, ...(note ? { note } : {}) };
  }

  /**
   * `get_qzone_msg_list` 在"空间里一条说说都没有"时会抛这句：SnowLuma 拿到 `msglist: null`
   * 就判"响应结构异常"。空空间不是故障，所以按签名认出来当空列表（她的第一条说说之后就自然消失）。
   */
  function isEmptySpaceError(error) {
    const text = String(error?.message ?? error ?? '');
    return /msglist/.test(text) && /null/.test(text);
  }

  /**
   * 读说说列表：默认她自己的空间；给了 `targetUin` 就是**好友**的空间（陌生人拒）。
   * 好友的空间**不查本地账本**（账本只记她自己的），权限位也就没有 —— 那本来就是别人的设置。
   * @param {{num?:number, limit?:number, targetUin?:string}} [opts]
   */
  async function listMoods(opts = {}) {
    const num = Math.max(1, Math.min(100, Number(opts.num) || Math.max(1, Number(opts.limit) || 10)));
    const local = loadState();
    const target = String(opts.targetUin ?? '').trim();
    if (target) await assertFriend(target, '那个人');
    try {
      const params = { num };
      if (target) params.target_uin = target;
      const data = await postOneBot('get_qzone_msg_list', params);
      const raw = Array.isArray(data?.msglist) ? data.msglist : [];
      const posts = raw.map((m) => ({
        tid: String(m?.tid ?? ''),
        at: Number(m?.time ?? 0) * 1000,
        text: String(m?.content ?? ''),
        commentCount: Number(m?.comment_num ?? 0),
        images: Array.isArray(m?.images) ? m.images.length : 0,
        isPrivate: Number(m?.is_private ?? 0) > 0
      }));
      // 权限只有本地账本知道（列表接口不回权限），能对上就补上（只对她自己的说说有意义）。
      if (!target) {
        for (const p of posts) {
          const hit = local.posts.find((x) => String(x.tid ?? '') && String(x.tid) === p.tid);
          if (hit) p.ugcRight = hit.ugcRight;
        }
      }
      const total = Number(data?.total ?? posts.length) || posts.length;
      return {
        source: 'qzone',
        scope: target ? `friend:${target}` : 'self',
        total,
        posts,
        text: formatMoodPosts(posts, { limit: num })
      };
    } catch (error) {
      if (isEmptySpaceError(error)) {
        return {
          source: 'qzone',
          scope: target ? `friend:${target}` : 'self',
          total: 0,
          posts: [],
          text: formatMoodPosts([], { limit: num }),
          note: target ? '这个人的空间里没有（对外的）说说' : '空间里还没有说说（这是第一条之前的状态）'
        };
      }
      // 读空间失败是**真故障**（cookie 掉了 / 风控 / 不是好友），照实抛；调用方负责让她知道。
      throw error;
    }
  }

  /** 控制台/诊断看的当前状态（纯读）。 */
  function status(now = Date.now()) {
    const state = loadState();
    const limit = quota(now);
    const last = lastMoodPost(state);
    return {
      enabled: enabled(),
      imagesEnabled: imagesEnabled(),
      dailyCap: limit.dailyCap,
      todayCount: limit.todayCount,
      remaining: limit.remaining,
      allowed: limit.allowed,
      reason: limit.reason,
      error: limit.error,
      minGapMs: Number(q.minGapMs) > 0 ? Number(q.minGapMs) : 2 * 3600000,
      ugcRight: resolveUgcRight(q.ugcRight, 4),
      ugcRightLabel: QZONE_UGC_RIGHT_LABELS[resolveUgcRight(q.ugcRight, 4)],
      maxChars: Number(q.maxChars) > 0 ? Number(q.maxChars) : MOOD_MAX_CHARS,
      lastAt: last ? Number(last.at) : null,
      lastText: last ? String(last.text ?? '') : '',
      lastImage: last?.image ? moodImageLabel(last.image) : '',
      posts: loadState().posts.slice(-MOOD_POSTS_KEPT).map((p) => ({
        tid: String(p.tid ?? ''),
        at: Number(p.at) || 0,
        text: String(p.text ?? ''),
        ugcRight: resolveUgcRight(p.ugcRight, 4),
        image: p.image ? { name: String(p.image.name ?? ''), by: p.image.by === 'her' ? 'her' : 'admin' } : null
      }))
    };
  }

  /** 给面板/她看的列表文本。 */
  function renderPosts(list, opts = {}) {
    return formatMoodPosts(list, opts);
  }

  return {
    postMood,
    deleteMood,
    listMoods,
    getMoodComments,
    listFeeds,
    replyToComment,
    checkComments,
    takeCommentNotice,
    startCommentWatch,
    stopCommentWatch,
    promptText,
    quota,
    status,
    renderPosts,
    stateFile: file
  };
}
