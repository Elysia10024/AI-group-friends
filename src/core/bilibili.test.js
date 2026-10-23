// src/core/bilibili.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTargets,
  extractVideo,
  diffVideos,
  nextSeen,
  formatVideo,
  signWbi,
  mixinKey
} from './bilibili.js';

test('normalizeTargets：过滤非法、同 uid 合并群、alias 兜底', () => {
  const out = normalizeTargets([
    { uid: 27534330, alias: '崩坏三', groups: [20000001, 20000001] },
    { uid: '401742377', alias: ' 原神 ', groups: [20000001, 0, 'x'] },
    { uid: -1, groups: [1] },
    { uid: 27534330, alias: '重复', groups: [123] },
    { uid: 'abc', groups: [1] },
    null
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { uid: 27534330, alias: '崩坏三', groups: [20000001, 123], enabled: true });
  assert.deepEqual(out[1], { uid: 401742377, alias: '原神', groups: [20000001], enabled: true });
  assert.deepEqual(normalizeTargets(null), []);
});

test('extractVideo：只认 DYNAMIC_TYPE_AV 且带合法 bvid', () => {
  const av = extractVideo({
    type: 'DYNAMIC_TYPE_AV',
    modules: {
      module_author: { pub_ts: 1700000000 },
      module_dynamic: { major: { archive: { bvid: 'BV1xx411c7mD', title: '  标题  ' } } }
    }
  });
  assert.deepEqual(av, {
    id: 'BV1xx411c7mD',
    title: '标题',
    created: 1700000000,
    url: 'https://www.bilibili.com/video/BV1xx411c7mD'
  });
  assert.equal(extractVideo({ type: 'DYNAMIC_TYPE_DRAW' }), null);
  assert.equal(extractVideo({ type: 'DYNAMIC_TYPE_AV', modules: { module_dynamic: { major: { archive: { bvid: 'av123' } } } } }), null);
  assert.equal(extractVideo(null), null);
});

test('diffVideos：首次只建基线；之后只报新且不过期的', () => {
  const now = 1_700_000_000_000; // 毫秒
  const videos = [
    { id: 'BVnew', created: 1_699_999_000 },  // 1000 秒前
    { id: 'BVold', created: 1_600_000_000 },  // 很久以前
    { id: 'BVseen', created: 1_699_999_500 }
  ];
  const first = diffVideos(null, videos, { now, maxAgeMs: 3600_000 });
  assert.deepEqual(first.baseline, ['BVnew', 'BVold', 'BVseen']);
  assert.deepEqual(first.fresh, []);

  const second = diffVideos(['BVseen'], videos, { now, maxAgeMs: 3600_000 });
  assert.deepEqual(second.fresh.map((v) => v.id), ['BVnew'], 'BVold 过期、BVseen 已见，都不播');
  assert.deepEqual(second.baseline, []);

  // 过期的也要留在 seen 里（由 nextSeen 负责），但 fresh 不报
  const stale = diffVideos(['BVnew', 'BVseen'], videos, { now, maxAgeMs: 3600_000 });
  assert.deepEqual(stale.fresh, []);
});

test('diffVideos：created=0 的条目不当成新视频', () => {
  const out = diffVideos([], [{ id: 'BVx', created: 0 }], { now: Date.now(), maxAgeMs: 3600_000 });
  assert.deepEqual(out.fresh, []);
});

test('nextSeen：去重、保留最新 cap 条、不改原数组', () => {
  const seen = ['A', 'B', 'C'];
  const videos = [
    { id: 'D', created: 40 },
    { id: 'B', created: 20 },
    { id: 'E', created: 50 }
  ];
  const next = nextSeen(seen, videos, 4);
  assert.deepEqual(next, ['C', 'B', 'D', 'E']);
  assert.deepEqual(seen, ['A', 'B', 'C']);
  assert.equal(nextSeen([], [], 4).length, 0);
  assert.deepEqual(nextSeen(['1', '2', '3', '4'], [], 2), ['3', '4']);
});

test('formatVideo：占位替换与默认模板', () => {
  assert.equal(
    formatVideo('{alias} 更新了\n{title}\n{url}', { alias: '原神', title: 'PV', url: 'https://x' }),
    '原神 更新了\nPV\nhttps://x'
  );
  assert.equal(formatVideo(undefined, { alias: 'A', title: 'T', url: 'U' }), 'A 发新视频了\nT\nU');
});

test('signWbi：参数排序、过滤 !()*、带 wts 和 32 位 w_rid', () => {
  const out = signWbi({ b: 'x!y', a: 2 }, 'k1', 'k2', 1000);
  assert.match(out, /^a=2&b=xy&wts=1000&w_rid=[0-9a-f]{32}$/);
  assert.equal(mixinKey('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef').length, 32);
});
