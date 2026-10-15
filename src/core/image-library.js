// 本地图库的纯逻辑（读文件/发图在 domains 层，这里只做解析、检索、渲染）。
//
// 背景：管理员在 <项目目录>\image 放了一批自己命名的梗图（名字即语义），想让她按语境发。
// 那份 `library.json` 是唯一真相源（她/他都能直接编辑）；这个模块负责：
//   · 校验条目（防路径穿越、防 verdict 写错）
//   · 按名字 / 标签 / 关键词检索
//   · 渲染成材料里那份**紧凑清单**（只给名字+标签，57 张约 900 字，便宜）
//
// 一个真实教训写在这：那批图里 48 张其实是 AVIF 却叫 .jpg —— QQ 发不出去、模型也读不了。
// 所以图库只认 `ready/` 里规范化过的文件（scripts/normalize-images.py 干的活）。

/** 允许出现在图库里的判定值。 */
export const IMAGE_VERDICTS = ['适合', '谨慎', '不适合'];
/** 会被注入材料、且允许发送的判定值（"不适合"只登记、不给她用）。 */
export const SENDABLE_VERDICTS = ['适合', '谨慎'];

/**
 * 文件名的安全校验：只允许"单层文件名"，不允许任何路径分隔符或上跳。
 *
 * 注意别写成 `s.includes('..')` —— 那会把「如果有一天我变成了文件....jpg」这种
 * 正常名字一起毙掉（真被毙过一次，57 张图少一张还没人发现）。禁止上跳只需要
 * 干掉分隔符 + 名字正好是 `.`/`..`，因为单层文件名没有 `/` 就跳不出去。
 * @returns {string|null} 合法则返回原名，否则 null
 */
export function safeImageFile(name) {
  const s = String(name ?? '').trim();
  if (!s) return null;
  if (/[/\\\0]/.test(s)) return null;
  if (s === '.' || s === '..') return null;
  if (s.startsWith('.')) return null;
  // Windows 会吃掉结尾的点和空格（`foo.` 与 `foo` 指向同一文件），容易撞名，直接拒。
  if (/[. ]$/.test(s)) return null;
  if (s.length > 120) return null;
  return s;
}

/**
 * 解析 library.json 的内容。
 * @returns {{ images: Array, errors: string[] }}
 */
export function parseImageLibrary(raw) {
  const errors = [];
  const list = Array.isArray(raw?.images) ? raw.images : [];
  const images = [];
  const seen = new Set();
  for (const item of list) {
    const name = String(item?.name ?? '').trim();
    const file = safeImageFile(item?.file);
    if (!name || !file) { errors.push(`跳过条目（name/file 不合法）：${JSON.stringify(item).slice(0, 80)}`); continue; }
    if (seen.has(name)) { errors.push(`重名条目：${name}`); continue; }
    const verdict = IMAGE_VERDICTS.includes(item?.verdict) ? item.verdict : '谨慎';
    if (!IMAGE_VERDICTS.includes(item?.verdict)) errors.push(`verdict 缺失/非法，按"谨慎"处理：${name}`);
    seen.add(name);
    images.push({
      name,
      file,
      verdict,
      reason: String(item?.reason ?? '').trim(),
      desc: String(item?.desc ?? '').trim(),
      tags: Array.isArray(item?.tags) ? item.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      // 谁加的：admin = 管理员命名（缺省）；her = 小鲸鱼自己用 qq_save_image 存进来的。
      // 分出来是为了她那份收藏能一眼认出来（清理、审计、看她的图库长没长都用得上）。
      by: item?.by === 'her' ? 'her' : 'admin'
    });
  }
  return { images, errors };
}

/** 能不能发（"不适合"不许发）。 */
export function isSendable(image) {
  return !!image && SENDABLE_VERDICTS.includes(image.verdict);
}

/** 按名字找图：支持全名、去掉扩展名的文件名、以及唯一子串。 */
export function findImage(images, ref) {
  const want = String(ref ?? '').trim();
  if (!want) return null;
  const list = Array.isArray(images) ? images : [];
  const exact = list.find((i) => i.name === want);
  if (exact) return exact;
  const noExt = want.replace(/\.[a-z0-9]{2,5}$/i, '');
  const byFile = list.find((i) => i.file === want || i.file.replace(/\.[a-z0-9]{2,5}$/i, '') === noExt);
  if (byFile) return byFile;
  const lower = want.toLowerCase();
  const partial = list.filter((i) => i.name.toLowerCase().includes(lower) || lower.includes(i.name.toLowerCase()));
  return partial.length === 1 ? partial[0] : null;
}

/** 按标签/关键词/判定过滤。 */
export function filterImages(images, { verdict = null, tag = null, query = null, limit = 60 } = {}) {
  const t = String(tag ?? '').trim();
  const q = String(query ?? '').trim().toLowerCase();
  return (Array.isArray(images) ? images : [])
    .filter((i) => !verdict || i.verdict === verdict)
    .filter((i) => !t || i.tags.some((x) => x.includes(t)))
    .filter((i) => !q || i.name.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q) || i.tags.some((x) => x.toLowerCase().includes(q)))
    .slice(0, Math.max(1, limit));
}

/**
 * 渲染材料里那份紧凑清单。**只列名字+标签**（描述太长，五十多张会吃掉上下文）。
 *
 * 2026-10-12 调整（主人发现她几乎不发图）：
 *   · 标题不再写"不确定先看一眼"——那道坎让她宁可不发；改成"名字对得上就直接发"；
 *   · **"谨慎"档不再逐个列名字**，只报数量（它们本来就"只在很合适的场合发"，
 *     列出来反而像在推荐），要用时她自己 `qq_list_images verdict=谨慎` 查；
 *   · 标签默认取 2 个（原来 3 个），清单更短。
 */
export function imageIndexText(images, { maxTags = 2 } = {}) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return '';
  const fmt = (i) => {
    const tags = i.tags.slice(0, maxTags).join('/');
    return tags ? `${i.name}(${tags})` : i.name;
  };
  const safe = list.filter((i) => i.verdict === '适合');
  const caution = list.filter((i) => i.verdict === '谨慎');
  const banned = list.filter((i) => i.verdict === '不适合');
  const lines = ['【能发的图（本地图库，名字就是它的意思；发图用 qq_send_image，名字对得上就直接发）】'];
  if (safe.length) lines.push(`可直接发：${safe.map(fmt).join('、')}`);
  if (caution.length) lines.push(`另有 ${caution.length} 张带水印/易引战的（只在很合适时用，需要时用 qq_list_images 查"谨慎"档）`);
  if (banned.length) lines.push(`不许发（${banned.length} 张）：${banned.map((i) => i.name).join('、')}`);
  return lines.join('\n');
}

/** MIME → 扩展名。只收这四种：AVIF 那批图 QQ 发不出去、模型也读不了（见文件头那段教训）。 */
export function pickImageExt(mimeType) {
  const m = String(mimeType ?? '').toLowerCase().split(';')[0].trim();
  if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  return '';
}

/**
 * 从字节魔数认图片格式。QQ 网关（get_image）不一定回 mimeType，靠字节最可靠。
 * 认不出就返回 ''（调用方一律拒绝 —— 存进去发不出去的图就是垃圾）。
 */
export function extFromBuffer(buffer) {
  const b = buffer;
  if (!b || b.length < 12) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return '.png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return '.gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return '.webp';
  return '';
}

/** 她给图起名时的规范化：挡掉文件系统不认的字符，去掉首尾空白，长度上限 30。 */
export function normalizeImageName(value) {
  const s = String(value ?? '').replace(/[/\\\0:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, 30);
}

/**
 * 造一条图库条目（她保存群友的图时用）。名字要短——"名字就是它的意思"是这套图库的设计前提。
 * @returns {{ok:boolean, entry?:object, error?:string}}
 */
export function buildLibraryEntry({ name, ext, tags = [], desc = '', verdict = '适合', reason = '', by = 'admin' } = {}) {
  const clean = normalizeImageName(name);
  if (!clean) return { ok: false, error: '得给它起个名字（短一点，名字就是它的意思）' };
  if (!/^\.(jpg|png|webp|gif)$/.test(String(ext ?? ''))) {
    return { ok: false, error: '不支持的图片格式（只收 jpg / png / webp / gif）' };
  }
  return {
    ok: true,
    entry: {
      name: clean,
      file: `${clean}${ext}`,
      verdict: IMAGE_VERDICTS.includes(verdict) ? verdict : '适合',
      reason: String(reason ?? '').trim().slice(0, 80),
      desc: String(desc ?? '').trim().slice(0, 120),
      tags: (Array.isArray(tags) ? tags : [tags]).map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 6),
      by: by === 'her' ? 'her' : 'admin'
    }
  };
}

/**
 * 把新条目追加进 library.json（**不改入参**，返回新对象）。同名直接拒——
 * 名字是她在材料里认图的唯一凭据，重名会让 findImage 变成掷骰子。
 * @returns {{ok:boolean, raw?:object, error?:string}}
 */
export function appendImageEntry(raw, entry) {
  const list = Array.isArray(raw?.images) ? raw.images.slice() : [];
  const name = String(entry?.name ?? '').trim();
  if (!name) return { ok: false, error: '条目缺名字' };
  if (list.some((i) => String(i?.name ?? '').trim() === name)) {
    return { ok: false, error: `图库里已经有叫「${name}」的了，换个名字` };
  }
  return { ok: true, raw: { ...(raw && typeof raw === 'object' ? raw : {}), images: list.concat([entry]) } };
}
