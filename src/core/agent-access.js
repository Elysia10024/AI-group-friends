// 带 agent token 的「v2 工具」准入闸门 —— 从 src/console/server.js 的 applyAccessGates()
// 逐字抽出（2026-10-28 第 21 轮）。与控制台令牌（core/console-auth.js）合起来，准入两半都可离线测。
//
// 为什么要小心：这七道闸门防的是「MCP 工具越权访问控制台」「AI 暂停时偷偷发消息」
// 「静音模式仍被读取」「角色扮演期用到不该用的工具」。原来内联在 HTTP handler 里，
// 顺序一变就可能绕过；抽成函数后顺序与每条消息都钉在测试里。
//
// 顺序（与抽离前逐字一致，**不可重排**）：
//   0. 空 agent token 一律拒（防 MCP 传空串被当管理端）
//   1. 静音模式：agent token + /api/socialV2/ + ?key= 命中静音 → 拒
//   2. 角色扮演白名单：agent token + (socialV2|images) + 是角色扮演角色 + 路径不在白名单 → 拒
//   3. 暂停：socialV2.paused + agent token + (socialV2|send|images) → 拒
//   4. 二代总开关关闭 + agent token + 同上三类 → 拒
//   5. 模式隔离：agent token + socialV2 + 非 reserved2 → 拒
//   6. 管理端专用 v2 路径 + agent token → 拒（防 MCP 越权）
//   7. 表情库管理路径 + agent token → 拒
//
// 所有判据由调用方注入（isChatMuted / isRoleplayRole / roleplayToolAllowed），纯函数、无 IO。
const ADMIN_ONLY_V2_PATHS = new Set([
  '/api/socialV2/config',
  '/api/socialV2/activity',
  '/api/socialV2/reset',
  '/api/socialV2/states',
  '/api/socialV2/wake',
]);

const V2_PREFIXES = ['/api/socialV2/', '/api/send/', '/api/images/'];

const deny = (error) => ({ action: 'json', status: 403, error });

/**
 * @param {object} p
 * @param {object} p.headers
 * @param {string} p.pathname
 * @param {string} p.method
 * @param {string|null} p.queryKey          ?key= 参数
 * @param {string} p.mode                   readRoleState().mode（全局模式）
 * @param {string} p.role                   readRoleState(queryKey)?.role（本次请求的角色）
 * @param {boolean} p.paused                socialV2.paused
 * @param {boolean} p.socialV2EnabledOff    cfg.socialV2.enabled === false
 * @param {string} p.currentMode            deps.flags.currentMode
 * @param {Function} p.isChatMuted          (mode, key) => boolean
 * @param {Function} p.isRoleplayRole       (role) => boolean
 * @param {Function} p.roleplayToolAllowed  (pathname) => boolean
 * @returns {{action:'allow'}|{action:'json',status:number,error:string}}
 */
export function checkAgentAccess({
  headers,
  pathname,
  method,
  queryKey,
  mode,
  role,
  paused,
  socialV2EnabledOff,
  currentMode,
  isChatMuted,
  isRoleplayRole,
  roleplayToolAllowed,
}) {
  const hasAgentToken = Boolean(headers?.['x-agent-token']);
  if (headers?.['x-agent-token'] === '') return deny('agent token 不能为空');

  if (hasAgentToken && pathname.startsWith('/api/socialV2/')) {
    const qKey = String(queryKey ?? '');
    if (qKey && isChatMuted(mode, qKey)) return deny('静默模式已开启（关闭聊天功能）：群聊不再读取');
  }

  if (hasAgentToken && (pathname.startsWith('/api/socialV2/') || pathname.startsWith('/api/images/'))) {
    const gateKey = String(queryKey ?? '').trim();
    const roleNow = String(role ?? '').trim();
    if (isRoleplayRole(roleNow) && !roleplayToolAllowed(pathname)) {
      return deny('当前角色只能聊天和看图片；发图/语音/视频/学习这类工具都用不了');
    }
  }

  const hitsV2Prefixes = V2_PREFIXES.some((p) => pathname.startsWith(p));

  if (paused && hasAgentToken && hitsV2Prefixes) return deny('AI 已暂停，当前不允许执行 v2 工具');
  if (socialV2EnabledOff && hasAgentToken && hitsV2Prefixes) return deny('二代模式已关闭，当前不允许执行 v2 工具');
  if (hasAgentToken && pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
    return deny('该接口仅 reserved2 模式可用');
  }
  if (hasAgentToken && (ADMIN_ONLY_V2_PATHS.has(pathname)
    || (pathname === '/api/socialV2/feedback' && method === 'GET')
    || (pathname === '/api/socialV2/tool-log' && method === 'GET'))) {
    return deny('该接口仅控制台可用');
  }
  if (hasAgentToken && (pathname === '/api/stickers' || pathname.startsWith('/api/stickers/'))) {
    return deny('该接口仅控制台可用');
  }
  return { action: 'allow' };
}
