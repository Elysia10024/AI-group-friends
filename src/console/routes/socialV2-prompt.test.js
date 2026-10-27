// GET /api/socialV2/prompt（qq_get_prompt）的 hermetic 测试（2026-10-28 第 36 轮）。
//
// 这条路由决定"她看到自己有哪些工具"——审计里"静默失效"的高危点：toolMap 漏写工具，
// 她就永远不知道自己能用（工具挂着等于没挂）。本测试钉住：
//   · 工具清单 = toolMap 全量 − 被关掉的开关 − 贴纸体系关闭时的表情族；
//   · 推荐值可整块关闭；角色提示随模式切换；贴纸上下文/策略可关闭；
//   · 表情库同步失败不阻塞 prompt。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSocialV2ReadWrite } from './socialV2.js';

const ALL_TOOLS = {
  getPrompt: true, getRecent: true, sendGroup: true, sendPrivate: true, reply: true, sendBurst: true,
  sendMessage: true, waitMessages: true, feedback: true, getMyRecent: true, getMessageDetail: true,
  getActiveMembers: true, setWakeConfig: true, memory: true, slangQuery: true, slangSubmit: true,
  getImages: true, getForwardMsg: true, sendPoke: true, listStickers: true, getStickerImage: true,
  sendSticker: true, setStickerRemark: true, stickerNote: true, collectSticker: true, getSelfImage: true,
  sendVoice: true, postMood: true, deleteMood: true, listMoods: true, moodComments: true,
  commentMood: true, qzoneFeeds: true,
};

function makeCtx(query = '?key=group:1', { mode = 'reserved2', tools = {}, stickerEnabled = () => true, cfgExtra = {}, syncImpl } = {}) {
  const sentJson = [];
  let syncCalls = 0;
  const st = { wakeConfig: { mode: 'active', triggers: {} }, unread: [{ seq: 1 }], recentMessages: [{ text: 'a' }] };
  const ctx = {
    agentTokenOk: () => true,
    allowedKeywordsRawV2: () => [],
    allowedKeywordsV2: () => [],
    buildSlangContext: (list, max) => `SLANG(${max})`,
    buildStickerContext: (list, max) => `STICKER-CTX(${max})`,
    buildStickerStrategyHint: () => 'STICKER-STRATEGY',
    cancelReplyCheckV2: () => {},
    cfg: { socialV2: { tools: { ...ALL_TOOLS, ...tools }, sticker: { enabled: true, includeInPrompt: true, promptMaxStickers: 8 }, provideRecommendations: true, wake: { w: 1 }, send: { s: 1 }, wait: { wa: 1 }, proactive: { p: 1 } }, slang: { enabled: true, injectMax: 5 }, ...cfgExtra },
    computeWakeSafetyV2: () => ({ guaranteed: true }),
    confirmedSlangListV2: () => [{ content: '摸鱼' }],
    currentRoleHint: () => 'ROLE-HINT-CLOSED',
    currentRoleHintV2: () => 'ROLE-HINT-V2',
    deps: { flags: { currentMode: mode, slangEntries: [{ content: 'x' }], stickerEntries: [{ id: 1 }, { id: 2 }] } },
    ensureWakeableV2: () => true,
    formatMemoryV2: () => 'MEM',
    formatParticipationV2: () => 'PART',
    getSocialV2State: () => st,
    isSleepingConfigV2: () => false,
    log: () => {},
    mentionsOnlyV2: () => ({}),
    normalizeSpeakerIdsV2: () => '',
    preSleepWaitBlockedV2: () => false,
    readBody: async () => ({}),
    readRoleState: () => ({ role: '小鲸鱼' }),
    readShadowAssemblies: () => ({}),
    req: { method: 'GET', headers: { 'x-agent-token': 'T' }, on: () => {} },
    resetPreSleepWait: () => {},
    saveSocialV2State: () => {},
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    settleV2ReadState: () => ({ markedCount: 0 }),
    setupSleepTimerV2: () => {},
    stickerEnabled,
    syncStickerLibrary: async (force) => { syncCalls += 1; if (syncImpl) return syncImpl(force); return {}; },
    url: new URL(`http://127.0.0.1:3100/api/socialV2/prompt${query}`),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
    wakeConfigMissCount: new Map(),
    wakeConfigUpdatedKeys: new Set(),
  };
  return { ctx, sentJson, syncCalls: () => syncCalls };
}

test('prompt：缺 key / 坏 token / 会话越界 / 工具关闭 → 各前置拒绝', async () => {
  const noKey = makeCtx('');
  await handleSocialV2ReadWrite(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const badToken = makeCtx();
  badToken.ctx.agentTokenOk = () => false;
  await handleSocialV2ReadWrite(badToken.ctx);
  assert.match(badToken.sentJson.at(-1).body.error, /agent token 无效/);

  const noSession = makeCtx();
  noSession.ctx.v2SessionAllowed = () => false;
  await handleSocialV2ReadWrite(noSession.ctx);
  assert.match(noSession.sentJson.at(-1).body.error, /不在当前模式允许范围/);

  const noTool = makeCtx();
  noTool.ctx.v2ToolEnabled = () => false;
  await handleSocialV2ReadWrite(noTool.ctx);
  assert.match(noTool.sentJson.at(-1).body.error, /工具未启用：qq_get_prompt/);
});

test('prompt：工具清单全量 33；关掉的开关与贴纸族会被剔除', async () => {
  const full = makeCtx();
  await handleSocialV2ReadWrite(full.ctx);
  assert.equal(full.sentJson.at(-1).body.enabledTools.length, 33, '全开时 33 个');

  const offVoice = makeCtx('?key=group:1', { tools: { sendVoice: false } });
  await handleSocialV2ReadWrite(offVoice.ctx);
  const names = offVoice.sentJson.at(-1).body.enabledTools;
  assert.equal(names.includes('qq_send_voice'), false, '关掉的工具不能出现在清单里');
  assert.equal(names.length, 32);

  const noStickers = makeCtx('?key=group:1', { stickerEnabled: () => false });
  await handleSocialV2ReadWrite(noStickers.ctx);
  const stickerNames = ['qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_set_sticker_remark', 'qq_sticker_note', 'qq_collect_sticker'];
  const list = noStickers.sentJson.at(-1).body.enabledTools;
  for (const n of stickerNames) assert.equal(list.includes(n), false, n);
  assert.equal(list.length, 27, '贴纸族 6 个整体剔除');
});

test('prompt：推荐值可整块关闭；角色提示随模式切换', async () => {
  const noRec = makeCtx('?key=group:1', { cfgExtra: { socialV2: { tools: ALL_TOOLS, provideRecommendations: false, sticker: { enabled: true, includeInPrompt: true } } } });
  await handleSocialV2ReadWrite(noRec.ctx);
  assert.equal(noRec.sentJson.at(-1).body.recommended, null);

  const v2 = makeCtx();
  await handleSocialV2ReadWrite(v2.ctx);
  assert.equal(v2.sentJson.at(-1).body.role.hint, 'ROLE-HINT-V2');

  const closed = makeCtx('?key=group:1', { mode: 'closed-agent' });
  await handleSocialV2ReadWrite(closed.ctx);
  assert.equal(closed.sentJson.at(-1).body.role.hint, 'ROLE-HINT-CLOSED');
});

test('prompt：贴纸上下文/策略可关闭（空串）；记忆/参与度/黑话块都在', async () => {
  const noStickerCtx = makeCtx('?key=group:1', { cfgExtra: { socialV2: { tools: ALL_TOOLS, sticker: { enabled: true, includeInPrompt: false } } } });
  await handleSocialV2ReadWrite(noStickerCtx.ctx);
  const body = noStickerCtx.sentJson.at(-1).body;
  assert.equal(body.stickers.context, '');
  assert.equal(body.stickers.strategy, '');
  assert.equal(body.memory, 'MEM');
  assert.equal(body.participation, 'PART');
  assert.equal(body.slang.block, 'SLANG(5)');
  assert.equal(body.unreadCount, 1);
  assert.equal(body.recentCount, 1);
});

test('prompt：表情库同步失败 / 成功都返回 prompt（失败不阻塞）', async () => {
  const fail = makeCtx('?key=group:1', { syncImpl: () => { throw new Error('OneBot 挂了'); } });
  await handleSocialV2ReadWrite(fail.ctx);
  assert.equal(fail.sentJson.at(-1).body.ok, true, '同步失败也要把 prompt 给她');
  assert.equal(fail.syncCalls(), 1);

  const ok = makeCtx('?key=group:1');
  await handleSocialV2ReadWrite(ok.ctx);
  assert.equal(ok.syncCalls(), 1, '贴纸开启时每次 prompt 顺手同步一次');
});
