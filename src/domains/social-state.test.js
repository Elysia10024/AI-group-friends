// domains/social-state 的 hermetic 测试（2026-10-28 第 51 轮：第 6 项"先补域测试"的第一步）。
//
// 这是状态的骨架：per-key 状态怎么建、怎么落盘、怎么读回、坏文件怎么 fail-fast。
// 全部用临时目录 + 真实 atomicWriteJson/state-schema，不碰真实 state/。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocialStateModule } from './social-state.js';
import { atomicWriteJson } from '../core/state-io.js';

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sstate-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ } });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  return dir;
}

function makeModule(root) {
  const socialV2 = { paused: false, conversations: new Map() };
  const seenForwardIds = new Map();
  const knownTokens = new Set();
  const ctx = {
    KNOWN_AGENT_TOKENS: knownTokens,
    SOCIAL_V2_FILE: path.join(root, 'state', 'social-v2.json'),
    MEMORY_DIR: path.join(root, 'state', 'memory'),
    appendMemory: () => {},
    atomicWriteJson,
    canonicalV2Key: (k) => {
      const m = /^(group|private):(\d+)$/.exec(String(k ?? ''));
      return m ? `${m[1]}:${Number(m[2])}` : '';
    },
    cfg: { ownerQQ: 10000001, socialV2: {} },
    crypto,
    defaultWakeConfigV2: () => ({ mode: 'diving', infinite: false, sleepUntil: null, triggers: { atMention: true } }),
    ensureWakeableV2: (st) => st,
    formatMemory: () => 'MEM',
    isDirectedAtAi: () => false,
    log: () => {},
    looksLikeUnfinished: () => false,
    normalizeSpeakerIdsV2: (x) => x,
    readJsonSafe: (file, dflt) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } },
    redactKnownTokensOnly: (s) => s,
    refreshDefaultWakeConfigV2: (st) => st,
    sanitizeForwardId: (x) => x,
    seenForwardIds,
    senderLabel: (s, uid) => String(uid),
    setupSleepTimerV2: () => {},
    socialV2,
    scheduleProactiveCheckV2: () => {},
    fs,
  };
  const mod = createSocialStateModule(ctx);
  return { mod, socialV2, seenForwardIds, knownTokens, file: ctx.SOCIAL_V2_FILE };
}

test('getSocialV2State：默认状态 + 32 位十六进制令牌 + 登记令牌 + 幂等 + 非法 key 抛 400', (t) => {
  const root = tempRoot(t);
  const { mod, socialV2, knownTokens } = makeModule(root);
  const st = mod.getSocialV2State('group:20000003');
  assert.equal(socialV2.conversations.size, 1);
  assert.equal(st.agentToken.length, 32);
  assert.match(st.agentToken, /^[0-9a-f]{32}$/);
  assert.equal(knownTokens.has(st.agentToken), true, '令牌要进 KNOWN_AGENT_TOKENS');
  assert.deepEqual(st.unread, []);
  assert.equal(st.bootstrapSent, false);
  assert.equal(st.wakeConfig.mode, 'diving');
  assert.equal(mod.getSocialV2State('group:20000003'), st, '同一 key 返回同一对象');
  assert.throws(() => mod.getSocialV2State('bad-key'), (e) => e.statusCode === 400);
  // 前导零要被归一化成同一个会话
  assert.equal(mod.getSocialV2State('group:020000003'), st);
});

test('save → load 往返：会话字段与记忆都落盘并读回', (t) => {
  const root = tempRoot(t);
  const first = makeModule(root);
  const st = first.mod.getSocialV2State('group:1');
  st.unread = [{ seq: 1, text: '在吗' }, { seq: 2, text: '刚在吗' }];
  st.activeTopics = [{ text: '周末去爬山' }];
  st.memberImpressions = { 10001: { traits: ['很温柔', '爱加班'] } };
  st.bootstrapSent = true;
  first.seenForwardIds.set('group:1', new Set(['f1']));
  first.mod.saveSocialV2State();

  const saved = JSON.parse(fs.readFileSync(first.file, 'utf8'));
  assert.equal(saved.schemaVersion, 1, '写盘要带 schemaVersion');
  assert.equal(saved.conversations['group:1'].unread.length, 2);
  assert.deepEqual(saved.conversations['group:1'].seenForwardIds, ['f1']);

  // 换一个模块实例（空内存）读回
  const second = makeModule(root);
  second.mod.loadSocialV2State();
  const back = second.socialV2.conversations.get('group:1');
  assert.ok(back, '会话应被读回');
  assert.equal(back.unread.length, 2);
  assert.equal(back.bootstrapSent, true);
  assert.deepEqual(back.activeTopics.map((x) => x.text), ['周末去爬山']);
  assert.deepEqual(back.memberImpressions['10001'].traits, ['很温柔', '爱加班']);
});

test('load：状态文件损坏 → 抛错且不覆盖原文件（fail-fast）', (t) => {
  const root = tempRoot(t);
  const { mod, file } = makeModule(root);
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  assert.throws(() => mod.loadSocialV2State());
  assert.equal(fs.readFileSync(file, 'utf8'), '{ 这不是 JSON', '坏文件绝不能被覆盖成空状态');
});

test('load：文件不存在 → 不抛，会话为空', (t) => {
  const root = tempRoot(t);
  const { mod, socialV2 } = makeModule(root);
  mod.loadSocialV2State();
  assert.equal(socialV2.conversations.size, 0);
});

test('allConversationSnapshots：返回内存里全部会话的 key 快照', (t) => {
  const root = tempRoot(t);
  const { mod } = makeModule(root);
  mod.getSocialV2State('group:1');
  mod.getSocialV2State('private:2');
  const snaps = mod.allConversationSnapshots();
  assert.equal(Array.isArray(snaps), true);
  assert.equal(snaps.length, 2);
});
