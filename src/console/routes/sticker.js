// 控制台路由：sticker 域（2 段，共 10 条路由）。
//
// 由 scripts/split-console-domains.mjs从 src/console/server.js 切出来。函数正文与原实现逐字相同，
// 只有两处机械改动：
//   1. 路由块里退出请求处理器的 `return;` → `return true;`（告诉分发器"已处理"）；
//   2. 整体缩进从 6 格降到 2 格。
//
// **段与段的调用顺序不能动**：链里有正则兜底路由（/api/slang/:id(/confirm|/reject)?），
// 它依赖自己在链里的位置。server.js 里按原始顺序依次调用这些段函数。
//
// ctx 来自 server.js：
//   Object.assign(Object.create(deps), { req, res, url, sendJson, readBody, gateSendTool })
// 用 Object.create(deps) 而不是展开，是为了让 deps 上的 get/set 访问器继续生效。

/**
 * 覆盖 4 条路由，原 L1928–L2016
 */
export async function handleSticker1(ctx) {
  const {
    MAX_MEDIA_BYTES,
    MAX_MEDIA_PIXELS,
    ROOT,
    agentTokenOk,
    applyStickerNoteV2,
    fs,
    getImageDimensions,
    getLibraryImageData,
    getStickerImageData,
    listLibraryImages,
    log,
    mimeFromBuffer,
    mimeFromUrl,
    path,
    readBody,
    req,
    safeFetchBuffer,
    saveIncomingImage,
    sendJson,
    setStickerRemarkV2,
    stickerEnabled,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

    if (await routeStickerImage()) return true;
    if (routeSelfImage()) return true;
    if (await routeStickerNote()) return true;
    if (await routeStickerRemark()) return true;
    if (await routeImageList()) return true;
    if (await routeImageFile()) return true;
    if (await routeSaveImage()) return true;

  return false;

  /**
   * 把**群友发的图**存进本地图库（POST /api/socialV2/save-image）。
   * 为什么要有它：这套图库原本只能"管理员往文件夹里丢图"，她看见好图只能干看着
   * （2026-10-12 主人要求补上）。门控沿用 collectSticker 那一档 —— 对她来说都是"把别人的图收进自己兜里"。
   */
  async function routeSaveImage() {
    if (req.method !== 'POST' || url.pathname !== '/api/socialV2/save-image') return false;
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const messageRef = String(body.messageId ?? body.seq ?? '').trim();
    const name = String(body.name ?? '').trim();
    if (!key || !messageRef || !name) { sendJson({ ok: false, error: 'key / messageId / name 都不能为空' }, 400); return true; }
    if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_save_image' }, 403); return true; }
    try {
      const saved = await saveIncomingImage(key, messageRef, { name, tags: body.tags, desc: body.desc, verdict: body.verdict });
      log(`[图库] 存图 ${key}：${saved.entry.name}（${Math.round(saved.bytes / 1024)}KB）`);
      sendJson({ ok: true, key, saved: saved.entry, bytes: saved.bytes, note: '已存进本地图库，下一轮你就能自己发它了' });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  /**
   * 本地图库列表（GET /api/socialV2/image-list）。
   * 跟 QQ 收藏表情（sticker-list）并列：那套在 QQ 云端，这套在 E:\ai群友\image。
   */
  async function routeImageList() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/image-list') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_images' }, 403); return true; }
      const verdict = String(url.searchParams.get('verdict') ?? '').trim();
      const tag = String(url.searchParams.get('tag') ?? '').trim();
      const query = String(url.searchParams.get('query') ?? '').trim();
      const count = Math.max(1, Math.min(200, Number(url.searchParams.get('count')) || 60));
      const images = listLibraryImages({ verdict: verdict || null, tag: tag || null, query: query || null, limit: count });
      sendJson({ ok: true, count: images.length, images });
      return true;
    }
    return false;
  }

  /** 取图库里的图片内容（GET /api/socialV2/image-file?name=…）—— 供模型"先看一眼再发"。 */
  async function routeImageFile() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/image-file') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const name = String(url.searchParams.get('name') ?? '').trim();
      if (!key || !name) { sendJson({ ok: false, error: 'key 和 name 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_view_library_image' }, 403); return true; }
      try {
        const { image, buffer, mimeType } = getLibraryImageData(name);
        sendJson({ ok: true, image: { name: image.name, verdict: image.verdict, tags: image.tags, desc: image.desc, mimeType, data: buffer.toString('base64') } });
      } catch (error) {
        sendJson({ ok: false, error: error?.message ?? String(error) }, 404);
      }
      return true;
    }
    return false;
  }

  async function routeStickerImage() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-image') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const key = String(url.searchParams.get('key') ?? '').trim();
      const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
      if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return true; }
      try {
        const entry = await getStickerImageData(stickerId);
        const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
        const dims = getImageDimensions(fetched.buffer);
        if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
          sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
          return true;
        }
        const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
        sendJson({
          ok: true,
          key,
          sticker: {
            id: entry.id,
            desc: entry.desc || '',
            localNote: entry.localNote || '',
            tags: entry.tags || [],
            url: entry.url,
            md5: entry.md5
          },
          image: { mimeType, data: fetched.buffer.toString('base64') }
        });
      } catch (error) {
        sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }

  function routeSelfImage() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/self-image') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return true; }
      const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
      try {
        if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return true; }
        const buf = fs.readFileSync(selfPath);
        const mimeType = mimeFromBuffer(buf) || 'image/png';
        sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
      } catch (error) {
        sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeStickerNote() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-note') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return true; }
      const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
      const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
      const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
      const entry = applyStickerNoteV2(stickerId, note, tags, usage);
      if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
      log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
      sendJson({ ok: true, key, sticker: entry });
      return true;
    }
    return false;
  }

  async function routeStickerRemark() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/sticker-remark') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return true; }
      try {
        const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
        log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
        sendJson({ ok: true, key, sticker: entry });
      } catch (error) {
        sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }
}

/**
 * 覆盖 6 条路由，原 L2106–L2221
 */
export async function handleSticker2(ctx) {
  const {
    agentTokenOk,
    appendActivity,
    applyStickerNoteV2,
    cfg,
    collectStickerV2,
    deps,
    formatStickerList,
    getSocialV2State,
    log,
    rateLimitCheck,
    readBody,
    req,
    reserveSlots,
    rollbackSlots,
    saveSocialV2State,
    sendJson,
    setStickerRemarkV2,
    stickerEnabled,
    syncStickerLibrary,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

    if (await routeCollectSticker()) return true;
    if (await routeStickerList()) return true;
    if (await routeStickers()) return true;
    if (await routeStickersSync()) return true;
    if (await routeStickersNote()) return true;
    if (await routeStickersRemark()) return true;

  return false;

  async function routeCollectSticker() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const messageRef = String(body.messageId ?? body.seq ?? '').trim();
      const remark = String(body.remark ?? '').trim();
      if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return true; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return true; }
      const st = getSocialV2State(key);
      const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
      if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return true; }
      const now = Date.now();
      if (!rateLimitCheck(st.stickerCollectTimes, {
        maxPerMinute: collectCfg.maxPerMinute,
        maxPerHour: collectCfg.maxPerHour,
        count: 1,
        now
      }).ok) {
        sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
        return true;
      }
      // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
      st.stickerCollectTimes = reserveSlots(st.stickerCollectTimes, { count: 1, now });
      try {
        const result = await collectStickerV2(key, messageRef, remark);
        saveSocialV2State();
        log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
        appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
        sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
      } catch (error) {
        st.stickerCollectTimes = rollbackSlots(st.stickerCollectTimes, { count: 1, now });
        saveSocialV2State();
        log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
        sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeStickerList() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/sticker-list') {
      if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return true; }
      const key = String(url.searchParams.get('key') ?? '').trim();
      const query = String(url.searchParams.get('query') ?? '').trim();
      const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
      const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
      let force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return true; }
      // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
      if (req.headers['x-agent-token'] && force) {
        const now = Date.now();
        if (now - deps.lastForcedAgentStickerSync < 10000) force = false;
        else deps.lastForcedAgentStickerSync = now;
      }
      try {
        const synced = await syncStickerLibrary(force);
        const list = formatStickerList(synced?.entries ?? deps.stickerEntries, query, count);
        sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
      } catch (error) {
        sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeStickers() {
    // 管理端表情库接口（控制台）
    if (req.method === 'GET' && url.pathname === '/api/stickers') {
      const query = String(url.searchParams.get('query') ?? '').trim();
      const maxCount = Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100);
      const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
      const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
      try {
        const synced = await syncStickerLibrary(force);
        const list = formatStickerList(synced?.entries ?? deps.stickerEntries, query, count);
        sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt, fromCache: synced?.fromCache ?? false });
      } catch (error) {
        sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeStickersSync() {
    if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
      try {
        const synced = await syncStickerLibrary(true);
        sendJson({ ok: true, total: synced?.entries?.length ?? deps.stickerEntries.length, syncedAt: synced?.syncedAt ?? deps.stickerSyncedAt });
      } catch (error) {
        sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }

  async function routeStickersNote() {
    if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
      const body = await readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
      const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
      const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
      if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
      const entry = applyStickerNoteV2(stickerId, note, tags, usage);
      if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return true; }
      sendJson({ ok: true, sticker: entry });
      return true;
    }
    return false;
  }

  async function routeStickersRemark() {
    if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
      const body = await readBody();
      const stickerId = String(body.stickerId ?? '').trim();
      if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return true; }
      try {
        const entry = await setStickerRemarkV2(stickerId, String(body.remark ?? ''));
        sendJson({ ok: true, sticker: entry });
      } catch (error) {
        sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
      }
      return true;
    }
    return false;
  }
}
