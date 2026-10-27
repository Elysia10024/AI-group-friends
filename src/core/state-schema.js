// 状态文件的版本戳与读侧闸门（2026-10-27 重构第 1 期，审计 P-02）。
//
// 问题：最贵的几个状态文件没有版本号，而 readJsonSafe 对「文件存在但解析失败」
// 静默返回 fallback —— 旧结构/坏文件被当成空状态继续跑，下一轮 save 覆盖原文件：
// 记忆不是「报错丢的」，是「安静地变没的」。
//
// 读侧三道闸（readStateFile）：
//   1. 文件不存在            → 返回 fallback（首启/合法空）；
//   2. 存在但解析失败        → 抛错（fail fast：宁可启动失败，也不静默清空）；
//   3. 解析成功但版本不符    → 比本代码新：抛错（旧进程不许覆盖新结构）；
//                              比本代码旧：走 MIGRATIONS；没登记迁移函数：抛错。
// 写侧：stamp() 统一补当前版本号。
//
// slang.json 例外：顶层是数组（4887 条），加版本号要改形状、且仓库外还有临时脚本
// 直接读它；条目形状漂移已由 normalizeSlangEntry 逐条归一兜住。所以 slang 只上
// 「存在但解析失败就抛」这道闸（见 slang-learner.js loadSlang），不改形状。
import fs from 'node:fs';

export const STATE_SCHEMA_VERSION = Object.freeze({
  'social-v2': 1,
  'context-shadow': 1,
});

// 版本号 → (data) => 迁移后的 data。将来抬版本号时在这里登记旧版本的迁移函数；
// 不登记 = 启动直接抛错，比静默当空状态诚实。
const MIGRATIONS = Object.freeze({
  'social-v2': Object.freeze({}),
  'context-shadow': Object.freeze({}),
});

/** 读状态文件：缺失返回 fallback；坏文件/版本不符抛错。 */
export function readStateFile(name, file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
  let data;
  try {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`状态文件 ${name} 存在但解析不了（${file}）：${error?.message ?? error}。拒绝按空状态处理——那会在下次保存时清空原文件。`);
  }
  return assertVersion(name, data);
}

/** 校验/迁移版本号。未登记版本表的 name 原样返回。 */
export function assertVersion(name, data) {
  const current = STATE_SCHEMA_VERSION[name];
  if (current === undefined) return data;
  const v = Number(data?.schemaVersion ?? 1);
  if (v === current) return data;
  if (v > current) {
    throw new Error(`状态文件 ${name} 的 schemaVersion=${v} 新于本代码的 ${current}：可能把桥接回滚到了旧版本。拒绝读取，避免旧逻辑覆盖新结构。`);
  }
  let migrated = data;
  for (let from = v; from < current; from++) {
    const fn = MIGRATIONS[name]?.[from];
    if (typeof fn !== 'function') {
      throw new Error(`状态文件 ${name} 的 schemaVersion=${from}，需要迁移到 ${from + 1}，但没登记迁移函数（在 core/state-schema.js 的 MIGRATIONS 里补）。`);
    }
    migrated = fn(migrated);
  }
  return migrated;
}

/** 写侧补版本号。数组/非对象原样返回（slang 那种顶层数组不盖章）。 */
export function stamp(name, data) {
  const current = STATE_SCHEMA_VERSION[name];
  if (current === undefined) return data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;
  return { ...data, schemaVersion: current };
}
