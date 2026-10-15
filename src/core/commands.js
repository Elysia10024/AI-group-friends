// 管理指令的**纯匹配层**：文本 → 指令 id，不碰状态、不发消息、不看权限。
//
// 为什么单独成文件：用户要求指令"以普通对话的形式发出也能执行"（不用斜杠、不用限定词），
// 而普通对话里什么话都可能有 —— 匹配规则必须能被**单测钉死**（`npm test` 自动带上
// `src/core/*.test.js`）。权限与执行在下游 `src/domains/admin-commands.js`。
//
// ⚠️ **自然语言模式一律整句锚定（^…$），不许子串匹配**。这是真实事故换来的：
//   群里有人只是在**描述**她 ——「小鲸鱼现在只有开启关闭聊天功能两个指令」——
//   而旧写法是 `/(关闭|…)(聊天|…)/` 子串匹配，那句话里的「关闭聊天功能」命中，
//   她真的把聊天关了。指令是普通对话形式，就必须假设"这句话可能不是在跟她说"。
//   现在允许少量口语前缀/后缀（「帮我…」「…吧」），但**整句必须就是这条指令本身**。
//   群里还多一道：必须点名（@ / 叫名字 / 引用她）才执行 —— 见 domains/admin-commands.js。
//   斜杠写法不受这两条限制（它是显式指令，历史上就随处可用）。
//
// 加新指令 = 往 ADMIN_COMMANDS 加一条：斜杠写法 + 自然语言写法 + 一句说明。
// 写模式的经验：用「动词 + 宾语」，别用单词（"状态"单独出现太常见，会误触发）。
const LEAD = String.raw`(?:(?:请|帮我|麻烦|你|现在|马上|先|就|给我)\s*)*`;
// 结尾只放"语气词/标点"，**不放问号** ——「关闭聊天功能？」是在问，不是在下令。
const TAIL = String.raw`(?:一下|吧|好吗|好不好|谢谢|哦|啊)?[。！!～~\s]*`;

export const ADMIN_COMMANDS = [
  {
    id: 'reset',
    desc: '重置会话（下次消息开新上下文）',
    patterns: [
      /^\/(?:reset|new)$/i,
      new RegExp(`^${LEAD}(?:重置|重开|清空)(?:一下)?(?:会话|上下文|对话)${TAIL}$`),
    ],
  },
  {
    id: 'status',
    desc: '看当前状态（会话 / 白名单 / 角色 / 模式）',
    patterns: [
      /^\/status$/i,
      new RegExp(`^${LEAD}(?:会话)?状态(?:怎么样|如何)?${TAIL}$`),
    ],
  },
  {
    id: 'role',
    desc: '切换角色（带名字；off / clear 表示清除）',
    patterns: [
      /^\/role(?:\s+(?<arg>.*))?$/i,
      new RegExp(`^${LEAD}(?:切换|换|设置|改)(?:一下|个|一个)?角色(?:到|为|成)?\\s*(?<arg>.*)$`),
    ],
  },
  {
    id: 'silent',
    desc: '关闭聊天（群友消息不再回复，管理员照常）',
    patterns: [
      /^\/(?:silent|quiet)$/i,
      new RegExp(`^${LEAD}(?:关闭|关掉|停掉|停止|禁用)(?:你的)?(?:聊天|说话|发言|回复)(?:功能)?${TAIL}$`),
      new RegExp(`^${LEAD}(?:把)?(?:你的)?(?:聊天|说话|发言|回复)(?:功能)?(?:给)?(?:关掉|关了|关闭|停掉|停了)${TAIL}$`),
      new RegExp(`^${LEAD}(?:别|不要)(?:再)?(?:说话|回复|发言)了?${TAIL}$`),
    ],
  },
  {
    // 只关**这一个会话**的聊天（群管理员也能用；全局静默 /silent 仍只给主人）。
    // 可以带群号（`/安静 20000003`）：委派群管理员在**私聊**里必须带，否则不知道他要关哪个群。
    id: 'quiet',
    desc: '只在当前会话关闭聊天（本群/本私聊；群管理员可用，私聊可带群号）',
    patterns: [
      /^\/(?:quiet|mute|安静|闭嘴)(?:\s+(?<arg>\d{6,12}))?$/i,
      new RegExp(`^${LEAD}(?:这个群|本群|这里|群里)(?:先)?(?:安静|静一静|别说话|闭嘴)(?:一下)?${TAIL}$`),
      new RegExp(`^${LEAD}(?:先)?(?:在这个群|在本群)(?:别|不要)说话${TAIL}$`)
    ]
  },
  {
    // 恢复**这一个会话**的聊天。
    id: 'resume',
    desc: '恢复当前会话的聊天（群管理员可用，私聊可带群号）',
    patterns: [
      /^\/(?:resume|unmute|恢复|说话)(?:\s+(?<arg>\d{6,12}))?$/i,
      new RegExp(`^${LEAD}(?:这个群|本群|这里|群里)(?:可以|能)?(?:说话|聊天|回复)了?${TAIL}$`),
      new RegExp(`^${LEAD}(?:恢复|开启|打开)(?:这个群|本群|这里)(?:的)?(?:聊天|说话|回复)(?:功能)?${TAIL}$`)
    ]
  },
  {
    id: 'active',
    desc: '开启聊天（恢复正常回复）',
    patterns: [
      /^\/(?:active|speak)$/i,
      new RegExp(`^${LEAD}(?:开启|打开|恢复|启用|开始)(?:你的)?(?:聊天|说话|发言|回复)(?:功能)?${TAIL}$`),
      new RegExp(`^${LEAD}(?:可以|能)(?:说话|回复|发言)了${TAIL}$`),
    ],
  },
  {
    // 订阅某人的发言（triggers.speakerIds）：那人**说任何话**都会唤醒她，是唯一"按人"的唤醒开关。
    // 参数写法：`[群号] 目标`，目标可以是 QQ 号或群名片/昵称（从最近的群成员名缓存里认）。
    id: 'subscribe',
    desc: '订阅某人的发言（可在群里加；[群号] 目标）',
    patterns: [
      /^\/(?:订阅|sub|subscribe)(?:\s+(?<arg>.+))?$/i,
      new RegExp(`^${LEAD}(?:订阅|关注)(?:一下)?\\s*(?<arg>.+)$`),
      new RegExp(`^${LEAD}把\\s*(?<arg>.+?)\\s*(?:订阅|关注)(?:上|一下|了)?${TAIL}$`),
    ],
  },
  {
    id: 'unsubscribe',
    desc: '取消订阅（写「全部」清空）',
    patterns: [
      /^\/(?:取消订阅|退订|unsub|unsubscribe)(?:\s+(?<arg>.+))?$/i,
      new RegExp(`^${LEAD}(?:取消订阅|退订)\\s*(?<arg>.+)$`),
      new RegExp(`^${LEAD}把\\s*(?<arg>.+?)\\s*(?:取消订阅|退订)(?:掉|了)?${TAIL}$`),
      new RegExp(`^${LEAD}取消\\s*(?<arg>.+?)\\s*的?订阅${TAIL}$`),
    ],
  },
  {
    id: 'subscribe-list',
    desc: '看当前订阅了谁',
    patterns: [
      /^\/(?:订阅列表|subs|subscriptions)$/i,
      new RegExp(`^${LEAD}(?:看|查|列出)?(?:一下)?订阅(?:列表|名单)?${TAIL}$`),
    ],
  },
];

/**
 * 匹配管理指令。命中返回 `{ id, desc, arg }`，没命中返回 null。
 * 表内顺序即优先级，取第一个命中的模式。
 */
export function matchAdminCommand(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // 前导 @提及：群里 @她 下指令时，@段渲染成 "@名字" 顶在句子最前面（qq-text.js 的 at 分支），
  // 而模式是整句锚定的 —— 不剔掉就永远匹配不上。
  // 真实事故：群里「@她 关闭聊天功能」没被桥执行，她只看到"你让我闭麦"，就口头答应然后继续说。
  // 只剔**带空白分隔**的形式（QQ 里 @ 之后通常有空格）；**粘连形式故意不猜** ——
  // 若按"每个位置切一刀"去试，会变成变相的子串匹配，又把上一轮修掉的误触发放回来。
  const stripped = t.replace(/^@\S+\s+/, '');
  for (const cand of stripped === t ? [t] : [t, stripped]) {
    for (const cmd of ADMIN_COMMANDS) {
      for (const re of cmd.patterns) {
        const m = re.exec(cand);
        if (m) return { id: cmd.id, desc: cmd.desc, arg: String(m.groups?.arg ?? '').trim() };
      }
    }
  }
  return null;
}

/** 斜杠开头但没命中指令的（如 /model）要原样交给 DSH 执行，不能吞掉。 */
export function isSlashCommand(text) {
  return String(text ?? '').trim().startsWith('/');
}

/**
 * 群里下**自然语言**指令时，算不算"对她说"。
 *
 * 私聊一律算；群里要求：真点名（@她/叫名字/引用她）**或**句首带 @提及。
 * 最后这条是踩出来的：管理员手打「@你 关闭聊天功能」—— 那个 "@你" 不是从成员列表里选的，
 * 所以 `isDirectAddress` 认不出来；而匹配层已经把前导 @ 剔掉了、能匹配上，
 * 结果被这道"必须点名"的门挡在门外，指令又没执行（她照旧说话，看着像阳奉阴违）。
 */
export function isCommandAddressed({ kind, plainContent, directAddress = false, quoteTargetIsSelf = false } = {}) {
  if (kind === 'private') return true;
  if (directAddress || quoteTargetIsSelf) return true;
  return /^@\S+/.test(String(plainContent ?? '').trim());
}

/** 给提示词/文档用的一句话清单。 */
export function describeAdminCommands() {
  return ADMIN_COMMANDS.map((c) => `· ${c.id}：${c.desc}`).join('\n');
}
