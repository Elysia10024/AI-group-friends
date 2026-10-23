// B 站订阅播报的纯逻辑：目标规整、动态解析、去重判定、文案、WBI 签名。
// IO（HTTP / 发送 / 落盘）在 domains/bilibili.js —— 这里只放能离线单测的部分。
import crypto from 'node:crypto';
//
// 为什么只认 `DYNAMIC_TYPE_AV`：用户只要视频（2026-10-23 定），图文/转发不播；
// 而 `feed/space` 里的 AV 条目正好带 `major.archive`（bvid/title），比 arc/search 稳
// （arc/search 对部分官号直接 -412，实测明日方舟）。

export const BILIBILI_DEFAULTS = {
  enabled: false,
  intervalMs: 10 * 60 * 1000,
  activeHours: [8, 24],
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxPerRun: 5,
  requestGapMs: 2000,
  pages: 2,
  template: '{alias} 发新视频了\n{title}\n{url}',
  targets: []
};

// WBI 混排表（B 站前端固定表；见 bilibili-API-collect 的 wbi 文档）。
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

/** 由 img_key + sub_key 得到 32 位 mixin key。 */
export function mixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32);
}

/**
 * WBI 签名：返回带 wts / w_rid 的 query string。
 * @param {object} params
 * @param {string} imgKey
 * @param {string} subKey
 * @param {number} [wts] 秒级时间戳（单测可传固定值）
 */
export function signWbi(params, imgKey, subKey, wts = Math.round(Date.now() / 1000)) {
  const key = mixinKey(imgKey + subKey);
  const all = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const w_rid = crypto.createHash('md5').update(query + key).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

/**
 * 把配置里的 targets 规整成 [{uid, alias, groups}]：
 * 同 uid 的多条合并 groups，非法 uid/群直接丢。
 */
export function normalizeTargets(raw) {
  const out = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    const uid = Number(t?.uid);
    if (!Number.isInteger(uid) || uid <= 0) continue;
    const groups = [...new Set((Array.isArray(t?.groups) ? t.groups : [])
      .map(Number)
      .filter((g) => Number.isInteger(g) && g > 0))];
    const alias = String(t?.alias ?? '').trim() || String(uid);
    const enabled = t?.enabled !== false;
    const prev = out.find((x) => x.uid === uid);
    if (prev) {
      for (const g of groups) if (!prev.groups.includes(g)) prev.groups.push(g);
      prev.enabled = prev.enabled && enabled;
      continue;
    }
    out.push({ uid, alias, groups, enabled });
  }
  return out;
}

/**
 * 从一条空间动态里取视频信息；不是投稿视频就返回 null。
 * @returns {{id:string,title:string,created:number,url:string}|null}
 */
export function extractVideo(item) {
  if (!item || item.type !== 'DYNAMIC_TYPE_AV') return null;
  const arch = item?.modules?.module_dynamic?.major?.archive;
  const bvid = String(arch?.bvid ?? '').trim();
  if (!/^BV[0-9A-Za-z]+$/.test(bvid)) return null;
  const created = Number(item?.modules?.module_author?.pub_ts) || 0;
  const title = String(arch?.title ?? '').trim();
  return {
    id: bvid,
    title,
    created,
    url: `https://www.bilibili.com/video/${bvid}`
  };
}

/**
 * 判断哪些是"该播的新视频"。
 * `seen` 为 null（该 UID 没有历史）时只返回基线，不播。
 * @param {string[]|null} seen
 * @param {{id:string,created:number}[]} videos
 * @param {{now?:number,maxAgeMs?:number}} [opts]
 * @returns {{baseline:string[],fresh:object[]}}
 */
export function diffVideos(seen, videos, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const maxAgeMs = Number(opts.maxAgeMs) || BILIBILI_DEFAULTS.maxAgeMs;
  const items = (Array.isArray(videos) ? videos : []).filter((v) => v && v.id);
  if (!Array.isArray(seen)) {
    return { baseline: items.map((v) => v.id), fresh: [] };
  }
  const got = new Set(seen);
  const fresh = items
    .filter((v) => !got.has(v.id) && v.created > 0 && now - v.created * 1000 <= maxAgeMs)
    .sort((a, b) => a.created - b.created);
  return { baseline: [], fresh };
}

/** 把这一轮看到的视频并入已见列表，保留最新的 cap 条（新 id 在末尾）。 */
export function nextSeen(seen, videos, cap = 200) {
  const items = (Array.isArray(videos) ? videos : [])
    .filter((v) => v && v.id)
    .sort((a, b) => (a.created || 0) - (b.created || 0));
  const freshIds = new Set(items.map((v) => v.id));
  const out = (Array.isArray(seen) ? seen : []).filter((id) => !freshIds.has(id));
  out.push(...items.map((v) => v.id));
  return out.slice(-Math.max(1, cap));
}

/** 填模板：{alias} {title} {url}。 */
export function formatVideo(template, { alias, title, url }) {
  const tpl = String(template ?? BILIBILI_DEFAULTS.template);
  return tpl
    .replaceAll('{alias}', String(alias ?? ''))
    .replaceAll('{title}', String(title ?? ''))
    .replaceAll('{url}', String(url ?? ''));
}
