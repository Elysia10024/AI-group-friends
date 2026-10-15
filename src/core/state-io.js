// 状态文件的读写基元：容错读 + 原子写。
// 从 bridge.js 抽出来（R5 第一刀）。
//
// 抽出来的理由：**所有状态落盘都走这三个函数**（33 个调用点）。
// 它们出错的方式是"静默毁数据"——写坏 social-v2.json 就是她的记忆没了，
// 而且是等到下次读才发现。抽出来之后可以拿临时目录把边界全跑一遍。
//
// 两个设计要点（都来自踩过的坑，别改）：
//  1. 读要容错：返回 fallback 而不是抛错，除非 required=true（启动必需配置才 fail-fast）。
//     Windows 上很多工具写 JSON 会带 UTF-8 BOM，`JSON.parse` 遇到 BOM 直接抛 —— 必须剥掉。
//  2. 写要原子：先写**唯一名**临时文件再 rename。
//     用固定临时名（如 `x.json.tmp`）会被并发写互相踩，也可能被符号链接攻击利用。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 读取 JSON 文件并容错。
 * @param {string} file
 * @param {*} fallback 文件缺失 / 解析失败时返回它
 * @param {boolean} [required] true = 缺失或解析失败直接抛错（用于启动必需配置，fail-fast）
 * @returns {*} 解析结果，或 fallback
 */
export function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/** 生成同目录下的唯一临时文件名（含 pid + 随机串，避免并发写互相踩）。 */
function uniqueTmp(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

/**
 * 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，
 * 也避免固定临时名被并发/符号链接攻击利用。
 * 内容格式：2 空格缩进 + 末尾换行；权限 0600。
 */
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTmp(file);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 原子写文本文件。权限 0600。 */
export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = uniqueTmp(file);
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 往日志文件追加一整行（调用方负责带上结尾 \n），并把文件裁到最近 cap 「行」。
 *
 * 抽出来的理由：三处日志（QQ 活动 500 行 / 桥日志 2000 行 / 工具调用 2000 行）
 * 原本各写一份同样的「追加 → 读回 → split → 超了就用 slice(-cap).join 重写」。
 *
 * 一个必须显式传的差异：重写时**是否补结尾换行**。桥日志与活动日志不补，
 * 工具调用日志补 —— 这是原实现的行为，别"顺手统一"。
 * 另外 `> cap` 判的是 `split('\n')` 之后的元素个数（末尾那个空串也算一项），
 * 也照原样保留，不要改成"真正的行数"。
 *
 * @param {string} file
 * @param {string} line 已格式化好、含结尾换行的一行
 * @param {{cap?: number, trailingNewline?: boolean}} [opts]
 * @returns {boolean} 是否发生了截断重写
 */
export function appendCappedLine(file, line, opts = {}) {
  const cap = Number(opts.cap) || 500;
  const trailingNewline = opts.trailingNewline === true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line, 'utf8');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines.length > cap) {
    fs.writeFileSync(file, lines.slice(-cap).join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
    return true;
  }
  return false;
}
