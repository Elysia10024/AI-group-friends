// 人物短名归一：记忆 key 与"名单"里只用短名，长名片的后缀/梗不算名字的一部分。
//
// 为什么要有它（2026-10-02 真实事故）：她在群里被问"拾圆拾圆和来来是一个人吗"，
// 答成"一个人，他名字里本来就带'来来'"——因为记忆 key 是**完整群名片**
// 「请你吃酸橙（！？来来？！）」，"来来"和"酸橙"同屏出现，没有任何一行说明
// 前者只是名片里的一部分，于是她把"来来"当成了拾圆拾圆的名字。
//
// 规则（保守，只砍明显的装饰）：
//   · 去掉**末尾**的括号补充：请你吃酸橙（！？来来？！） → 请你吃酸橙
//   · 去掉**第一个逗号之后**的内容：至招，至丑，至绷的化身 → 至招
//   · 两样都做，最后 trim；砍完太短（<2 字）就退回原名，别把名字砍没了
// 不做模糊匹配、不做拼音/相似度——那会制造新的"我以为他是谁"。

/** 取一个人的短名（用于记忆 key 与名单展示）。 */
export function personShortName(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return '';
  let s = raw;
  // 1) 砍末尾的括号补充（中文/英文括号都算；可以连着砍）
  for (let i = 0; i < 3; i += 1) {
    const next = s.replace(/[（(][^（()）]*[)）]\s*$/u, '').trim();
    if (next === s) break;
    s = next;
  }
  // 2) 砍第一个逗号之后的内容（「至招，至丑，至绷的化身」→「至招」）
  const comma = s.search(/[，,]/u);
  if (comma > 0) s = s.slice(0, comma).trim();
  if (s.length < 2) return raw;
  return s;
}

/**
 * 在已有 key 里找"这个人"：短名相同即同一个；完全包含也算（避免同一人开两个 key）。
 * @returns {string|null} 命中的已有 key
 */
export function matchExistingKey(name, keys) {
  const short = personShortName(name);
  if (!short) return null;
  const list = Array.isArray(keys) ? keys.map(String) : [];
  for (const k of list) {
    if (k === name) return k;
  }
  for (const k of list) {
    if (personShortName(k) === short) return k;
  }
  for (const k of list) {
    if (short.length >= 2 && (k.includes(short) || short.includes(k))) return k;
  }
  return null;
}

// ── 身份锚点：名字 → QQ，QQ → 名字（2026-10-15 主人要求）─────────────────────────
// 为什么要有这一段（真实数据）：memberImpressions 的 key 以前是**名字**，于是主人自己裂成
// 「杨森 / 群三水 / 测试用户」三份，另有 10 个在 people.json 里查不到名字的孤儿 key（约占全部
// 印象的 24%）；而关系档挂在 **QQ** 上（people.json 的 relation），两边接不上 ——
// 这就是 2026-10-15「讨厌档没生效」的一半原因。
// 现在以 **QQ 为唯一锚点**：写记忆时把名字解析成 QQ，显示时再反查回当前名片。
// 名字只是"现在怎么称呼"，不是身份 —— 名片改了显示自动跟上，不需要再动一遍数据（这就是后门）。
//
// 这次改造只写**一份**映射逻辑（本文件），写入 / 显示 / 迁移三处都调它：
// 以前 `routes/memory.js` 里那段"从 recentMessages 找 sender 拿 userId"是第二份，
// 只服务关系/标签、不管印象 key —— 两份逻辑必然走偏，已删除并改调这里。
//
// 解析链的顺序（可靠 → 不可靠；宁可少认，也不认错）：
//   ① 名字本身就是 QQ 号（她可以直接填 QQ）
//   ② people[qq].names[本会话] 精确相等 ← 最权威：这是"本会话里他叫什么"
//   ③ people[*].names[*] 任意会话精确相等（同一个人在别的群叫这个名字）
//   ④ 短名相等（名片带装饰/后缀/梗）；**同短名对应多个 QQ 就放弃** —— 那说明这名字不唯一
//   ⑤ 本会话消息里的 sender 精确相等 ← 覆盖面最大（孤儿 key 主要靠它救）
//   ⑥ 消息里 sender 的短名相等（同样要求唯一）
//   ⑦ 她自己印象里记的「（QQ 236153286）」—— 最后的兜底，且只在只记了一个 QQ 时才认
// 全程**不做相似度模糊匹配**：那会制造新的"我以为他是谁"，比认不出来更糟。

/** QQ 号形态（与路由/工具里既有的口径一致：5~12 位数字）。 */
export const QQ_KEY_RE = /^\d{5,12}$/;

/** 从一段文本里取出她记下的 QQ 号（只认带 QQ 前缀的写法，免得把日期/别的数字当 QQ）。 */
export function extractQqMentions(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/qq\s*[:：]?\s*(\d{5,12})/gi)) out.push(m[1]);
  return [...new Set(out)];
}

/** 候选里唯一的那个 QQ（0 个或多个 → null）。"多个"= 这个名字不唯一，不猜。 */
function uniqueQq(list) {
  const set = new Set(list.map((c) => c.qq));
  return set.size === 1 ? [...set][0] : null;
}

/** people.json 里所有 (会话, 名字, QQ)。 */
function peopleNameCandidates(people) {
  const list = [];
  for (const [qq, rec] of Object.entries(people && typeof people === 'object' ? people : {})) {
    if (!QQ_KEY_RE.test(String(qq))) continue;
    const names = rec && typeof rec.names === 'object' && rec.names ? rec.names : {};
    for (const [convKey, nm] of Object.entries(names)) {
      const n = String(nm ?? '').trim();
      if (n) list.push({ qq: String(qq), name: n, convKey: String(convKey) });
    }
  }
  return list;
}

/** 会话消息里的 (名字, QQ)，只取别人的发言。 */
function messageNameCandidates(st) {
  const list = [];
  const push = (m) => {
    if (!m || m.isSelf) return;
    const nm = String(m.sender ?? '').trim();
    const qq = String(m.userId ?? m.user_id ?? '').trim();
    if (nm && QQ_KEY_RE.test(qq)) list.push({ qq, name: nm });
  };
  for (const m of Array.isArray(st?.recentMessages) ? st.recentMessages : []) push(m);
  for (const m of Array.isArray(st?.unread) ? st.unread : []) push(m);
  return list;
}

/**
 * 名字 → QQ（身份锚点）。**解析不出就返回 null**（调用方保留原名并标 pendingQq，将来能认领）。
 * @param {string} name 她说的那个人（名字/昵称/群名片，也可以直接是 QQ 号）
 * @param {object} [ctx]
 * @param {string} [ctx.key] 会话 key（group:xxx / private:xxx）—— 决定"本会话名片"优先
 * @param {object} [ctx.people] state/memory/people.json
 * @param {object} [ctx.st] 该会话的 socialV2 状态（消息与已有印象都从这里读）
 * @returns {string|null}
 */
export function resolvePersonQq(name, { key = '', people = null, st = null } = {}) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  if (QQ_KEY_RE.test(raw)) return raw;                                                    // ①

  const short = personShortName(raw);
  const fromPeople = peopleNameCandidates(people);
  const here = fromPeople.find((c) => c.convKey === String(key) && c.name === raw);        // ②
  if (here) return here.qq;
  const exactPeople = uniqueQq(fromPeople.filter((c) => c.name === raw));                  // ③
  if (exactPeople) return exactPeople;
  if (short) {                                                                            // ④
    const byShort = uniqueQq(fromPeople.filter((c) => personShortName(c.name) === short));
    if (byShort) return byShort;
  }

  const fromMsgs = messageNameCandidates(st);
  const exactMsg = uniqueQq(fromMsgs.filter((c) => c.name === raw));                       // ⑤
  if (exactMsg) return exactMsg;
  if (short) {                                                                            // ⑥
    const byShortMsg = uniqueQq(fromMsgs.filter((c) => personShortName(c.name) === short));
    if (byShortMsg) return byShortMsg;
  }

  // ⑦ 印象文本里她自己记的 QQ（先按名字找到那条记录，再从记录文本里取；只认唯一一个）
  const imps = st?.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  const ownerKey = matchExistingKey(raw, Object.keys(imps));
  if (ownerKey && !QQ_KEY_RE.test(ownerKey)) {
    const texts = [ownerKey, ...(Array.isArray(imps[ownerKey]?.traits) ? imps[ownerKey].traits : [])];
    const qqs = extractQqMentions(texts.join('\n'));
    if (qqs.length === 1) return qqs[0];
  }
  return null;
}

/**
 * QQ → 给她看的名字（显示层反查，**绝不落成第二份真相**：名字存在 people.json 与会话消息里）。
 * 回退：本会话名片 → 本会话里他最近一条消息的 sender → people 里任意一个名字 →
 *      记录里带的 displayName → `（QQ 12345）`（可读的兜底，而不是一串裸数字）。
 * key 不是 QQ 时（还没认领的条目）直接把它当名字用。
 * @param {string} qq
 * @param {{key?:string, people?:object, st?:object, fallback?:string}} [ctx]
 */
export function displayNameForQq(qq, { key = '', people = null, st = null, fallback = '' } = {}) {
  const id = String(qq ?? '').trim();
  const fb = String(fallback ?? '').trim();
  if (!QQ_KEY_RE.test(id)) return fb || id;
  const rec = people && typeof people === 'object' ? people[id] : null;
  const names = rec && typeof rec.names === 'object' && rec.names ? rec.names : {};
  const here = String(names[key] ?? '').trim();
  if (here) return here;
  if (st) {
    // 名片可能比 people.json 新（people 只在有消息时刷新），所以也看消息里最近一次怎么称呼
    const msgs = [
      ...(Array.isArray(st.recentMessages) ? st.recentMessages : []),
      ...(Array.isArray(st.unread) ? st.unread : [])
    ];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (!m || m.isSelf) continue;
      if (String(m.userId ?? m.user_id ?? '').trim() !== id) continue;
      const nm = String(m.sender ?? '').trim();
      if (nm && !QQ_KEY_RE.test(nm)) return nm;
    }
  }
  const anyName = Object.values(names).map((n) => String(n ?? '').trim()).find(Boolean);
  if (anyName) return anyName;
  if (fb && !QQ_KEY_RE.test(fb)) return fb;
  return `（QQ ${id}）`;
}
