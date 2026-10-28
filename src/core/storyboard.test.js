// core/storyboard.js 单测（分镜图纯逻辑）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTs, selectCells, mapSubtitlesToCells, summarizeLoudness, formatStoryboardNote,
  STORYBOARD_MIN_CELLS
} from './storyboard.js';

test('formatTs：分秒与小时', () => {
  assert.equal(formatTs(0), '0:00');
  assert.equal(formatTs(12), '0:12');
  assert.equal(formatTs(75), '1:15');
  assert.equal(formatTs(3725), '1:02:05');
  assert.equal(formatTs(-3), '0:00');
});

test('selectCells：切点够 → 按时间均匀挑 9–16 个，保留首尾', () => {
  const scenes = Array.from({ length: 30 }, (_, i) => i * 8 + 3); // 30 个切点
  const { cells, source } = selectCells(scenes, 300);
  assert.equal(source, 'scene');
  assert.ok(cells.length >= STORYBOARD_MIN_CELLS && cells.length <= 16, `实际 ${cells.length}`);
  assert.equal(cells[0], scenes[0]);
  assert.equal(cells[cells.length - 1], scenes[scenes.length - 1]);
});

test('selectCells：切点不够 → 均匀补足到 min，且升序无重复', () => {
  const { cells, source } = selectCells([5, 40], 300);
  assert.equal(source, 'mixed');
  assert.ok(cells.length >= STORYBOARD_MIN_CELLS);
  assert.deepEqual(cells, [...new Set(cells)].sort((a, b) => a - b));
});

test('selectCells：没有切点 → 均匀采样，全部落在时长内', () => {
  const { cells, source } = selectCells([], 120);
  assert.equal(source, 'uniform');
  assert.equal(cells.length, STORYBOARD_MIN_CELLS);
  for (const t of cells) assert.ok(t >= 0 && t < 120);
});

test('selectCells：切点过近（<0.8s）去重', () => {
  const { cells, source } = selectCells([10, 10.2, 10.4], 60);
  // 去重后不足 9 → 混合补点
  assert.equal(source, 'mixed');
  assert.ok(cells.length >= STORYBOARD_MIN_CELLS);
});

test('mapSubtitlesToCells：覆盖该时刻的字幕优先', () => {
  const subs = [{ from: 0, to: 5, text: '开头' }, { from: 30, to: 35, text: '第三十秒' }];
  const out = mapSubtitlesToCells([1, 31, 50], subs);
  assert.equal(out[0].text, '开头');
  assert.equal(out[1].text, '第三十秒');
  // 50 秒没有覆盖字幕 → 取后面最近的一条（没有则跳过）
  assert.equal(out.length, 2);
});

test('summarizeLoudness：合并同类、最多 5 段、带时间戳', () => {
  const segs = [
    { from: 0, to: 5, level: 0.02 }, { from: 5, to: 10, level: 0.03 },
    { from: 10, to: 20, level: 0.6 }, { from: 20, to: 25, level: 0.7 },
    { from: 30, to: 40, level: 0.5 }
  ];
  const line = summarizeLoudness(segs);
  assert.match(line, /^响度：/);
  assert.match(line, /安静/);
  assert.match(line, /人声\/音乐明显/);
  assert.ok(line.length < 200);
});

test('formatStoryboardNote：没格子返回空；有格子写清格数/来源/时间戳', () => {
  assert.equal(formatStoryboardNote({ cells: [] }), '');
  const note = formatStoryboardNote({
    cells: [0, 10, 20], source: 'scene',
    subtitleLines: [{ at: 10, text: '你好呀' }],
    loudnessLine: '响度：0:00–0:10 安静'
  });
  assert.match(note, /3 格/);
  assert.match(note, /按镜头切换/);
  assert.match(note, /0:10 你好呀/);
  assert.match(note, /响度/);
});
