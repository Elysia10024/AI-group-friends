// 控制台路由：看群友分享的 B 站视频（二代工具通道）。
//
// POST /api/socialV2/bili-look  body { key, url } + header x-agent-token
// 只读：标题/简介/热评。**配额（每人每天一次）在 domains/bili-look.js 里硬校验**，
// 分享者从该会话的 recentMessages 里按 BV 号反查，不接受模型自己传“是谁”。
export async function handleBiliLook(ctx) {
  const { req, url, sendJson, readBody, agentTokenOk, v2SessionAllowed, biliLook, getSocialV2State } = ctx;

  // 控制台面板（只读）：今天看了什么 + 按群/人的分享配额。不带 agent token。
  if (req.method === 'GET' && url.pathname === '/api/bili-look/status') {
    const data = biliLook?.status?.() ?? { history: [], quotas: [] };
    const quotas = (data.quotas ?? []).map((q) => {
      let name = '';
      try {
        const st = getSocialV2State(q.key);
        const hit = [...(st?.recentMessages ?? [])].reverse()
          .find((m) => String(m.userId) === String(q.who));
        name = hit?.sender ?? '';
      } catch { /* 取不到名字就显示号码 */ }
      return {
        ...q,
        group: String(q.key).replace(/^group:/, ''),
        name: name || String(q.who),
        owner: String(q.who) === String(data.ownerQQ ?? '')
      };
    });
    sendJson({ ok: true, ...data, quotas });
    return true;
  }

  if (req.method !== 'POST') return false;
  if (url.pathname !== '/api/socialV2/bili-look' && url.pathname !== '/api/socialV2/bili-zoom') return false;

  if (url.pathname === '/api/socialV2/bili-look') {
    const body = await readBody();
    const key = String(body.key ?? '').trim();
    const token = String(req.headers['x-agent-token'] ?? '');
    if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (!token) { sendJson({ ok: false, error: '缺 agent token' }, 403); return true; }
    if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }

    try {
      const withFrames = body.withFrames === undefined ? null : body.withFrames === true;
      const mode = body.mode === 'frames' || body.mode === 'storyboard' ? body.mode : null;
      const out = await biliLook.look(key, String(body.url ?? ''), { withFrames, mode });
      sendJson({ ok: true, ...out });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }

  // 细看：给一个时间窗，返回 2-4 帧拼图（分镜省钱，zoom 按需花）
  if (url.pathname === '/api/socialV2/bili-zoom') {
    const bodyZ = await readBody();
    const keyZ = String(bodyZ.key ?? '').trim();
    const tokenZ = String(req.headers['x-agent-token'] ?? '');
    if (!keyZ) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
    if (!tokenZ) { sendJson({ ok: false, error: '缺 agent token' }, 403); return true; }
    if (!agentTokenOk(keyZ, tokenZ)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
    if (!v2SessionAllowed(keyZ)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
    try {
      const outZ = await biliLook.zoom(String(bodyZ.url ?? ''), Number(bodyZ.startSec) || 0, Number(bodyZ.endSec) || (Number(bodyZ.startSec) || 0) + 10);
      sendJson({ ok: true, ...outZ });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }
}
