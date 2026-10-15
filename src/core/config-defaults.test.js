// 配置加载的不变量：**旧 config.json 缺新的默认键时，不能丢默认值**。
//
// 这是从真实事故里抠出来的：以前 socialV2.tools / socialV2.sticker 靠"在加载函数末尾再手写
// 一遍完整默认值"兜底，而 socialV2.wake / send / wait / proactive 这些段落**没兜**——
// config.json 里只要写了 `socialV2.wake.sleepMinMs`，整个 wake 段的默认值就全变 undefined。
// 现在统一走 deepMerge，这份测试把语义钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigModule } from '../config.js';
import { createIdsModule } from '../ids.js';
import { DENSITY_DEFAULTS } from './msg-density.js';
import { readJsonSafe } from './state-io.js';

const ids = createIdsModule({});
const loadWith = (raw) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbridge-cfg-'));
  fs.writeFileSync(path.join(root, 'config.json'), raw, 'utf8');
  return createConfigModule({
    ROOT: root, path, readJsonSafe,
    normalizeIdList: ids.normalizeIdList, normalizeOwnerQQ: ids.normalizeOwnerQQ
  }).loadConfig();
};

test('老配置只写 wake 的一个子键：同段其他默认值必须还在', () => {
  const cfg = loadWith(JSON.stringify({ socialV2: { wake: { sleepMinMs: 1 } } }));
  assert.equal(cfg.socialV2.wake.sleepMinMs, 1);
  assert.equal(cfg.socialV2.wake.preSleepWaitMs, 120000);
  assert.equal(cfg.socialV2.wake.preSleepWaitEnabled, true);
  assert.equal(cfg.socialV2.wake.defaultMode, 'diving');
  assert.ok(cfg.socialV2.wake.recommendedKeywords.length > 5);
});

test('嵌套两层的 collect：改一个子键不丢其他默认值', () => {
  const cfg = loadWith(JSON.stringify({ socialV2: { sticker: { collect: { maxPerHour: 3 } } } }));
  assert.equal(cfg.socialV2.sticker.collect.maxPerHour, 3);
  assert.equal(cfg.socialV2.sticker.collect.maxPerMinute, 2);
  assert.equal(cfg.socialV2.sticker.collect.enabled, true);
  assert.equal(cfg.socialV2.sticker.syncTtlMs, 60000);
});

test('工具开关：默认齐全，config 里关掉的那个生效、没提的保持默认', () => {
  const cfg = loadWith(JSON.stringify({ socialV2: { tools: { sendPoke: false } } }));
  assert.equal(cfg.socialV2.tools.sendPoke, false);
  assert.equal(cfg.socialV2.tools.slangQuery, true);
  assert.equal(cfg.socialV2.tools.setStickerRemark, false);   // 默认就是关的，别被"存在即 true"的逻辑带跑
  // 26 → 27：2026-10-06 加 sendVoice（语音输出）。加开关就要在这里同步数字，否则这条会红。
  // 27 → 30：2026-10-12 加 postMood / deleteMood / listMoods（QQ 空间说说）。
  // 30 → 32：2026-10-12 加 moodComments / qzoneFeeds（读评论、好友动态，都只读）。
  // 32 → 33：2026-10-13 加 commentMood（回她自己说说下的评论）。
  assert.equal(Object.keys(cfg.socialV2.tools).length, 33);   // 2026-09 起 markRead 不再需要开关（桥侧接管标已读）
});

test('聊天密度（densityWake）：默认值来自 core/msg-density.js，且只写了一个子键时不丢其它键', () => {
  // 这条钉两件事：① 默认值的唯一来源是 core（config.js 只是引用，不许抄字面量）；
  // ② config.json 里只写了 dailyCap 时，同段其它键仍然有效（deepMerge 的老坑）。
  const cfg = loadWith('{}');
  assert.equal(cfg.socialV2.densityWake.enabled, DENSITY_DEFAULTS.enabled);
  assert.equal(cfg.socialV2.densityWake.windowMs, DENSITY_DEFAULTS.windowMs);
  assert.equal(cfg.socialV2.densityWake.minMessages, DENSITY_DEFAULTS.minMessages);
  assert.equal(cfg.socialV2.densityWake.cooldownMs, DENSITY_DEFAULTS.cooldownMs);
  assert.equal(cfg.socialV2.densityWake.dailyCap, DENSITY_DEFAULTS.dailyCap);
  assert.equal(cfg.socialV2.densityWake.probability, DENSITY_DEFAULTS.probability);
  const one = loadWith(JSON.stringify({ socialV2: { densityWake: { dailyCap: 1 } } }));
  assert.equal(one.socialV2.densityWake.dailyCap, 1);
  assert.equal(one.socialV2.densityWake.minMessages, DENSITY_DEFAULTS.minMessages);
  assert.equal(one.socialV2.densityWake.enabled, true);
});

test('说说（qzone）默认值：默认开、一天 2 条、两次隔 2 小时、所有人可见、可配图、评论监听开着', () => {
  const cfg = loadWith('{}');
  assert.equal(cfg.socialV2.qzone.enabled, true);
  assert.equal(cfg.socialV2.qzone.dailyCap, 2);
  assert.equal(cfg.socialV2.qzone.minGapMs, 2 * 3600 * 1000);
  assert.equal(cfg.socialV2.qzone.ugcRight, 1);   // 2026-10-13 起默认所有人可见
  assert.equal(cfg.socialV2.qzone.maxChars, 300);
  assert.equal(cfg.socialV2.qzone.promptHint, true);
  assert.equal(cfg.socialV2.qzone.imageEnabled, true);
  // 评论监听（2026-10-13）：有新评论就叫醒她一次；回评论的边界同段可调
  assert.equal(cfg.socialV2.qzone.commentWake, true);
  assert.equal(cfg.socialV2.qzone.commentCheckMs, 10 * 60 * 1000);
  assert.equal(cfg.socialV2.qzone.commentMaxChars, 120);
  assert.equal(cfg.socialV2.qzone.commentReplyCap, 2);
  assert.equal(cfg.socialV2.qzone.commentReplyWindowMs, 30 * 60 * 1000);
  // config 里只写一个键时，同段其它键不能被冲掉（deepMerge 的老坑）
  const one = loadWith(JSON.stringify({ socialV2: { qzone: { dailyCap: 5 } } }));
  assert.equal(one.socialV2.qzone.dailyCap, 5);
  assert.equal(one.socialV2.qzone.minGapMs, 2 * 3600 * 1000);
  assert.equal(one.socialV2.qzone.ugcRight, 1);
  assert.equal(one.socialV2.qzone.imageEnabled, true);
});

test('null 段落视为"没配"：不能变成 null（否则调用处 includes/length 直接炸）', () => {
  const cfg = loadWith(JSON.stringify({ social: { mustReplyKeywords: null }, socialV2: { tools: null } }));
  assert.ok(Array.isArray(cfg.social.mustReplyKeywords));
  assert.equal(cfg.socialV2.tools.sendGroup, true);
});

test('空配置：所有段落都有默认值', () => {
  const cfg = loadWith('{}');
  assert.equal(cfg.dsh.baseUrl, 'http://127.0.0.1:3080');
  assert.equal(cfg.consolePort, 3100);
  assert.equal(cfg.social.enabled, true);
  assert.equal(cfg.socialV2.send.maxMessageChars, 500);
  assert.deepEqual(cfg.allow, { private: [], groups: [] });
  assert.deepEqual(cfg.deny, { private: [], groups: [] });
  assert.equal(cfg.allowAllWhenEmpty, false);
});

test('白名单老字段名（group/privates）仍然认，且严格取布尔', () => {
  const cfg = loadWith(JSON.stringify({
    ownerQQ: '123456', allowAllWhenEmpty: 1,
    allow: { group: [1, '2', 'x'] }, deny: { privates: ['7'] }
  }));
  assert.equal(cfg.ownerQQ, 123456);                // 规范化成数字
  assert.deepEqual(cfg.allow.groups, ['1', '2']);   // 非法项 'x' 被丢
  assert.equal(cfg.allowAllWhenEmpty, false);       // 严格 `=== true`：写 1 不算开（原语义，别顺手放宽）
  assert.deepEqual(cfg.deny.private, ['7']);
});

test('ownerQQ 填非数字要当场抛（不是静默当没配）', () => {
  assert.throws(() => loadWith(JSON.stringify({ ownerQQ: 'abc' })), /ownerQQ/);
});

test('配置格式错误要抛（不是静默用默认值跑）', () => {
  assert.throws(() => loadWith('[]'), /配置格式错误/);
  assert.throws(() => loadWith('null'), /配置格式错误/);
});
