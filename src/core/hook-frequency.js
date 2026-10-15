// 「句尾挂钩」频率检测 —— 她的傲不该靠每句话尾巴上补一刀。
//
// 为什么是这个词表而不是通用 n-gram 检测：先扫过一遍她发过的 119 条消息，
// 通用 n-gram 排出来的"高频短语"是「自检：」「src」「已搬进」——那是她跟管理员汇报
// 重构进度时的正常用词，不是口癖。真正的问题是**句尾的收尾刀**：
//   · 句尾否定祈使：「行，去吧，别把脑子也一块冲下水道了」「别死我群里」「别问我」
//   · 记账/翻账本：「……行吧，摸就摸吧，这条别记我账上」「写你名下」「给你单开一页」
//   · 招牌抬价：「本小姐才不稀罕」当尾巴
// 所以按"**只看句尾**+ 明确的钩子类型"来判，宁可漏报也不误报（误报会让她把正常的
// 关心句也削掉，比如"别客气""别熬夜了"这种正当的关心）。
//
// 检测结果只用来在【参与度参考】里加一句提示，不做拦截。

/** 句尾取样长度：只看最后这一段，避免正文里出现"别"就被算成挂钩。 */
const TAIL_CHARS = 14;

/** 从句尾判定的钩子类型（顺序即优先级）。 */
export const TAIL_HOOK_RULES = [
  // 记账/账本类：尾巴上出现账目、名单、排队
  { id: 'account', label: '记账/账本', re: /(账本|记账|账上|记[你我一]笔|记[你我一]?账|记[你我在]?名下|写[你我在]?名下|名单|排队|单开一页)[^，。！？!?…~]{0,6}$/ },
  // 句尾否定祈使：最后一个小句以"别/甭/少"开头
  { id: 'negate', label: '句尾的“别…”', re: /(^|[，,。！？!?…~、])\s*(别|甭|少)[^，。！？!?…~]{0,12}$/ },
  // 招牌抬价：句尾抖"本小姐"
  { id: 'lady', label: '“本小姐”', re: /本小姐[^，。！？!?…~]{0,8}$/ },
  // 甩袖子：句尾用"懒得理你/不搭理你"这类收场
  { id: 'dismiss', label: '甩袖子', re: /(懒得(理|搭理|跟|和)[^，。！？!?…~]{0,8}|不(理|搭理|稀罕)[^，。！？!?…~]{0,8}|就这\??|说完了\??)$/ }
];

/**
 * 这条消息的句尾挂的是什么钩（没有则 null）。
 * @param {string} text
 * @returns {{id: string, label: string} | null}
 */
export function tailHookOf(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  const tail = s.slice(-TAIL_CHARS);
  for (const rule of TAIL_HOOK_RULES) {
    if (rule.re.test(tail)) return { id: rule.id, label: rule.label };
  }
  return null;
}

/** 至少要看她多少条消息才下结论。 */
export const HOOK_MIN_SAMPLE = 5;
/** 窗口里她自己的消息条数。 */
export const HOOK_SAMPLE_SIZE = 8;
/** 同一个钩子在窗口里出现几次才算口癖。 */
export const HOOK_REPEAT_THRESHOLD = 3;

/**
 * 句尾挂钩频率提示；不需要提醒时返回空串。
 * @param {Array} recentMessages 会话消息（含她自己的）
 * @returns {string}
 */
export function hookFrequencyHint(recentMessages) {
  const mine = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((m) => m && m.isSelf)
    .map((m) => String(m.plain ?? m.text ?? '').trim())
    .filter(Boolean)
    .slice(-HOOK_SAMPLE_SIZE);
  if (mine.length < HOOK_MIN_SAMPLE) return '';
  const byId = new Map();
  let example = '';
  for (const t of mine) {
    const hook = tailHookOf(t);
    if (!hook) continue;
    const cur = byId.get(hook.id) || { hook, n: 0 };
    cur.n += 1;
    byId.set(hook.id, cur);
    example = t;
  }
  const top = [...byId.values()].sort((a, b) => b.n - a.n)[0];
  if (!top || top.n < HOOK_REPEAT_THRESHOLD) return '';
  return `你最近 ${mine.length} 条里有 ${top.n} 条在句尾补了一刀（${top.hook.label}，例如「${example.slice(0, 24)}」）——**这句说完就停**：让步就软到底，别在尾巴上再把傲拎回来。`;
}
