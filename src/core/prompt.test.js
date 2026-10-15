// 唤醒提示词的契约测试。跑法：npm test
//
// 这次改动的行为不变性由一次性差分脚本（scripts/tmp-diff-prompt.mjs）证明：
// 把 bridge.js 里原件的 buildWakePromptV2 抽出来，与 buildWakePrompt 在 24 组输入下
// 逐字节比对，全部一致。那份脚本验证完即删。
//
// 这里留下的是长期护栏：段落顺序、各段触发条件、结尾段文案、以及"恒定段落"清单。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWakePrompt, SECTIONS, MATERIAL_COVERED_SECTIONS, sectionText, staticSectionIds } from './prompt.js';

const NOW = Date.parse('2026-09-18T12:00:00+08:00');
const msg = (seq, sender, text, extra = {}) => ({ seq, sender, text, time: NOW - 60000, ...extra });

function ctxOf(over = {}) {
  const st = {
    agentToken: 'TOKEN-abc',
    lastFetchedSeq: 100,
    pendingMentions: [],
    unread: [],
    recentMessages: [msg(101, '群友甲', '你好'), msg(102, '我', '在', { isSelf: true })],
    lastAiReplyAt: NOW - 5 * 60000,
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true } },
    ...(over.st ?? {})
  };
  return {
    key: 'group:20000001',
    reason: 'atMention',
    now: NOW,
    roleState: { role: '小鲸鱼' },
    selfAliases: ['大隐鲸'],
    memoryText: '',
    participationText: '',
    stickerText: '',
    inlineMax: 20,
    preSleepMs: 120000,
    redPacket: null,
    ...over,
    st
  };
}

// ---------- 结构：段落顺序 ----------
test('段落表顺序固定且齐全（12 段，now 必须在最后）', () => {
  assert.deepEqual(SECTIONS.map((s) => s.id), [
    'mention', 'role', 'selfName', 'token', 'context',
    'sticker', 'qzone', 'status', 'wake', 'memory', 'participation', 'now'
  ]);
});

test('输出里各段的出现顺序与段落表一致', () => {
  const out = buildWakePrompt(ctxOf({
    st: { pendingMentions: [{ seq: 105, at: NOW - 60000, kind: 'atMention', sender: 'UserB', text: '@大隐鲸 在吗' }], unread: [msg(105, 'UserB', '@大隐鲸 在吗')] },
    memoryText: 'MEMORY-MARKER',
    participationText: 'PARTICIPATION-MARKER'
  }));
  // 注意：【最近的群聊 这个串在 mention 段里就被引用过（"这条已经在下面的【最近的群聊】里"），
  // 所以必须用完整标题做标记，否则会误判顺序。
  const markers = ['【⚠️ 有人在找你', '【当前角色】', '【你在本群的名字】', '【会话令牌】', '【最近的群聊（最新在最下', '【此刻状态】', '【当前唤醒】', 'MEMORY-MARKER', 'PARTICIPATION-MARKER', '【现在】'];
  let last = -1;
  for (const m of markers) {
    const at = out.indexOf(m);
    assert.ok(at >= 0, `缺少段落标记 ${m}`);
    assert.ok(at > last, `段落顺序错位：${m} 出现在 ${last} 之前`);
    last = at;
  }
});

test('【现在】：给日期+星期，且永远排在最末（前缀缓存纪律）', () => {
  // 这一条是**成本**守卫，不是文案守卫：当前时间每轮都变，往上挪一格，
  // 它后面的所有内容每轮全部缓存失效（命中价约是未命中的 1/50）。
  assert.equal(SECTIONS[SECTIONS.length - 1].id, 'now');
  assert.ok(!MATERIAL_COVERED_SECTIONS.includes('now'), '组装开启时它也不该被过滤掉（材料那边的"现在"是另一种格式）');

  const out = buildWakePrompt(ctxOf({
    now: Date.parse('2026-10-14T23:07:00+08:00'),
    participationText: 'PARTICIPATION-MARKER'
  }));
  assert.ok(out.includes('【现在】2026-10-14 周三 23:07'), '要写清几号、周几、几点');
  // 它必须是**所有块**里的最后一块：后面只剩按 reason 生成的结尾段（那一段本来就每轮都变），
  // 前面不许再有任何块 —— 否则那个块每轮都因为它而缓存失效。
  const tail = out.slice(out.indexOf('【现在】'));
  assert.ok(!tail.includes('PARTICIPATION-MARKER'));
  for (const title of ['【当前角色】', '【会话令牌】', '【你在本群的名字】', '【此刻状态】', '【最近的消息']) {
    assert.ok(!tail.includes(title), `${title} 不该排在【现在】之后`);
  }
});

test('【现在】：没有 ctx.now 就整块不出现（不许退回机器时钟）', () => {
  assert.ok(!buildWakePrompt(ctxOf({ now: 0 })).includes('【现在】'));
  assert.ok(!buildWakePrompt(ctxOf({ now: undefined })).includes('【现在】'));
  assert.ok(!buildWakePrompt(ctxOf({ now: NaN })).includes('【现在】'));
});

test('恒定段落清单（搬 system prompt 的候选）', () => {
  assert.deepEqual(staticSectionIds(), ['role', 'selfName', 'token']);
});

// ---------- 空段不注入 ----------
test('无角色 / 无别名 / 无记忆 → 对应段落不出现', () => {
  const out = buildWakePrompt(ctxOf({ roleState: {}, selfAliases: [], memoryText: '', participationText: '', stickerText: '' }));
  assert.ok(!out.includes('【当前角色】'));
  assert.ok(!out.includes('【你在本群的名字】'));
  assert.ok(!out.includes('MEMORY'));
  assert.ok(out.includes('【此刻状态】'), '恒定段落始终在');
});

test('贴纸段为空串时不注入', () => {
  const out = buildWakePrompt(ctxOf({ stickerText: '' }));
  assert.ok(!out.includes('策略'));
  const out2 = buildWakePrompt(ctxOf({ stickerText: 'STICKER-MARKER\n\n' }));
  assert.ok(out2.includes('STICKER-MARKER'));
});

test('说说段：空串不注入，有内容就注入（这一行是每轮成本，关掉时必须一分钱不花）', () => {
  assert.ok(!buildWakePrompt(ctxOf({ qzoneText: '' })).includes('【说说】'));
  assert.ok(!buildWakePrompt(ctxOf({ qzoneText: undefined })).includes('【说说】'));
  assert.ok(buildWakePrompt(ctxOf({ qzoneText: '【说说】QQ 空间：今天还没发。\n' })).includes('【说说】'));
});

test('主动机会：提不提说说，取决于这一轮有没有那一行', () => {
  const withMood = buildWakePrompt(ctxOf({ reason: 'proactiveCheck', qzoneText: '【说说】QQ 空间：今天还没发。\n' }));
  const without = buildWakePrompt(ctxOf({ reason: 'proactiveCheck', qzoneText: '' }));
  assert.ok(withMood.includes('发条说说'));
  assert.ok(!without.includes('发条说说'));
  assert.ok(without.includes('【主动机会】'), '不提说说也还是主动机会');
});

test('插话机会（densityWake）：是"趁热闹插一句"，不是"安静了回来看一眼"', () => {
  const out = buildWakePrompt(ctxOf({ reason: 'densityWake' }));
  assert.ok(out.includes('【插话机会】'));
  assert.ok(out.includes('正热'), '要说明是群里正热闹');
  assert.ok(out.includes('不是有人 @ 你'), '同上：这次的唤醒不是冲她来的，写不清楚她就会当成有人点她名');
  assert.ok(!out.includes('安静了一段时间'), '不能把"安静"那套口径抄过来（时机是反的）');
  // 刹车：达标 = 有机会，不等于必须说话。少了这句她会为了不浪费机会硬凑一句。
  assert.ok(out.includes('安静收尾'), '必须有"没有想说的就不说"的出口');
  assert.ok(out.includes('硬凑一句，比不说话更像机器人'));
  assert.ok(out.includes('qq_get_recent_messages'), '要先看一眼正在聊什么，再接话');
});

// ---------- 有人找你 ----------
test('未读提醒：列出原文，只取最后 3 条', () => {
  const pending = [1, 2, 3, 4, 5].map((i) => ({ seq: 105 + i, at: NOW - i * 1000, kind: 'atMention', sender: 'S' + i, text: 't' + i }));
  const out = buildWakePrompt(ctxOf({ st: { pendingMentions: pending, lastFetchedSeq: 100 } }));
  assert.ok(out.includes('【⚠️ 有人在找你，你还没看过】'));
  assert.ok(!out.includes('t2'), '第 2 条应被裁掉（只留最后 3 条）');
  for (const i of [3, 4, 5]) assert.ok(out.includes('t' + i), `应包含 t${i}`);
});

test('未读提醒：超过 2 小时的过期提醒不出现在顶部', () => {
  const out = buildWakePrompt(ctxOf({ st: { pendingMentions: [{ seq: 105, at: NOW - 3 * 3600000, kind: 'poke', sender: 'UserB', text: '戳了戳 你' }], lastFetchedSeq: 100 } }));
  assert.ok(!out.includes('【⚠️ 有人在找你'));
});

test('未读提醒：seq 不超过 lastFetchedSeq 的不算（她已看过）', () => {
  const out = buildWakePrompt(ctxOf({ st: { pendingMentions: [{ seq: 99, at: NOW - 1000, kind: 'atMention', sender: 'X', text: '旧' }], lastFetchedSeq: 100 } }));
  assert.ok(!out.includes('【⚠️ 有人在找你'));
});

test('poke 的措辞与 @/名字 不同；没证据说是拍你就不许写"拍了一拍你"', () => {
  // 真实事故（2026-09-29）：UserA 戳的是丰川祥子，材料却写"UserA 拍了一拍你"，
  // 她醒来以为在拍她，回手给了管理员一个拍一拍。所以这里正反两面都要钉住。
  const pokeSelf = sectionText(ctxOf({ st: { pendingMentions: [{ seq: 105, at: NOW - 1000, kind: 'poke', sender: 'A', pokeTargetIsSelf: true, text: 'x' }] } }), 'mention');
  assert.match(pokeSelf, /拍了一拍你/);
  const pokeOther = sectionText(ctxOf({ st: { pendingMentions: [{ seq: 105, at: NOW - 1000, kind: 'poke', sender: 'A', pokeTargetIsSelf: false, text: 'x' }] } }), 'mention');
  assert.match(pokeOther, /拍了别人/);
  assert.ok(!pokeOther.includes('拍了一拍你'), '拍别人时绝不能写成拍你');
  const noFlag = sectionText(ctxOf({ st: { pendingMentions: [{ seq: 105, at: NOW - 1000, kind: 'poke', sender: 'A', text: '无证据' }] } }), 'mention');
  assert.match(noFlag, /拍了别人/, '老记录没有字段时按正文兜底，默认不认成拍你');
  assert.match(sectionText(ctxOf({ st: { pendingMentions: [{ seq: 105, at: NOW - 1000, kind: 'atMention', sender: 'A', text: 'x' }] } }), 'mention'), /@ 了你/);
  assert.match(sectionText(ctxOf({ st: { pendingMentions: [{ seq: 105, at: NOW - 1000, kind: 'nameMention', sender: 'A', text: 'x' }] } }), 'mention'), /叫了你的名字/);
});

// ---------- 群聊内联 ----------
test('群聊内联：标出管理员与自己', () => {
  const out = buildWakePrompt(ctxOf({ st: { recentMessages: [msg(101, '群友甲', '我说了算', { isOwner: true }), msg(102, '我', '嗯', { isSelf: true })] } }));
  assert.ok(out.includes('[群友甲·管理员] 我说了算'));
  assert.ok(out.includes('[我] 嗯'));
});

test('群聊内联：正文截断到 200 字并折叠空白', () => {
  const out = buildWakePrompt(ctxOf({ st: { recentMessages: [msg(101, 'A', 'x'.repeat(300))] } }));
  assert.ok(out.includes('x'.repeat(200)));
  assert.ok(!out.includes('x'.repeat(201)));
});

test('群聊内联：锚点在 60 条封顶之内时一定被包含', () => {
  const many = Array.from({ length: 80 }, (_, i) => msg(i + 1, 'S' + i, 'm' + i));
  // 锚点消息本身必须在 recentMessages 里 —— ctxSlice 是从 recentMessages 切的，
  // 只放进 unread 是切不出来的。真实链路上 appendSocialV2Message 两边都会写。
  many[39] = msg(40, 'A', '锚点这条');
  const out = buildWakePrompt(ctxOf({ st: { lastFetchedSeq: 39, unread: [msg(40, 'A', '锚点这条')], recentMessages: many } }));
  assert.ok(out.includes('[A] 锚点这条'), '锚点在封顶范围内时必须被包含');
  assert.ok(!out.includes('[S19] m19'), '第 19 条应被裁掉');
});

test('群聊内联 / 【BUG-002】锚点早于 60 条封顶时会被裁掉（与注释矛盾）', () => {
  const many = Array.from({ length: 80 }, (_, i) => msg(i + 1, 'S' + i, 'm' + i));
  many[0] = msg(1, 'A', '最老');
  const out = buildWakePrompt(ctxOf({ st: { lastFetchedSeq: 0, unread: [msg(1, 'A', '最老')], recentMessages: many } }));
  // 原实现是 slice(-take)：take 由锚点位置算出但封顶 60，锚点若更早就会被裁掉。
  // 而函数注释声称「起点取"被 @ 的那条"（保证触发她的那条一定在）」—— 两者冲突。
  // R1' 抽取时严格保留原行为，问题记入 已知问题.md BUG-002。
  assert.ok(!out.includes('[A] 最老'), '当前行为：锚点被裁掉');
  assert.ok(out.includes('[S20] m20'), '保留的是最后 60 条');
});

test('群聊为空 → 不注入该段', () => {
  const out = buildWakePrompt(ctxOf({ st: { recentMessages: [], unread: [] } }));
  assert.ok(!out.includes('【最近的群聊'));
});

// ---------- 此刻状态 ----------
test('此刻状态：未读条数 / 最近一条 / 上次发言', () => {
  const out = buildWakePrompt(ctxOf({ st: { unread: [msg(110, 'A', 'x')], recentMessages: [msg(110, 'A', '你好')], lastAiReplyAt: NOW - 7 * 60000 } }));
  assert.ok(out.includes('未读 1 条'));
  assert.ok(out.includes('最近一条来自 A：你好'));
  assert.ok(out.includes('你上次发言 7 分钟前'));
});

test('此刻状态：半句结尾会提示"对方可能没说完"', () => {
  const out = buildWakePrompt(ctxOf({ st: { recentMessages: [msg(110, 'A', '我觉得吧，')] } }));
  assert.ok(out.includes('对方可能没说完'));
});

test('此刻状态：对方说要走（收尾信号）时必须点出来，且分场合措辞', () => {
  // 真实事故：他发了「我要洗澡了」，她回了「别把脑子也一块冲下水道了」，
  // 台阶被踩了，一小时后架就续上。这里保证"他要走了"这件事一定出现在她眼前。
  const out = buildWakePrompt(ctxOf({ st: { recentMessages: [msg(110, '老秦', 'nonono我要洗澡了，回来再跟你唠')] } }));
  assert.ok(out.includes('对方像是要收尾'), out);
  assert.ok(out.includes('收住别补刀'), '必须明说别补刀');
  assert.ok(out.includes('闲聊照常'), '别把平时的损人玩笑一起禁掉');
});

test('此刻状态：普通消息不出现收尾提醒', () => {
  const out = buildWakePrompt(ctxOf({ st: { recentMessages: [msg(110, 'A', '刚吃了一顿烤肉')] } }));
  assert.ok(!out.includes('对方像是要收尾'));
});

test('此刻状态：没发过言时不显示"上次发言"', () => {
  const out = buildWakePrompt(ctxOf({ st: { lastAiReplyAt: 0 } }));
  assert.ok(!out.includes('你上次发言'));
});

// ---------- 当前唤醒 ----------
test('唤醒条件：红包是无条件显示的', () => {
  const out = buildWakePrompt(ctxOf({ st: { wakeConfig: { mode: 'diving', infinite: true, triggers: {} } } }));
  assert.ok(out.includes('触发：红包'));
});

test('唤醒条件：全部触发项都列出来', () => {
  const out = buildWakePrompt(ctxOf({
    st: { wakeConfig: { mode: 'active', infinite: false, sleepUntil: new Date(NOW + 3600000).toISOString(), triggers: { atMention: true, nameMention: true, keywords: ['a'], question: true, poke: true, speakerIds: [1, 2], anyMessage: true, probability: 0.3 } } }
  }));
  for (const t of ['@', '名字', '关键词', '提问', '拍一拍', '指定成员(2:1,2)', '任意消息', '红包', '概率0.3']) {
    assert.ok(out.includes(t), `缺少触发项 ${t}`);
  }
  assert.ok(out.includes('活跃'));
});

// ---------- 结尾段 ----------
test('结尾段：每种 reason 都有专属文案', () => {
  const key = 'group:20000001';
  assert.ok(buildWakePrompt(ctxOf({ reason: 'bootstrap' })).includes('【引导唤醒】你已接入 QQ 会话 ' + key));
  assert.ok(buildWakePrompt(ctxOf({ reason: 'timeout' })).includes('有限潜水时间已到'));
  assert.ok(buildWakePrompt(ctxOf({ reason: 'replyCheck' })).includes('【回复检查】'));
  assert.ok(buildWakePrompt(ctxOf({ reason: 'replyCheck' })).includes('timeoutMs=120000'));
  assert.ok(buildWakePrompt(ctxOf({ reason: 'proactiveCheck' })).includes('【主动机会】'));
  assert.ok(buildWakePrompt(ctxOf({ reason: 'densityWake' })).includes('【插话机会】'));
  assert.ok(buildWakePrompt(ctxOf({ reason: 'poke' })).includes('有人拍了一拍你'), '只能在自己被拍时才这样叫她');
  assert.ok(buildWakePrompt(ctxOf({ reason: 'poke' })).includes('回拍要用'), '回拍对象别搞错（她曾回拍给管理员）');
  assert.ok(buildWakePrompt(ctxOf({ reason: 'poke' })).includes('别拍别人'));
  // 被拍醒给的示范里**必须有一个不带刺的**（2026-10-12：三个示范全是"？/干嘛/再拍试试"，
  // 深夜被拍时她把这一套原样用出来，群里说"嘴臭"）。
  assert.ok(buildWakePrompt(ctxOf({ reason: 'poke' })).includes('在呢'), '被拍醒要有一个软示范');
  assert.ok(buildWakePrompt(ctxOf({ reason: 'keyword:DS' })).includes('原因：keyword:DS'));
});

test('结尾段：replyCheck 用传入的 preSleepMs', () => {
  assert.ok(buildWakePrompt(ctxOf({ reason: 'replyCheck', preSleepMs: 123456 })).includes('timeoutMs=123456'));
});

test('结尾段：preSleepMs=0（沉睡前观察开关关着）时不许再提"沉睡前观察"', () => {
  // 开关关着还要求她先观察，既跟每轮提示里的「收尾要快」自相矛盾，也白花一次工具调用。
  const t = buildWakePrompt(ctxOf({ reason: 'replyCheck', preSleepMs: 0 }));
  assert.ok(t.includes('【回复检查】'), '回复检查本身照旧');
  assert.ok(!t.includes('沉睡前观察'), '不该再要求沉睡前观察');
  assert.ok(t.includes('直接收尾'), '改成直接收尾');
});

// ---------- 红包分支 ----------
test('红包：真红包 + 自定义留言 → 要求接留言', () => {
  const out = buildWakePrompt(ctxOf({ reason: 'redPacket', redPacket: { kind: 'real', greeting: '祝小鲸鱼天天开心', isDefaultGreeting: false } }));
  assert.ok(out.includes('真的 QQ 红包'));
  assert.ok(out.includes('祝小鲸鱼天天开心'));
  assert.ok(out.includes('这句留言要接'));
  assert.ok(out.includes('不许装成抢到了'));
});

test('红包：真红包 + 默认留言 → 明确要求不要针对留言', () => {
  const out = buildWakePrompt(ctxOf({ reason: 'redPacket', redPacket: { kind: 'real', greeting: '恭喜发财', isDefaultGreeting: true } }));
  assert.ok(out.includes('不用针对留言做反应'));
  assert.ok(out.includes('这是事实'));
});

test('红包：假红包 → 要按内容回，不是一律嘲讽', () => {
  const out = buildWakePrompt(ctxOf({ reason: 'redPacket', redPacket: { kind: 'fake', text: '[QQ红包] 祝小鲸鱼永远开心' } }));
  assert.ok(out.includes('假的"文本红包"'));
  assert.ok(out.includes('[QQ红包] 祝小鲸鱼永远开心'));
  assert.ok(out.includes('不要一律嘲讽'));
  assert.ok(out.includes('损人要损出花样'));
  assert.ok(!out.includes('不许装成抢到了'), '假红包分支不该出现真红包的话术');
});

test('红包：无 redPacket 状态时兜底成假红包且不崩', () => {
  const out = buildWakePrompt(ctxOf({ reason: 'redPacket', redPacket: null }));
  assert.ok(out.includes('假的"文本红包"'));
  assert.ok(out.includes('「(空)」'));
});

// ---------- 时间注入 ----------
test('时间来自 ctx.now 而不是内部读时钟', () => {
  const older = buildWakePrompt(ctxOf({ st: { lastAiReplyAt: NOW - 60 * 60000 } }));
  assert.ok(older.includes('你上次发言 60 分钟前'));
});
