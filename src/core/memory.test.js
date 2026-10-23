// 记忆读写的契约测试。跑法：npm test
//
// 行为不变性由一次性差分脚本证明：把 bridge.js 里原件的 formatMemoryV2 / appendMemoryV2
// 抽出来，与新模块在 12 + 25 组输入下比对（渲染比字符串，写入比修改后的完整状态），
// 全部一致；脚本验证完即删。
//
// 这里留下的重点是把「历史上栽过的三个坑」钉成回归测试 —— 三次都是静默写错，
// 靠群里表现才发现。现在它们会在 npm test 阶段就报红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMemory,
  appendMemory,
  mergeTrait,
  mergeTraitWithMeta,
  mergeImpressionRecords,
  traitSimilarity,
  normalizeTrait,
  TRAIT_DUPLICATE_THRESHOLD
} from './memory.js';

const NOW = Date.parse('2026-09-18T12:00:00+08:00');
const HOUR = 3600000;
const IDENT = (s) => String(s);
const op = (over = {}) => ({ now: NOW, redact: IDENT, ...over });

// ==================== formatMemory ====================

test('formatMemory：空状态返回空串', () => {
  assert.equal(formatMemory(null), '');
  assert.equal(formatMemory({}), '');
  assert.equal(formatMemory(undefined), '');
});

test('formatMemory：话题 / 想法 / 印象三段齐全', () => {
  const out = formatMemory({
    activeTopics: [{ text: '在聊重构', lastMentionAt: NOW - 5 * 60000, pendingQuestion: '谁负责' }],
    pendingThoughts: [{ text: '想吐槽', createdAt: NOW, expiresAt: NOW + HOUR, motivation: '好奇' }],
    memberImpressions: { 拾圆拾圆: { traits: ['爱开玩笑'], interactionCount: 3, lastSeenAt: NOW } }
  }, op());
  assert.match(out, /【进行中的话题】/);
  assert.match(out, /- 在聊重构（5分钟前）；待追问：谁负责/);
  assert.match(out, /【你想说但还没说的】/);
  assert.match(out, /- 想吐槽（好奇）/);
  assert.match(out, /【对群友的印象】/);
  assert.match(out, /- 拾圆拾圆：爱开玩笑（互动 3 次）/);
});

test('formatMemory：超过 2 小时没提起的话题标「已搁置」', () => {
  const out = formatMemory({ activeTopics: [{ text: '旧话题', lastMentionAt: NOW - 3 * HOUR }] }, op());
  assert.match(out, /旧话题（已搁置）/);
});

test('formatMemory：话题最多展开 10 条（取最新）', () => {
  const topics = Array.from({ length: 15 }, (_, i) => ({ text: 'T' + i, lastMentionAt: NOW - i * 1000 }));
  const out = formatMemory({ activeTopics: topics }, op());
  // 按"最近被提及"排序取前 10：T0 最新应留下、T14 最旧应被裁掉。
  // （旧实现是 slice(-10)，拿到的其实是**最早写入**的 10 条 —— 2026-09-30 修。）
  assert.ok(out.includes('T0'), '最新的必须留下');
  assert.ok(!out.includes('T14'), '最旧的应被裁掉');
  assert.equal(out.split('\n').filter((l) => l.startsWith('- T')).length, 10);
});

test('formatMemory：已过期的想法不渲染', () => {
  const out = formatMemory({
    pendingThoughts: [
      { text: '还有效', createdAt: NOW, expiresAt: NOW + HOUR },
      { text: '已过期', createdAt: NOW, expiresAt: NOW - 1000 }
    ]
  }, op());
  assert.ok(out.includes('还有效'));
  assert.ok(!out.includes('已过期'));
});

// ---------- 历史坑 ②③：印象渲染 ----------
test('【回归·坑③】印象按最近互动排序，不是按写入顺序', () => {
  // 原实现用 Object.keys().slice(-10)（写入顺序）取最后 10 位，
  // 存了 50 位群友也只有 10 位能看到，第 11 位之后等于白记。
  const out = formatMemory({
    memberImpressions: {
      最早互动: { traits: ['a'], interactionCount: 1, lastSeenAt: NOW - 10 * HOUR },
      中间互动: { traits: ['b'], interactionCount: 1, lastSeenAt: NOW - 2 * HOUR },
      最近互动: { traits: ['c'], interactionCount: 1, lastSeenAt: NOW - 1000 }
    }
  }, op({ memoryMaxMembers: 1 }));
  assert.ok(out.includes('最近互动'), '只展开 1 位时必须是最近互动的那位');
  assert.ok(!out.includes('最早互动'), '写入顺序最早的不该被优先展开');
});

test('【回归·坑③】超出上限时给出「还有 N 位没展开」', () => {
  const memberImpressions = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => ['P' + i, { traits: ['t'], interactionCount: i, lastSeenAt: NOW - i * 1000 }])
  );
  const out = formatMemory({ memberImpressions }, op({ memoryMaxMembers: 2 }));
  assert.match(out, /（还有 3 位群友的印象没展开）/);
});

test('formatMemory：每人只保留最新 N 条印象，每条按字数截断加省略号', () => {
  const out = formatMemory({
    memberImpressions: { A: { traits: ['一', '二', '三', '四'], interactionCount: 1, lastSeenAt: NOW } }
  }, op({ memoryMaxTraits: 2, memoryTraitChars: 40 }));
  assert.ok(out.includes('三；四'), '应保留最新的两条');
  assert.ok(!out.includes('一'), '最旧的应被丢掉');

  const long = formatMemory({ memberImpressions: { A: { traits: ['x'.repeat(200)], interactionCount: 1, lastSeenAt: NOW } } }, op());
  assert.ok(long.includes('x'.repeat(170) + '…'));
});

test('formatMemory：上限配置非法时回落到默认值', () => {
  const out = formatMemory({ memberImpressions: { A: { traits: ['x'], interactionCount: 1, lastSeenAt: NOW } } },
    op({ memoryMaxMembers: 'abc', memoryMaxTraits: -5, memoryTraitChars: 99999 }));
  assert.ok(out.includes('A：x'), '不该因为配置非法就渲染不出东西');
});

test('formatMemory：坏数据不炸（traits 非数组 / 条目非对象）', () => {
  const out = formatMemory({
    memberImpressions: { A: { interactionCount: 2, lastSeenAt: NOW }, B: { traits: 'nope', lastSeenAt: NOW }, C: 'str', D: null }
  }, op());
  assert.match(out, /- A：暂无记录（互动 2 次）/);
  assert.ok(!out.includes('C'), '非对象条目应被过滤');
});

// ── 印象的时间坐标（2026-10-14：她 23:00 问"早八上完没"的第二层根因）──
// 记忆里那句"白天有早八"是几天前记的，而渲染不带日子 → 她把它当成现在的事。
const DAY = 86400000;

test('formatMemory：≥2 天的印象带上「多久以前」，今天/昨天的不标', () => {
  const out = formatMemory({
    memberImpressions: {
      群三水: {
        traits: ['【作息】白天有早八要上课', '今天刚说的', '昨天说的'],
        traitMeta: [
          { firstAt: NOW - 20 * DAY, lastAt: NOW - 12 * DAY, hits: 3 },
          { firstAt: NOW, lastAt: NOW - 1000, hits: 1 },
          { firstAt: NOW - DAY, lastAt: NOW - DAY, hits: 1 }
        ],
        interactionCount: 72,
        lastSeenAt: NOW
      }
    }
  }, op());
  assert.ok(out.includes('【作息】白天有早八要上课（12 天前）'), '十几天前记的必须带日子，否则她会当成现在的事');
  assert.ok(out.includes('今天刚说的；昨天说的'), '今天/昨天都不标 —— 这块是稳定前缀块，标了就得每天变一次');
});

test('formatMemory：印象用默认门限 2 —— 昨天不标、前天标「前天」（消息行是 1，故意不同）', () => {
  const out = formatMemory({
    memberImpressions: {
      A: {
        traits: ['昨天的', '前天的'],
        traitMeta: [
          { firstAt: 0, lastAt: NOW - DAY, hits: 1 },
          { firstAt: 0, lastAt: NOW - 2 * DAY, hits: 1 }
        ],
        interactionCount: 1,
        lastSeenAt: NOW
      }
    }
  }, op());
  assert.ok(out.includes('昨天的；前天的（前天）'), '昨天不标、前天标「前天」——印象是长期事实，差一天不影响判断');
});

test('formatMemory：时间戳为 0 的老印象什么都不显示（老数据不动，也不编时间）', () => {
  const out = formatMemory({
    memberImpressions: { A: { traits: ['x'], traitMeta: [{ firstAt: 0, lastAt: 0, hits: 0 }], interactionCount: 1, lastSeenAt: NOW } }
  }, op());
  assert.match(out, /- A：x（互动 1 次）/, '印象照常渲染，只是不带时间');
  assert.ok(!out.includes('天前') && !out.includes('个月前') && !out.includes('1970'));
});

test('formatMemory：traitMeta 与 traits 长度不一致 → 整条都不标时间（错位比没有更糟）', () => {
  const out = formatMemory({
    memberImpressions: {
      A: {
        traits: ['新写的'],
        // 两个 meta 对一条 trait：中间被动过，谁配谁不知道
        traitMeta: [{ firstAt: 0, lastAt: NOW - 30 * DAY, hits: 1 }, { firstAt: 0, lastAt: NOW - 40 * DAY, hits: 1 }],
        interactionCount: 1,
        lastSeenAt: NOW
      }
    }
  }, op());
  assert.ok(out.includes('A：新写的'));
  assert.ok(!out.includes('天前'), '宁可这条没有时间，也不能把别人的 30 天前贴到它身上');
});

test('formatMemory：只展开最新 N 条时，时间要跟着这 N 条一起切（最容易错位的地方）', () => {
  const out = formatMemory({
    memberImpressions: {
      A: {
        traits: ['最早', '中间', '最新'],
        traitMeta: [
          { firstAt: 0, lastAt: NOW - 40 * DAY, hits: 1 },
          { firstAt: 0, lastAt: NOW - 10 * DAY, hits: 1 },
          { firstAt: 0, lastAt: NOW - 3 * DAY, hits: 1 }
        ],
        interactionCount: 1,
        lastSeenAt: NOW
      }
    }
  }, op({ memoryMaxTraits: 2 }));
  assert.ok(out.includes('中间（10 天前）'), '切片时 meta 必须同切，否则会把 40 天前贴到"中间"上');
  assert.ok(out.includes('最新（3 天前）'));
  assert.ok(!out.includes('最早'));
});

test('formatMemory：没有 traitMeta 段（旧状态）时照常渲染，只是不带时间', () => {
  const out = formatMemory({
    memberImpressions: { A: { traits: ['x'], interactionCount: 1, lastSeenAt: NOW } }
  }, op());
  assert.match(out, /- A：x（互动 1 次）/);
});

// ==================== appendMemory ====================

test('appendMemory：缺 redact 直接抛错（宁可炸也不要静默泄露 token）', () => {
  assert.throws(
    () => appendMemory({}, { category: 'activeTopic', content: 'x', now: NOW }),
    /必须传入 redact/
  );
});

test('appendMemory：null st 返回 false（不落盘）', () => {
  assert.equal(appendMemory(null, { category: 'activeTopic', content: 'x', ...op() }), false);
});

test('appendMemory：话题新建 / 命中已有则刷新时间', () => {
  const st = {};
  assert.equal(appendMemory(st, { category: 'activeTopic', content: '聊 A', ...op() }), true);
  assert.equal(st.activeTopics.length, 1);
  assert.equal(st.activeTopics[0].lastMentionAt, NOW);

  assert.equal(appendMemory(st, { category: 'activeTopic', content: '聊 A', extra: { participants: ['u1'] }, now: NOW + 1000, redact: IDENT }), true);
  assert.equal(st.activeTopics.length, 1, '同名话题应合并而不是新增');
  assert.equal(st.activeTopics[0].lastMentionAt, NOW + 1000);
  assert.deepEqual(st.activeTopics[0].participants, ['u1']);
});

test('appendMemory：话题 72h 未提起被清理，超过 20 条裁最旧', () => {
  const st = { activeTopics: [{ text: '陈年', lastMentionAt: NOW - 80 * HOUR }] };
  appendMemory(st, { category: 'activeTopic', content: '新的', ...op() });
  assert.ok(!st.activeTopics.some((t) => t.text === '陈年'), '72h 前的话题应被清掉');
  assert.ok(st.activeTopics.some((t) => t.text === '新的'));
});

test('appendMemory：想法默认 2 小时过期，已过期的会被清理', () => {
  const st = { pendingThoughts: [{ text: '过期', expiresAt: NOW - 1000 }] };
  appendMemory(st, { category: 'pendingThought', content: '新想法', ...op() });
  assert.equal(st.pendingThoughts.length, 1);
  assert.equal(st.pendingThoughts[0].text, '新想法');
  assert.equal(st.pendingThoughts[0].expiresAt, NOW + 2 * HOUR);
  assert.equal(st.pendingThoughts[0].motivation, 'curiosity');
});

// ---------- 历史坑 ①②：印象写入 ----------
test('【回归·坑①】印象 traits 保留最新 20 条，超出后新观察仍能落库', () => {
  // 原实现 slice(0, 10) 保留**最旧**的 10 条再 push 新的存成 11 条，
  // 下次又砍回最旧 10 条 —— 超过 10 条之后，新写的观察永远存不进去。
  const st = { memberImpressions: { A: { traits: Array.from({ length: 25 }, (_, i) => 't' + i), interactionCount: 1, lastSeenAt: NOW } } };
  appendMemory(st, { category: 'memberImpression', content: '最新观察', extra: { target: 'A' }, ...op() });
  const traits = st.memberImpressions.A.traits;
  assert.equal(traits.length, 20);
  assert.equal(traits[traits.length - 1], '最新观察', '新观察必须在库里');
  assert.ok(!traits.includes('t0'), '最旧的应被挤掉');
});

test('【回归·坑②】单条观察不截到 50 字（可存到 300 字）', () => {
  const st = {};
  const long = '观'.repeat(200);
  appendMemory(st, { category: 'memberImpression', content: long, extra: { target: 'A' }, ...op() });
  assert.equal(st.memberImpressions.A.traits[0].length, 200, '原实现会砍到 50 字');
});

test('appendMemory：重复的观察不重复追加，互动次数照加', () => {
  const st = { memberImpressions: { A: { traits: ['一样的话'], interactionCount: 1, lastSeenAt: NOW - HOUR } } };
  appendMemory(st, { category: 'memberImpression', content: '一样的话', extra: { target: 'A' }, ...op() });
  assert.deepEqual(st.memberImpressions.A.traits, ['一样的话']);
  assert.equal(st.memberImpressions.A.interactionCount, 2);
});

test('appendMemory：群友超过 80 位时丢掉最久没互动的', () => {
  const st = { memberImpressions: Object.fromEntries(Array.from({ length: 82 }, (_, i) => ['M' + i, { traits: [], interactionCount: 1, lastSeenAt: NOW - i * 1000 }])) };
  appendMemory(st, { category: 'memberImpression', content: 'x', extra: { target: '新人' }, ...op() });
  const keys = Object.keys(st.memberImpressions);
  assert.equal(keys.length, 80);
  assert.ok(keys.includes('新人'), '新写的必须在');
  assert.ok(!keys.includes('M81'), '最久没互动的应被丢');
});

test('appendMemory：危险 target 直接拒绝且不落盘', () => {
  for (const target of ['__proto__', 'constructor', 'prototype', '', '   ']) {
    const st = {};
    assert.equal(appendMemory(st, { category: 'memberImpression', content: 'x', extra: { target }, ...op() }), false, `target=${JSON.stringify(target)} 应返回 false`);
    assert.deepEqual(st.memberImpressions, undefined, '不该写入任何东西');
  }
});

test('appendMemory：脱敏作用于内容 / 参与者 / 追问 / 动机', () => {
  const MASK = (s) => String(s).split('TOKEN').join('***');
  const st = {};
  appendMemory(st, { category: 'activeTopic', content: 'TOKEN 在内容里', extra: { participants: ['TOKEN-u1'], pendingQuestion: 'TOKEN?' }, now: NOW, redact: MASK });
  assert.equal(st.activeTopics[0].text, '*** 在内容里');
  assert.deepEqual(st.activeTopics[0].participants, ['***-u1']);
  assert.equal(st.activeTopics[0].pendingQuestion, '***?');

  const st2 = {};
  appendMemory(st2, { category: 'pendingThought', content: 'TOKEN', extra: { motivation: 'TOKEN好奇' }, now: NOW, redact: MASK });
  assert.equal(st2.pendingThoughts[0].motivation, '***好奇');

  const st3 = {};
  appendMemory(st3, { category: 'memberImpression', content: 'TOKEN观察', extra: { target: 'X' }, now: NOW, redact: MASK });
  assert.equal(st3.memberImpressions.X.traits[0], '***观察');
});

// ==================== 去重（2026-09-20 新增） ====================

test('normalizeTrait：标点/空白/大小写差异不算差异', () => {
  assert.equal(normalizeTrait('他 爱 拍 我！'), normalizeTrait('他爱拍我'));
  assert.equal(normalizeTrait('Likes Coffee'), normalizeTrait('likescoffee'));
});

test('traitSimilarity：同一件事换个说法仍然高度相似', () => {
  const a = '今天早七上课，课后还有实验，早上就喊脑袋疼。累的时候会来戳我撒娇，接一句软的、别凶他。';
  const b = '他今天早七上课+课后实验，力竭了还来戳我说「看见你会让我心情变好」。这种时候别凶，回一句软的就行。';
  assert.ok(traitSimilarity(a, b) >= TRAIT_DUPLICATE_THRESHOLD, `实测相似度 ${traitSimilarity(a, b).toFixed(3)}`);
});

test('traitSimilarity：不相干的两条不该相似', () => {
  assert.ok(traitSimilarity('爱问我好感度', '昨天交了课表') < TRAIT_DUPLICATE_THRESHOLD);
  assert.equal(traitSimilarity('', 'x'), 0);
});

test('mergeTrait：近似重复合并成一条，而不是越攒越多（真实事故复现）', () => {
  // 拾圆拾圆真实攒过的 5 条近似印象
  const seq = [
    '今天早七起来上课，下课还要去做实验，累到发气鼓鼓的毛绒玩偶表情来戳我。他累的时候发这种图就是撒娇，别凶他，接一句软的。',
    '今天早七上课，课后还有实验，早上就喊脑袋疼。累的时候会来戳我撒娇，接一句软的、别凶他。专属叫法「哦鲸鲸」。',
    '今早七点上课+课后实验，脑袋疼着还拍我、发「親密度↑」粉色图撒娇。他状态差的时候别凶，哄一句。',
    '他今天早七上课+课后实验，力竭了还来戳我说「看见你会让我心情变好」。这种时候别凶，回一句软的就行。'
  ];
  let traits = [];
  for (const t of seq) traits = mergeTrait(traits, t);
  assert.ok(traits.length <= 2, `四句同一件事应合并成一两条，实际 ${traits.length} 条`);
  assert.ok(traits.every((t) => t.length > 0));
});

test('mergeTrait：真的新信息照常追加', () => {
  let traits = mergeTrait([], '爱叫我「哦鲸鲸」');
  traits = mergeTrait(traits, '一周六天早八，累到发崩图报到');
  traits = mergeTrait(traits, '昨天交了 .ics 课表');
  assert.equal(traits.length, 3);
});

test('mergeTrait：合并后挪到末尾（末尾 = 最新，渲染优先取）', () => {
  let traits = mergeTrait(['甲：爱拍我'], '乙：爱问好感度');
  traits = mergeTrait(traits, '甲：爱拍我，每次都连拍好几下');
  assert.equal(traits.length, 2);
  assert.match(traits[traits.length - 1], /甲/);
});

test('mergeTrait：更长的旧描述优先保留（信息更多）', () => {
  const rich = '他很爱吃辣，说过三次，上次是麻辣香锅，吃完还喊胃疼，别再怂恿他吃。';
  const short = '他爱吃辣。';
  const traits = mergeTrait([rich], short);
  assert.deepEqual(traits, [rich]);
});

test('mergeTrait：不改入参 / 空输入安全 / 有上限', () => {
  const old = ['a'];
  mergeTrait(old, 'b');
  assert.deepEqual(old, ['a'], '不能改入参');
  assert.deepEqual(mergeTrait(undefined, 'x'), ['x']);
  assert.deepEqual(mergeTrait(['a'], ''), ['a']);
  const many = Array.from({ length: 30 }, (_, i) => `第${i}件事，各不相同，编号${i}`);
  assert.equal(mergeTrait(many, '第31件事，各不相同，编号31').length, 20);
});

test('appendMemory：近似重复不再新增条目（写入路径也接上了去重）', () => {
  const st = {};
  const one = '今天早七上课，课后还有实验，累了会来戳我撒娇，接一句软的、别凶他。';
  const two = '他今天早七上课+课后实验，力竭了还来戳我撒娇，这种时候别凶，回一句软的就行。';
  appendMemory(st, { category: 'memberImpression', content: one, extra: { target: '拾圆拾圆' }, ...op() });
  appendMemory(st, { category: 'memberImpression', content: two, extra: { target: '拾圆拾圆' }, ...op() });
  assert.equal(st.memberImpressions['拾圆拾圆'].traits.length, 1, '同一件事换个说法不该存成两条');
  assert.equal(st.memberImpressions['拾圆拾圆'].interactionCount, 2);
});

test('appendMemory：未知 category 也返回 true（与原实现一致：仍会落盘）', () => {
  assert.equal(appendMemory({}, { category: '莫名其妙', content: 'x', ...op() }), true);
});

// ── traitMeta（记忆时间戳）────────────────────────────────────────────────
// 2026-10-12 主人定：时间**只存不渲染**（材料里一个字不加，省 token），被追问时才查。
// 所以 traits 必须保持纯字符串数组，时间旁挂在同索引的 traitMeta 上 —— 下面几条把边界钉死。
test('mergeTraitWithMeta：同一件事反复提 → 保留最早的 firstAt、更新 lastAt、hits 累加', () => {
  const t1 = 1000, t2 = 2000;
  let r = mergeTraitWithMeta([], undefined, '他骂过我「你怎么不去死」', { now: t1 });
  assert.deepEqual(r.traits, ['他骂过我「你怎么不去死」']);
  assert.deepEqual(r.traitMeta, [{ firstAt: t1, lastAt: t1, hits: 1 }]);
  r = mergeTraitWithMeta(r.traits, r.traitMeta, '他骂过我，很烦', { now: t2 });
  assert.equal(r.traits.length, 1, '同一件事只留一条');
  assert.equal(r.traitMeta.length, 1);
  assert.equal(r.traitMeta[0].firstAt, t1, 'firstAt 保留最早（"这事什么时候开始的"）');
  assert.equal(r.traitMeta[0].lastAt, t2, 'lastAt 更新到这次（"最近一次提"）');
  assert.equal(r.traitMeta[0].hits, 2);
});

test('mergeTraitWithMeta：meta 与 traits 对不上就整体丢弃，绝不给错位的时间', () => {
  const r = mergeTraitWithMeta(['甲', '乙'], [{ firstAt: 1, lastAt: 1, hits: 1 }], '丙', { now: 5 });
  assert.deepEqual(r.traits, ['甲', '乙', '丙']);
  assert.equal(r.traitMeta.length, 3, '两个数组永远等长');
  assert.deepEqual(r.traitMeta[0], { firstAt: 0, lastAt: 0, hits: 0 }, '旧条目没有时间就记 0，不拿别人的');
  assert.deepEqual(r.traitMeta[2], { firstAt: 5, lastAt: 5, hits: 1 });
});

test('mergeTraitWithMeta：槽位覆盖时时间重置为这次（状态类不是历史事件）', () => {
  const a = mergeTraitWithMeta([], undefined, '【作息】他早七上课', { now: 100 });
  const b = mergeTraitWithMeta(a.traits, a.traitMeta, '【作息】他现在改晚课了', { now: 900 });
  assert.equal(b.traits.length, 1);
  assert.deepEqual(b.traitMeta[0], { firstAt: 900, lastAt: 900, hits: 1 });
});

test('mergeTraitWithMeta：截断时两个数组同步裁，永远等长', () => {
  // 注意：这里**直接传入** 25 条已有印象（它们之间不做相似度判定），只让新来的那条走合并逻辑 ——
  // 否则"第1件事/第2件事"这种高度相似的内容会被互相合并掉（一开始就是这么写错的）。
  const traits = Array.from({ length: 25 }, (_, i) => `编号${i}的独立观察记录`);
  const meta = traits.map((_, i) => ({ firstAt: i + 1, lastAt: i + 1, hits: 1 }));
  const r = mergeTraitWithMeta(traits, meta, '完全新的一件事：他昨天送了我一张图', { now: 999, cap: 20 });
  assert.equal(r.traits.length, 20);
  assert.equal(r.traitMeta.length, 20, '两个数组同步裁');
  assert.equal(r.traitMeta[r.traitMeta.length - 1].firstAt, 999, '新条目落在末尾');
  assert.equal(r.traits[0], '编号6的独立观察记录', '25 条 + 新增 1 条 = 26，只留后 20 条（丢最旧的 6 条）');
});

test('appendMemory：写进去的印象自带时间（traits 仍是字符串数组，旧代码不用改）', () => {
  const st = {};
  appendMemory(st, { category: 'memberImpression', content: '他骂过我', extra: { target: 'Qruei' }, now: 777, redact: (s) => s });
  appendMemory(st, { category: 'memberImpression', content: '他骂过我，很烦', extra: { target: 'Qruei' }, now: 888, redact: (s) => s });
  const im = st.memberImpressions.Qruei;
  assert.equal(typeof im.traits[0], 'string', 'traits 还是字符串数组');
  assert.equal(im.traitMeta[0].firstAt, 777);
  assert.equal(im.traitMeta[0].lastAt, 888);
});

// ── 身份锚点（2026-10-15：key 从名字改成 QQ）────────────────────────────────
const OWNER_QQ = '10000001';
const OWNER_PEOPLE = {
  [OWNER_QQ]: { names: { 'private:10000001': '群三水', 'group:20000002': '测试用户' } },
  '1797151424': { names: { 'group:20000001': '至招，至丑，至绷的化身' } }
};

test('身份锚点：名片改了还是同一条记忆（key 是 QQ，不是名字）', () => {
  const st = {};
  const key = 'private:10000001';
  appendMemory(st, {
    category: 'memberImpression', content: '他说白天有早八', extra: { target: '群三水' },
    now: 1000, redact: (s) => s, key, people: OWNER_PEOPLE
  });
  assert.ok(st.memberImpressions[OWNER_QQ], 'key 应该落成 QQ');
  assert.equal(st.memberImpressions[OWNER_QQ].displayName, '群三水');
  // 过了几天，名片改成了「三水」
  const people2 = { [OWNER_QQ]: { names: { [key]: '三水' } } };
  appendMemory(st, {
    category: 'memberImpression', content: '【作息】他熬夜到三点才睡', extra: { target: '三水' },
    now: 2000, redact: (s) => s, key, people: people2
  });
  assert.deepEqual(Object.keys(st.memberImpressions), [OWNER_QQ], '改名片不能再开一条');
  assert.equal(st.memberImpressions[OWNER_QQ].traits.length, 2, '两条都在这一个人名下');
  assert.equal(st.memberImpressions[OWNER_QQ].interactionCount, 2);
  assert.equal(st.memoryVersion, 2, '写过一次就是 v2');
});

test('身份锚点：同一个人的不同群名片指向同一条（群里叫这个、私聊叫那个）', () => {
  const st = {};
  appendMemory(st, {
    category: 'memberImpression', content: '私聊里他说要睡了', extra: { target: '群三水' },
    now: 1, redact: (s) => s, key: 'private:10000001', people: OWNER_PEOPLE
  });
  appendMemory(st, {
    category: 'memberImpression', content: '群里他发了个表情', extra: { target: '测试用户' },
    now: 2, redact: (s) => s, key: 'group:20000001', people: OWNER_PEOPLE
  });
  assert.deepEqual(Object.keys(st.memberImpressions), [OWNER_QQ]);
  assert.equal(st.memberImpressions[OWNER_QQ].traits.length, 2);
});

test('身份锚点：认领 —— 旧的名字条目在能算出 QQ 时并过来（后门）', () => {
  const st = {
    memberImpressions: {
      群三水: {
        traits: ['旧的印象：他爱拿我的配置当谈资'],
        traitMeta: [{ firstAt: 111, lastAt: 222, hits: 3 }],
        interactionCount: 5,
        lastSeenAt: 500,
        pendingQq: true
      }
    }
  };
  appendMemory(st, {
    category: 'memberImpression', content: '新的印象：他今天夸我了', extra: { target: '群三水' },
    now: 900, redact: (s) => s, key: 'private:10000001', people: OWNER_PEOPLE
  });
  assert.deepEqual(Object.keys(st.memberImpressions), [OWNER_QQ], '旧名字 key 应被认领并删掉');
  const im = st.memberImpressions[OWNER_QQ];
  assert.equal(im.traits.length, 2, '旧印象不能丢');
  assert.equal(im.interactionCount, 6, '互动次数相加（旧的 5 + 这次 1）');
  assert.equal(im.traitMeta[0].firstAt, 111, '旧的时间也要带过来（firstAt 保留最早的）');
  assert.equal(im.pendingQq, undefined, '认领之后不该再挂 pendingQq');
});

test('身份锚点：解析不出 QQ 时**保留原名**并标 pendingQq（不丢弃、将来能认领）', () => {
  const st = {};
  appendMemory(st, {
    category: 'memberImpression', content: '他好像不太爱说话', extra: { target: '保科柊史' },
    now: 5, redact: (s) => s, key: 'group:20000001', people: OWNER_PEOPLE
  });
  assert.ok(st.memberImpressions['保科柊史'], '保留原名 key');
  assert.equal(st.memberImpressions['保科柊史'].pendingQq, true);
  assert.equal(st.memberImpressions['保科柊史'].traits.length, 1);
});

test('formatMemory：key 是 QQ 也**显示当前名片**（输出格式一个字不变）', () => {
  const st = {
    memberImpressions: {
      [OWNER_QQ]: { traits: ['他说白天有早八'], interactionCount: 72, lastSeenAt: 999, displayName: '群三水' }
    }
  };
  const out = formatMemory(st, { now: 1000, people: OWNER_PEOPLE, sessionKey: 'private:10000001' });
  assert.ok(out.includes(`- 群三水：他说白天有早八（互动 72 次）`), out);
  assert.ok(!out.includes(OWNER_QQ), '材料里不该出现 QQ 号');
  // 换个会话（名片不同）→ 显示那个群里的名字
  const out2 = formatMemory(st, { now: 1000, people: OWNER_PEOPLE, sessionKey: 'group:20000002' });
  assert.ok(out2.includes('- 测试用户：'), out2);
  // 查不到名片 → 用记录里的 displayName 兜底（仍不是数字）
  const out3 = formatMemory(st, { now: 1000, people: {}, sessionKey: 'x' });
  assert.ok(out3.includes('- 群三水：'), out3);
});

test('mergeImpressionRecords：同槽位保留最新、完全相同去重、时间对齐、计数相加', () => {
  const a = {
    traits: ['【作息】他早七上课', '他爱发图'],
    traitMeta: [{ firstAt: 100, lastAt: 100, hits: 1 }, { firstAt: 100, lastAt: 100, hits: 1 }],
    interactionCount: 3,
    lastSeenAt: 1000
  };
  const b = {
    traits: ['【作息】他改成早八上课了', '他爱发图', '他昨天送了我一张图'],
    traitMeta: [{ firstAt: 200, lastAt: 200, hits: 1 }, { firstAt: 150, lastAt: 150, hits: 2 }, { firstAt: 200, lastAt: 200, hits: 1 }],
    interactionCount: 4,
    lastSeenAt: 2000
  };
  const m = mergeImpressionRecords([a, b]);
  // 顺序：按"这条大概是什么时候的"旧→新；同时间的保持原顺序（稳定排序）。
  // 槽位的胜出者（最新那条）自然落在它自己的时间位置上。
  assert.deepEqual(m.traits, ['他爱发图', '【作息】他改成早八上课了', '他昨天送了我一张图']);
  assert.equal(m.traitMeta.length, m.traits.length, 'traitMeta 必须与 traits 一一对应');
  assert.equal(m.interactionCount, 7, '互动次数相加');
  assert.equal(m.lastSeenAt, 2000, 'lastSeenAt 取最大');
  assert.deepEqual(m.droppedTexts, ['【作息】他早七上课', '他爱发图'], '被槽位覆盖的、完全重复的都要记下来（报告里要列）');
  // 完全相同的那条并掉，但时间要合起来（firstAt 取最早、hits 累加）
  const kept = m.traits.indexOf('他爱发图');
  assert.equal(m.traitMeta[kept].firstAt, 100);
  assert.equal(m.traitMeta[kept].hits, 3);
});

test('mergeImpressionRecords：自己就对不上的记录整体丢时间（不给错位的时间）', () => {
  const bad = { traits: ['甲', '乙'], traitMeta: [{ firstAt: 1, lastAt: 1, hits: 1 }], interactionCount: 1, lastSeenAt: 10 };
  const m = mergeImpressionRecords([bad]);
  assert.deepEqual(m.traits, ['甲', '乙']);
  assert.equal(m.traitMeta.length, 2);
  for (const meta of m.traitMeta) assert.equal(meta.lastAt, 0, '没时间就是 0，不能拿别人的时间顶上');
});

test('mergeImpressionRecords：无槽位按时间排、超上限丢最旧的', () => {
  const mk = (text, lastAt) => ({ traits: [text], traitMeta: [{ firstAt: lastAt, lastAt, hits: 1 }], interactionCount: 1, lastSeenAt: lastAt });
  const m = mergeImpressionRecords([mk('晚的', 300), mk('早的', 100), mk('中的', 200)]);
  assert.deepEqual(m.traits, ['早的', '中的', '晚的'], '无槽位按时间旧→新');
  const many = Array.from({ length: 25 }, (_, i) => mk(`第${i}件`, i + 1));
  const capped = mergeImpressionRecords(many);
  assert.equal(capped.traits.length, 20, '每人上限 20 条');
  assert.equal(capped.droppedByCap, 5, '丢了几条要如实报出来');
  assert.equal(capped.traits[0], '第5件', '丢的是最旧的');
});
