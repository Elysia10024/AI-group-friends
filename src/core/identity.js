// 身份与引用解析的纯逻辑：会话键、自己的名字、成员显示名、引用归属校验。
// 从 bridge.js 抽出来（R1' 第 6 步）。
//
// 抽出来的理由：
//   · `card || nickname` 这个取名模式在 4 处重复，而 BUG-001 正出在这里
//     （丰川祥子的 `card` 返回未解码的 protobuf，导致她在 AI 眼里是乱码）。
//     收成一个函数之后，修 bug 只需要改一处、且能离线测。
//   · 引用归属校验是**安全相关**的（防止用群消息 id 跨会话读取私聊、反之亦然），
//     原来夹在 40 行的 async 函数里、没法单独验证。现在它是一个纯谓词。
//   · 兜底的 reply info 构造在 resolveReplyTargetV2 里写了两遍。
//
// 注意：真正取数据的部分（bot.getMessage / getGroupMemberInfo / 缓存 / 日志）仍是 I/O，
// 留在桥里。这里只放"给定数据怎么判断、怎么显示"。

/** 从 `group:123` 这样的会话键里取出群号；不是群会话则返回 ''。 */
export function groupIdFromKey(key) {
  const m = /^group:(\d+)$/.exec(String(key ?? ''));
  return m ? m[1] : '';
}

/**
 * 她在某个会话里的所有可能名字（账号昵称 + 该群名片缓存），全部小写。
 * @param {string} nickname 账号昵称（原始大小写）
 * @param {Iterable<string>} [cachedNames] 该群名片的缓存（调用方保证已小写化）
 * @returns {Set<string>}
 */
export function selfAliases(nickname, cachedNames) {
  const names = new Set();
  if (nickname) names.add(String(nickname).toLowerCase());
  if (cachedNames) for (const n of cachedNames) names.add(n);
  return names;
}

/**
 * 这个名字能不能用（BUG-001）。
 *
 * 群名片偶尔是**未解码的 protobuf**。实测样本（群 20000001 的 945327621）：
 *   "\n\n\n\b&ÿfÌÿ\n\u000e\u0012\f丰川祥子\u0010\u0000"
 * —— 19 个字符里 10 个是 C0 控制字符，真名被夹在二进制框架中间。她在 AI 眼里就是这串乱码。
 * 同一个人的 nickname 是干净的「群友庚」。
 *
 * 判据：含 C0 控制字符（U+0000–U+001F，**制表符除外**）、DEL（U+007F）或替换字符
 * （U+FFFD）就不可用。真实的 QQ 昵称/群名片不会含这些 —— 该群 48 名成员里只有那 1 个
 * 中招，其余 47 个含 emoji、全角标点、♿、🐊 的都没被误判。
 *
 * @param {*} value
 * @returns {boolean}
 */
export function isUsableName(value) {
  const s = String(value ?? '');
  if (!s) return false;
  return !/[\u0000-\u0008\u000A-\u001F\u007F\uFFFD]/.test(s);
}

/**
 * 从群成员/发送者对象里取显示名：优先群名片，其次昵称。
 *
 * **刻意不 trim**（与原实现一致）：`{ card: '  ', nickname: '昵称' }` 仍然返回 `'  '`。
 * 但**会**跳过含控制字符的脏值（BUG-001）—— 群名片是未解码 protobuf 时改用昵称。
 * 两个都不可用时返回 ''，让 senderLabel 回退到 QQ 号（比二进制乱码有用得多）。
 *
 * @returns {string}
 */
export function memberName(source) {
  if (!source) return '';
  if (isUsableName(source.card)) return String(source.card);
  if (isUsableName(source.nickname)) return String(source.nickname);
  return '';
}

/**
 * 消息发送者的显示标签：群名片 → 昵称 → 兜底 id。
 * @param {object} sender 事件里的 sender 对象
 * @param {string|number} [fallbackId] 取不到名字时用它
 * @param {string} [unknownLabel] 连 id 都没有时的兜底文案（默认 '未知'）
 */
export function senderLabel(sender, fallbackId, unknownLabel = '未知') {
  const name = memberName(sender);
  if (name) return name;
  if (fallbackId != null && fallbackId !== '') return String(fallbackId);
  return String(unknownLabel);
}

/** messageId 是否可以安全地转成 number（超出安全整数范围就拒绝解析）。 */
export function isSafeMessageId(id) {
  return Number.isSafeInteger(Number(id));
}

/**
 * 校验一条被引用的消息是否属于当前会话 —— 防止用群消息 id 跨会话读取私聊、反之亦然。
 *
 * 判定规则（与原实现逐字一致）：
 *   · 群会话：raw 必须带群归属，且与当前会话一致；
 *   · 私聊：raw 不能带群归属；raw 的发送者必须等于会话对象（或是机器人自己）。
 * 任何一项无法确认，都视为"不通过"。
 *
 * @param {object} raw OneBot get_msg 返回
 * @param {'group'|'private'} kind
 * @param {string|number} convId 当前会话 id（群号或对方 QQ）
 * @param {string|number|null} [selfId] 机器人自己的 QQ
 * @returns {boolean}
 */
export function replyOwnershipOk(raw, kind, convId, selfId = null) {
  if (!raw || typeof raw !== 'object') return false;
  const rawGroup = raw.group_id ?? raw.groupId;
  if (kind === 'group') {
    if (rawGroup == null) return false;
    return String(rawGroup) === String(convId);
  }
  const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
  // 私聊消息必须同时满足：没有群归属，且发送者匹配。
  if (rawGroup != null) return false;
  if (rawUser == null) return false;
  if (String(rawUser) === String(convId)) return true;
  return selfId != null && String(rawUser) === String(selfId);
}

/**
 * 引用目标在本地 recentMessages 里命中、但真实 get_msg 拿不到时的兜底 info。
 * （原实现在 resolveReplyTargetV2 里把这段写了两遍。）
 */
export function localReplyInfo(found, realId) {
  return {
    sender: String(found?.sender || ''),
    text: String(found?.text || found?.plain || '').slice(0, 1200),
    userId: null,
    messageId: String(realId),
    seq: found?.seq
  };
}
