// 语音转写域：把 QQ 的 `record` 段（SILK）变成文字，交给提示词。
//
// 为什么这么做（2026-10-05）：
//   · 她以前只看到 `[语音]` 三个字，完全不知道对方说了什么；
//   · QQ 自带的转写（SnowLuma 的 `fetch_ptt_text`）实测被腾讯拒：`ptt translate errCode=9`，
//     两条不同语音都一样 —— 靠不住，所以走本地；
//   · 本地 SenseVoice-Small（int8，228 MB）在这台机器上 ~1.9 秒/条，**边际成本 0**，
//     语音也不出本机。工具在 `<root>/asr/`（transcribe.py + venv + models）。
//
// 设计要点：
//   1. **绝不阻塞消息**：任何失败（模型缺失、超时、解码失败）都退回 `[语音]` 并记一行日志；
//   2. **按文件名缓存**：同一条语音会被引用多次（引用原文、材料、提示词），只转一次；
//   3. 只处理 record 段，不动图片链路（图片是内容块，语音只能变成文字）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { safeFetchBinary } from '../safe-fetch.js';
import { voiceFailureNote } from '../core/voice-label.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_ROOT = path.resolve(HERE, '..', '..');

const DEFAULT_SCRIPT = path.join(BRIDGE_ROOT, '..', 'asr', 'transcribe.py');
const DEFAULT_PYTHON = path.join(BRIDGE_ROOT, '..', 'asr', 'venv', 'Scripts', 'python.exe');
const MAX_SILK_BYTES = 2 * 1024 * 1024;   // QQ 语音上限约 60 秒 ≈ 100 KB，2 MB 已经很宽松
const CACHE_MAX = 300;
const FAILURE_TTL_MS = 10 * 60 * 1000;    // 失败结果只缓存 10 分钟，模型修好了不用重启桥

export function createVoiceModule(ctx) {
  const { cfg, log } = ctx;
  const options = cfg.voice ?? {};
  const enabled = options.enabled !== false && process.env.QQ_BRIDGE_ASR !== 'off';
  const script = String(options.scriptPath || process.env.QQ_BRIDGE_ASR_SCRIPT || DEFAULT_SCRIPT);
  const python = String(options.pythonPath || process.env.QQ_BRIDGE_ASR_PYTHON || DEFAULT_PYTHON);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;
  const cache = new Map();                // file -> { text, at, ok }
  const tmpRoot = path.join(os.tmpdir(), 'qq-bridge-voice');
  let warnedPath = false;

  function toolReady() {
    if (enabled && fs.existsSync(script) && fs.existsSync(python)) return true;
    if (enabled && !warnedPath) {
      warnedPath = true;
      log(`语音转写未启用：找不到 ${script} 或 ${python}（QQ_BRIDGE_ASR=off 可显式关闭）`);
    }
    return false;
  }

  function runTranscriber(file) {
    return new Promise((resolve) => {
      const child = spawn(python, [script, file, '--json'], { windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已经退出 */ }
        resolve({ ok: false, reason: `超时 ${timeoutMs}ms` });
      }, timeoutMs);
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, reason: error.message }); });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(out.trim().split('\n').pop() ?? '');
          if (parsed?.ok) return resolve({ ok: true, text: String(parsed.text ?? ''), ms: parsed.ms });
          return resolve({ ok: false, reason: String(parsed?.reason ?? '未知错误') });
        } catch {
          return resolve({ ok: false, reason: `无法解析转写输出（stderr: ${err.trim().slice(0, 120)}）` });
        }
      });
    });
  }

  /** 从 OneBot 取音频（get_record 给的是下载链接）→ 落到临时文件 → 本地转写。 */
  async function transcribeRecord(file) {
    if (!toolReady()) return { ok: false, reason: '转写工具不可用' };
    let url = '';
    try {
      // 不传 out_format：网关会直接回原始语音的下载地址（传 amr 会触发转码，而它的 ffmpeg
      // 没有 AMR 编码器 → "Encoder not found"；传 silk 会被参数校验拒）。原始文件就是 SILK，
      // pilk 直接能解，不需要网关转码。
      const info = await ctx.bot.getRecord({ file: String(file) });
      url = String(info?.file || info?.url || '');
    } catch (error) {
      return { ok: false, reason: `get_record 失败：${error?.message ?? error}` };
    }
    if (!url) return { ok: false, reason: 'get_record 没返回下载地址' };

    let buffer;
    try {
      // 用 safeFetchBinary（不校验"是不是图片"）：SSRF 校验保留，语音不被图片白名单挡掉。
      const fetched = await safeFetchBinary(url, MAX_SILK_BYTES, { requireImage: false });
      buffer = fetched.buffer;
    } catch (error) {
      return { ok: false, reason: `下载语音失败：${error?.message ?? error}` };
    }
    if (!buffer || buffer.length === 0) return { ok: false, reason: '语音是空的' };
    if (buffer.length > MAX_SILK_BYTES) return { ok: false, reason: `语音文件过大（${buffer.length} 字节）` };

    fs.mkdirSync(tmpRoot, { recursive: true });
    const safeName = String(file).replace(/[^\w.-]/g, '_').slice(-60) || 'voice';
    const local = path.join(tmpRoot, `${Date.now()}-${process.pid}-${safeName}`);
    try {
      fs.writeFileSync(local, buffer);
      const result = await runTranscriber(local);
      return result;
    } finally {
      // 转写产物（.pcm/.16k.wav）和输入都在这个临时目录里，转完就删，不留垃圾
      for (const suffix of ['', '.pcm', '.16k.wav']) {
        try { fs.rmSync(local + suffix, { force: true }); } catch { /* 删不掉不影响结果 */ }
      }
    }
  }

  /**
   * 给 segmentsToText 用的解析器：record 段 → 文字（失败返回 null，调用方退回 `[语音]`）。
   * 同一条语音只转一次；失败也记一小会儿，避免一条坏语音反复起进程。
   */
  async function resolveRecord(file) {
    const key = String(file ?? '');
    if (!key) return null;
    const hit = cache.get(key);
    if (hit) {
      if (hit.ok) return hit.text;
      if (Date.now() - hit.at < FAILURE_TTL_MS) return null;
      cache.delete(key);
    }
    const result = await transcribeRecord(key);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    if (result.ok) {
      cache.set(key, { ok: true, text: result.text, at: Date.now() });
      log(`语音转写：${key.slice(0, 12)}… → 「${result.text.slice(0, 40)}」（${result.ms}ms）`);
      return result.text;
    }
    cache.set(key, { ok: false, text: '', at: Date.now() });
    log(voiceFailureNote(`${key.slice(0, 12)}… ${result.reason}`));
    return null;
  }

  return { resolveRecord, transcribeRecord, enabled, toolReady, _cache: cache };
}
