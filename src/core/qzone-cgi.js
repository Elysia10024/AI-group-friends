// QQ 空间 CGI 的**纯解析层**：g_tk 算法、JSONP 拆壳、正文清洗、评论/动态的拍平与渲染。
//
// 为什么要有这一层（2026-10-12 主人要"看好友动态、看评论"时发现）：
//   SnowLuma 把**写**的动作都暴露成 OneBot action 了（发/删/改权限/点赞/评论），
//   但**读评论**没有 —— 它内部有 `emotion_cgi_msgdetail_v6`（改权限的两步要用），只是没开成 action。
//   我们不去改第三方（升级就丢），改成用她自己的 cookie 直连这个 CGI。
//   这样做的代价是"要自己维护一小段 QQ 私有接口的知识"，所以：
//     · 能纯的都放这里（有单测，坏了能一眼看出来）；
//     · I/O 与 cookie 只留在 domains/qzone.js 一处；
//     · **失败必须响亮**（cookie 掉了、tid 不是好友的、风控拦截 —— 都要抛出来，不许静默回空）。
//
// 那个坑（花了我一次 403 才找到）：`g_tk` 必须用 **p_skey** 算，不是 skey。
// SnowLuma 的 getBknFromCookie 也是这么写的（`cookieObject['p_skey'] || cookieObject['skey']`），
// 用 skey 算出来的 g_tk 会被空间网关判 403（而不是给个业务错误码，很容易误判成"没权限"）。
import { fmtClock } from './mention-window.js';

/** 空间正文里的表情码：`[em]e400867[/em]` → 一个词，免得她照着念一串数字。 */
const EM_RE = /\[em\]e?\d+\[\/em\]/gi;

/**
 * g_tk / bkn：QQ 空间所有 CGI 的签名参数（djb2 变体 & 0x7fffffff）。
 * @param {string} pskey cookie 里的 `p_skey`（拿不到时才退回 `skey`）
 * @returns {string}
 */
export function bknFrom(pskey) {
  const s = String(pskey ?? '');
  let hash = 5381;
  for (let i = 0; i < s.length; i += 1) hash += (hash << 5) + s.charCodeAt(i);
  return String(hash & 2147483647);
}

/** 从 `k=v; k=v` 的 cookie 串里取某个键（取不到返回空串）。 */
export function cookieValue(cookieStr, name) {
  const m = new RegExp(`(?:^|;\\s*)${String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^;]*)`).exec(String(cookieStr ?? ''));
  return m ? m[1] : '';
}

/**
 * 从 cookie 串里取签名用的那个 skey：**优先 p_skey**（见文件头那个坑）。
 * 附带的两个都取出来，调用方要原样回传给 CGI（`cgi_upload_image` 之类会把 skey 放进 body）。
 */
export function qzoneKeys(cookieStr) {
  const pSkey = cookieValue(cookieStr, 'p_skey');
  const skey = cookieValue(cookieStr, 'skey');
  return { skey, pSkey, gtk: bknFrom(pSkey || skey) };
}

/**
 * 空间 CGI 回的是 JSONP（`_Callback({…});` / `callback({…})`），偶尔是裸 JSON。
 * 壳拆不掉就**抛错并把开头带出来** —— 静默当空数据会让"没评论"和"cookie 废了"长得一模一样。
 * @returns {object}
 */
export function parseQzoneJsonp(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('空间 CGI 返回空响应');
  if (raw.startsWith('{')) {
    try { return JSON.parse(raw); } catch (error) { throw new Error(`空间 CGI 返回的不是合法 JSON：${raw.slice(0, 120)}（${error?.message ?? error}）`); }
  }
  // 壳名可能带前后缀（`_Callback(`、`callback(`、`jsonhtml_callback(`），所以找第一个 `(` 与最后一个 `)`。
  const open = raw.indexOf('(');
  const close = raw.lastIndexOf(')');
  if (open < 0 || close <= open) throw new Error(`空间 CGI 返回了无法识别的内容：${raw.slice(0, 120)}`);
  const inner = raw.slice(open + 1, close).trim();
  try {
    return JSON.parse(inner);
  } catch (error) {
    throw new Error(`空间 CGI 的 JSONP 体解析失败：${inner.slice(0, 120)}（${error?.message ?? error}）`);
  }
}

/**
 * 把空间返回的"HTML 味正文"洗成她能读的一行：
 * 表情码 → `[表情]`、标签 → 空格（`<br>` 类换行标签 → 换行）、常见实体解码、空白收干净。
 * 好友动态那条 CGI 回的就是**预渲染 HTML**，不洗的话她看到的是标签汤。
 */
export function cleanQzoneText(input, { keepNewlines = false } = {}) {
  let s = String(input ?? '');
  if (!s) return '';
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, keepNewlines ? '\n' : ' ');
  s = s.replace(/<\/(p|div|li|tr)>/gi, keepNewlines ? '\n' : ' ');
  s = s.replace(/<[^>]*>/g, ' ');
  s = s.replace(EM_RE, '[表情]');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  s = keepNewlines
    ? s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n')
    : s.replace(/\s+/g, ' ').trim();
  return s;
}

/** @ 语法 `@{uin:123,nick:某某,who:1,auto:1}` → `@某某`（空间评论里就是这么存的）。 */
export function cleanQzoneMention(text) {
  return String(text ?? '').replace(/@\{uin:(\d+),nick:([^,}]*)[^}]*\}/g, (_, uin, nick) => `@${String(nick || uin).trim()}`);
}

/** 评论里嵌套的回复数组（实测字段名 `list_3`，其它位深可能是 `list_2`/`list_4`）。 */
function repliesOf(comment) {
  const key = Object.keys(comment ?? {}).find((k) => /^list_\d+$/.test(k) && Array.isArray(comment[k]));
  const list = key ? comment[key] : [];
  return (Array.isArray(list) ? list : []).map((r) => ({
    uin: String(r?.uin ?? r?.owner?.uin ?? ''),
    name: cleanQzoneText(r?.name ?? r?.owner?.name ?? ''),
    at: Number(r?.create_time ?? 0) * 1000,
    when: String(r?.createTime2 ?? ''),
    text: cleanQzoneText(cleanQzoneMention(r?.content))
  })).filter((r) => r.text);
}

/**
 * 把 `emotion_cgi_msgdetail_v6` 的返回拍平成"我们能渲染的东西"。
 * @returns {{tid:string, content:string, images:number, at:number, ugcRight:number|null, source:string, secret:boolean, commentCount:number, forwardCount:number, comments:Array}}
 */
export function mapMoodDetail(data) {
  const d = data && typeof data === 'object' ? data : {};
  const comments = (Array.isArray(d.commentlist) ? d.commentlist : []).map((c) => ({
    uin: String(c?.uin ?? c?.owner?.uin ?? ''),
    name: cleanQzoneText(c?.name ?? c?.owner?.name ?? ''),
    // create_time 是 unix 秒（可靠）；createTime/createTime2 是给人看的字符串（"2025年11月21日"），
    // 只当回显用 —— 别拿它 Date.parse（中文日期在 Node 里解析不出来，会静默变 0）。
    at: Number(c?.create_time ?? 0) * 1000,
    when: String(c?.createTime2 ?? c?.createTime ?? ''),
    text: cleanQzoneText(cleanQzoneMention(c?.content)),
    replies: repliesOf(c)
  })).filter((c) => c.text || c.replies.length);
  return {
    tid: String(d.tid ?? ''),
    // 说说是谁的 —— 判"这是不是她自己的说说"要靠它（别信本地账本：账本可能被清、被丢）
    uin: String(d.uin ?? ''),
    content: cleanQzoneText(cleanQzoneMention(d.content)),
    images: Array.isArray(d.pic) ? d.pic.length : 0,
    at: Number(d.created_time ?? 0) * 1000,
    ugcRight: Number.isFinite(Number(d.ugc_right)) ? Number(d.ugc_right) : null,
    source: cleanQzoneText(d.source_name ?? ''),
    secret: Number(d.secret ?? 0) > 0,
    commentCount: Number(d.cmtnum ?? comments.length) || comments.length,
    forwardCount: Number(d.fwdnum ?? 0) || 0,
    comments
  };
}

/**
 * 一条说说的详情 + 评论，渲染成她读得懂的那几行。
 * @param {{now?:number, maxComments?:number}} [opts]
 */
export function formatMoodDetail(detail, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const max = Math.max(1, Number(opts.maxComments) || 20);
  const d = detail ?? {};
  const head = [
    `【说说】${d.content || '(无正文)'}`,
    `（${d.at ? fmtClock(d.at, now) : '时间未知'}${d.source ? `，来自 ${d.source}` : ''}`
      + `${d.images ? `，${d.images} 张图` : ''}｜评论 ${d.commentCount} 条${d.forwardCount ? `，转发 ${d.forwardCount}` : ''}`
      + `${d.ugcRight != null ? `｜权限 ${d.ugcRight}` : ''}）`
  ].join('\n');
  if (!d.comments?.length) return `${head}\n（还没有人评论）`;
  const lines = d.comments.slice(0, max).map((c) => {
    // 时间优先用空间给的那句人话（comments 里是 createTime2），没有才自己格式化 —— 两种混着显示很脏。
    const stamp = (x) => x.when || (x.at ? fmtClock(x.at, now) : '');
    const cWhen = stamp(c);
    const mine = c.replies?.length
      ? `\n${c.replies.map((r) => `    └ ${r.name}${stamp(r) ? `（${stamp(r)}）` : ''}：${r.text}`).join('\n')}`
      : '';
    return `- ${c.name}${cWhen ? `（${cWhen}）` : ''}：${c.text}${mine}`;
  });
  const more = d.comments.length > max ? `\n（还有 ${d.comments.length - max} 条没列出来）` : '';
  return `${head}\n评论：\n${lines.join('\n')}${more}`;
}

/**
 * 好友动态（`get_qzone_feeds` 回的每条带预渲染 HTML）→ 清单文本。
 * 空的时候要**说清是"没有新动态"**，别让她以为是工具坏了（这个接口很多时候真的是空的）。
 */
export function formatQzoneFeeds(feeds, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const max = Math.max(1, Number(opts.limit) || 10);
  const list = (Array.isArray(feeds) ? feeds : []).slice(0, max);
  if (!list.length) return '（好友动态是空的：她这些好友最近没发说说）';
  return list.map((f) => {
    const when = Number(f?.time) > 0 ? fmtClock(Number(f.time) * 1000, now) : '时间未知';
    const who = String(f?.nickname ?? f?.uin ?? '?').slice(0, 20);
    const body = cleanQzoneText(f?.html).slice(0, 200);
    return `[${when}] ${who}${body ? `：${body}` : ''}`;
  }).join('\n');
}
