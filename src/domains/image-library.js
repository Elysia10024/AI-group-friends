// 本地图库域：把 <项目根>\image 里那批"管理员命名的梗图"接进她的工具链。
//
// 与表情包（QQ 收藏表情）的区别：那套走 QQ 云端，加一张图要上传到 QQ 收藏、受 QQ 格式限制；
// 这套是**本地文件夹**——加图就是丢个文件、改名就是改文件名，`library.json` 里写一句备注即可。
//
// 发送方式：读文件 → base64 → OneBot `send_group_msg/send_private_msg` 的 image 段。
// 为什么用 base64 而不是本地路径：OneBot 的 `file://` 本地路径在多数实现里被限制/沙箱化，
// base64 是各实现都认的通用做法（我们的图规范化后 ≤240KB，base64 约 320KB，没问题）。
import fs from 'node:fs';
import path from 'node:path';
import { parseImageLibrary, findImage, filterImages, imageIndexText, isSendable, safeImageFile, pickImageExt, extFromBuffer, buildLibraryEntry, appendImageEntry } from '../core/image-library.js';

const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
/**
 * 图库单张上限，**存图和发图共用同一个数**。
 * 为什么必须是同一个（2026-10-12 主人问"她存的图能发出去吗"时查出来的）：
 * 之前存图 6MB、发图 4MB —— 4~6MB 那段会出现"存得下、发不出去"的图，那对她来说就是垃圾。
 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export function createImageLibraryModule(ctx) {
  const {
    ROOT,
    cfg,
    log,
    sleep,
  } = ctx;

  /** 图库根目录（默认兄弟目录 ../image，可用 cfg.imageLibrary.dir 覆盖）。 */
  function libraryDir() {
    const custom = String(cfg.imageLibrary?.dir ?? '').trim();
    return custom ? path.resolve(ROOT, custom) : path.resolve(ROOT, '..', 'image');
  }
  function readyDir() { return path.join(libraryDir(), 'ready'); }
  function libraryFile() { return path.join(libraryDir(), 'library.json'); }

  let cache = null;   // { mtimeMs, images, errors, dir }

  /** 读图库（按 mtime 缓存；改了 library.json 下一轮就生效，不用重启）。 */
  function loadLibrary() {
    const file = libraryFile();
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* 没有文件 */ }
    if (cache && cache.mtimeMs === mtimeMs) return cache;
    let images = [];
    let errors = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const parsed = parseImageLibrary(raw);
      images = parsed.images;
      errors = parsed.errors;
    } catch (error) {
      errors = [`读取图库失败：${error?.message ?? error}`];
    }
    if (errors.length) log?.(`[图库] ${errors.length} 条问题：${errors.slice(0, 3).join('；')}`);
    cache = { mtimeMs, images, errors, dir: libraryDir() };
    return cache;
  }

  function listImages(opts = {}) {
    return filterImages(loadLibrary().images, opts);
  }

  /** 取图片二进制（供发送/预览）。只允许 ready/ 下的白名单扩展名，且必须存在于 library.json。 */
  function readImageData(ref) {
    const lib = loadLibrary();
    const image = findImage(lib.images, ref);
    if (!image) throw new Error(`图库里没有「${String(ref).slice(0, 30)}」这张图（可用 qq_list_images 看全部名字）`);
    const file = safeImageFile(image.file);
    if (!file) throw new Error(`图库条目文件名不合法：${image.file}`);
    const full = path.join(readyDir(), file);
    const ext = path.extname(full).toLowerCase();
    const mimeType = MIME_BY_EXT[ext];
    if (!mimeType) throw new Error(`不支持的图片格式：${ext}（图库只放 jpg/png/webp/gif；AVIF 请先用 scripts/normalize-images.py 转一下）`);
    const buffer = fs.readFileSync(full);
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`图片太大（${Math.round(buffer.length / 1024)}KB > ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）`);
    return { image, buffer, mimeType, bytes: buffer.length };
  }

  /** 材料里那份紧凑清单。 */
  function indexText() {
    return imageIndexText(loadLibrary().images);
  }

  async function postOneBot(action, params) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(20000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指到了 WebSocket 端口）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  /**
   * 从图库发一张图。
   * @param {string} key 会话键 group:xxx / private:xxx
   * @param {string} ref 图片名字（library.json 里的 name，或文件名）
   */
  async function sendLibraryImage(key, ref, options = {}) {
    const { image, buffer, mimeType } = readImageData(ref);
    if (!isSendable(image)) {
      throw new Error(`「${image.name}」被标记为不许发（${image.reason || '管理员判定'}），换一张`);
    }
    const [kind, id] = String(key).split(':');
    const segments = [];
    if (options.replyToMessageId !== undefined && options.replyToMessageId !== null && String(options.replyToMessageId).trim() !== '') {
      const rid = String(options.replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (options.atUserId !== undefined && options.atUserId !== null && String(options.atUserId).trim() !== '') {
      const at = String(options.atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'image', data: { file: `base64://${buffer.toString('base64')}` } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };

    // 与文字/表情共用 sendChain：保证"先说话再发图"的真人顺序不被并发工具调用打乱。
    let resolveOut; let rejectOut;
    const result = new Promise((resolve, reject) => { resolveOut = resolve; rejectOut = reject; });
    ctx.sendChain = ctx.sendChain.then(async () => {
      try {
        await sleep(ctx.randInt(600, 1600));   // 真人发图前会有一下停顿
        resolveOut(await postOneBot(action, params));
      } catch (error) {
        rejectOut(error);
      }
    });
    const data = await result;
    log?.(`[图库] 发送「${image.name}」(${Math.round(buffer.length / 1024)}KB ${mimeType}) 到 ${key}`);
    return { image, messageId: data?.message_id ?? null, bytes: buffer.length, mimeType };
  }

  /** 图库总张数上限（主人关心存储成本：超了让她先删）。单张上限见文件头的 MAX_IMAGE_BYTES（存/发共用）。 */
  const MAX_LIBRARY_IMAGES = 200;

  /**
   * 把**群友发的图**存进本地图库（2026-10-12 主人要求："她也能保存群友发的图"）。
   *
   * 取字节一律走 fetchOneBotImage / fetchFaceMedia —— **绝不允许**把 media.url 直接交给 OneBot 去下载
   * （那会绕过 SSRF/本地文件防护，domains/sticker.js 里那条注释说的就是这个）。
   * 落盘顺序：先写图，再改 library.json —— 反过来的话，一旦图写失败，图库里就会多一条指向空文件的死条目。
   */
  async function saveIncomingImage(key, messageRef, { name, tags, desc, verdict } = {}) {
    const st = ctx.getSocialV2State?.(key);
    if (!st) throw new Error('拿不到这个会话的状态');
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息（messageId/seq 要对，而且得是这个会话里的）');
    if (found.isSelf) throw new Error('那是你自己发的图，不用存');
    const media = (Array.isArray(found.media) ? found.media : [])[0];
    if (!media) throw new Error('这条消息里没有图');

    // 取字节：优先走 OneBot get_image（QQ 网关，比 URL 可靠 —— 消息里的图片 URL 带签名、几小时就过期）。
    // **这里刻意不走 media 模块那条 4MB 的看图上限**：看图是喂视觉模型的（有它自己的限制），
    // 存图只是落盘，群友发的原图（>4MB）也该存得下。只放宽大小，不放宽安全：
    // 仍然只用"安全缓存文件名"去问网关，绝不把 media.url 交给 OneBot（那是 SSRF 口子）。
    let buffer = null;
    let mimeType = '';
    const fileRef = String(media.file ?? '');
    const safeRef = fileRef && !fileRef.includes('..') && /^[\w.+=@-]+$/.test(fileRef);
    if (media.kind === 'image' && safeRef && ctx.bot?.getImage) {
      try {
        const info = await ctx.bot.getImage({ file: fileRef });
        const raw = info?.data || info?.base64
          || (typeof info?.file === 'string' && info.file.startsWith('base64://') ? info.file.slice('base64://'.length) : '');
        if (raw) {
          const buf = Buffer.from(String(raw), 'base64');
          if (buf.length) { buffer = buf; mimeType = String(info?.mimeType ?? ''); }
        }
        // 多数实现的 get_image 只回一个**临时下载地址**（实测字段：file/url/file_size/file_name）——
        // 那就自己抓，但用 safeFetchBuffer（带 SSRF 白名单校验），并把上限放到存图这一档。
        if (!buffer && info?.url && ctx.safeFetchBuffer) {
          const got = await ctx.safeFetchBuffer(String(info.url), MAX_IMAGE_BYTES);
          if (got?.buffer?.length) { buffer = got.buffer; mimeType = String(got.mimeType ?? ''); }
        }
      } catch (error) {
        log?.(`[图库] get_image 取图失败（继续试别的路）：${error?.message ?? error}`);
      }
    }
    if (!buffer) {
      const got = media.kind === 'face' ? await ctx.fetchFaceMedia(media) : await ctx.fetchOneBotImage(media);
      buffer = got?.buffer ?? null;
      mimeType = String(got?.mimeType ?? media.mimeType ?? '');
    }
    if (!buffer || !buffer.length) throw new Error('取不到这张图的字节（链接可能过期了；她在刚看到那张图时存最稳）');
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`这张图太大（${Math.round(buffer.length / 1024)}KB），存不下`);
    const ext = pickImageExt(mimeType) || extFromBuffer(buffer);
    const built = buildLibraryEntry({ name, ext, tags, desc, verdict, by: 'her' });
    if (!built.ok) throw new Error(built.error);

    const lib = loadLibrary();
    if (lib.images.length >= MAX_LIBRARY_IMAGES) {
      throw new Error(`图库已经 ${lib.images.length} 张了（上限 ${MAX_LIBRARY_IMAGES}），先删几张再存`);
    }
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(libraryFile(), 'utf8')); } catch { raw = { note: '小鲸鱼的本地图库。', images: [] }; }
    const appended = appendImageEntry(raw, built.entry);
    if (!appended.ok) throw new Error(appended.error);

    fs.mkdirSync(readyDir(), { recursive: true });
    const target = path.join(readyDir(), built.entry.file);
    if (fs.existsSync(target)) throw new Error(`ready/ 里已经有同名文件「${built.entry.file}」`);
    fs.writeFileSync(`${target}.tmp`, buffer);
    fs.renameSync(`${target}.tmp`, target);
    fs.writeFileSync(`${libraryFile()}.tmp`, JSON.stringify(appended.raw, null, 2), 'utf8');
    fs.renameSync(`${libraryFile()}.tmp`, libraryFile());
    cache = null;   // 立刻生效（同一毫秒内 mtime 可能不变，别等下一轮）
    log?.(`[图库] 存了群友的图「${built.entry.name}」（${Math.round(buffer.length / 1024)}KB｜${built.entry.tags.join('/')}）`);
    return { entry: built.entry, bytes: buffer.length };
  }

  return { loadLibrary, listImages, readImageData, indexText, sendLibraryImage, saveIncomingImage, libraryDir, readyDir };
}
