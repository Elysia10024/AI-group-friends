// 上下文组装器（纯函数）—— A1 的核心：把"这一回合要给她看的材料"拼成一份 prompt。
//
// 为什么是纯函数：组装错了就是"她失忆"，而失忆是**静默**的。纯函数能离线测、能对着真实状态回放，
// 不必每次重启桥去验证（`重构方案.md` R2 的同一条理由）。
//
// 两条设计约束（都来自实测，别随手改）：
//   1. **稳定前缀纪律**：她的钱近一半花在"缓存命中读取"，而命中要求前缀稳定。所以
//      长期事实/记忆/黑话（变化少）排前面、最近消息/本轮触发（每回合变）排后面，
//      中间绝不允许插入易变内容。`prefixHash` 就是给"稳定块是否真的没变"用的。
//   2. **每块都有上限**：不设上限的话，一次"顺手把消息全带上"就能把 3 万顶回 26 万。
//      上限按**字符**给（中文约 1.5 字符/token，所以 5000 字符 ≈ 3.3k token）。
export const ASSEMBLER_DEFAULT_LIMITS = {
  role: 14000,     // 人格核心（roles/<角色>/core.md）——每轮都要在，否则她只剩预设里的小抄
  facts: 5000,     // 长期事实（人/群/事）
  memory: 5000,    // 记忆条目
  slang: 1500,     // 黑话
  status: 800,     // 她当前的状态/唤醒配置摘要
  recent: 12000,   // 最近群聊原文
  trigger: 6000    // 本轮触发（未读/被 @/唤醒原因）
};

/** 稳定块（放前面，参与 prefixHash）：只要事实没变，字节就一模一样。 */
export const ASSEMBLER_STABLE_BLOCKS = ['role', 'facts', 'memory', 'slang'];

const clip = (text, cap) => {
  const s = String(text ?? '').trim();
  if (!cap || s.length <= cap) return s;
  // 截断时保留头部（头部信息密度最高），并明确标注"被截断"，免得她以为就这些
  return `${s.slice(0, cap)}\n…（内容过长已截断，需要更多可以用 qq_recall 回忆）`;
};

/**
 * @param {object} input
 *   · persona        人设（正常由 DSH preset 提供；影子模式里留空即可）
 *   · facts/memory/slang/status/recent/trigger  各块文本（调用方负责取好）
 *   · limits         覆盖默认上限（字符）
 * @returns {{ blocks, prefix, tail, text, prefixHash, chars, stats }}
 */
export function assembleContextV2(input = {}) {
  const limits = { ...ASSEMBLER_DEFAULT_LIMITS, ...(input.limits ?? {}) };
  const SPEC = [
    ['role', '【你的角色】', input.role],
    ['facts', '【关于群里的人与事】', input.facts],
    ['memory', '【你记得的事】', input.memory],
    ['slang', '【群里的黑话】', input.slang],
    ['status', '【你现在的状态】', input.status],
    ['recent', '【最近的群聊】', input.recent],
    ['trigger', '【这次找你的原因】', input.trigger]
  ];

  const blocks = [];
  for (const [name, title, body] of SPEC) {
    const text = clip(body, limits[name]);
    if (!text) continue;                       // 空块直接不出现（避免"【黑话】(空)"这种噪音）
    blocks.push({ name, title, text, chars: text.length, stable: ASSEMBLER_STABLE_BLOCKS.includes(name) });
  }

  const render = (b) => `${b.title}\n${b.text}`;
  const prefix = blocks.filter((b) => b.stable).map(render).join('\n\n');
  const tail = blocks.filter((b) => !b.stable).map(render).join('\n\n');
  const text = [prefix, tail].filter(Boolean).join('\n\n');

  const stats = { chars: text.length, byBlock: Object.fromEntries(blocks.map((b) => [b.name, b.chars])) };
  return {
    blocks,
    prefix,
    tail,
    text,
    prefixHash: hash32(prefix),               // 稳定块没变 → 哈希不变 → 前缀缓存能命中
    chars: text.length,
    stats
  };
}

/** 稳定前缀的稳定性判据：同内容 → 同哈希。用 FNV-1a，够用且无依赖。 */
export function hash32(text) {
  let h = 0x811c9dc5;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 粗略 token 估算（中文约 1.5 字符/token；只用于影子模式的可读数字，别当账）。 */
export const estimateTokens = (chars) => Math.round(Number(chars || 0) / 1.5);
