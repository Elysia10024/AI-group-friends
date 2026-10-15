// 控制台保存配置时的类型规整：口径由"默认值的类型"决定，不再手抄键名。
//
// 这些 case 覆盖两类风险：
//   1. 类型口径错（该取整的没取整、该夹的没夹、概率被取整成 0/1）→ 存进 config.json 的值是脏的；
//   2. 规整表漏了键 → 新配置键被静默丢掉（所以"默认值里没有的键"必须原样带过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeByDefaults } from './config-normalize.js';
import { CONFIG_DEFAULTS, CONFIG_RANGES, CONFIG_ENUMS } from '../config.js';

const DEF = CONFIG_DEFAULTS.socialV2;
const norm = (current, patch) => normalizeByDefaults(DEF, current, patch, {
  prefix: 'socialV2', ranges: CONFIG_RANGES, enums: CONFIG_ENUMS, keepCurrentOnNonBool: ['socialV2.tools']
});

test('整数：四舍五入 + 非负；字符串数字也认', () => {
  const out = norm({}, { send: { maxMessageChars: '499.6' }, wake: { maxWakePerMinute: -5 } });
  assert.equal(out.send.maxMessageChars, 500);
  assert.equal(out.wake.maxWakePerMinute, 0);
});

test('整数：范围夹取（表里声明过的键）', () => {
  const out = norm({}, {
    autoReplyCheckMs: 1,
    feedback: { maxLength: 0 },
    context: { recentLimit: 0, unreadLimit: 2, contextWindow: 999 },
    sticker: { maxListCount: 9999, promptMaxStickers: 0 }
  });
  assert.equal(out.autoReplyCheckMs, 1000);          // [1000, ∞)
  assert.equal(out.feedback.maxLength, 1);           // [1, ∞)
  assert.equal(out.context.recentLimit, 1);
  assert.equal(out.context.unreadLimit, 2);
  assert.equal(out.context.contextWindow, 999);      // 只夹下限
  assert.equal(out.sticker.maxListCount, 500);       // [1, 500]
  assert.equal(out.sticker.promptMaxStickers, 1);    // [1, 30]
});

test('概率（小数默认值）：不取整，夹 0..1；非有限数回落到当前值', () => {
  const out = norm({ proactive: { probability: 0.15 } }, {
    wake: { recommendedProbability: 0.05 }, proactive: { probability: 'abc' }, send: { longGapProbability: 5 }
  });
  assert.equal(out.wake.recommendedProbability, 0.05);   // 没被 Math.round 成 0
  assert.equal(out.proactive.probability, 0.15);         // 脏值不清掉用户设的概率
  assert.equal(out.send.longGapProbability, 1);
});

test('布尔：严格取布尔（不把 "yes" 当开）', () => {
  const out = norm({}, { enabled: 'yes', provideRecommendations: 1, wake: { preSleepWaitEnabled: 'true' }, feedback: { notifyOwnerOnError: 'no' } });
  assert.equal(out.enabled, false);
  assert.equal(out.provideRecommendations, false);
  assert.equal(out.wake.preSleepWaitEnabled, false);
  assert.equal(out.feedback.notifyOwnerOnError, false);
  assert.equal(norm({}, { enabled: true }).enabled, true);
});

test('工具开关：传了非布尔保留当前值（旧口径，别改成严格布尔）', () => {
  assert.equal(norm({ tools: { sendPoke: false } }, { tools: { sendPoke: 'x' } }).tools.sendPoke, false);
  assert.equal(norm({ tools: {} }, { tools: { sendPoke: 'x' } }).tools.sendPoke, true);
  assert.equal(norm({ tools: { sendPoke: false } }, { tools: { sendPoke: true } }).tools.sendPoke, true);
});

test('数组：逗号/中文逗号/空白拆分；元素转字符串并去空', () => {
  assert.deepEqual(norm({}, { wake: { recommendedKeywords: '小鲸鱼,大肥鱼  DS' } }).wake.recommendedKeywords, ['小鲸鱼', '大肥鱼', 'DS']);
  assert.deepEqual(norm({}, { wake: { recommendedKeywords: ['a', '', 'b'] } }).wake.recommendedKeywords, ['a', 'b']);
});

test('字符串：默认空串；枚举只保留允许值，其余回落默认值', () => {
  assert.equal(norm({}, { wake: { recommendedHint: null } }).wake.recommendedHint, '');
  assert.equal(norm({}, { wake: { defaultMode: 'active' } }).wake.defaultMode, 'active');
  assert.equal(norm({}, { wake: { defaultMode: 'zzz' } }).wake.defaultMode, 'diving');
});

test('数值枚举：也只能取允许值里的那几个（2026-10-12 补的口径缺口）', () => {
  // qzone.ugcRight 默认 4，允许 1/4/64：区间夹取表达不了"只能这三个"，所以走枚举分支
  assert.equal(norm({}, { qzone: { ugcRight: 64 } }).qzone.ugcRight, 64);
  assert.equal(norm({}, { qzone: { ugcRight: '1' } }).qzone.ugcRight, 1);      // 面板传来字符串也认
  assert.equal(norm({}, { qzone: { ugcRight: 7 } }).qzone.ugcRight, 1);        // 不在允许列表 → 回落默认值
  assert.equal(norm({}, { qzone: { ugcRight: 999 } }).qzone.ugcRight, 1);
  // 非法/缺失时保留当前值（别把用户已经设好的权限清成默认）
  assert.equal(norm({ qzone: { ugcRight: 64 } }, { qzone: { ugcRight: 'abc' } }).qzone.ugcRight, 64);
  assert.equal(norm({}, { qzone: { ugcRight: null } }).qzone.ugcRight, 1);
  // 同一个段里其它数值键照旧走整数分支
  assert.equal(norm({}, { qzone: { dailyCap: 9.6, maxChars: 0 } }).qzone.dailyCap, 10);
  assert.equal(norm({}, { qzone: { maxChars: 0 } }).qzone.maxChars, 1);
});

test('段落传非对象：保留当前值（当前值没有则空对象），不会把整段清掉', () => {
  const out = norm({ wake: { sleepMinMs: 60000 }, tools: { memory: false } }, { wake: null, tools: [], send: 'x' });
  assert.deepEqual(out.wake, { sleepMinMs: 60000 });
  assert.deepEqual(out.tools, { memory: false });
  assert.deepEqual(out.send, {});
});

test('嵌套两层（sticker.collect）按默认值类型逐层规整', () => {
  const out = norm({}, { sticker: { collect: { maxPerHour: 10.4, enabled: 'yes', maxRemarkChars: 30 } } });
  assert.equal(out.sticker.collect.maxPerHour, 10);
  assert.equal(out.sticker.collect.enabled, false);
  assert.equal(out.sticker.collect.maxRemarkChars, 30);
});

test('只动送来的键：没提到的键保持原值（看门狗的字段不能被顺手改）', () => {
  const out = norm({ wake: { sleepMinMs: 60000, defaultMode: 'active' } }, { send: { maxMessageChars: 100 } });
  assert.equal(out.wake.sleepMinMs, 60000);
  assert.equal(out.wake.defaultMode, 'active');   // 旧实现会在这里强行写回 'diving'（已作为有意差异记录）
  assert.equal(out.send.maxMessageChars, 100);
});

test('默认值里没有的键：原样带过（新配置键不会因为规整表没更新就被丢掉）', () => {
  const out = norm({}, { 未来的开关: true, wake: { 未来的键: 'x' } });
  assert.equal(out.未来的开关, true);
  assert.equal(out.wake.未来的键, 'x');
});

test('不修改入参（纯函数）', () => {
  const current = { wake: { sleepMinMs: 1 } };
  const patch = { wake: { sleepMinMs: 2 } };
  norm(current, patch);
  assert.deepEqual(current, { wake: { sleepMinMs: 1 } });
  assert.deepEqual(patch, { wake: { sleepMinMs: 2 } });
});
