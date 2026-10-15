// 「不理某人」名单的判定 —— 抽成纯函数，理由和 `src/core/mute.js` 一样：
// 这条边界很容易被改错，而且有**两处**要用（群消息入站、拍一拍事件），写两份就会各自跑偏。
//
// 语义（2026-10-12 主人要求：把骂过她的那个人「拉黑，以后不理他」）：
//   · 名单里的 QQ 号，**在群里说什么都不读、不记账、不唤醒** —— 丢弃点在 `domains/incoming.js`
//     的入站闸门里，和"会话静音"同级，都在任何解析/记录之前；
//   · 他**拍一拍也叫不醒**（`domains/pending.js` 的 handlePokeNotice 同样过滤）；
//   · **只按 QQ 号认人**，不看群名片/昵称 —— 改个名字、换个头像躲不掉；
//   · 名单为空 = 谁都不忽略（默认，改了不会有副作用）。
//
// 和 `/安静`（`state` 里会话级 muted）的区别：那是**整个会话**静音（群里所有人都读不到、不回），
// 这里只针对**一个人**，别人照常。

/** 把配置值规整成"纯数字 QQ 号字符串数组"：非数组按空名单处理，脏值丢弃，自动去重。 */
export function normalizeIgnoreUsers(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const s = String(v ?? '').trim();
    if (/^\d+$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 这个 QQ 号是不是在忽略名单里。事件里的 id 可能是数字也可能是字符串，统一按字符串比。 */
export function isIgnoredUser(list, userId) {
  const s = String(userId ?? '').trim();
  if (!s) return false;
  return normalizeIgnoreUsers(list).includes(s);
}
