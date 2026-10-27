// socialV2 状态读写：hydrate（读）与 save（写）的对称性。
//
// 为什么专门测这一块：这块以前**一条测试都没有**，而它是"她的记忆"落盘的地方 ——
// 加一个持久化字段要同时改读侧和写侧，漏改一边就静默丢数据（读侧有、写侧没有 = 重启后消失；
// 写侧有、读侧没有 = 每次重启都回到默认值）。
//
// wake 相关依赖（defaultWakeConfigV2 / ensureWakeableV2 / refreshDefaultWakeConfigV2 等）在这里
// 一律用**桩**：本测试只管"字段能不能原样进出文件"，不管 wake 默认值长什么样（那些有 wake.test.js）。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createSocialStateModule, PERSISTED_V2_FIELDS, RUNTIME_ONLY_V2_FIELDS, MEMORY_V2_FIELDS
} from '../domains/social-state.js';

/** 造一个模块实例；返回它、以及可观测的内部状态。 */
function makeModule(raw = '{}') {
  // written 必须**每个模块一份**：saveSocialV2State 现在会写两次（运行时状态 + 每会话记忆文件），
  // 而"往返稳定"那条会造两个模块 —— 共用同一个数组会被第二个模块清空，断言就假红。
  const written = [];
  // 2026-10-27 第 1 期：读侧改走真 readStateFile（不再吃 ctx.readJsonSafe），
  // 桩喂不进数据了——改成把 raw 写进真临时文件。顺带把这份测试从"纯内存桩"
  // 升级成真过一遍磁盘的 IO 测试（审计第 10 条：最贵的数据以前真 IO 一次没测）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sstate-'));
  const stateFile = path.join(dir, 'social-v2.json');
  fs.writeFileSync(stateFile, raw, 'utf8');
  const socialV2 = { paused: false, conversations: new Map() };
  const seenForwardIds = new Map();
  const mod = createSocialStateModule({
    KNOWN_AGENT_TOKENS: new Set(),
    SOCIAL_V2_FILE: stateFile,
    appendMemory: () => {}, atomicWriteJson: (p, o) => written.push(o),
    canonicalV2Key: (k) => (/^(group|private):\d+$/.test(String(k)) ? String(k) : null),
    cfg: { socialV2: {} },
    crypto,
    scheduleProactiveCheckV2: () => {},
    defaultWakeConfigV2: () => ({ triggers: {}, sleepMinMs: 1 }),
    ensureWakeableV2: () => {}, formatMemory: () => '',
    isDirectedAtAi: () => false, log: () => {}, looksLikeUnfinished: () => false,
    normalizeSpeakerIdsV2: (v) => (Array.isArray(v) ? v : []),
    // 记忆文件（state/memory/*）在 fixture 里不存在 → 返回 null，走"从会话状态自动拆分"那条分支；
    // 其它路径返回 fixture 本身（与旧行为一致）。
    readJsonSafe: (p, dflt) => (/memory[\\/]/.test(String(p)) ? (dflt ?? null) : JSON.parse(raw)),
    fs: { mkdirSync: () => {}, copyFileSync: () => {} },
    redactKnownTokensOnly: (t) => t, refreshDefaultWakeConfigV2: () => {},
    sanitizeForwardId: (v) => (/^[\w-]+$/.test(String(v)) ? String(v) : null),
    seenForwardIds, senderLabel: () => 'x', setupSleepTimerV2: () => {}, socialV2
  });
  return { mod, written, socialV2, seenForwardIds };
}

/** 取"运行时状态文件"的那一次写（saveSocialV2State 之后还会写会话记忆文件，别拿错）。 */
function lastState(w) {
  return w.filter((o) => o && typeof o === 'object' && o.conversations).at(-1);
}

const CONV = {
  'group:20000001': {
    agentToken: '', lastWakeReason: 42, lastAiReplyAt: 'abc', wakeTimes: 'x',
    recentMessages: Array.from({ length: 250 }, (_, i) => ({ i })),
    unread: Array.from({ length: 130 }, (_, i) => ({ i })),
    pendingMentions: Array.from({ length: 30 }, (_, i) => ({ i })), activeTopics: null,
    memberImpressions: { __proto__: { polluted: 1 }, constructor: {}, prototype: {}, alice: { nice: true } },
    seenForwardIds: ['ok-1', 'bad id!!', 'ok-2']
  },
  'private:10000001': { agentToken: 'dupe', wakeConfig: null }
};

test('hydrate：只收合法会话 key，非对象值直接丢', () => {
  const { mod, socialV2 } = makeModule(JSON.stringify({
    paused: true,
    conversations: { ...CONV, 'garbage-key': { agentToken: 'x' }, 'group:0': 'not an object' }
  }));
  mod.loadSocialV2State();
  assert.deepEqual([...socialV2.conversations.keys()], ['group:20000001', 'private:10000001']);
  assert.equal(socialV2.paused, true);
});

test('hydrate：类型兜底（数字/数组字段被写脏也不炸）', () => {
  const { mod, socialV2 } = makeModule(JSON.stringify({ conversations: CONV }));
  mod.loadSocialV2State();
  const st = socialV2.conversations.get('group:20000001');
  assert.equal(st.lastAiReplyAt, 0);          // 'abc' → 0
  assert.equal(st.lastWakeReason, '42');      // 统一成字符串
  assert.deepEqual(st.wakeTimes, []);         // 'x' → []
  assert.deepEqual(st.activeTopics, []);      // null → []
  assert.equal(st.recentMessages.length, 250); // hydrate 不截断（截断是落盘时的事）
  assert.equal(st.pendingMentions.length, 20); // 这个是读侧就截
});

test('hydrate：memberImpressions 过滤原型污染键', () => {
  const { mod, socialV2 } = makeModule(JSON.stringify({ conversations: CONV }));
  mod.loadSocialV2State();
  const imp = socialV2.conversations.get('group:20000001').memberImpressions;
  assert.deepEqual(Object.keys(imp), ['alice']);
  assert.equal({}.polluted, undefined);
});

test('hydrate：agentToken 缺失或重复都要重新生成，且互不相同', () => {
  // 注意去重的口径：只有**同一个非空 token 出现两次**才判定重复并重新生成；
  // 单独出现的值（哪怕叫 dupe）是合法的旧令牌，必须原样保留 —— 否则重启会换掉她的令牌。
  const { mod, socialV2 } = makeModule(JSON.stringify({
    conversations: {
      'group:20000001': { agentToken: '' },
      'private:10000001': { agentToken: 'dup-token' },
      'group:111': { agentToken: 'dup-token' }
    }
  }));
  mod.loadSocialV2State();
  const missing = socialV2.conversations.get('group:20000001').agentToken;
  const one = socialV2.conversations.get('private:10000001').agentToken;
  const two = socialV2.conversations.get('group:111').agentToken;
  assert.match(missing, /^[0-9a-f]{32}$/);   // 缺失 → 生成
  assert.notEqual(one, two);                  // 重复 → 后来者重新生成
  assert.equal([one, two].includes('dup-token'), true); // 先到者保留原值
});

test('字段表与 hydrate 产出的字段必须一一对应（加字段漏改一处就红）', () => {
  const { mod, socialV2 } = makeModule(JSON.stringify({ conversations: CONV }));
  mod.loadSocialV2State();
  const st = socialV2.conversations.get('group:20000001');
  const hydrated = Object.keys(st).filter((k) => !RUNTIME_ONLY_V2_FIELDS.includes(k));
  // seenForwardIds 不在这张比对里：它不挂在 st 上，而是按会话 key 存在模块级 Map（写侧单独取）。
  // 记忆三件套现在落在 state/memory/<key>.json，不在运行时字段表里 —— 但 hydrate 仍要产出它们。
  const expectedFields = [...PERSISTED_V2_FIELDS, ...MEMORY_V2_FIELDS].map(([f]) => f).sort();
  assert.deepEqual(hydrated.slice().sort(), expectedFields);
});

test('save：按表落盘，截断/兜底/对象兜底都生效', () => {
  const { mod, written, seenForwardIds } = makeModule(JSON.stringify({ conversations: CONV }));
  mod.loadSocialV2State();
  seenForwardIds.set('group:20000001', ['f1', 'f2']);
  mod.saveSocialV2State();
  const conv = lastState(written).conversations['group:20000001'];
  assert.equal(conv.recentMessages.length, 200);         // cap 200
  assert.equal(conv.unread.length, 100);                 // cap 100
  assert.equal(conv.pendingMentions.length, 20);         // cap 20
  assert.equal(conv.lastIncomingAt, 0);                  // zero 兜底
  assert.deepEqual(conv.seenForwardIds, ['f1', 'f2']);
  assert.deepEqual(Object.keys(conv), [...PERSISTED_V2_FIELDS.map(([f]) => f), 'seenForwardIds']);
  for (const [f] of MEMORY_V2_FIELDS) assert.equal(f in conv, false, `${f} 不该再落在 social-v2.json 里`);
});

test('save：memberImpressions 不是对象时，记忆文件里落成 {}（运行时文件不再带记忆）', () => {
  const { mod, written, socialV2 } = makeModule(JSON.stringify({ conversations: CONV }));
  mod.loadSocialV2State();
  socialV2.conversations.get('group:20000001').memberImpressions = null;
  // 给一条话题：否则"三样全空"会被判成空记忆、根本不建文件（那是刻意的，见 memory-files）
  socialV2.conversations.get('group:20000001').activeTopics = [{ text: '在聊重构' }];
  mod.saveSocialV2State();
  assert.equal('memberImpressions' in lastState(written).conversations['group:20000001'], false, '运行时文件不该带记忆');
  const memWrites = written.filter((o) => o && typeof o === 'object' && 'memberImpressions' in o && 'activeTopics' in o);
  assert.ok(memWrites.length > 0, '应该写会话记忆文件');
  assert.ok(
    memWrites.some((o) => o.memberImpressions && Object.keys(o.memberImpressions).length === 0),
    '脏值应兜底成 {} 写进记忆文件'
  );
});

test('save：表外的字段不落盘（st 上挂临时对象不会漏进状态文件）', () => {
  const { mod, written, socialV2 } = makeModule(JSON.stringify({ conversations: CONV }));
  mod.loadSocialV2State();
  socialV2.conversations.get('group:20000001').someTransientThing = { big: 'x' };
  mod.saveSocialV2State();
  assert.equal('someTransientThing' in lastState(written).conversations['group:20000001'], false);
});

test('往返稳定：save → hydrate → save 结果不变（写侧漏字段会在这里暴露）', () => {
  const first = makeModule(JSON.stringify({ conversations: CONV }));
  first.mod.loadSocialV2State();
  first.mod.saveSocialV2State();
  const saved = lastState(first.written);
  const second = makeModule(JSON.stringify(saved));
  second.mod.loadSocialV2State();
  second.mod.saveSocialV2State();
  // agentToken 会被第一轮重新生成，之后必须稳定。
  assert.deepEqual(lastState(second.written), saved);
});
