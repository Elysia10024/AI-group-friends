// handleStickerCollectRoutes · 收藏表情路由的 hermetic 测试（2026-10-28 第 31 轮）。
//
// 收藏表情会下载图片并写本地表情库（"偷图"）——属本地资产写入面。重点：
//   · 体系/功能开关、key 格式、限频；
//   · 限频额度先预占、失败回滚（与发送额度同一套路子）；
//   · 列表的缓存/强制刷新节流。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleStickerCollectRoutes } from './sticker.js';
import { reserveSlots, rollbackSlots } from '../../core/ratelimit.js';

function makeCtx(pathname, { method = 'GET', body = {}, query = '', stickerEnabled = true, rateOk = true, collectImpl, syncImpl } = {}) {
  const sentJson = [];
  const calls = { saves: 0, collect: [], sync: [], notes: [], remarks: [], activity: [] };
  const st = { stickerCollectTimes: [] };
  const ctx = {
    agentTokenOk: () => true,
    appendActivity: (s) => calls.activity.push(s),
    applyStickerNoteV2: (id, note, tags, usage) => { calls.notes.push({ id, note, tags, usage }); return { id, note, tags, usage }; },
    cfg: { socialV2: { sticker: { maxListCount: 100, collect: { enabled: true, maxPerMinute: 5, maxPerHour: 20 } } } },
    collectStickerV2: async (key, ref, remark) => {
      calls.collect.push({ key, ref, remark });
      if (collectImpl) return collectImpl(key, ref, remark);
      return { emojiId: 'e1', remark, entry: { id: 'e1', desc: '摸鱼' } };
    },
    deps: { flags: { stickerEntries: [{ id: 'cached' }], stickerSyncedAt: 'AT', lastForcedAgentStickerSync: 0 } },
    formatStickerList: (list, q, count) => ({ entries: list.slice(0, count), total: list.length }),
    getSocialV2State: () => st,
    log: () => {},
    rateLimitCheck: () => ({ ok: rateOk }),
    readBody: async () => body,
    req: { method, headers: { 'x-agent-token': 'T' }, on: () => {} },
    reserveSlots,
    rollbackSlots,
    saveSocialV2State: () => { calls.saves += 1; },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    setStickerRemarkV2: async (id, remark) => { calls.remarks.push({ id, remark }); return { id, desc: remark }; },
    stickerEnabled: () => stickerEnabled,
    syncStickerLibrary: async (force) => {
      calls.sync.push(force);
      if (syncImpl) return syncImpl(force);
      return { entries: [{ id: 'e1' }, { id: 'e2' }], syncedAt: 'NOW', fromCache: false };
    },
    url: new URL(`http://127.0.0.1:3100${pathname}${query}`),
    v2SessionAllowed: () => true,
    v2ToolEnabled: () => true,
  };
  return { ctx, sentJson, calls, st };
}

test('collect-sticker：体系关闭 → 403；缺参 → 400；key 格式非法 → 400', async () => {
  const off = makeCtx('/api/socialV2/collect-sticker', { method: 'POST', body: { key: 'group:1', messageId: 'm1' }, stickerEnabled: false });
  await handleStickerCollectRoutes(off.ctx);
  assert.equal(off.sentJson.at(-1).status, 403);

  const missing = makeCtx('/api/socialV2/collect-sticker', { method: 'POST', body: { key: 'group:1' } });
  await handleStickerCollectRoutes(missing.ctx);
  assert.equal(missing.sentJson.at(-1).status, 400);

  const badKey = makeCtx('/api/socialV2/collect-sticker', { method: 'POST', body: { key: 'x:1', messageId: 'm1' } });
  await handleStickerCollectRoutes(badKey.ctx);
  assert.equal(badKey.sentJson.at(-1).status, 400);
  assert.match(badKey.sentJson.at(-1).body.error, /key 格式/);
});

test('collect-sticker：限频 → 429，不预占额度', async () => {
  const { ctx, sentJson, st, calls } = makeCtx('/api/socialV2/collect-sticker', {
    method: 'POST', body: { key: 'group:1', messageId: 'm1' }, rateOk: false,
  });
  await handleStickerCollectRoutes(ctx);
  assert.equal(sentJson.at(-1).status, 429);
  assert.equal(st.stickerCollectTimes.length, 0);
  assert.equal(calls.collect.length, 0);
});

test('collect-sticker：成功 → 预占 1 格、落盘、回 emojiId 与 entry', async () => {
  const { ctx, sentJson, st, calls } = makeCtx('/api/socialV2/collect-sticker', {
    method: 'POST', body: { key: 'group:1', messageId: 'm1', remark: '摸鱼猫' },
  });
  await handleStickerCollectRoutes(ctx);
  assert.equal(sentJson.at(-1).body.ok, true);
  assert.equal(sentJson.at(-1).body.emojiId, 'e1');
  assert.equal(calls.collect[0].remark, '摸鱼猫');
  assert.equal(st.stickerCollectTimes.length, 1);
  assert.ok(calls.saves >= 1);
});

test('collect-sticker：收藏失败 → 500 且额度回滚', async () => {
  const { ctx, sentJson, st } = makeCtx('/api/socialV2/collect-sticker', {
    method: 'POST', body: { key: 'group:1', messageId: 'm1' },
    collectImpl: () => { throw new Error('下载失败'); },
  });
  await handleStickerCollectRoutes(ctx);
  assert.equal(sentJson.at(-1).status, 500);
  assert.match(sentJson.at(-1).body.error, /收藏表情失败/);
  assert.equal(st.stickerCollectTimes.length, 0, '失败必须回滚额度');
});

test('sticker-list：关闭 403、缺 key 400、成功带缓存标记、同步失败 500', async () => {
  const off = makeCtx('/api/socialV2/sticker-list', { stickerEnabled: false });
  await handleStickerCollectRoutes(off.ctx);
  assert.equal(off.sentJson.at(-1).status, 403);

  const noKey = makeCtx('/api/socialV2/sticker-list');
  await handleStickerCollectRoutes(noKey.ctx);
  assert.equal(noKey.sentJson.at(-1).status, 400);

  const ok = makeCtx('/api/socialV2/sticker-list', { query: '?key=group:1&count=1' });
  await handleStickerCollectRoutes(ok.ctx);
  const body = ok.sentJson.at(-1).body;
  assert.equal(body.ok, true);
  assert.equal(body.entries.length, 1);
  assert.equal(body.syncedAt, 'NOW');
  assert.equal(body.fromCache, false);

  const fail = makeCtx('/api/socialV2/sticker-list', { query: '?key=group:1', syncImpl: () => { throw new Error('OneBot 挂了'); } });
  await handleStickerCollectRoutes(fail.ctx);
  assert.equal(fail.sentJson.at(-1).status, 500);
});

test('sticker-list：AI 强制刷新有 10 秒节流', async () => {
  const { ctx, calls } = makeCtx('/api/socialV2/sticker-list', { query: '?key=group:1&refresh=1' });
  await handleStickerCollectRoutes(ctx);
  assert.deepEqual(calls.sync, [true], '首次强制刷新放行');
  // 第二次立刻再刷：节流成 false（deps.flags 里时间戳刚被写）
  await handleStickerCollectRoutes(ctx);
  assert.equal(calls.sync[1], false, '10 秒内第二次强制刷新被降级为普通刷新');
});

test('管理端 /api/stickers/note 与 /remark：调用对应写入并回执（字段 stickerId）', async () => {
  const note = makeCtx('/api/stickers/note', { method: 'POST', body: { stickerId: 'e1', note: '摸鱼用', tags: [' 摸鱼 ', ''], usage: ' 用来表达在偷懒 ' } });
  await handleStickerCollectRoutes(note.ctx);
  assert.deepEqual(note.calls.notes, [{ id: 'e1', note: '摸鱼用', tags: ['摸鱼'], usage: '用来表达在偷懒' }]);
  assert.equal(note.sentJson.at(-1).body.ok, true);

  const noId = makeCtx('/api/stickers/note', { method: 'POST', body: {} });
  await handleStickerCollectRoutes(noId.ctx);
  assert.equal(noId.sentJson.at(-1).status, 400);

  const remark = makeCtx('/api/stickers/remark', { method: 'POST', body: { stickerId: 'e1', remark: '官方备注' } });
  await handleStickerCollectRoutes(remark.ctx);
  assert.deepEqual(remark.calls.remarks, [{ id: 'e1', remark: '官方备注' }]);
});
