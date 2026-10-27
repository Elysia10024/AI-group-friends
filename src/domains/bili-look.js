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
      const interval = Math.max(1, Number(o.frameIntervalSec) || 2);
      // 关键：DSH 的图片准入上限是 20 张/次，直接回一帧一张会被整批拒绝
      // （model 只看到 98 条 [image unavailable]）。所以按 5×4=20 帧拼成一张图，
      // 帧数照旧每 2 秒一张，图片数降到 4~8 张。
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

  /**
   * 看一个 BV：标题/简介/热度前 5 评论 + 截图（不含分享者/配额）。
   * 群友分享（look）和她自己浏览（bili-scroll）共用这一层。
   * @param {string} bv
   * @param {{withFrames?:boolean|null}} [options]
   */
  async function watchBv(bv, { withFrames = null } = {}) {
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
    const wantFrames = withFrames === null ? o.withFrames !== false : !!withFrames;
    if (wantFrames) {
      const fr = await extractFrames(bv);
      images = fr.images;
      framesNote = fr.note;
      if (images.length) text += `\n（附 ${images.length} 张拼图：每张 20 帧，按时间从左到右、从上到下）`;
      if (framesNote) text += `\n（画面没抽出来：${framesNote}）`;
    }
    return { text, images, framesNote, view, comments };
  }

  /**
   * 看一条群友分享的视频。
   * @param {object} [options]
   * @param {boolean|null} [options.withFrames] true=抽帧；null/不传=按配置（默认开，每 2 秒一帧）
   * @returns {Promise<{text:string,bv:string,sharer:object,images:Array,framesNote?:string}>}
   */
  async function look(key, url, { withFrames = null } = {}) {
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

    const out = await watchBv(bv, { withFrames });

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

  return { look, watchBv, status, recordHistory };
}
