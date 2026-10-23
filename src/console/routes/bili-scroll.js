// 控制台路由：她自己刷 B 站（空闲时段，每小时最多一次）。
//
// POST /api/socialV2/bili-scroll  body { key } + header x-agent-token
// 空闲时段/间隔/日上限都在 domains/bili-scroll.js 里硬校验。
export async function handleBiliScroll(ctx) {
  const { req, url, sendJson, readBody, agentTokenOk, v2SessionAllowed, biliScroll } = ctx;
  if (req.method !== 'POST' || url.pathname !== '/api/socialV2/bili-scroll') return false;

  const body = await readBody();
  const key = String(body.key ?? '').trim();
  const token = String(req.headers['x-agent-token'] ?? '');
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
  if (!token) { sendJson({ ok: false, error: '缺 agent token' }, 403); return true; }
  if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
  if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }

  try {
    const out = await biliScroll.scroll(key);
    sendJson({ ok: true, ...out });
  } catch (error) {
    sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
  }
  return true;
}
