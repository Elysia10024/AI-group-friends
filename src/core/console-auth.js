// 控制台访问准入（token + CSRF）——从 src/console/server.js 的请求处理器里逐字抽出
// （2026-10-28 第 20 轮）。抽出来的唯一理由：这是"谁能动她的记忆/重启她"的安全边界，
// 内联在 HTTP handler 里只能靠 E2E 验证；抽成纯函数后可以离线钉死每一条规则。
//
// 判据（与抽离前的内联代码逐条一致）：
//   1. 配了 consoleToken 时，请求必须带对得上的令牌（?token= 优先于 x-console-token 头）；
//      例外：GET /console.css、/console.js —— 浏览器加载静态资源不会带自定义头，
//      而页面脚本还负责把 ?token= 引导进 localStorage（鸡生蛋），不放行就"UI 没了"。
//   2. 没配 consoleToken 时跳过令牌校验（历史行为：本地单机默认不设令牌，只靠 CSRF 挡跨站）。
//   3. CSRF：所有写操作必须 application/json；带 Origin 时必须来自本机页面。
export const PUBLIC_ASSETS = new Set(['/console.css', '/console.js']);

/**
 * @param {object} p
 * @param {string} p.method
 * @param {string} p.pathname
 * @param {string|null} p.suppliedToken  url.searchParams.get('token') ?? 请求头
 * @param {string} [p.consoleToken]     配置里的令牌（空/falsy = 不校验）
 * @param {object} p.headers            请求头
 * @param {number} p.port               控制台端口（Origin 白名单：127.0.0.1:port / localhost:port）
 * @returns {{action:'allow'}|{action:'html401'}|{action:'json',status:number,error:string}}
 */
export function checkConsoleAuth({ method, pathname, suppliedToken, consoleToken, headers, port }) {
  const isPublicAsset = method === 'GET' && PUBLIC_ASSETS.has(pathname);
  if (consoleToken && suppliedToken !== consoleToken && !isPublicAsset) {
    if (method === 'GET' && pathname === '/') return { action: 'html401' };
    return { action: 'json', status: 401, error: '未授权：请提供控制台访问令牌' };
  }
  if (method !== 'GET') {
    const ctype = String(headers?.['content-type'] ?? '');
    if (!ctype.toLowerCase().includes('application/json')) {
      return { action: 'json', status: 415, error: '请求必须是 application/json' };
    }
    const origin = headers?.['origin'];
    if (origin) {
      let originHost = '';
      try {
        originHost = new URL(String(origin)).host;
      } catch { /* Origin 不是合法 URL 就当没有 Origin：下面按 host 白名单校验，取不到即拒绝跨站 */ }
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(originHost)) {
        return { action: 'json', status: 403, error: '跨站请求被拒绝' };
      }
    }
  }
  return { action: 'allow' };
}
