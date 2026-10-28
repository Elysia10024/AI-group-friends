// 唤醒提示词组装 —— 纯函数：给定 ctx，输出字符串。无 I/O、无时钟、无副作用。
//
// 从 bridge.js 的 main() 闭包里抽出来（R1' 第 2 步）。抽出来的动机不只是"搬家"：
// 原来它是 13 段字符串直接相加：
//     const base = mentionLine + roleLine + selfNameLine + tokenLine + contextLine
//                + antiAiLine + proactiveLine + stickerLine + preSleepLine
//                + statusLine + wakeLine + memoryLine + participationLine;
// 每加一条要求就再挂一项，`proactiveLine` 一项就 2200 字符、装了 10 条互不相关的要求。
//
// 现在改成 SECTIONS 声明式列表：加/删/调序是**改数据**，不是改代码。
// 每条带 `static` 标记 —— 标注"这一段的每回合内容是否恒定"，
// 恒定的段落属于"应该放进 system prompt、而不是每轮塞进 user 消息"的候选
// （见 成本治理方案.md 阶段 1.3）。本步只标注，不改任何输出。
//
// 关于日期/时钟：原来函数内部直接调 Date.now()（判断提醒是否过期、上次发言几分钟前）。
// 现在统一从 ctx.now 传入，这样测试能喂固定时间。
import { groupStyleHint } from './redpacket.js';
import { looksLikeTopicEnd } from './topic-end.js';
import { looksLikeUnfinished } from '../v2-wait.js';
import { mentionLabel } from './mention-label.js';
import { fmtLocalNow } from './local-day.js';

/** 「有人在找你」提醒的有效期：2 小时 */
const MENTION_TTL_MS = 2 * 3600000;

// 人格与规则已经**只写在一处**：roles/<角色>/core.md（人格）+ roles/<角色>/速记.core.md（流程硬规则）。
// 这里以前还内联着【反AI味】【说话时机】【傲娇配比】【记忆是你的硬盘】【收尾要快】等大段文案——
// 它们与那两处**互相打架**（例如这里写着"被夸先嘴硬"，人格里写着"不嘴硬"）。
// 2026-09-30 重构：这些段落一律删掉，prompt 只负责"这一轮的事实与机械信息"。

/**
 * 声明式段落表。顺序即输出顺序。
 * static=true 表示该段每回合内容恒定（与 st/时间无关）→ 属于搬进 system prompt 的候选。
 *   - role / selfName / token：每"会话"恒定，不是每回合
 *   - antiAi / proactive / preSleep：完全恒定
 *   - mention / context / sticker / status / wake / memory / participation：每回合都可能变
 */
export const SECTIONS = [
  {
    id: 'mention',
    static: false,
    // 【有人在找你】需要她真正看过的事件（@/名字/拍一拍）：她还没真看过，就顶在最前面点名列出原文。
    // 拍一拍也列出来（事实），但回不回由她决定（2026-10-26：被戳烦了允许不理/装死，@ 仍必须回）。
    // 动机：唤醒提示只报条数不给正文，她可能不看就 mark_read，把 @ 一起吞掉。
    render: (ctx, scope) => (scope.liveMentions.length
      ? '【⚠️ 有人在找你，你还没看过】\n' +
        scope.liveMentions
          .slice(-3)
          .map((m) => `- ${m.sender} ${mentionLabel(m)}（seq${m.seq}）：「${m.text}」`)
          .join('\n') +
        '\n这条已经在下面的【最近的群聊】里了，直接回就行。\n\n'
      : '')
  },
  {
    id: 'role',
    static: true,
    render: (ctx) => (ctx.roleState?.role
      ? `【当前角色】${ctx.roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n`
      : '')
  },
  {
    id: 'selfName',
    static: true,
    // 你在这里"叫什么"必须明确告诉它：它的自我认知来自角色卡（小鲸鱼/DeepSeek），
    // 并不知道自己在 QQ 上的昵称与群名片；不说明就会把 @ 自己当成在 @ 别人。
    render: (ctx) => (ctx.selfAliases.length
      ? `【你在本群的名字】${ctx.selfAliases.join(' / ')}——这些都是你自己。消息里出现 @你、或有人用这些名字叫你，就是在找你。\n\n`
      : '')
  },
  {
    id: 'token',
    static: true,
    render: (ctx) => `【会话令牌】${ctx.st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`
  },
  {
    id: 'context',
    static: false,
    // 【最近的群聊】直接内联正文：原来唤醒提示只给"最后一条"的预览，她要靠额外一次
    // 一次"看消息"的额外请求才看得到——而那次请求要重读整个上下文，很贵。
    render: (ctx, scope) => (scope.ctxSlice.length
      ? '【最近的群聊（最新在最下；这就是你要的全部上下文，直接回，不要为了看消息再调工具）】\n' +
        scope.ctxSlice
          .map((m) => {
            // 标出管理员：她必须能一眼看出谁是自己人（ownerQQ 的 isOwner 标记）。
            const who = m && m.isSelf
              ? '我'
              : String((m && m.sender) || '?').replace(/\s+/g, ' ').slice(0, 14) + (m && m.isOwner ? '·管理员' : '');
            const body = String((m && (m.text ?? m.plain)) ?? '').replace(/\s+/g, ' ').slice(0, 200);
            return `[${who}] ${body}`;
          })
          .join('\n') + '\n\n'
      : '')
  },
  {
    id: 'sticker',
    static: false,
    // 表情策略段由桥侧渲染好传进来（它依赖 stickerEntries 模块状态）；
    // 未启用时传空串。
    render: (ctx) => ctx.stickerText
  },
  {
    id: 'qzone',
    static: false,
    // 【说说】那一行（QQ 空间）：今天发过几条、上一条是什么、现在能不能发。
    // **只给事实，不给规矩** —— "什么时候想发"写在角色卡里（roles/<角色>/core.md）。
    // 桥侧渲染（额度是本地账本算的），关掉或没开提示时传空串，这一轮就不花这份 token。
    render: (ctx) => ctx.qzoneText || ''
  },
  {
    id: 'bili',
    static: false,
    // 【B站订阅】那一行：关注了哪些官号、最近播报了什么。
    // 为什么要有：播报是桥接直接发群的，**没进过她的上下文** —— 群里有人问
    // 「你关注的那几个游戏有新动态吗」，她只能瞎猜。给一行事实，答得准，也只花几十 token。
    // 关掉订阅 / 没有订阅时桥侧传空串，这一轮就不出现。
    render: (ctx) => ctx.biliText || ''
  },
  {
    id: 'status',
    static: false,
    render: (ctx) => {
      const st = ctx.st;
      const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
      const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((ctx.now - Number(st.lastAiReplyAt)) / 60000)) : null;
      const statusBits = [`未读 ${(st.unread || []).length} 条`];
      if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 200)}`);
      if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
      // 收尾信号要点出来：2026-09-19 他递了台阶（"我要洗澡了"），她补了一刀
      // （"别把脑子也一块冲下水道了"），一小时后就续成了那场大战。
      // 这句只在**这条消息确实像要走**时出现，且措辞分场合（吵架收住 / 闲聊照常）。
      if (lastMsg && looksLikeTopicEnd(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) {
        statusBits.push('对方像是要收尾（去忙/洗澡/睡/不聊了）——正在互怼就收住别补刀，闲聊照常打趣');
      }
      if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
      return `【此刻状态】${statusBits.join('；')}\n\n`;
    }
  },
  {
    id: 'wake',
    static: false,
    render: (ctx) => {
      const wc = ctx.st.wakeConfig || {};
      const wcTr = wc.triggers || {};
      const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
      const wcTime = wc.infinite
        ? '无限'
        : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
      const wcTriggers = [];
      if (wcTr.atMention) wcTriggers.push('@');
      if (wcTr.nameMention) wcTriggers.push('名字');
      if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
      if (wcTr.question) wcTriggers.push('提问');
      if (wcTr.poke) wcTriggers.push('拍一拍');
      if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
      if (wcTr.anyMessage) wcTriggers.push('任意消息');
      wcTriggers.push('红包');
      if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
      return `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    }
  },
  {
    id: 'memory',
    static: false,
    render: (ctx) => (ctx.memoryText ? `${ctx.memoryText}\n\n` : '')
  },
  {
    id: 'participation',
    static: false,
    render: (ctx) => (ctx.participationText ? `${ctx.participationText}\n\n` : '')
  },
  {
    id: 'now',
    static: false,
    // 【现在】必须是**最后一块**（硬约束，别因为"这条最重要"就往上挪）。
    //
    // 为什么：材料的前缀吃 DeepSeek 的前缀缓存，命中单价约是未命中的 1/50。当前时间**每轮都在变**
    // （分钟级），一旦它落在任何一段前面，它后面的所有内容每轮全部缓存失效 —— 成本立刻翻一大截，
    // 而且是静默的（她照常说话，只有账单知道）。排在最后，则它前面的一切照旧命中，
    // 每轮只有这一小块是新的。
    //
    // 为什么要这一块（真实 bug）：她 23:00 被唤醒后问"早八上完没"。材料里没有任何地方告诉她
    // "现在几号、周几"，而记忆里的"白天有早八"又是几天前记的（见 core/memory.js 的时间标记）
    // —— 两件事叠在一起，她把几天前的话茬当成了现在。
    // 为什么带星期：她的生活全是工作日概念（早八 / 周一 / 周末），没有星期她算不出"还有几天"。
    render: (ctx) => {
      const now = Number(ctx.now);
      // 没有时间就整块不出现：这里**不许**退回 new Date()（本模块是纯函数，测试喂的是固定时间；
      // 真在渲染里读机器时钟，测试和线上就成了两个真相）。
      return Number.isFinite(now) && now > 0 ? `【现在】${fmtLocalNow(now)}\n\n` : '';
    }
  }
];

/** 计算所有段落共用的中间量：还活着的提醒、以及要内联的群聊切片。 */
function prepareScope(ctx) {
  const st = ctx.st;
  const all = Array.isArray(st.pendingMentions) ? st.pendingMentions : [];
  // 起点锚只认"还活着"的提醒（她没查过、且 2 小时内）——过期提醒不能把锚点拖到很远，
  // 否则每轮都会内联几十条无关消息。
  const liveMentions = all.filter(
    (m) => m && Number(m.seq) > (Number(st.lastFetchedSeq) || 0) && ctx.now - (Number(m.at) || 0) < MENTION_TTL_MS
  );

  const inlineMax = Math.max(5, Math.min(60, Number(ctx.inlineMax) || 20));
  const recentAll = Array.isArray(st.recentMessages) ? st.recentMessages : [];
  // unread 全部算锚点（未读本来就该全看到）
  const anchorSeqs = [
    ...liveMentions.map((m) => Number(m.seq)),
    ...(Array.isArray(st.unread) ? st.unread.map((m) => Number(m && m.seq)) : [])
  ].filter((n) => Number.isFinite(n) && n > 0);

  let ctxSlice = recentAll.slice(-inlineMax);
  if (anchorSeqs.length) {
    const anchorSeq = Math.min(...anchorSeqs);
    const at = recentAll.findIndex((m) => m && Number(m.seq) >= anchorSeq);
    if (at >= 0) {
      // 保底 inlineMax 条（未读很少时也要有上下文），锚点更早则往前扩，但最多 60 条封顶。
      const want = recentAll.length - at;
      const take = Math.max(inlineMax, Math.min(60, want));
      ctxSlice = recentAll.slice(-take);
    }
  }
  return { liveMentions, ctxSlice };
}

/**
 * 按 reason 生成结尾段。
 * @param {object} ctx
 * @param {{ctxSlice: Array}} scope
 */
function renderReasonTail(ctx, scope) {
  const { key, reason } = ctx;
  if (reason === 'bootstrap') {
    return `【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看你的角色、推荐值、可用工具和当前状态，然后用 qq_set_wake_config 设置你希望如何被唤醒。`;
  }
  if (reason === 'timeout') {
    return `【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
  }
  if (reason === 'replyCheck') {
    // preSleepMs>0 表示后台把"沉睡前观察"开关打开了，这时才要求她先观察一段；
    // 关着（传 0）就不提，免得跟每轮提示里的「收尾要快」自相矛盾、还让她白等两分钟。
    const head = `【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n你可以调用工具查看未读消息、用 qq_wait_for_messages(quietMs=5000~10000) 判断对方是否说完。`;
    const tail = Number(ctx.preSleepMs) > 0
      ? `如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${ctx.preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_set_wake_config）。`
      : '如果没人回你，不用硬补一句；回完直接收尾即可（qq_set_wake_config），不要原地长时间等。';
    return head + tail;
  }
  if (reason === 'proactiveCheck') {
    // 群里安静时的这次机会，也是"她自己想发条说说"最自然的时机（提示行里写着今天还能不能发）。
    const moodTail = ctx.qzoneText
      ? '心里正好有句话想说、又不想在群里开口，也可以发条说说（额度见上面【说说】那行）。'
      : '';
    return `【主动机会】${key}\n原因：群里已经安静了一段时间，桥接给你一次"可以主动开口"的机会。\n有想接的话头、或者刚想到什么（群友的事、你自己这边的事）就自然说一句；**没有想说的就安静收尾**——不用标已读、也不用改唤醒条件（桥接会自动处理）。别为了打破沉默硬找话题，也别专门搜热点来凑话。${moodTail}`;
  }
  if (reason === 'densityWake') {
    // 这一条和上面的 proactiveCheck 是**相反的时机**：那个是"群里安静了，回头看一眼"，
    // 这个是"群里正热闹，你插得上就插一句"。所以文案不能复用，口径要反过来：
    // 前者不鼓励为打破沉默找话，后者要先让她**看一眼这会儿在聊什么**再决定，否则她会拿
    // 好几分钟前的话当现在的话接（群里那种"她怎么突然回岔了"多半就是这么来的）。
    // 结尾那句刹车是必须的：密度达标只说明"机会来了"，不说明"该说话了" ——
    // 为了不浪费机会硬凑一句，比不说话更像机器人。
    return `【插话机会】${key}\n原因：群里这会儿聊得正热（不是有人 @ 你，也不是群里安静了）——桥接觉得话头还新鲜，给你一次"插得进去就说一句"的机会。\n`
      + `【怎么做】先用 qq_get_recent_messages 扫一眼这几分钟在聊什么：有你能接的梗、能接的半句、或者正好懂的话题，就用一两句自然插进去（接着当前的话题说，别自己另起一摊）。\n`
      + `**没有想说的、看不懂、或者话题已经过去了，就安静收尾**（qq_set_wake_config）——这次机会不发言完全没有问题；为了不浪费机会硬凑一句，比不说话更像机器人。\n`
      + `别连发好几条、别"报到"式地冒个泡，也别把好几分钟前的话当成现在的话来回。`;
  }
  if (reason === 'biliScroll') {
    // 空闲时段（低价）自己刷视频：桥接只给"可以刷了"的由头，看不看、说什么都归她。
    // 2026-10-24 用户定：每天配额按空闲小时数；凌晨 1~8 点只刷不分享（普通聊天照常），
    // 刷到的攒进待分享池，8 点后挑 1~2 个群说自己的看法。
    const bs = ctx.biliScroll || {};
    const quiet = bs.quiet === true;
    const pending = Array.isArray(bs.pending) ? bs.pending.slice(0, 6) : [];
    const groups = Array.isArray(bs.groups) ? bs.groups : [];
    const groupLine = groups.length
      ? `【能发消息的群】${groups.map((g) => g.key).join('、')}——分享时挑 1~2 个群说，别每个群都发一遍。\n`
      : '';
    const pendingLine = pending.length
      ? `【凌晨刷到、还没分享的】\n${pending.map((p) => `- ${p.title || p.bv}（${p.bv}）`).join('\n')}\n`
        + `挑你真正觉得有意思的 1~2 条，现在跟群友说说你的看法；没兴趣就跳过，不用硬发。\n`
      : '';
    if (quiet) {
      return `【空闲时间】${key}\n原因：现在是梁文谷的空闲时段（价格低谷），桥接给你一次"自己去刷会儿 B 站"的机会。\n`
        + `【怎么做】想刷就调用 qq_bili_scroll 挑一个 5 分钟以内的短视频看看：它会返回标题/简介、按热度前 5 条评论，还有一张分镜图（9–16 格、每格标时间戳；想看某段细节可以再调 qq_bili_zoom）。\n`
        + `**现在是凌晨 1~8 点：刷完别在群里分享视频内容**，这轮先攒着，8 点后再挑着说。注意这只是"不分享视频"——群里有人找你、有人聊天，照常回，别装睡。\n`
        + `不想刷、没看到感兴趣的，就安静收尾；想记一笔就 qq_memory_append。`;
    }
    return `【空闲时间】${key}\n原因：现在是梁文谷的空闲时段（价格低谷），桥接给你一次"自己去刷会儿 B 站"的机会。\n`
      + `【怎么做】想刷就调用 qq_bili_scroll 挑一个 5 分钟以内的短视频看看：它会返回标题/简介、按热度前 5 条评论，还有一张分镜图（9–16 格、每格标时间戳；想看某段细节可以再调 qq_bili_zoom）。\n`
      + `看完想说什么就在群里自然说一句（视频本身有意思的点、评论区在聊什么）；**不想说、没看到感兴趣的，就安静收尾**——这次机会不发言完全没问题，别为了刷而刷、也别硬凑一句。\n`
      + `${pendingLine}${groupLine}`
      + `看完想记一笔就用 qq_memory_append 记成 activeTopic 或 pendingThought；别一天刷好几次，桥接会控制频率。`;
  }
  if (reason === 'redPacket') {
    const rp = ctx.redPacket || { kind: 'fake', text: '' };
    const styleHint = groupStyleHint(scope.ctxSlice);
    if (rp.kind === 'real') {
      const greetLine = rp.greeting && !rp.isDefaultGreeting
        ? `红包上的留言写的是：「${rp.greeting}」。**这句留言要接**——顺着留言的内容回一句（谁发的、写了什么就接什么），别当成普通的「恭喜发财」忽略掉。\n`
        : `红包留言是 QQ 默认的「恭喜发财」，**不用针对留言做反应**，只说红包本身。\n`;
      return `【唤醒】${key}\n原因：群里有人发了**真的 QQ 红包**。\n${greetLine}${styleHint}【怎么反应】你抢不到——你的 PC 端就是抢不了红包，这是事实。所以要俏皮／傲娇地认怂：夸老板大气、可惜我抢不到、手慢了、你们抢吧我看着……**不许装成抢到了**，也不许长篇感谢或讲道理。一到两句，短、有梗、带情绪。\n回完直接收尾（qq_set_wake_config）。`;
    }
    return `【唤醒】${key}\n原因：群里有人发了一个**假的"文本红包"**——手打的一行字，一分钱都没有。\n他写的是：「${rp.text || '(空)'}」。其中「[QQ红包]」「【红包】」这类只是前缀，**重点是前缀后面那句话**。\n${styleHint}【怎么反应】**先看他那行字到底写了什么，回他的内容——不要一律嘲讽，也不要每句都只骂"假的"。**\n- 写的是**祝福／许愿／夸你**（例如「祝小鲸鱼天天开心」）→ **先把祝福接住**：傲娇地领情、道谢、嘴上嫌弃心里高兴，都行；再顺口轻轻点一句"可惜是空的"就够了，**不许把祝福本身损掉**。\n- 写的是**金额／炫耀**（例如「50元」「一人10块」）→ 抓金额往死里损：钱呢、一分没见着、画大饼、空手套白狼、拿数字当钱花。\n- 写的是**玩梗／整活** → 接他的梗，配合演两句。\n- 写的是**挑衅／催你／点你名** → 顶回去。\n**【损人要损出花样】**不管走上面哪一支，都要**用比喻、类比、夸张、对比或反问**，把他比成一个具体的东西（越具体越狠），别干巴巴骂一句就完；**换一种你上一条没用过的说法**，同一个梗别连着用两轮，更别每次都只会"一分钱没有"。"这是手打的、一分钱没有"最多做最后半句的点缀，**不要变成整条回复的主题**。火力照群聊风格调：群里在互怼就往死里损，气氛温和就俏皮点。一到两句。\n回完直接收尾（qq_set_wake_config）。`;
  }
  if (reason === 'qzoneComment') {
    // 说说是她自己的空间：评论要**在空间里回**，别搬到群里/私聊里说。
    // （2026-10-13 加：在那之前她根本不知道有人评论过 —— 没有任何触发器。）
    const notice = ctx.qzoneComment?.notice
      ? ctx.qzoneComment.notice
      : '（这次没拿到评论内容，用 qq_mood_comments 看一眼就知道）';
    const tid = ctx.qzoneComment?.tid ?? '';
    return `【空间评论】${key}\n原因：**你发的说说下面有人评论了**（这是 QQ 空间，不是群消息）。\n${notice}\n`
      + `【怎么处理】想回就用 qq_comment_mood（tid=${tid || '见 qq_list_moods'}；想 @ 谁就传 toName=他的名字、toUserId=他的 QQ）。`
      + `**回不回随你**：挑你真想接的那一两条回，其余不用理；不想回就直接收尾（标已读与唤醒条件桥接都会自动处理）。\n`
      + `【边界】① 只回**你自己说说**下面的评论，别人的空间只读、不留言；② 每条只回一次、这一轮最多回一两条；`
      + `③ **不要为了这件事在群里或私聊里发消息**——评论在空间里回；④ 别人空间里看到的东西不要在群里转述。`;
  }
  if (reason === 'poke') {
    // 2026-10-26 用户要求：被戳烦了允许不理/沉默/装死（@ 才是硬性必须回）。
    // 所以这里不再写"必须回应"——给她拒绝的权利，但别让她误以为可以永远装死：
    // 连着被拍、深夜、刚聊完 → 不回也没事；想接就回一句或回拍（必须拍回那个人）。
    return `【唤醒】${key}\n原因：**有人拍了一拍你**（这是在叫你，但没有 @ 那么正式）。\n【回不回看你】拍一拍不是命令：想接就回一句短的（"在呢""怎么了""？"）或用 qq_send_poke 回拍一下；**烦了、不想理、连着被拍**，都可以不回——直接收尾潜水就行，不用解释，也别假装没看见（别回"没看到"这类话）。\n回拍要用**拍你那个人的 QQ**（消息里 \`[拍一拍] <他> 戳了戳 你\` 的那个他；拿不准就用 qq_get_recent_messages 看一眼）——**别拍别人**。\n注意：被 **@** 的时候必须回（那是硬要求）；拍一拍没有这个强制。\n（别人互拍不会叫醒你；你要是正好醒着看见了，才需要判断接不接梗。）`;
  }
  return `【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，看你想不想接：有想说的可以自然插一句，没兴趣就安静收尾——这两者都正常。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；回完或看完直接收尾即可（qq_set_wake_config），不要原地长时间等待。`;
}

/**
 * 组装唤醒提示词。
 *
 * @param {object} ctx
 * @param {string} ctx.key            会话键（group:xxx / private:xxx）
 * @param {string} ctx.reason         唤醒原因
 * @param {number} ctx.now            当前毫秒时间戳（注入而非内部读时钟，便于测试）
 * @param {{role?: string}} ctx.roleState
 * @param {string[]} ctx.selfAliases  她在本群的昵称/群名片
 * @param {object} ctx.st             二代社交状态
 * @param {string} ctx.memoryText     已渲染好的记忆段（空串=不注入）
 * @param {string} ctx.participationText 已渲染好的参与度段
 * @param {string} ctx.stickerText    已渲染好的表情策略段（含末尾空行；空串=不注入）
 * @param {string} ctx.qzoneText   已渲染好的「说说」事实行（空串=不注入）
 * @param {string} ctx.biliText    已渲染好的「B站订阅」事实行（空串=不注入）
 * @param {number} ctx.inlineMax      最多内联多少条群聊
 * @param {number} ctx.preSleepMs     replyCheck 结尾里引用的沉睡等待时长
 * @param {null|{kind:string,greeting?:string,isDefaultGreeting?:boolean,text?:string}} ctx.redPacket
 * @returns {string}
 */
export function buildWakePrompt(ctx) {
  const scope = prepareScope(ctx);
  // A1.1 组装开启时（ctx.assemblerOn）：这几段由桥侧组装材料负责，提示里不再内联，
  // 否则同一批信息每回合发两遍（都是按"未命中"单价算的）。
  const covered = new Set(MATERIAL_COVERED_SECTIONS);
  const sections = ctx.assemblerOn ? SECTIONS.filter((s) => !covered.has(s.id)) : SECTIONS;
  return sections.map((s) => s.render(ctx, scope)).join('') + renderReasonTail(ctx, scope);
}

/** 开启组装时由材料接管、提示里要跳过的段落（见 A1.1 设计）。 */
/**
 * 开启组装时由材料接管、提示里要跳过的段落（见 A1.1 设计）。
 *
 * **这里没有 'now'，是故意的**：材料侧 status 块也有一份"现在"，所以组装开启时
 * 会有两行时间（格式不同、可能差几十秒），看着像重复。试过把 'now' 加进来消掉它，**已回滚**：
 *   · 消掉的收益 ≈ 一行 token，按未命中价一天不到一分钱（¥0.006 量级）；
 *   · 代价是材料侧一旦降级、或组装处于半开状态，她就**彻底失去时间感** —— 而 2026-10-14
 *     这次改动治的恰恰是"她不知道现在是几号"。
 * 宁可贵那一分钱，也别在这件事上留一条隐藏依赖。（等真出问题，先看这条注释。）
 */
export const MATERIAL_COVERED_SECTIONS = ['context', 'status', 'memory'];

/** 供诊断/测试：某段在给定 ctx 下是否会产生输出。 */
export function sectionText(ctx, id) {
  const s = SECTIONS.find((x) => x.id === id);
  if (!s) return null;
  return s.render(ctx, prepareScope(ctx));
}

/** 供成本治理使用：列出恒定的段落 id（这些是搬进 system prompt 的候选）。 */
export function staticSectionIds() {
  return SECTIONS.filter((s) => s.static).map((s) => s.id);
}
