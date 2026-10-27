// OneBot HTTP 请求的唯一实现（第 5 期 5b，2026-10-28）。
//
// 以前 5 个域各手抄一份（qzone / send-path / voice-out / image-library / sticker），
// 426 提示文案有四个版本（「可能指到了」×2 / 长版 ×2 / 无 ×1）；改鉴权、加重试、
// 换网关要改 5 处，漏一处就是「这条路径静默不工作」（表情能发、说说不能发那种灵异故障）。
//
// 差异显式参数化，行为逐字保留：
//   timeoutMs —— 各域历史值（send/sticker 15s、image-library 20s、qzone 默认 30s、voice 120s）；
//   hint426  —— 'long' | 'short' | 'none'，保留各域原措辞（统一措辞属行为变更，不做）。
export function createOneBotClient({ cfg }) {
  const HINTS = {
    long: '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）',
    short: '（HTTP 426：snowluma.httpUrl 可能指到了 WebSocket 端口）',
    none: '',
  };

  async function call(action, params, { timeoutMs = 30000, hint426 = 'short' } = {}) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? (HINTS[hint426] ?? '') : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  return { call };
}
