// 发送类工具（send-burst / send-message / send-sticker / send-voice / send-image / send-poke…）的
// 公共闸门 —— 从 src/console/server.js 的 gateSendTool 逐字抽出（2026-10-28 第 22 轮）。
//
// 它和 core/agent-access.js 的分工：
//   · agent-access 管「带 token 的请求能不能进这个接口」；
//   · 本函数管「要发消息的目标/工具/模式是否允许」，并解析出 group/private 与数字 id。
// 抽出来的理由：原来 13 行内联在 HTTP handler 里，七条判断的顺序与文案只能靠 E2E 覆盖；
// 而任何一条被绕过都意味着"能在不该发的地方发消息"。
//
// 顺序（与抽离前逐字一致，**不可重排**）：
//   1. 带 token 时校验 token 有效性；
//   2. 带 token 时校验会话准入（模式范围）；
//   3. 带 token 时校验工具开关（label 里带工具中文名）；
//   4. 非 reserved2 一律拒；
//   5. 没带 agent token 一律拒（reserved2 发送必须带）；
//   6. key 必须形如 group:数字 / private:数字；
//   7. 目标必须在当前模式允许范围内。
const KEY_RE = /^(group|private):(\d+)$/;

const deny = (status, error) => ({ action: 'json', status, error });

/**
 * @param {object} p
 * @param {string|undefined} p.agentToken     请求头 x-agent-token
 * @param {string} p.key                      目标会话键
 * @param {string} p.tool                     工具开关名（如 'sendSticker'）
 * @param {string} p.label 工具关掉时的提示（如 '工具未启用：qq_send_sticker'）
 * @param {string} p.currentMode              deps.flags.currentMode
 * @param {object} p.cfg
 * @param {Function} p.agentTokenOk           (key, token) => boolean
 * @param {Function} p.v2SessionAllowed       (key) => boolean
 * @param {Function} p.v2ToolEnabled          (tool) => boolean
 * @param {Function} p.modeAllowed            (key, kind, id, cfg, mode) => boolean
 * @returns {{action:'json',status:number,error:string}|{action:'handle',gate:{kind:string,id:number}}}
 */
export function checkSendToolAccess({
  agentToken,
  key,
  tool,
  label,
  currentMode,
  cfg,
  agentTokenOk,
  v2SessionAllowed,
  v2ToolEnabled,
  modeAllowed,
}) {
  if (agentToken && !agentTokenOk(key, agentToken)) return deny(403, 'agent token 无效');
  if (agentToken && !v2SessionAllowed(key)) return deny(403, '目标不在当前模式允许范围内');
  if (agentToken && !v2ToolEnabled(tool)) return deny(403, label);
  if (currentMode !== 'reserved2') return deny(403, '该接口仅 reserved2 模式可用');
  if (!agentToken) return deny(403, 'reserved2 模式发送必须携带 agent token');
  const keyMatch = KEY_RE.exec(key);
  if (!keyMatch) return deny(400, 'key 格式应为 group:群号 或 private:QQ号');
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
    return deny(403, '目标不在当前模式允许范围内');
  }
  return { action: 'handle', gate: { kind, id } };
}
