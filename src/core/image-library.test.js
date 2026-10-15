// src/core/image-library.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  safeImageFile,
  parseImageLibrary,
  findImage,
  filterImages,
  imageIndexText,
  isSendable,
  IMAGE_VERDICTS,
  pickImageExt,
  normalizeImageName,
  buildLibraryEntry,
  appendImageEntry
} from './image-library.js';

const RAW = {
  images: [
    { name: '偷懒', file: '偷懒.jpg', verdict: '适合', tags: ['摸鱼', '摆烂', '拖延', '自嘲'], desc: '躺鲸鱼抱枕上打哈欠' },
    { name: 'ciallo~', file: 'ciallo~.jpg', verdict: '谨慎', reason: '带小红书水印', tags: ['打招呼', '卖萌'], desc: '眨眼比耶' },
    { name: '你终于回家了（病娇）', file: '你终于回家了（病娇）.jpg', verdict: '不适合', reason: '病娇+引流', tags: ['病娇'], desc: '满屏爱心' },
    { name: '改回第一版', file: '改回第一版.jpg', verdict: '适合', tags: ['需求变更', '改稿', '甲方'], desc: '举 V1~V5 牌子' }
  ]
};

test('safeImageFile：挡掉路径穿越与奇怪的名字', () => {
  assert.equal(safeImageFile('偷懒.jpg'), '偷懒.jpg');
  for (const bad of ['../secret.jpg', 'a/b.jpg', 'a\\b.jpg', '..', '.', '.hidden', '', null, undefined, 'x'.repeat(200)]) {
    assert.equal(safeImageFile(bad), null, `应拒绝：${String(bad).slice(0, 20)}`);
  }
});

test('safeImageFile：名字里带连续点是合法的（曾经被误杀过一张图）', () => {
  // 上跳防护靠"禁分隔符 + 名字正好是 . 或 .."，不是靠 includes('..')
  assert.equal(safeImageFile('如果有一天我变成了文件....jpg'), '如果有一天我变成了文件....jpg');
  assert.equal(safeImageFile('a..b.jpg'), 'a..b.jpg');
  // 但 Windows 会吃掉结尾的点和空格，这种名字有撞名风险
  assert.equal(safeImageFile('foo.'), null);
  assert.equal(safeImageFile('foo. '), null);
});

test('parseImageLibrary：正常条目全收，判定值非法就降级成"谨慎"并记一笔', () => {
  const { images, errors } = parseImageLibrary(RAW);
  assert.equal(images.length, 4);
  assert.equal(errors.length, 0);
  assert.equal(images[0].name, '偷懒');
  assert.equal(images[0].verdict, '适合');
  const { images: i2, errors: e2 } = parseImageLibrary({ images: [{ name: 'x', file: 'x.jpg', verdict: '随便' }] });
  assert.equal(i2[0].verdict, '谨慎');
  assert.match(e2[0], /verdict/);
});

test('parseImageLibrary：坏条目不会让整体崩（缺 file / 重名 / 非法路径）', () => {
  const { images, errors } = parseImageLibrary({
    images: [
      { name: 'A', file: 'A.jpg', verdict: '适合' },
      { name: 'A', file: 'A2.jpg', verdict: '适合' },
      { name: 'B', verdict: '适合' },
      { name: 'C', file: '../C.jpg', verdict: '适合' },
      null
    ]
  });
  assert.deepEqual(images.map((i) => i.name), ['A']);
  assert.equal(errors.length, 4);
  assert.equal(parseImageLibrary(null).images.length, 0);
});

test('findImage：全名 / 带扩展名 / 唯一子串都能找到，歧义时返回 null', () => {
  const { images } = parseImageLibrary(RAW);
  assert.equal(findImage(images, '偷懒').name, '偷懒');
  assert.equal(findImage(images, '偷懒.jpg').name, '偷懒');
  assert.equal(findImage(images, 'ciallo~.jpg').name, 'ciallo~');
  assert.equal(findImage(images, '改回').name, '改回第一版', '唯一子串也能定位');
  // "第一版" 只对应一张 → 唯一匹配；找不到 → null
  assert.equal(findImage(images, '不存在的图'), null);
  assert.equal(findImage(images, '第一版').name, '改回第一版');
});

test('filterImages：按判定 / 标签 / 关键词过滤', () => {
  const { images } = parseImageLibrary(RAW);
  assert.deepEqual(filterImages(images, { verdict: '适合' }).map((i) => i.name), ['偷懒', '改回第一版']);
  assert.deepEqual(filterImages(images, { tag: '摸鱼' }).map((i) => i.name), ['偷懒']);
  assert.deepEqual(filterImages(images, { query: 'v1' }).map((i) => i.name), ['改回第一版'], '描述里的英文也参与匹配（大小写不敏感）');
  assert.deepEqual(filterImages(images, { tag: '不存在' }).map((i) => i.name), []);
});

test('isSendable：只有"不适合"不许发', () => {
  const { images } = parseImageLibrary(RAW);
  assert.equal(isSendable(findImage(images, '偷懒')), true);
  assert.equal(isSendable(findImage(images, 'ciallo~')), true, '谨慎的能发，只是要挑场合');
  assert.equal(isSendable(findImage(images, '你终于回家了（病娇）')), false);
});

test('imageIndexText：适合档逐个列、谨慎档只报数量、不适合档点名警告', () => {
  const { images } = parseImageLibrary(RAW);
  const text = imageIndexText(images);
  assert.match(text, /可直接发：偷懒\(摸鱼\/摆烂\)/, '默认只取 2 个标签');
  assert.match(text, /另有 1 张带水印\/易引战的/, '谨慎档不再逐个列名字（列出来像在推荐）');
  assert.ok(!text.includes('ciallo~'), '谨慎档的名字不出现在清单里');
  assert.match(text, /不许发（1 张）：你终于回家了（病娇）/);
  assert.ok(text.length < 400, `清单要紧凑，实际 ${text.length} 字`);
  assert.equal(imageIndexText([]), '');
});

test('imageIndexText：标签最多取 maxTags 个，别把清单撑爆', () => {
  const { images } = parseImageLibrary(RAW);
  const text = imageIndexText(images, { maxTags: 1 });
  assert.match(text, /偷懒\(摸鱼\)/);
  assert.ok(!text.includes('摆烂'));
});

test('IMAGE_VERDICTS 是约定的三档（前端/文档都靠它）', () => {
  assert.deepEqual(IMAGE_VERDICTS, ['适合', '谨慎', '不适合']);
});

test('by 标记：缺省是管理员命名，她存的记 her', () => {
  const { images } = parseImageLibrary({ images: [
    { name: 'a', file: 'a.jpg', verdict: '适合' },
    { name: 'b', file: 'b.jpg', verdict: '适合', by: 'her' },
    { name: 'c', file: 'c.jpg', verdict: '适合', by: '随便' }
  ] });
  assert.equal(images[0].by, 'admin', '没写 = 管理员命名（57 张老图的默认）');
  assert.equal(images[1].by, 'her');
  assert.equal(images[2].by, 'admin', '认不出的值一律当管理员');
  assert.equal(buildLibraryEntry({ name: 'x', ext: '.png' }).entry.by, 'admin');
  assert.equal(buildLibraryEntry({ name: 'y', ext: '.png', by: 'her' }).entry.by, 'her');
});

// ── 保存群友的图（2026-10-12 新增）────────────────────────────────────────
test('pickImageExt：只认四种能在 QQ 里发的格式', () => {
  assert.equal(pickImageExt('image/jpeg'), '.jpg');
  assert.equal(pickImageExt('image/jpg'), '.jpg');
  assert.equal(pickImageExt('image/png; charset=binary'), '.png');
  assert.equal(pickImageExt('image/webp'), '.webp');
  assert.equal(pickImageExt('image/gif'), '.gif');
  assert.equal(pickImageExt('image/avif'), '', 'AVIF 发不出去（那批图的老教训），一律不收');
  assert.equal(pickImageExt(''), '');
});

test('normalizeImageName：挡掉文件系统不认的字符，长度封顶', () => {
  assert.equal(normalizeImageName('  猫猫问号  '), '猫猫问号');
  assert.equal(normalizeImageName('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
  assert.equal(normalizeImageName('x'.repeat(50)).length, 30);
  assert.equal(normalizeImageName(null), '');
});

test('buildLibraryEntry：名字/格式必须给对，verdict 非法就按"适合"', () => {
  const ok = buildLibraryEntry({ name: '猫猫问号', ext: '.jpg', tags: ['猫', '问号'], desc: '一只猫歪头' });
  assert.equal(ok.ok, true);
  assert.equal(ok.entry.file, '猫猫问号.jpg');
  assert.equal(ok.entry.verdict, '适合');
  assert.deepEqual(ok.entry.tags, ['猫', '问号']);
  assert.equal(buildLibraryEntry({ name: '', ext: '.jpg' }).ok, false, '没名字不行');
  assert.equal(buildLibraryEntry({ name: 'x', ext: '.avif' }).ok, false, '格式不行');
  assert.equal(buildLibraryEntry({ name: 'x', ext: '.png', verdict: '随便' }).entry.verdict, '适合');
  assert.equal(buildLibraryEntry({ name: 'x', ext: '.png', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).entry.tags.length, 6, '标签最多 6 个');
});

test('appendImageEntry：同名拒绝、不改入参、保留 note', () => {
  const raw = { note: '图库说明', images: [{ name: '偷懒', file: '偷懒.jpg' }] };
  const dup = appendImageEntry(raw, { name: '偷懒', file: '偷懒.jpg' });
  assert.equal(dup.ok, false);
  assert.match(dup.error, /已经有叫/);
  const add = appendImageEntry(raw, { name: '猫猫问号', file: '猫猫问号.jpg' });
  assert.equal(add.ok, true);
  assert.equal(add.raw.images.length, 2);
  assert.equal(add.raw.note, '图库说明', 'note 不能丢');
  assert.equal(raw.images.length, 1, '不能改入参');
});
