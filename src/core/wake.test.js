// 唤醒判定的契约测试。跑法：npm test
//
// 行为不变性由一次性差分脚本证明：抽取 bridge.js 里原件的 4 段（textMentionsSelf /
// wake 策略帮助函数 / isDirectedAtAi / evaluateWakeTriggerV2），与新模块在 76 组输入下比对
// reason 与副作用，全部一致；脚本验证完即删。
//
// 这里留下的重点是**判定链的顺序**——8 个分支有优先级，改一处很容易踩到另一处。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wakePolicy, mentionsOnly, allowedKeywordsRaw, allowedKeywords,
  armFollowUp, followUpState, mentionsAlias, isDirectedAtAi, decideWake
} from './wake.js';

const NOW = Date.parse('2026-09-18T12:00:00+08:00');
const GROUP_KEY = 'group:20000001';
const SELF_ID = '10000000';
const NICK = '竹沥半夏二号机';
const ALIASES = new Set(['大隐鲸']);

const ev = (over = {}) => ({
  group_id: '20000001', self_id: SELF_ID, user_id: 'u1',
  sender: { card: '甲', nickname: '甲' },
  message: [{ type: 'text', data: { text: '你好' } }],
  ...over
});
const st = (over = {}) => ({ wakeConfig: { triggers: { atMention: true, nameMention: true } }, recentMessages: [], unread: [], ...over });
const dec = (over = {}) => decideWake({
  cfg: {}, st: st(), kind: 'group', event: ev(), textContent: '你好', plainContent: '你好',
  quoteTargetIsSelf: false, selfNickname: NICK, selfAliases: ALIASES, now: NOW, random: () => 0.5,
  ...over
});
const reason = (over = {}) => { const hit = dec(over); return hit ? hit.reason : null; };

// ---------------- 策略锁 ----------------
test('wakePolicy / mentionsOnly 认 policy，空白被 trim', () => {
  assert.equal(wakePolicy({}), '');
  assert.equal(wakePolicy({ socialV2: { wake: { policy: '  mentionsOnly  ' } } }), 'mentionsOnly');
  assert.equal(mentionsOnly({}), false);
  assert.equal(mentionsOnly({ socialV2: { wake: { policy: 'mentionsOnly' } } }), true);
});

test('allowedKeywords 只在 mentionsOnly 下生效，并按小写匹配', () => {
  const locked = { socialV2: { wake: { policy: 'mentionsOnly', allowedKeywords: ['DS', ' 大肥鱼 ', '', null] } } };
  assert.deepEqual(allowedKeywordsRaw(locked), ['DS', '大肥鱼']);
  assert.deepEqual([...allowedKeywords(locked)], ['ds', '大肥鱼']);
  // 非 mentionsOnly → 不锁
  assert.equal(allowedKeywords({ socialV2: { wake: { policy: 'x', allowedKeywords: ['DS'] } } }), null);
  assert.equal(allowedKeywords({}), null);
});

// ---------------- 跟进窗口 ----------------
test('armFollowUp 按 lookback 收集说话人、按 windowMs 设过期', () => {
  const cfg = { socialV2: { followUp: { windowMs: 300000, speakerLookbackMs: 180000, maxPerWindow: 1 } } };
  const s = { recentMessages: [
    { isSelf: false, time: NOW - 60000, userId: 'u1' },
    { isSelf: true, time: NOW - 30000, userId: 'me' },
    { isSelf: false, time: NOW - 10 * 60000, userId: 'u2' }
  ] };
  assert.equal(armFollowUp(s, cfg, NOW), true);
  assert.deepEqual(s.followUp.speakers, ['u1'], '自己说的和别人很久以前说的都不算');
  assert.equal(s.followUp.until, NOW + 300000);
  assert.equal(s.followUp.used, 0);
});

test('armFollowUp 可被配置禁用', () => {
  assert.equal(armFollowUp({}, { socialV2: { followUp: { enabled: false } } }, NOW), false);
});

test('armFollowUp 没配 windowMs / speakerLookbackMs 时默认 3 分钟', () => {
  // 这道断言是为了防"默认值悄悄漂走"：配置里改了、代码默认值没跟，
  // 新装的机器就会回到老行为（而且没人看得出来）。
  // 2026-10-02：2 → 3 分钟（实测群里接话常落在 2 分 04 秒 / 2 分 16 秒，刚好错过窗口）。
  const s = { recentMessages: [
    { isSelf: false, time: NOW - 60000, userId: 'u1' },
    { isSelf: false, time: NOW - 150000, userId: 'u2' }
  ] };
  assert.equal(armFollowUp(s, { socialV2: {} }, NOW), true);
  assert.equal(s.followUp.until, NOW + 180000, '默认窗口 3 分钟');
  assert.deepEqual(s.followUp.speakers, ['u1'], '默认 lookback 仍是 2 分钟 → 150 秒前的说话人不算');
});

test('窗口还活着时重新武装**不重置已用次数**（防 followUp 自续链）', () => {
  // 真实事故：她每发一条就重置 used → maxPerWindow 形同虚设，
  // 75 秒内被 followUp 叫醒 4 次、连发 5 条。
  const cfg = { socialV2: { followUp: { windowMs: 180000, speakerLookbackMs: 180000, maxPerWindow: 2 } } };
  const s = { recentMessages: [{ isSelf: false, time: NOW, userId: 'u1' }] };
  armFollowUp(s, cfg, NOW);
  assert.equal(s.followUp.used, 0);
  s.followUp.used = 1;
  armFollowUp(s, cfg, NOW + 30000); // 窗口内再武装
  assert.equal(s.followUp.used, 1, '窗口内保留已用次数');
  s.followUp.used = 2;
  armFollowUp(s, cfg, NOW + 60000);
  assert.equal(followUpState(s, cfg, NOW + 60000), null, '用满 2 次后窗口失效');
  // 窗口过期后重新武装 → 归零，新窗口重新计
  s.followUp.used = 2;
  armFollowUp(s, cfg, NOW + 400000);
  assert.equal(s.followUp.used, 0, '新窗口从 0 开始');
});

test('followUpState 过期 / 用完 / 无状态都返回 null', () => {
  const cfg = { socialV2: { followUp: { maxPerWindow: 1 } } };
  assert.equal(followUpState({}, cfg, NOW), null);
  assert.equal(followUpState({ followUp: { until: NOW - 1, used: 0 } }, cfg, NOW), null);
  assert.equal(followUpState({ followUp: { until: NOW + 1000, used: 1 } }, cfg, NOW), null);
  assert.ok(followUpState({ followUp: { until: NOW + 1000, used: 0 } }, cfg, NOW));
});

// ---------------- 名字匹配 ----------------
test('mentionsAlias 认裸名字与 @名字，空输入不炸', () => {
  assert.equal(mentionsAlias('@大隐鲸 在吗', ALIASES), true);
  assert.equal(mentionsAlias('叫大隐鲸', ALIASES), true);
  assert.equal(mentionsAlias('无关内容', ALIASES), false);
  assert.equal(mentionsAlias('', ALIASES), false);
  assert.equal(mentionsAlias(null, ALIASES), false);
  assert.equal(mentionsAlias('x', null), false);
});

test('isDirectedAtAi 认 AI 提问/挑战/催促，不认闲聊', () => {
  for (const t of ['你和大肥鱼谁强', '你有claude一半强吗', '你是人类还是ai', '怎么不说话', '你是真人吗']) {
    assert.equal(isDirectedAtAi(t), true, t);
  }
  for (const t of ['今天天气不错', 'DS 是什么', '', null, '你是谁']) {
    assert.equal(isDirectedAtAi(t), false, String(t));
  }
});

// ---------------- 判定链：顺序 ----------------
test('私聊直接唤醒（不看 triggers）', () => {
  assert.equal(reason({ kind: 'private', st: {} }), 'private');
});

test('红包优先于一切：连 @ 都不用看', () => {
  assert.equal(reason({ event: ev({ message: [{ type: 'redbag', data: { greeting: '恭喜发财' } }] }) }), 'redPacket');
  assert.equal(reason({ event: ev({ message: [{ type: 'text', data: { text: '[QQ红包] 50元' } }] }) }), 'redPacket');
});

test('红包会通过 redPacket 字段回传给调用方（副作用留在桥侧）', () => {
  const hit = dec({ event: ev({ message: [{ type: 'redbag', data: { greeting: '祝好' } }] }) });
  assert.equal(hit.reason, 'redPacket');
  assert.equal(hit.redPacket.kind, 'real');
  assert.equal(hit.redPacket.greeting, '祝好');
});

test('anyMessage 优先于 @', () => {
  assert.equal(reason({ st: st({ wakeConfig: { triggers: { anyMessage: true, atMention: true } } }), event: ev({ message: [{ type: 'at', data: { qq: SELF_ID } }] }) }), 'anyMessage');
});

test('@ 与引用：@自己 / 引用自己 都算；@别人 不算', () => {
  assert.equal(reason({ event: ev({ message: [{ type: 'at', data: { qq: SELF_ID } }] }) }), 'atMention');
  assert.equal(reason({ quoteTargetIsSelf: true }), 'atMention');
  assert.equal(reason({ event: ev({ message: [{ type: 'at', data: { qq: '999' } }] }) }), null);
});

test('atMention 关掉时 @ 不再触发', () => {
  assert.equal(reason({ st: st({ wakeConfig: { triggers: { atMention: false, nameMention: false } } }), event: ev({ message: [{ type: 'at', data: { qq: SELF_ID } }] }) }), null);
});

test('名字：账号昵称优先于群名片，两者都认', () => {
  assert.equal(reason({ textContent: '@竹沥半夏二号机 在吗', plainContent: 'x' }), 'nameMention');
  assert.equal(reason({ textContent: '大隐鲸 出来', plainContent: 'x' }), 'nameMention');
  assert.equal(reason({ textContent: '今天天气好', plainContent: '今天天气好' }), null);
});

test('关键词：受策略锁约束，短英文用词边界', () => {
  const locked = { socialV2: { wake: { policy: 'mentionsOnly', allowedKeywords: ['DS'] } } };
  assert.equal(reason({ cfg: locked, st: st({ wakeConfig: { triggers: { keywords: ['DS'] } } }), textContent: 'DS 是什么', plainContent: 'DS 是什么' }), 'keyword:DS');
  // 白名单里没有的词被锁掉
  assert.equal(reason({ cfg: locked, st: st({ wakeConfig: { triggers: { keywords: ['红包'] } } }), textContent: '红包来了', plainContent: '红包来了' }), null);
  // ADS 不该命中 DS
  assert.equal(reason({ cfg: locked, st: st({ wakeConfig: { triggers: { keywords: ['DS'] } } }), textContent: 'ADS 投放', plainContent: 'ADS 投放' }), null);
  // 中文按子串匹配
  assert.equal(reason({ cfg: {}, st: st({ wakeConfig: { triggers: { keywords: ['重构'] } } }), textContent: '在聊重构', plainContent: '在聊重构' }), 'keyword:重构');
});

test('跟进窗口：说话人在名单内才唤醒，过期/用完都不行', () => {
  const inWin = { followUp: { until: NOW + 60000, used: 0, speakers: ['u1'] } };
  assert.equal(reason({ st: st(inWin) }), 'followUp');
  assert.equal(reason({ st: st({ followUp: { ...inWin.followUp, speakers: ['u9'] } }) }), null);
  assert.equal(reason({ st: st({ followUp: { ...inWin.followUp, until: NOW - 1 } }) }), null);
});

test('提问分支受策略锁约束：潜水时被挡', () => {
  const s = st({ wakeConfig: { triggers: { question: true } } });
  assert.equal(reason({ cfg: {}, st: s, textContent: '你有claude一半强吗', plainContent: '你有claude一半强吗' }), 'question');
  assert.equal(reason({ cfg: { socialV2: { wake: { policy: 'mentionsOnly' } } }, st: s, textContent: '你有claude一半强吗', plainContent: '你有claude一半强吗' }), null);
});

test('指定成员：标签优先用群名片，回退昵称再回退 QQ 号', () => {
  assert.equal(reason({ cfg: {}, st: st({ wakeConfig: { triggers: { speakerIds: ['999'] } } }), event: ev({ user_id: '999', sender: { card: '甲' } }) }), 'speaker:甲');
  assert.equal(reason({ cfg: {}, st: st({ wakeConfig: { triggers: { speakerIds: ['999'] } } }), event: ev({ user_id: '999', sender: { nickname: '乙' } }) }), 'speaker:乙');
  assert.equal(reason({ cfg: {}, st: st({ wakeConfig: { triggers: { speakerIds: ['999'] } } }), event: ev({ user_id: '999', sender: {} }) }), 'speaker:999');
});

test('概率分支：随机数与策略锁都生效', () => {
  const s = st({ wakeConfig: { triggers: { probability: 0.5 } } });
  assert.equal(reason({ cfg: {}, st: s, random: () => 0.1 }), 'probability');
  assert.equal(reason({ cfg: {}, st: s, random: () => 0.9 }), null);
  assert.equal(reason({ cfg: { socialV2: { wake: { policy: 'mentionsOnly' } } }, st: s, random: () => 0.1 }), null);
});

test('默认随机源是 Math.random（不传 random 也能跑）', () => {
  const hit = decideWake({ cfg: { socialV2: { wake: { probability: 1 } } }, st: st({ wakeConfig: { triggers: { probability: 1 } } }), kind: 'group', event: ev(), textContent: 'x', plainContent: 'x', quoteTargetIsSelf: false, selfNickname: NICK, selfAliases: ALIASES, now: NOW });
  assert.equal(hit.reason, 'probability');
});

// ---------------- 边界 ----------------
test('全不命中返回 null；triggers 缺失返回 null', () => {
  assert.equal(reason({ cfg: {}, st: st({ wakeConfig: { triggers: {} } }) }), null);
  assert.equal(reason({ cfg: {}, st: {} }), null);
});

test('event 为空对象不炸', () => {
  assert.equal(reason({ event: {}, textContent: '', plainContent: '' }), null);
});

test('st 为 null 会抛错（与原实现一致：唯一调用点保证非 null，抛错是响亮失败）', () => {
  assert.throws(() => dec({ st: null }));
});
