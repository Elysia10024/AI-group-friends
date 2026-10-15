// 控制台路由：QQ 空间说说（她自己发 + 只读别人空间 + 回自己说说下的评论）。
//
// 8 条路由：
//   POST /api/socialV2/post-mood          发一条（可配一张图库里的图）
//   POST /api/socialV2/delete-mood        删一条（按 tid）
//   GET  /api/socialV2/mood-list          看她/好友空间里的说说（真问 QQ 空间）
//   GET  /api/socialV2/mood-comments      读一条说说的评论（含楼中楼）
//   POST /api/socialV2/mood-comment       回一条评论（只回她自己说说的）
//   GET  /api/socialV2/mood-new-comments  查一次"有没有新评论"（平时是桥的轮询在做）
//   GET  /api/socialV2/qzone-feeds        好友动态
//   GET  /api/socialV2/mood-status        本地账本 + 额度（控制台面板用，只读）
//
// 带 agent token 的路由走 `gateSendTool`：它一次把 agent token / 模式准入 / 工具开关 /
// reserved2 门禁 / key 格式 / 白名单全查了 —— 说说是**公开发布**，比群里发一句更需要这层闸门。
// 最后一条（mood-status）是控制台通道：不带 agent token，只读本地账本，不碰 QQ。
//
// 文件头这段是给读代码的人看的：路由里每一处 `v2ToolEnabled('xxx')` 的字面量都被
// scripts/check-tool-flags.mjs 盯着（配置 / 界面 / 代码 / qq_get_prompt 清单四处必须一致）。
export async function handleQzone1(ctx) {
  const {
    gateSendTool,
    readBody,
    req,
    sendJson,
    url,
    postMood,
    deleteMood,
    listMoods,
    getMoodComments,
    listQzoneFeeds,
    replyToComment,
    checkQzoneComments,
    qzoneStatus,
    getSocialV2State,
    log
  } = ctx;

  if (await routePostMood()) return true;
  if (await routeDeleteMood()) return true;
  if (await routeMoodList()) return true;
  if (await routeMoodComments()) return true;
  if (await routeMoodComment()) return true;
  if (await routeMoodNewComments()) return true;
  if (await routeQzoneFeeds()) return true;
  if (routeMoodStatus()) return true;

  return false;

  /** 回一条评论（只能回她自己说说下面的；每条一次 + 窗口限频都在域里兜着）。 */
  async function routeMoodComment() {
    if (req.method !== 'POST' || url.pathname !== '/api/socialV2/mood-comment') return false;
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const tid = String(body.tid ?? '').trim();
    if (!key || !tid) { sendJson({ ok: false, error: 'key 和 tid 都不能为空' }, 400); return true; }
    const gate = gateSendTool(key, 'commentMood', '工具未启用：qq_comment_mood');
    if (!gate) return true;
    try {
      const token = getSocialV2State?.(key)?.agentToken;
      // 四个"回哪条"的线索都往下传：commentKey（精确）/ toUserId / toName / commentText（一段原文）。
      // 少传一个不会报错，只会让"认出是哪条评论"变糊 —— 上一版就漏了 toUserId/commentText，
      // 结果她每次都在回"最新那条"，去重也就永远轮不到（测试里被"重复回居然成功"抓到）。
      const out = await replyToComment(tid, body.content, {
        toName: body.toName,
        toUserId: body.toUserId,
        commentText: body.commentText,
        commentKey: body.commentKey,
        secrets: token ? [String(token)] : []
      });
      sendJson({ ok: true, ...out });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  /** 主动查一次"我的说说下面有没有新评论"（平时由桥的轮询自己做；这条给面板/诊断用）。 */
  async function routeMoodNewComments() {
    if (req.method !== 'GET' || url.pathname !== '/api/socialV2/mood-new-comments') return false;
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    const gate = gateSendTool(key, 'moodComments', '工具未启用：qq_mood_comments');
    if (!gate) return true;
    try {
      const out = await checkQzoneComments();
      // 评论的 `key`（"这条评论"的身份）由域给出来 —— 认评论只有那一处实现，路由不自己拼。
      sendJson({ ok: true, ...out });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  /** 发一条说说（可配一张图）。 */
  async function routePostMood() {
    if (req.method !== 'POST' || url.pathname !== '/api/socialV2/post-mood') return false;
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    const gate = gateSendTool(key, 'postMood', '工具未启用：qq_post_mood');
    if (!gate) return true;
    try {
      // 把会话令牌喂给正文校验：说说是公开的，提示里的令牌绝不能跟着发出去。
      const token = getSocialV2State?.(key)?.agentToken;
      const out = await postMood(body.content, {
        ugcRight: body.ugcRight,
        targetUins: body.targetUins,
        image: body.image,
        secrets: token ? [String(token)] : []
      });
      log(`[说说] 发表成功 ${key}：${String(out.content).slice(0, 30)}（tid=${out.tid || '无'}，今天第 ${out.todayCount} 条`
        + `${out.image ? `，配图 ${out.image.name}` : ''}）`);
      sendJson({
        ok: true,
        tid: out.tid,
        at: out.at,
        content: out.content,
        ugcRight: out.ugcRight,
        ...(out.image ? { image: out.image } : {}),
        todayCount: out.todayCount,
        remainingToday: out.remaining,
        ...(out.note ? { note: out.note } : {})
      });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  /** 删一条说说（只能删自己的）。 */
  async function routeDeleteMood() {
    if (req.method !== 'POST' || url.pathname !== '/api/socialV2/delete-mood') return false;
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const tid = String(body.tid ?? '').trim();
    if (!key || !tid) { sendJson({ ok: false, error: 'key 和 tid 都不能为空' }, 400); return true; }
    const gate = gateSendTool(key, 'deleteMood', '工具未启用：qq_delete_mood');
    if (!gate) return true;
    try {
      const out = await deleteMood(tid);
      log(`[说说] 删除成功 ${key}：tid=${tid}`);
      sendJson({ ok: true, tid: out.tid, ...(out.note ? { note: out.note } : {}) });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  /** 看她/好友空间里的说说（走 OneBot，读的是 QQ 空间的真实状态）。 */
  async function routeMoodList() {
    if (req.method !== 'GET' || url.pathname !== '/api/socialV2/mood-list') return false;
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    const gate = gateSendTool(key, 'listMoods', '工具未启用：qq_list_moods');
    if (!gate) return true;
    try {
      const count = Math.max(1, Math.min(50, Number(url.searchParams.get('count')) || 10));
      const targetUin = String(url.searchParams.get('targetUserId') ?? '').trim();
      const list = await listMoods({ num: count, targetUin: targetUin || undefined });
      sendJson({ ok: true, ...list });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  /** 读一条说说的评论（含楼中楼）—— 走她自己的 cookie 直连空间 CGI。 */
  async function routeMoodComments() {
    if (req.method !== 'GET' || url.pathname !== '/api/socialV2/mood-comments') return false;
    const key = String(url.searchParams.get('key') ?? '').trim();
    const tid = String(url.searchParams.get('tid') ?? '').trim();
    if (!key || !tid) { sendJson({ ok: false, error: 'key 和 tid 都不能为空' }, 400); return true; }
    const gate = gateSendTool(key, 'moodComments', '工具未启用：qq_mood_comments');
    if (!gate) return true;
    try {
      const targetUin = String(url.searchParams.get('targetUserId') ?? '').trim();
      const maxComments = Math.max(1, Math.min(50, Number(url.searchParams.get('maxComments')) || 20));
      const out = await getMoodComments(tid, { targetUin: targetUin || undefined, maxComments });
      sendJson({ ok: true, tid, ...out });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  /** 好友动态（多数时候是空的：她那几个好友经常不发说说）。 */
  async function routeQzoneFeeds() {
    if (req.method !== 'GET' || url.pathname !== '/api/socialV2/qzone-feeds') return false;
    const key = String(url.searchParams.get('key') ?? '').trim();
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    const gate = gateSendTool(key, 'qzoneFeeds', '工具未启用：qq_list_feeds');
    if (!gate) return true;
    try {
      const count = Math.max(1, Math.min(50, Number(url.searchParams.get('count')) || 10));
      sendJson({ ok: true, ...(await listQzoneFeeds({ count })) });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  /**
   * 本地账本 + 额度（控制台面板用）。
   * **刻意不查 QQ**：面板每几秒刷一次，不能每次都去打空间接口（既不礼貌也慢）。
   */
  function routeMoodStatus() {
    if (req.method !== 'GET' || url.pathname !== '/api/socialV2/mood-status') return false;
    try {
      sendJson({ ok: true, ...qzoneStatus() });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }
}
