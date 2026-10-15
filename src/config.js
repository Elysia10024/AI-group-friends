// 配置加载域：从 bridge.js 的**模块级**整体搬出来的单个函数（loadConfig，262 行）。
//
// 搬出来的理由：bridge.js 是个巨型文件，想读这一段得跨过整个文件。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且**在构造点之前**声明的名字走解构；
//   · **可写的**和**在构造点之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 0 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
import { deepMerge } from './core/deep-merge.js';
// 聊天密度（densityWake）的默认值住在纯函数模块里（那边有单测），这里只引用一份 ——
// 抄一遍字面量就等于给自己留了第二个真相，改了一处另一处静默过期。
import { DENSITY_DEFAULTS } from './core/msg-density.js';

// ── 推理档位：**只在这里写一次** ─────────────────────────────────────────────────
// DeepSeek 的模型元数据写着 deepseek-flash（= V4.1-Flash）
//   effort.supported_levels = ["low","high","max"]，effort.default_level = "high"
// 也就是说 high 是模型自己的默认档，low 是"主动降级"、max 是"往上限顶"。
//
// 为什么单独抽成常量（2026-10-05 的真实教训）：同一个值曾在三处各写一遍并且互相打架 ——
// config.json 写 low、这里的默认值写 max、scripts/test-vision-media.mjs 断言必须是 max，
// 结果那条守卫长期是红的也没人知道（它不在每日体检里）。现在默认值、桥下发的值、
// 守卫脚本都从这两个常量取（守卫见 scripts/check-effort-config.mjs）。
export const REASONING_EFFORTS = ['low', 'high', 'max'];
export const DEFAULT_REASONING_EFFORT = 'high';

// ── 配置默认值（**加配置键 = 在这里的对应段落加一行，只此一处**）────────────────
// 控制台保存配置时的类型规整也由这里推导（见 core/config-normalize.js）：加一个键不用再去
// 路由里抄一遍键名。以前 socialV2.tools 的默认值在字面量里列一遍、loadConfig 末尾又整份列了
// 第二遍（第二遍顶掉第一遍），sticker.collect 甚至在同一个对象字面量里连写了两遍 —— 加一个键
// 要改两三处，漏一处就静默丢默认值。现在嵌套段落由 deepMerge 递归合并，一份就够。
export const CONFIG_DEFAULTS = {
  dsh: {
    baseUrl: 'http://127.0.0.1:3080',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash-vision-exp',
    reasoningEffort: DEFAULT_REASONING_EFFORT
  },
  snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '' },
  // 语音转写（她"听得见"）：record 段 → 本地 SenseVoice-Small → 文字进提示词。
  // 工具在 <root>/asr/（transcribe.py + venv + models，见 docs/语音转写.md）。
  // 路径留空 = 自动找默认位置；QQ_BRIDGE_ASR=off 可整体关掉（不改配置也能关）。
  voice: {
    enabled: true,
    scriptPath: '',
    pythonPath: '',
    timeoutMs: 20000
  },
  // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
  sessionCwd: '',
  agentPreset: 'qq-chat',
  workspaceTitle: 'QQ 聊天',
  ackMessage: '🤔 收到，正在思考…',
  sendDelayMs: 300,
  questionTimeoutMs: 5 * 60 * 1000,
  consolePort: 3100,
  consoleToken: '',
  security: {
    interceptNotify: true
  },
  slang: {
    enabled: true,
    extractMinMessages: 10,
    extractCooldownMs: 5 * 60 * 1000,
    // 候选词出现次数达到这些档位就触发**联网考究**（web_search + web_fetch 多轮）——
    // 这是黑话链路上最贵的一环：2026-10-14 实测 09:00~10:00 一小时里，黑话 agent 花了 ¥2.709
    // （26 个任务 / 116 个请求 / 未命中 871k），而且正好在高峰价时段。
    // 原来有 2/4/8 三档，去掉最低的 2 → 研究次数大致减半；冷门词晚一点有释义，基本无感。
    inferenceThresholds: [4, 8],
    injectMax: 8,
    learnerPreset: 'qq-chat',
    workspaceTitle: 'QQ 黑话学习',
    autoResearch: true,
    // 每次抽取/研究都用**新的干净会话**（2026-10-14 加）。
    // 为什么：这是个长期复用的单例会话，每次抽取都往里追加 —— 而抽取/研究的输入**是自包含的**
    // （prompt 里带的就是"最近这几条群消息"或"这批候选词"，历史对它没有任何增益）。
    // 实测代价：那个会话 8.3 天涨到 41.9 万 token、平均每次请求要重读 24 万（¥0.886/天，占她当天 8.7%）。
    // 换成每次新会话后，上下文回到"系统提示 + 这一次的 prompt"≈1~2 万。
    // 代价只是会话目录变多（每个都是小文件），而缓存按前缀匹配、跨会话照样命中，不会因此多花钱。
    // 回退：设成 false 就回到"一个会话用到底"的老行为。
    freshSession: true
  },
  social: {
    enabled: true,
    // 启动阶段（观望）
    triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
    contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
    // 活跃阶段（对话进行中）
    activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
    activeCheckMaxMs: 30 * 1000,
    activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
    activeReplyDelayMaxMs: 8 * 1000,
    // 活跃超时主动退出（防止活跃群中一直保持活跃）
    activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
    activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
    activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
    // 冷场处理
    idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
    idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
    idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
    // 二期：观望阶段主动开话题（第三种触发）
    proactiveEnabled: true,         // 总开关
    proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
    proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
    proactiveCheckMaxMs: 90 * 60 * 1000,
    proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
    // 选择性沉默/退让
    skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
    surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
    // 摘要与展示
    maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
    mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
    // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
    burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
    burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
    burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
    longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
    longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
    longGapMaxMs: 5000              // 长间隔上限（当前控制台保存值）
  },
  socialV2: {
    enabled: true,
    autoReplyCheckMs: 30000,
    agentPreset: 'qq-chat-v2',
    provideRecommendations: true,
    tools: {
      getPrompt: true,
      getRecent: true,
      sendGroup: true,
      sendPrivate: true,
      reply: true,
      sendBurst: true,
      sendMessage: true,
      waitMessages: true,
      feedback: true,
      getMyRecent: true,
      getMessageDetail: true,
      getActiveMembers: true,
      setWakeConfig: true,
      memory: true,
      slangQuery: true,
      slangSubmit: true,
      getImages: true,
      getForwardMsg: true,
      sendPoke: true,
      listStickers: true,
      getStickerImage: true,
      sendSticker: true,
      setStickerRemark: false,
      stickerNote: true,
      collectSticker: true,
      getSelfImage: true,
      // 语音输出（她自己的声音）：本机常驻 TTS worker 合成 → OneBot 发 record 段。
      // 硬边界在 domains/voice-out.js：群里默认不发、单条字数、最小间隔、每日上限。
      sendVoice: true,
      // QQ 空间说说（她自己发的那种"自言自语"，公开发布）。
      // 硬边界在 core/qzone.js：每日上限、两次最小间隔、正文长度、密钥拦截。
      postMood: true,
      deleteMood: true,
      listMoods: true,
      // 只看不写：好友动态、某条说说的评论（含楼中楼）。
      // 读评论走她自己的 cookie 直连空间 CGI（网关没暴露这个动作），见 domains/qzone.js 那段注释。
      qzoneFeeds: true,
      moodComments: true,
      // 写：回她自己说说下面的评论（只回自己的、每条一次、窗口限频 —— 边界在 domains/qzone.js）。
      commentMood: true
    },
    // QQ 空间说说（她"自己发一条"）的边界。
    // 为什么默认这么紧：说说是**公开发布**、发出去就在空间里挂着 —— 群里说错一句最多当场被怼，
    // 说错一条是挂在墙上。所以一天 2 条、两次至少隔 2 小时（风控 + 像真人）。
    // 权限默认 1（所有人可见）—— 2026-10-13 主人手动把她那条改成所有人可见之后定的：他要的就是公开。
    // 判据（本地日切口、额度、正文校验、评论去重/限频）全在 core/qzone.js，有单测。
    qzone: {
      enabled: true,
      dailyCap: 2,               // 每天最多几条（本地日，UTC+8）
      minGapMs: 2 * 3600 * 1000, // 两次之间至少隔多久
      ugcRight: 1,               // 默认权限：1 所有人 / 4 好友 / 64 仅自己
      maxChars: 300,             // 正文上限（字）
      promptHint: true,          // 是否在每轮提示里带【说说】那一行
      // 配图（默认开）：图只从本地图库取（名字就是它的意思），上传到空间"说说相册"。
      // 注意：**删说说不会把上传的图一起删掉**（图还在相册里），所以配图比纯文字更"留痕"。
      imageEnabled: true,
      // 评论：监听"她的说说下面有没有新评论"并在有新评论时叫醒她一次（只读轮询，不花 token）；
      // 回评论的边界：只回自己的说说、每条一次、30 分钟内最多 2 条、单条 ≤120 字。
      commentWake: true,
      commentCheckMs: 10 * 60 * 1000,
      commentMaxChars: 120,
      commentReplyCap: 2,
      commentReplyWindowMs: 30 * 60 * 1000
    },
    // 语音输出的边界（她"什么时候能说、能说多长"由这里兜住，不靠她自觉）
    voiceOut: {
      workerUrl: 'http://127.0.0.1:3210',
      allowGroups: false,      // 默认不在群里发语音；要开由主人显式开（群里另有更紧的边界）
      maxChars: 20,            // 单条最多这么多字（约 10 秒）
      minIntervalMs: 180000,   // 私聊：同一个会话两次语音之间至少隔 3 分钟
      dailyCap: 20,            // 私聊：每天最多 20 条
      groupMinIntervalMs: 600000,  // 群里：至少隔 10 分钟（一群人在听，出声越少越值钱）
      groupDailyCap: 4             // 群里：每天最多 4 条
    },
    wake: {
      defaultMode: 'diving',
      preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
      preSleepWaitMs: 120000,          // 默认沉睡前至少等待/观察 2 分钟（后台可调）
      recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
      sleepMinMs: 60000,
      sleepMaxMs: 0,
      recommendedSleepMinMs: 300000,
      recommendedSleepMaxMs: 7200000,
      recommendedProbability: 0.05,
      recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
      recommendedAtMention: true,
      recommendedNameMention: true,
      recommendedQuestion: true,
      recommendedPoke: true,
      recommendedHint: '你不是只能被叫才说话：被 @/叫名字/拍一拍/直接问时必须回；此外群里有你能接、有意思、有态度的话题，也可以自然插一句，不用每条都参与，也不用一直沉默。收尾别刻意等：设好下一次唤醒条件就收尾（qq_set_wake_config），长时间等会占住会话、别人 @ 你时要排队。潜水时长推荐 5~120 分钟；常态潜水锁开着时，概率/提问/任意消息由桥接固定关闭（设了也不生效），稳定生效的是 @/名字/拍一拍/白名单关键词。要等某个人时可以临时订阅他（triggers.speakerIds，成本开关：他说任何话都唤醒你），管理员也能在私聊里让你加/取消。',
      batchWindowMs: 8000,
      maxWakePerMinute: 1,
      maxWakePerHour: 12,
      noActionLimit: 3,
      maxWakeConfigReminders: 2
    },
    send: {
      burstEnabled: true,
      burstMaxMessages: 8,
      burstIntervalMinMs: 1000,
      burstIntervalMaxMs: 3000,
      longGapProbability: 0.2,
      longGapMinMs: 5000,
      longGapMaxMs: 10000,
      maxSendPerMinute: 8,
      maxSendPerHour: 60,
      // 回复额度：被直接叫醒（@/名字/拍一拍/私聊/跟进/红包）之后的 10 分钟内，
      // 每小时上限之外还能多用这么多条。没有它，上半天闲聊会把额度烧完，
      // 等到她被人对线时一个字都发不出去（2026-09-19 真实事故，见 core/ratelimit.js）。
      replyBudgetPerHour: 30,
      replyBudgetWindowMs: 600000,
      maxMessageChars: 500,
      maxGapMs: 10000,
      gapBaseMs: 800,
      gapPerCharMs: 20,
      recommendedHint: '普通对话默认 1 条、最多 2 条；讲故事/回忆/补刀时可以 2~4 条。条间 1~3 秒，讲故事可以 5~10 秒；不要连续刷屏。'
    },
    wait: {
      defaultMs: 30000,
      minMs: 5000,
      maxMs: 600000,
      defaultQuietMs: 8000,
      minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
    },
    sticker: {
      enabled: true,             // 表情包体系总开关
      syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
      maxListCount: 100,         // qq_list_stickers 单次最大返回数
      includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
      promptMaxStickers: 8,      // 提示里最多列出的常用表情数
      collect: {
        enabled: true,           // AI 收藏他人表情总开关
        maxPerMinute: 2,         // 每分钟最多收藏次数
        maxPerHour: 10,          // 每小时最多收藏次数
        maxRemarkChars: 20       // 收藏时备注最大长度
      }
    },
    // 主动冒泡（"群里安静 ≥15 分钟就自己找话说"）——**2026-10-14 已关**，由下面的 densityWake 取代。
    // 关它的依据是日志：75 条记录里全是"已安排…约 20~24 小时后检查"，一次真触发都没有
    // （排期 18~24 小时 + 到点还要群安静 15 分钟 + 概率），是段看起来在工作、其实在空转的机制；
    // 何况"安静时没话找话"正是话质量最差的那种。留着这段配置只为可回退（设 true 即恢复）。
    proactive: {
      enabled: false,
      checkIntervalMinMs: 30 * 60 * 1000,
      checkIntervalMaxMs: 90 * 60 * 1000,
      idleThresholdMs: 15 * 60 * 1000,
      probability: 0.3
    },
    // 聊天密度触发插话（densityWake，2026-10-14 主人要求）——**和上面的 proactive 方向相反**：
    //   · proactive 要求"群里安静 ≥ idleThresholdMs"才冒泡，是没人说话时她自己找话；
    //   · densityWake 要求"最近 windowMs 内消息够多"，是**群里正热闹时插一句** —— 话题新鲜、有人接，
    //     而不是一个人对着冷掉的群自言自语。
    // 为什么阈值/上限这么定（每一道闸门都对应一笔真实开销）：
    //   · 25 条 / 10 分钟 ≈ 每分钟 2.5 条，是"确实在聊"而不是"偶尔飘过两句"；
    //   · cooldownMs 30 分钟 + dailyCap 6 是**成本闸门**：每次唤醒 = 一整轮模型调用，
    //     不夹住的话一个热闹的群能把她一天的钱烧在插话上（6 次也够覆盖一天里的几波高潮）；
    //   · probability 0.5 让她不必"达标必开口"——达标只是有机会，说不说仍看她自己；
    //   · activeHourStart/End 挡掉凌晨：半夜群里再热闹也别叫她。
    // 判定逻辑与全部单测在 src/core/msg-density.js（纯函数，时间/随机数都从参数进来）。
    densityWake: { ...DENSITY_DEFAULTS },
    feedback: {
      maxLength: 500,
      notifyOwnerOnError: false
    },
    // 故障告警（用户 2026-10-03）：她连续多轮调不通（key 失效 / 余额不足 / 模型不可用 / 网络）
    // 时私聊告诉主人 —— 第一次立刻报，同一场故障每 repeatIntervalMs 最多再报一次，恢复再报一声。
    // 判定与文案：src/core/alert.js（有单测）；只在私聊发，群里一个字都不提。
    alert: {
      enabled: true,
      repeatIntervalMs: 30 * 60 * 1000
    },
    context: {
      recentLimit: 100,
      unreadLimit: 30,
      contextWindow: 20,
      // A1 上下文组装器（设计见 docs/上下文组装设计.md）：
      //   shadow=true   影子模式：照常走长会话，另外生成"新方案会给她看什么"并落盘/控制台可看（只读旁路，零风险）
      //   enabled=true  真正切换（A1.1）。出问题把它改回 false，立刻回到现在的长会话——这就是后路开关
      assembler: { enabled: false, shadow: true }
    }
  }
};

// ── 数值范围 / 枚举（只有"默认规则不够用"的键才写在这里）────────────────────
// 默认规则（见 core/config-normalize.js）：布尔→严格取布尔；整数→四舍五入且非负；
// 小数→按概率夹到 0..1；数组→逗号/空格拆分；字符串→String(v ?? '')；对象→递归。
// 所以这里只列**要额外夹范围**的和**枚举**的键。路径带 socialV2. 前缀。
export const CONFIG_RANGES = {
  'socialV2.autoReplyCheckMs': [1000, null],
  'socialV2.feedback.maxLength': [1, null],
  'socialV2.context.recentLimit': [1, null],
  'socialV2.context.unreadLimit': [1, null],
  'socialV2.context.contextWindow': [1, null],
  'socialV2.sticker.maxListCount': [1, 500],
  'socialV2.sticker.promptMaxStickers': [1, 30],
  // 说说：上限别让人填出 0（0 会被 core 当成"没配"退回默认值，反而更糊涂）——夹到 1~10。
  'socialV2.qzone.dailyCap': [1, 10],
  'socialV2.qzone.maxChars': [1, 1000]
};
// 注意：前端的"保存"里还有几处自己的夹取（syncTtlMs ≥ 1000、maxRemarkChars 1~50 等），
// 那是面板侧的输入约束，**服务端正规化并不夹这些** —— 别照着前端再抄一遍（抄了就等于悄悄改了行为）。

// 枚举：值不在允许列表里 → 回落到该键的**默认值**（不是回落到第一个允许值）。
export const CONFIG_ENUMS = {
  'socialV2.wake.defaultMode': ['active'],
  // 面板里手填一个不存在的档位（比如 ultra）会被这里退回默认档，而不是存下去让桥在下发时报错。
  'dsh.reasoningEffort': REASONING_EFFORTS,
  // 说说的默认权限：只开放这三个。"部分好友可见/不可见"（16/128）需要名单，
  // 面板上一个输入框表达不了，硬要做只会做出一个能存坏配置的开关 —— 要用就手改 config.json。
  'socialV2.qzone.ugcRight': [1, 4, 64]
};


export function createConfigModule(ctx) {
  const {
    ROOT,
    normalizeIdList,
    normalizeOwnerQQ,
    path,
    readJsonSafe,
  } = ctx;


// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = deepMerge(CONFIG_DEFAULTS, file);

  // 下面这几项不是"默认值 + 覆盖"能表达的，必须按 config.json 的**原值**规范化/严格取布尔，
  // 所以不放进 CONFIG_DEFAULTS（放进去反而是第二份真相）。
  cfg.ownerQQ = normalizeOwnerQQ(file.ownerQQ);
  cfg.allow = {
    private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
    groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
  };
  cfg.deny = {
    private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
    groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
  };
  // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
  cfg.allowAllWhenEmpty = file.allowAllWhenEmpty === true;

  return cfg;
}


  return { loadConfig };
}
