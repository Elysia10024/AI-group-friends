// 「分镜图」的纯逻辑：从场景切点里挑 9–16 格、格式化时间戳、把字幕/响度压成文字摘要。
// 2026-10-28 方案：借鉴 dsh-video-storyboard（一张图 + 时间戳 + 转录/音频摘要），
// 用 ffmpeg 自己实现，不装 DSH 插件（内核冻结 0.1.1）。
//
// 纯函数、零 I/O：ffmpeg 调用在 domains/bili-look.js，这里只做能单测的决策。

export const STORYBOARD_MIN_CELLS = 9;
export const STORYBOARD_MAX_CELLS = 16;
/** 两个切点太近（<0.8s）就只留前一个：同一镜头切两刀会出重复格。 */
const MIN_SCENE_GAP_SEC = 0.8;

/** 秒 → "m:ss"（超过 1 小时用 "h:mm:ss"）。 */
export function formatTs(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : mm) + `:${String(ss).padStart(2, '0')}`;
}

/**
 * 从场景切点里挑格子。
 * - 切点够（>=min）：按时间均匀从切点里挑 min..max 个，保留首尾；
 * - 切点不够：用均匀采样补足到 min 个（暗场/慢镜头常见）；
 * - 全无切点：均匀 min 个。
 * @param {number[]} sceneTimes 场景切点（秒）
 * @param {number} durationSec 视频总长（秒）
 * @param {{min?:number,max?:number}} [opts]
 * @returns {{cells:number[], source:'scene'|'mixed'|'uniform'}}
 */
export function selectCells(sceneTimes, durationSec, opts = {}) {
  const min = Math.max(1, Math.floor(Number(opts.min) || STORYBOARD_MIN_CELLS));
  const max = Math.max(min, Math.floor(Number(opts.max) || STORYBOARD_MAX_CELLS));
  const dur = Math.max(0.1, Number(durationSec) || 0);
  const sorted = [...new Set((Array.isArray(sceneTimes) ? sceneTimes : [])
    .map((x) => Number(x))
    .filter((t) => Number.isFinite(t) && t >= 0 && t < dur - 0.05))]
    .sort((a, b) => a - b)
    .filter((t, i, arr) => i === 0 || t - arr[i - 1] >= MIN_SCENE_GAP_SEC);

  if (sorted.length >= min) {
    const target = Math.min(max, sorted.length);
    const picked = [];
    for (let i = 0; i < target; i += 1) {
      const idx = target === 1 ? 0 : Math.round((i * (sorted.length - 1)) / (target - 1));
      picked.push(sorted[idx]);
    }
    return { cells: [...new Set(picked)].sort((a, b) => a - b), source: 'scene' };
  }

  const set = new Set(sorted);
  for (let i = 0; i < min; i += 1) set.add(Number(((dur * (i + 0.5)) / min).toFixed(2)));
  const cells = [...set].sort((a, b) => a - b);
  return { cells: cells.slice(0, max), source: sorted.length ? 'mixed' : 'uniform' };
}

/**
 * 把字幕按时间挂到格子上：每格取"覆盖该时刻或最近的下一条"。
 * @param {number[]} cells
 * @param {{from:number,to:number,text:string}[]} subtitles
 * @returns {{at:number,text:string}[]}
 */
export function mapSubtitlesToCells(cells, subtitles) {
  const subs = (Array.isArray(subtitles) ? subtitles : [])
    .map((s) => ({ from: Number(s?.from) || 0, to: Number(s?.to) || 0, text: String(s?.text ?? '').trim() }))
    .filter((s) => s.text);
  const out = [];
  for (const at of cells) {
    const hit = subs.find((s) => at >= s.from && at <= s.to)
      ?? subs.filter((s) => s.from >= at).sort((a, b) => a.from - b.from)[0];
    if (hit) out.push({ at, text: hit.text.slice(0, 120) });
  }
  return out;
}

/**
 * 响度序列（每 ~5s 一个 0..1 值）压成文字摘要：只写 3–5 段，别啰嗦。
 * @param {{from:number,to:number,level:number}[]} segments
 */
export function summarizeLoudness(segments) {
  const segs = (Array.isArray(segments) ? segments : [])
    .map((s) => ({ from: Number(s?.from) || 0, to: Number(s?.to) || 0, level: Math.max(0, Math.min(1, Number(s?.level) || 0)) }))
    .filter((s) => s.to > s.from);
  if (!segs.length) return '';
  // 合并相邻同类（安静 <0.15 / 一般 <0.45 / 明显 >=0.45）
  const kind = (v) => (v < 0.15 ? '安静' : v < 0.45 ? '有声音' : '人声/音乐明显');
  const merged = [];
  for (const s of segs) {
    const k = kind(s.level);
    const last = merged[merged.length - 1];
    if (last && last.kind === k && s.from - last.to <= 6) last.to = s.to;
    else merged.push({ from: s.from, to: s.to, kind: k, level: s.level });
  }
  // 只保留 5 段最重要的：按长度排序取前 5，再按时间排
  const top = [...merged].sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 5).sort((a, b) => a.from - b.from);
  return `响度：${top.map((s) => `${formatTs(s.from)}–${formatTs(s.to)} ${s.kind}`).join('；')}`;
}

/** 拼最终给模型的画面说明（不含标题/评论，那些在 formatLookText 里）。 */
export function formatStoryboardNote({ cells, source, subtitleLines, loudnessLine }) {
  const n = Array.isArray(cells) ? cells.length : 0;
  if (!n) return '';
  const why = source === 'scene' ? '按镜头切换' : source === 'mixed' ? '镜头切换+均匀补点' : '均匀采样';
  const lines = [`附 1 张分镜图（${n} 格，${why}，每格左上角是时间戳；按从左到右、从上到下看）`];
  if (Array.isArray(subtitleLines) && subtitleLines.length) {
    lines.push(`字幕片段：${subtitleLines.slice(0, 8).map((x) => `${formatTs(x.at)} ${x.text}`).join(' / ')}`);
  }
  if (loudnessLine) lines.push(loudnessLine);
  return lines.join('\n');
}
