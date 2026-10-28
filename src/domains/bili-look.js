// 「看群友分享的 B 站视频」域：解析 BV、找分享者、校验每人每日配额、抓简介+热评。
//
// 为什么放在桥接里而不是直接给她 videoread 工具：
// 用户要求「每个群友每天只能让她看一次」—— 这是硬配额，必须在能看到“谁发的链接”的地方做。
// MCP 工具拿不到消息发送者，只有桥接的会话状态里有 recentMessages（含 userId/sender）。
//
// 数据源：view（匿名可）+ x/v2/reply/wbi/main（需要 SESSDATA + buvid3/4 + WBI）。
// 只读，不点赞不评论。
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BILI_LOOK_DEFAULTS, extractBv, pickSharer, quotaAllowed, bumpQuota, formatLookText } from '../core/bili-look.js';
import { selectCells, formatTs, mapSubtitlesToCells, summarizeLoudness, formatStoryboardNote } from '../core/storyboard.js';
import { appendNote, makeNote } from '../core/bili-notes.js';
import { signWbi } from '../core/bilibili.js';
import { localDayKey } from '../core/local-day.js';

const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CRED_TTL_MS = 10 * 60 * 1000;

export function createBiliLookModule(ctx) {
  const { cfg, log, stateDir, readJsonSafe, atomicWriteJson, getSocialV2State } = ctx;
  const stateFile = path.join(stateDir, 'bili-look.json');
  const cookieFile = path.join(stateDir, 'bilibili-cookie.json');
  // 看过的视频笔记（2026-10-27）：和自刷共用 state/bili-notes.json，source 标 share。
  const notesFile = path.join(stateDir, 'bili-notes.json');

  let state = readJsonSafe(stateFile, { version: 1, look: {} });
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = { version: 1, look: {} };
  if (!state.look || typeof state.look !== 'object' || Array.isArray(state.look)) state.look = {};
  if (!Array.isArray(state.history)) state.history = [];

  let cred = null;

  const opts = () => ({ ...BILI_LOOK_DEFAULTS, ...(cfg.biliLook ?? {}) });

  function save() {
    state.version = 1;
    atomicWriteJson(stateFile, state);
  }

  /** 记一条“看过”：控制台展示用（最近 200 条）。 */
  function recordHistory(entry) {
    state.history.push({ at: Date.now(), ...entry });
    if (state.history.length > 200) state.history = state.history.slice(-200);
    save();
  }

  /** 控制台用：今天的观看历史 + 按群/人的分享配额。 */
  function status() {
    const quotas = [];
    for (const [key, byWho] of Object.entries(state.look ?? {})) {
      for (const [who, rec] of Object.entries(byWho ?? {})) {
        quotas.push({
          key,
          who,
          day: rec?.day ?? '',
          count: Math.max(0, Number(rec?.count) || 0),
          lastBv: rec?.lastBv ?? '',
          at: Number(rec?.at) || 0
        });
      }
    }
    const history = [...(state.history ?? [])];
    for (const [key, byWho] of Object.entries(state.look ?? {})) {
      for (const [who, rec] of Object.entries(byWho ?? {})) {
        const at = Number(rec?.at) || 0;
        const bv = rec?.lastBv ?? '';
        if (!at || !bv) continue;
        // 旧记录只有 BV/时间（没有标题/来源），回填一条，保证“今天看了什么”至少能看到 BV。
        if (!history.some((h) => h.at === at && h.bv === bv)) {
          history.push({ at, bv, title: '', source: 'share', key, sharer: { userId: who, sender: '' }, frames: 0 });
        }
      }
    }
    history.sort((a, b) => Number(a.at) - Number(b.at));
    const today = localDayKey();
    return {
      history: history
        .filter((h) => localDayKey(Number(h.at) || 0) === today)
        .slice(-100)
        .reverse(),
      quotas,
      limits: { dailyPerUser: Number(opts().dailyPerUser) || 1, ownerBypass: opts().ownerBypass !== false },
      ownerQQ: String(cfg.ownerQQ ?? '')
    };
  }

  async function getJson(url, headers) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`B 站返回非 JSON（HTTP ${res.status}）`);
    }
  }

  async function getCred(force = false) {
    if (cred && !force && Date.now() - cred.at < CRED_TTL_MS) return cred;
    const sessdata = String(readJsonSafe(cookieFile, null)?.sessdata ?? '').trim();
    if (!sessdata) throw new Error('缺 SESSDATA：state/bilibili-cookie.json');
    const spi = await getJson('https://api.bilibili.com/x/frontend/finger/spi', {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/'
    });
    const b3 = String(spi?.data?.b_3 ?? '');
    const b4 = String(spi?.data?.b_4 ?? '');
    const cookie = [
      `SESSDATA=${sessdata}`,
      b3 && `buvid3=${b3}`,
      b4 && `buvid4=${b4}`,
      `b_nut=${Math.round(Date.now() / 1000)}`
    ].filter(Boolean).join('; ');
    const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      cookie,
      referer: 'https://www.bilibili.com/'
    });
    if (nav?.code !== 0 || nav?.data?.isLogin !== true) {
      throw new Error('B 站登录态无效（SESSDATA 过期？）');
    }
    const imgUrl = String(nav?.data?.wbi_img?.img_url ?? '');
    const subUrl = String(nav?.data?.wbi_img?.sub_url ?? '');
    cred = {
      cookie,
      imgKey: imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0],
      subKey: subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0],
      at: Date.now()
    };
    return cred;
  }

  async function fetchView(bv) {
    const json = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bv)}`, {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      referer: `https://www.bilibili.com/video/${bv}`
    });
    if (json?.code !== 0 || !json?.data) {
      throw new Error(`视频不存在或不可见（code=${json?.code ?? '?'}）`);
    }
    return json.data;
  }

  async function fetchComments(aid, ps) {
    try {
      const c = await getCred();
      const qs = signWbi({ oid: aid, type: 1, mode: 3, plat: 1, ps, pn: 1 }, c.imgKey, c.subKey);
      const json = await getJson(`https://api.bilibili.com/x/v2/reply/wbi/main?${qs}`, {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        cookie: c.cookie,
        referer: 'https://www.bilibili.com/'
      });
      if (json?.code !== 0) return [];
      return (json?.data?.replies ?? []).slice(0, ps).map((r) => ({
        uname: r?.member?.uname ?? '',
        like: r?.like ?? 0,
        content: String(r?.content?.message ?? '')
      }));
    } catch (error) {
      log(`[bili-look] 评论没拿到：${error?.message ?? error}`);
      return [];
    }
  }

  /** 读本地视频时长（ffmpeg -i 的 stderr 里解析）。 */
  async function probeDuration(ffmpeg, file) {
    let stderr = '';
    try {
      await execFileAsync(ffmpeg, ['-hide_banner', '-i', file], { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      stderr = String(error?.stderr ?? '');
    }
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }

  /**
   * 下载低清视频并按固定间隔抽帧（JPEG，宽 640）。
   * 一次 ffmpeg 解码 + fps 滤镜，比逐帧 seek 快得多。
   * 失败不抛：返回 { images: [], note: '原因' }，让调用方降级成纯文字。
   */
  async function extractFrames(bv) {
    const o = opts();
    const py = String(o.pythonPath || '');
    const ff = String(o.ffmpegPath || '');
    if (!py || !ff || !fs.existsSync(py) || !fs.existsSync(ff)) {
      return { images: [], note: '抽帧依赖不在（yt-dlp/ffmpeg 路径）' };
    }
    const dir = path.join(stateDir, 'frames-cache');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${bv}-${Date.now()}`;
    const tpl = path.join(dir, `${stamp}.%(ext)s`);
    const sessdata = String(readJsonSafe(cookieFile, null)?.sessdata ?? '').trim();

    const ytArgs = [
      '-m', 'yt_dlp', '--no-playlist',
      '-f', 'bv*[height<=720]/b[height<=720]/bv*[height<=1280]/b',
      '--add-header', 'Referer:https://www.bilibili.com/',
      ...(sessdata ? ['--add-header', `Cookie: SESSDATA=${sessdata}`] : []),
      '-o', tpl,
      `https://www.bilibili.com/video/${bv}`
    ];
    try {
      await execFileAsync(py, ytArgs, {
        timeout: Math.max(30000, Number(o.downloadTimeoutMs) || 180000),
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      });
    } catch (error) {
      return { images: [], note: `视频没下载下来（${String(error?.message ?? error).slice(0, 80)}）` };
    }

    const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${stamp}.`));
    const video = files[0] ? path.join(dir, files[0]) : '';
    if (!video) return { images: [], note: '下载文件没找到' };

    let duration = 0;
    const images = [];
    try {
      duration = await probeDuration(ff, video);
      if (!duration) return { images: [], note: '读不出视频时长' };
      const interval = Math.max(1, Number(o.frameIntervalSec) || 1);
      // 关键：DSH 的图片准入上限是 20 张/次，直接回一帧一张会被整批拒绝
      // （model 只看到 98 条 [image unavailable]）。所以按 5×4=20 帧拼成一张图，
      // 每秒一张：5 分钟视频 300 帧 → 15 张拼图（每张 5×4=20 帧），仍在单次 20 张图上限内。
      const outPattern = path.join(dir, `${stamp}-t%02d.jpg`);
      await execFileAsync(ff, [
        '-y', '-loglevel', 'error',
        '-i', video,
        '-vf', `fps=1/${interval},scale=320:180,format=yuvj420p,tile=5x4`,
        '-vsync', '0', '-q:v', '3', outPattern
      ], { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      const frames = fs.readdirSync(dir)
        .filter((f) => f.startsWith(`${stamp}-t`) && f.endsWith('.jpg'))
        .sort();
      for (const f of frames) {
        const p = path.join(dir, f);
        images.push({ mimeType: 'image/jpeg', data: fs.readFileSync(p).toString('base64') });
        fs.rmSync(p, { force: true });
      }
    } finally {
      fs.rmSync(video, { force: true });
    }
    return { images, note: images.length ? '' : '帧没抽出来' };
  }

  /** 下载低清视频（分镜/zoom 共用）。 */
  async function downloadVideo(bv) {
    const o = opts();
    const py = String(o.pythonPath || '');
    const ff = String(o.ffmpegPath || '');
    if (!py || !ff || !fs.existsSync(py) || !fs.existsSync(ff)) {
      return { ok: false, note: '抽帧依赖不在（yt-dlp/ffmpeg 路径）' };
    }
    const dir = path.join(stateDir, 'frames-cache');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${bv}-${Date.now()}`;
    const tpl = path.join(dir, `${stamp}.%(ext)s`);
    const sessdata = String(readJsonSafe(cookieFile, null)?.sessdata ?? '').trim();
    try {
      await execFileAsync(py, [
        '-m', 'yt_dlp', '--no-playlist',
        '-f', 'bv*[height<=720]/b[height<=720]/bv*[height<=1280]/b',
        '--add-header', 'Referer:https://www.bilibili.com/',
        ...(sessdata ? ['--add-header', `Cookie: SESSDATA=${sessdata}`] : []),
        '-o', tpl, `https://www.bilibili.com/video/${bv}`
      ], { timeout: Math.max(30000, Number(o.downloadTimeoutMs) || 180000), maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    } catch (error) {
      return { ok: false, note: `视频没下载下来（${String(error?.message ?? error).slice(0, 80)}）` };
    }
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${stamp}.`));
    const video = files[0] ? path.join(dir, files[0]) : '';
    if (!video) return { ok: false, note: '下载文件没找到' };
    return { ok: true, video, dir, stamp, ff };
  }

  /** 场景切点：解析 ffmpeg showinfo 的 pts_time。 */
  async function detectSceneTimes(ff, video) {
    let stderr = '';
    try {
      const r = await execFileAsync(ff, ['-hide_banner', '-i', video, '-an', '-vf', "select='gt(scene,0.3)',showinfo", '-vsync', '0', '-f', 'null', '-'], { timeout: 120000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
      // ffmpeg 正常退出时 showinfo 的输出在 stderr —— 之前只在 catch 里取，导致永远拿不到场景点
      stderr = String(r?.stderr ?? '');
    } catch (error) { stderr = String(error?.stderr ?? ''); }
    const out = [];
    const re = /pts_time:\s*([\d.]+)/g;
    let m;
    while ((m = re.exec(stderr))) out.push(Number(m[1]));
    return out;
  }

  /** 抽指定时刻一帧（320x180）。 */
  async function extractOneFrame(ff, video, at, outFile) {
    await execFileAsync(ff, ['-y', '-loglevel', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-vf', 'scale=320:180', '-q:v', '2', outFile], { timeout: 30000, windowsHide: true });
    return outFile;
  }

  /** 帧左上角写时间戳。 */
  // 字体文件随分镜临时目录复制一份，用**相对路径**调 ffmpeg：Windows 盘符里的冒号
  // 在 drawtext 的 filter 语法里很难转义（实测 7.1 各种写法都会解析失败），绕开最稳。
  const FONT_SRC = 'C:/Windows/Fonts/arial.ttf';
  async function overlayTimestamp(ff, inFile, outFile, ts) {
    // 文本里的冒号同样不用：2:57 → "2m57s"（一样清楚，不用额外字体）。
    const text = String(ts).replace(/:/g, 'm') + 's';
    const dir = path.dirname(inFile);
    if (!fs.existsSync(path.join(dir, 'arial.ttf'))) fs.copyFileSync(FONT_SRC, path.join(dir, 'arial.ttf'));
    const vf = `drawtext=fontfile=arial.ttf:text='${text}':x=6:y=4:fontsize=14:fontcolor=white:box=1:boxcolor=black@0.55`;
    await execFileAsync(ff, ['-y', '-loglevel', 'error', '-i', path.basename(inFile), '-vf', vf, '-q:v', '2', path.basename(outFile)], { cwd: dir, timeout: 30000, windowsHide: true });
    return outFile;
  }

  /** 网格：2-4 帧用 2×2，9 帧 3×3，12 帧 4×3，其余 4×4。 */
  function gridOf(n) {
    if (n <= 4) return { cols: 2, rows: 2 };
    if (n <= 9) return { cols: 3, rows: 3 };
    if (n <= 12) return { cols: 4, rows: 3 };
    return { cols: 4, rows: 4 };
  }
  async function tileGrid(ff, pattern, n, outFile) {
    const { cols, rows } = gridOf(n);
    await execFileAsync(ff, ['-y', '-loglevel', 'error', '-framerate', '1', '-i', pattern, '-vf', `tile=${cols}x${rows}:padding=2:margin=2`, '-frames:v', '1', '-q:v', '3', outFile], { timeout: 60000, windowsHide: true });
    return outFile;
  }

  /** 响度（ebur128）→ 每 5s 一个 0..1 级别。 */
  async function analyzeLoudness(ff, video) {
    let stderr = '';
    try {
      const r = await execFileAsync(ff, ['-hide_banner', '-i', video, '-vn', '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'], { timeout: 120000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
      stderr = String(r?.stderr ?? '');
    } catch (error) { stderr = String(error?.stderr ?? ''); }
    const points = [];
    const re = /t:\s*([\d.]+)\s+M:\s*(-?inf|-?[\d.]+)/g;
    let m;
    while ((m = re.exec(stderr))) {
      if (m[2].includes('inf')) continue;
      points.push({ t: Number(m[1]), db: Number(m[2]) });
    }
    if (!points.length) return [];
    const bucket = new Map();
    for (const pt of points) {
      const k = Math.floor(pt.t / 5) * 5;
      const arr = bucket.get(k) ?? [];
      arr.push(pt.db);
      bucket.set(k, arr);
    }
    return [...bucket.entries()].sort((a, b) => a[0] - b[0]).map(([from, arr]) => {
      const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
      return { from, to: from + 5, level: Math.max(0, Math.min(1, (mean + 40) / 40)) };
    });
  }

  /** B 站字幕（需登录态）；拿不到返回 []。 */
  async function fetchSubtitles(view) {
    try {
      const c = await getCred();
      const cid = Number(view?.cid) || 0;
      if (!cid) return [];
      const json = await getJson(`https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(view.bvid ?? '')}&cid=${cid}`, {
        'user-agent': UA, cookie: c.cookie, referer: 'https://www.bilibili.com/'
      });
      const subs = json?.data?.subtitle?.subtitles ?? [];
      const pick = subs.find((s) => String(s?.lan ?? '').startsWith('zh')) ?? subs[0];
      const url = String(pick?.subtitle_url ?? '');
      if (!url) return [];
      const full = url.startsWith('//') ? `https:${url}` : url;
      const body = await getJson(full, { 'user-agent': UA, referer: 'https://www.bilibili.com/' });
      return (body?.body ?? []).map((x) => ({ from: Number(x.from) || 0, to: Number(x.to) || 0, text: String(x.content ?? '') }));
    } catch (error) {
      log(`[bili-look] 字幕没拿到：${error?.message ?? error}`);
      return [];
    }
  }

  /** 分镜图：一张（9-16 格 + 时间戳）+ 字幕/响度摘要；失败抛错由 watchBv 降级。 */
  async function storyboard(bv, view, durationSec) {
    const cacheDir = path.join(stateDir, 'bili-storyboard');
    fs.mkdirSync(cacheDir, { recursive: true });
    const img = path.join(cacheDir, `${bv}.jpg`);
    const meta = path.join(cacheDir, `${bv}.json`);
    if (fs.existsSync(img) && fs.existsSync(meta)) {
      const m = readJsonSafe(meta, null);
      return { images: [{ mimeType: 'image/jpeg', data: fs.readFileSync(img).toString('base64') }], note: String(m?.note ?? ''), cells: Array.isArray(m?.cells) ? m.cells : [] };
    }
    const dl = await downloadVideo(bv);
    if (!dl.ok) throw new Error(dl.note);
    const tmp = path.join(dl.dir, `${dl.stamp}-sb`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const scenes = await detectSceneTimes(dl.ff, dl.video);
      const { cells, source } = selectCells(scenes, durationSec, { min: 9, max: 16 });
      const frames = [];
      for (let i = 0; i < cells.length; i += 1) {
        const raw = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`);
        const tsd = path.join(tmp, `s${String(i).padStart(2, '0')}.jpg`);
        try {
          await extractOneFrame(dl.ff, dl.video, cells[i], raw);
          await overlayTimestamp(dl.ff, raw, tsd, formatTs(cells[i]));
          frames.push(tsd);
        } catch (error) { log(`[bili-look] 第 ${i} 格抽帧失败：${error?.message ?? error}`); }
      }
      if (frames.length < 6) throw new Error('有效帧太少');
      // tile 需要从 0 开始的连续序号：重命名一遍
      for (let i = 0; i < frames.length; i += 1) {
        const dst = path.join(tmp, `t${String(i).padStart(2, '0')}.jpg`);
        fs.copyFileSync(frames[i], dst);
      }
      await tileGrid(dl.ff, path.join(tmp, 't%02d.jpg'), frames.length, img);
      const subtitles = await fetchSubtitles(view);
      const subtitleLines = mapSubtitlesToCells(cells, subtitles);
      const loud = await analyzeLoudness(dl.ff, dl.video);
      const note = formatStoryboardNote({ cells, source, subtitleLines, loudnessLine: summarizeLoudness(loud) });
      atomicWriteJson(meta, { bv, at: Date.now(), cells, note, source, frames: frames.length });
      return { images: [{ mimeType: 'image/jpeg', data: fs.readFileSync(img).toString('base64') }], note, cells };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响 */ }
      try { fs.rmSync(dl.video, { force: true }); } catch { /* 同上 */ }
    }
  }

  /** 细看一个时间窗：2-4 帧拼一张图。 */
  async function zoom(bv, startSec, endSec) {
    const start = Math.max(0, Number(startSec) || 0);
    const end = Math.max(start + 1, Number(endSec) || start + 10);
    const span = Math.min(60, end - start);
    const dl = await downloadVideo(bv);
    if (!dl.ok) throw new Error(dl.note);
    const tmp = path.join(dl.dir, `${dl.stamp}-zm`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const n = span <= 3 ? 2 : span <= 8 ? 3 : 4;
      const files = [];
      for (let i = 0; i < n; i += 1) {
        const at = start + (span * i) / Math.max(1, n - 1);
        const raw = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`);
        const tsd = path.join(tmp, `s${String(i).padStart(2, '0')}.jpg`);
        await extractOneFrame(dl.ff, dl.video, at, raw);
        await overlayTimestamp(dl.ff, raw, tsd, formatTs(at));
        files.push(tsd);
      }
      const out = path.join(tmp, 'zoom.jpg');
      await tileGrid(dl.ff, path.join(tmp, 's%02d.jpg'), files.length, out);
      return {
        images: [{ mimeType: 'image/jpeg', data: fs.readFileSync(out).toString('base64') }],
        text: `第 ${formatTs(start)}–${formatTs(Math.min(start + span, end))} 的 ${n} 帧（每格左上角时间戳）。`
      };
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响 */ }
      try { fs.rmSync(dl.video, { force: true }); } catch { /* 同上 */ }
    }
  }
  /**
   * 看一个 BV：标题/简介/热度前 5 评论 + 截图（不含分享者/配额）。
   * 群友分享（look）和她自己浏览（bili-scroll）共用这一层。
   * @param {string} bv
   * @param {{withFrames?:boolean|null}} [options]
   */
  async function watchBv(bv, { withFrames = null, mode = null } = {}) {
    const o = opts();
    const view = await fetchView(bv);
    const durationSec = Number(view.duration) || 0;
    const maxDuration = Number(o.maxDurationSec) || 300;
    if (maxDuration > 0 && durationSec > maxDuration) {
      throw new Error(`这个视频 ${Math.round(durationSec / 60)} 分钟，超过我只看 ${Math.round(maxDuration / 60)} 分钟的上限`);
    }
    // 评论按热度（x/v2/reply/wbi/main 的 mode=3 就是热度序），只看前 5 条。
    const comments = await fetchComments(Number(view.aid), Math.max(1, Math.min(20, Number(o.maxComments) || 5)));
    let text = formatLookText({
      bv,
      title: view.title,
      owner: view?.owner?.name ?? '',
      desc: view.desc ?? '',
      comments
    });
    let images = [];
    let framesNote = '';
    let usedMode = 'none';
    const wantFrames = withFrames === null ? o.withFrames !== false : !!withFrames;
    if (wantFrames) {
      const prefer = mode || o.mode || 'storyboard';
      if (prefer === 'frames') {
        usedMode = 'frames';
        const fr = await extractFrames(bv);
        images = fr.images;
        framesNote = fr.note;
        if (images.length) text += `\n（附 ${images.length} 张拼图：每张 20 帧，按时间从左到右、从上到下）`;
        if (framesNote) text += `\n（画面没抽出来：${framesNote}）`;
      } else {
        try {
          const sb = await storyboard(bv, view, durationSec);
          usedMode = 'storyboard';
          images = sb.images;
          if (sb.note) text += `\n${sb.note}`;
        } catch (error) {
          // 分镜失败 → 降级逐秒抽帧（不让"省成本"把功能弄没）
          usedMode = 'frames';
          framesNote = `分镜没成功（${String(error?.message ?? error)}），退回逐秒抽帧`;
          const fr = await extractFrames(bv);
          images = fr.images;
          framesNote += fr.note ? `；${fr.note}` : '';
          if (images.length) text += `\n（附 ${images.length} 张拼图：每张 20 帧，按时间从左到右、从上到下）`;
          if (fr.note) text += `\n（画面没抽出来：${fr.note}）`;
        }
      }
    }
    return { text, images, framesNote, view, comments, mode: usedMode };
  }

  /**
   * 看一条群友分享的视频。
   * @param {object} [options]
   * @param {boolean|null} [options.withFrames] true=抽帧；null/不传=按配置（默认开，每秒一帧）
   * @returns {Promise<{text:string,bv:string,sharer:object,images:Array,framesNote?:string}>}
   */
  async function look(key, url, { withFrames = null, mode = null } = {}) {
    const o = opts();
    if (o.enabled === false) throw new Error('看视频功能已关闭（config.biliLook.enabled=false）');
    const input = String(url ?? '').trim();
    let bv = extractBv(input);
    if (!bv && /b23\.tv|bili2233\.cn/i.test(input)) {
      try {
        const res = await fetch(input, {
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
          headers: { 'user-agent': UA }
        });
        bv = extractBv(res.url) || extractBv(await res.text());
      } catch { /* 短链展开失败就按没认出来处理 */ }
    }
    if (!bv) throw new Error('没认出 BV 号：只支持 B 站视频链接/BV 号');
    const st = getSocialV2State(key);
    const sharer = pickSharer(st?.recentMessages, bv) ?? pickSharer(st?.recentMessages, input);
    if (!sharer) {
      throw new Error('最近消息里没有这个视频的分享者：只看看群里有人发过的链接');
    }
    const who = sharer.userId || sharer.sender || '未知';
    const isOwner = String(sharer.userId) === String(cfg.ownerQQ ?? '');
    if (!(isOwner && o.ownerBypass !== false)) {
      const rec = state.look[key]?.[who];
      const day = localDayKey();
      if (!quotaAllowed(rec, day, o.dailyPerUser)) {
        throw new Error(`${sharer.sender} 今天已经让你看过一个视频了，明天再来吧`);
      }
    }

    const out = await watchBv(bv, { withFrames, mode });

    // 成功看到才占配额（请求失败不扣次数）。
    state.look[key] = state.look[key] ?? {};
    const day = localDayKey();
    state.look[key][who] = bumpQuota(state.look[key][who], day, bv);
    save();
    recordHistory({
      bv,
      title: out.view?.title ?? '',
      source: 'share',
      key,
      sharer: { userId: sharer.userId, sender: sharer.sender },
      frames: out.images.length
    });

    // 看过的视频落笔记（内容摘要，source=share）：以后检索/回灌材料用。
    let noted = false;
    try {
      const note = makeNote({
        bv,
        title: out.view?.title ?? '',
        owner: out.view?.owner?.name,
        duration: out.view?.duration,
        desc: out.view?.desc,
        comments: out.comments,
        key,
        source: 'share',
        at: Date.now()
      });
      if (note) {
        const store = readJsonSafe(notesFile, { version: 1, notes: [] });
        const notes = appendNote(Array.isArray(store?.notes) ? store.notes : [], note);
        atomicWriteJson(notesFile, { version: 1, notes });
        noted = true;
        log(`[bili-notes] 记下 ${bv}（分享｜共 ${notes.length} 条）`);
      }
    } catch (error) {
      log(`[bili-notes] 笔记写入失败：${error?.message ?? error}`);
    }

    // 看完引导她**自己**把要记的规则/注意事项写进长期记忆（2026-10-27 用户要求：
    // 视频里的注意事项要她自己学、自动记，不靠人工补记忆）。
    const learnHint = '【看完记一笔】如果视频里有要记住的规则、注意事项或知识点（比如「这几句话别说」「这几步别做」「这个坑别踩」），'
      + '现在就调用 qq_memory_append 记一条（category=activeTopic，写具体内容，别写「视频里讲了些注意事项」这种空话）——'
      + '不记的话这一轮结束就忘了，下次再想起来就来不及了。';

    log(`[bili-look] ${key} 看了 ${bv}（分享者 ${sharer.sender}/${who}${out.images.length ? `，${out.images.length} 帧` : ''}）`);
    return {
      text: `${out.text}\n\n${learnHint}`,
      bv,
      sharer: { userId: sharer.userId, sender: sharer.sender },
      images: out.images,
      noted,
      ...(out.framesNote ? { framesNote: out.framesNote } : {})
    };
  }

  return { look, watchBv, status, recordHistory, zoom };
}
