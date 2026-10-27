// 脚本层路径锚（第 6 期 6b，2026-10-28）。
//
// 为什么要有它：scripts/ 里曾有 49 处写死 `<项目根>/...`（32 个文件）——
// 换磁盘、改目录名、甚至只是把仓库挪个位置，整条 `npm run selfcheck` 全红；
// 而"跑一下 selfcheck 看看"一直是这项目的标准建议，于是这条建议变得不可移植。
//
// 口径：
//   PROJECT_ROOT   = qq-bridge-main（本文件在 scripts/lib/ 下，往上两级）
//   AIQUNYOU_ROOT  = 它的父目录（dsh-home-legacy / autostart / tts / image / voice-stack 等都在这层）
// 用 import.meta.dirname 定位，**与 cwd 无关**（npm script、watchdog、双击运行都一样）。
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const AIQUNYOU_ROOT = path.resolve(PROJECT_ROOT, '..');

export function projectPath(...parts) {
  return path.join(PROJECT_ROOT, ...parts);
}
export function aiqunyouPath(...parts) {
  return path.join(AIQUNYOU_ROOT, ...parts);
}
