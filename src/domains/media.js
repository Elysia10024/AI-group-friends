// 媒体处理域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（12 个互相调用的函数）。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 6 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export function createMediaModule(ctx) {
  const {
    cfg,
    fs,
    getSocialV2State,
    log,
    looksLikeImageBuffer,
    path,
    safeFetchBuffer,
  } = ctx;


  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch { /* 按扩展名猜 MIME 只是兜底：猜不出返回 null，由调用方继续用嗅探结果 */ }
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch { /* 图片尺寸解析失败返回 null：尺寸只用于像素上限校验，拿不到就不校验 */ }
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 10; // 单条消息最多内联/返回的图片/表情数（2026-10-19 主人要求 5→10）
  /**
   * 直接喂给视觉模型的单张上限。2026-10-12 从 4MB 放宽到 8MB ——
   * 起因：主人在群里发的那张图 7.5MB，她一直看不到（日志里是"超过大小限制（4194304 字节）"）。
   * 更大的图靠**自动缩放**（见下面 shrinkToVision）：取原料放到 MAX_FETCH_BYTES。
   */
  const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // 单条消息图片总字节上限（喂模型的那一份）
  /** 取"缩放原料"时的上限：比喂模型的那份宽得多，够得着群里的手机原图。 */
  const MAX_FETCH_BYTES = 24 * 1024 * 1024;
  /** 超过这个字节数就缩放（缩放本身要起一次 Python，别为小图白跑）。 */
  const SHRINK_ABOVE_BYTES = 1536 * 1024;
  /** 缩放后的长边（业界常见的视觉友好尺寸）。 */
  const SHRINK_MAX_EDGE = 1568;
  const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  async function fetchOneBotImage(media, { maxBytes = MAX_MEDIA_BYTES } = {}) {
    // 失败时返回 `{ error: '原因' }` 而**不是** null：上层必须能把"为什么没看到图"说清楚。
    // 2026-10-12 主人问"她是不是因为图太大看不到"时才发现：失败被静默吞成"（图片获取失败）"，
    // 她既没法告诉群友、也可能误以为看过了。
    let lastError = '';
    // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
    if (media.kind === 'image' && media.file && isProbablySafeImageFileRef(media.file)) {
      try {
        const info = await ctx.bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          const approx = base64.length * 3 / 4;
          if (approx <= maxBytes) {
            const buf = Buffer.from(base64, 'base64');
            if (buf.length > 0 && looksLikeImageBuffer(buf)) {
              const dims = getImageDimensions(buf);
              if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
                lastError = `像素太多（${dims.width}x${dims.height}）`;
                log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
              } else {
                return { buffer: buf, mimeType: mimeFromBuffer(buf) };
              }
            } else {
              lastError = '网关返回的内容不是有效图片';
            }
          } else {
            lastError = `${(approx / 1024 / 1024).toFixed(1)}MB，超过单张上限 ${Math.round(maxBytes / 1024 / 1024)}MB`;
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(approx / 1024)}KB）`);
          }
        }
        if (obj.url) {
          try {
            const fetched = await safeFetchBuffer(String(obj.url), maxBytes);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              lastError = `像素太多（${dims.width}x${dims.height}）`;
              log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url) };
            }
          } catch (error) {
            lastError = String(error?.message ?? error);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > maxBytes) {
            lastError = `${(stat.size / 1024 / 1024).toFixed(1)}MB，超过单张上限 ${Math.round(maxBytes / 1024 / 1024)}MB`;
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const buf = fs.readFileSync(obj.file);
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              lastError = `像素太多（${dims.width}x${dims.height}）`;
              log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: buf, mimeType: mimeFromBuffer(buf) };
            }
          }
        }
      } catch (error) {
        lastError = String(error?.message ?? error);
        log(`get_image 解析失败: ${lastError}`);
      }
    }
    // 其次直接用消息段里的 URL
    if (media.url) {
      try {
        const fetched = await safeFetchBuffer(String(media.url), maxBytes);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          lastError = `像素太多（${dims.width}x${dims.height}）`;
          log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
        } else {
          return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url) };
        }
      } catch (error) {
        lastError = String(error?.message ?? error);
        log(`图片 URL 抓取失败: ${lastError}`);
      }
    }
    return { error: lastError || '取不到（网关没回内容，或链接已过期）' };
  }

  /**
   * 把大图缩成"视觉友好"的一份（长边 1568 / JPEG 85，见 scripts/shrink-image.py）。
   * 失败就返回 null，让调用方**回退原图** —— 宁可让她看一张可能超限的图，也别因为缩放出问题就什么都看不到。
   */
  async function shrinkToVision(buffer, { maxEdge = SHRINK_MAX_EDGE } = {}) {
    // 用 import.meta.dirname（Node 22+）而不是 new URL(...).pathname —— 后者的中文路径会被 URL 编码成
    // %E7%BE%A4...，拼出来的脚本路径根本不存在（第一版就是这么静默失败的）。
    const script = path.join(import.meta.dirname, '..', '..', 'scripts', 'shrink-image.py');
    const base = path.join(os.tmpdir(), `dsh-shrink-${process.pid}-${Date.now()}`);
    const src = `${base}.img`;
    const dst = `${base}.jpg`;
    try {
      if (!fs.existsSync(script)) { log(`[图片] 找不到缩放脚本（${script}），改用原图`); return null; }
      fs.writeFileSync(src, buffer);
      const configured = String(cfg.media?.pythonPath ?? '').trim();
      // 候选：配置指定的 → Windows 的 py 启动器 → PATH 里的 python → 本机常见安装位置。
      const candidates = [
        configured,
        'py', 'python', 'python3',
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python310', 'python.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Python312', 'python.exe')
      ].filter(Boolean);
      let lastErr = '';
      for (const exe of candidates) {
        try {
          const out = execFileSync(exe, [script, src, dst, String(maxEdge), '85'], { timeout: 30000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          if (/^OK \d+/m.test(String(out)) && fs.existsSync(dst)) {
            const shrunk = fs.readFileSync(dst);
            if (shrunk.length) {
              log(`[图片] 缩放 ${Math.round(buffer.length / 1024)}KB → ${Math.round(shrunk.length / 1024)}KB`);
              return { buffer: shrunk, mimeType: 'image/jpeg' };
            }
            lastErr = '产出为空';
          } else {
            lastErr = `返回异常：${String(out).slice(0, 100)}`;
          }
        } catch (error) {
          lastErr = String(error?.stderr || error?.message || error).slice(0, 140);
        }
      }
      log(`[图片] 缩放不可用（${lastErr}），改用原图`);
      return null;
    } catch (error) {
      log(`[图片] 缩放出错（${error?.message ?? error}），改用原图`);
      return null;
    } finally {
      try { if (fs.existsSync(src)) fs.unlinkSync(src); } catch { /* 清理失败不影响主流程 */ }
      try { if (fs.existsSync(dst)) fs.unlinkSync(dst); } catch { /* 同上 */ }
    }
  }

  /**
   * 取一张图、必要时缩放 —— `resolveMediaList` 与 `fetchMediaData` **共用这一份**
   * （同一件事写两遍就是下一个"改一处漏一处"）。
   *
   * @param {object} media 消息里的媒体元数据
   * @param {number} index 第几张（报错用）
   * @param {{full?:boolean}} [opts] `full=true` = 主人/群友明确要"看原图"：不缩放，上限也放宽
   * @returns {{buffer?:Buffer, mimeType?:string, error?:string}}
   */
  async function prepareImagePart(media, index, { full = false } = {}) {
    const img = await fetchOneBotImage(media, { maxBytes: full ? MAX_MEDIA_BYTES : MAX_FETCH_BYTES });
    if (!img?.buffer) return { error: img?.error || '取不到' };
    let buffer = img.buffer;
    let mimeType = img.mimeType || 'image/jpeg';
    if (!full && buffer.length > SHRINK_ABOVE_BYTES) {
      const shrunk = await shrinkToVision(buffer);
      if (shrunk) { buffer = shrunk.buffer; mimeType = shrunk.mimeType; }
    }
    if (buffer.length > MAX_MEDIA_BYTES) {
      return { error: `${(buffer.length / 1024 / 1024).toFixed(1)}MB，超过单张上限 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB${full ? '（原图就有这么大；让她发张小图，或者别带 full、让我自己缩）' : ''}` };
    }
    return { buffer, mimeType };
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await ctx.bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  async function resolveMediaList(mediaList, { full = false } = {}) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const prep = await prepareImagePart(media, index, { full });
        if (prep.buffer) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[图片${index}（本条消息的图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += prep.buffer.length;
          parts.push({ type: 'text', text: `[图片${index}]` });
          parts.push({ type: 'image', mediaType: prep.mimeType || 'image/jpeg', data: prep.buffer.toString('base64'), name: `qq-image-${index}.${(prep.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `[图片${index}（拿不到：${prep.error}）]` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList, { full = false } = {}) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const prep = await prepareImagePart(media, index, { full });
        if (prep.buffer) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: '（本条消息的图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            index,
            kind: 'image',
            file: media.file ? String(media.file) : undefined,
            url: media.url ? String(media.url) : undefined,
            mimeType: prep.mimeType || 'image/jpeg',
            data: prep.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ index, kind: 'image', file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined, text: `（获取失败：${prep.error}）` });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (ctx.currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (ctx.currentMode === 'reserved2' || ctx.socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st && Array.isArray(st.recentMessages)) {
          const found = st.recentMessages.find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
          if (found && Array.isArray(found.media)) return found.media;
        }
      } catch { /* 本地最近消息里找不到对应媒体就算没有，属正常情况 */ }
    }
    // 一代/普通模式：messageMediaStore
    const byRef = ctx.messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }


  return { mimeFromBuffer, mimeFromUrl, getImageDimensions, base64FromMaybe, isSafeLocalMediaPath, isProbablySafeImageFileRef, fetchOneBotImage, fetchFaceMedia, resolveMediaList, fetchMediaData, mediaHintFor, findMessageMedia, MAX_MEDIA_COUNT, MAX_MEDIA_BYTES, MAX_MEDIA_PIXELS, MAX_MEDIA_STORE_PER_KEY };
}
