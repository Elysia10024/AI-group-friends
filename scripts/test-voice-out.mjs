// 语音输出自检（GSV 时代，2026-10-20 起）：worker 在线 + GSV 服务在线 + 合成成功 + 文本预处理 + 引用拒绝。
//
// 为什么要有它：语音输出"失败就退回文字"，静默降级正是最需要守卫的形状 ——
// worker 挂了、GSV 没起来、参考音/配方坏了，她只会变回不会说话，没人会发现。
// 这条只合成、不发 QQ（群/私聊真实发送由 tmp/test-voice-tool-e2e.mjs 手工验）。
//
//   node scripts/test-voice-out.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceOutModule } from '../src/domains/voice-out.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const PRESET_PATH = '<项目根>/voice-stack/preset.json';

let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? '  PASS  ' : '  FAIL  '}${label}${detail ? `  [${detail}]` : ''}`); if (!ok) failed += 1; };

const workerUrl = String(cfg.socialV2?.voiceOut?.workerUrl || 'http://127.0.0.1:3210').replace(/\/+$/, '');

async function post(pathname, payload) {
  const res = await fetch(`${workerUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120_000),
  });
  return { res, body: await res.json().catch(() => ({})) };
}

console.log('=== 语音输出自检（GSV） ===');

// 1) worker + GSV 服务
const hres = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
const health = hres ? await hres.json().catch(() => ({})) : {};
check('worker 在线', hres?.ok === true && health.engine === 'gsv', JSON.stringify(health).slice(0, 160));
check('GSV 服务在线（9880）', health.gsv_online === true);

// 2) 配方（参考音/种子/prompt）
let preset = {};
try { preset = JSON.parse(fs.readFileSync(PRESET_PATH, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { /* 下面报 */ }
check('配方文件可读', Boolean(preset.ref_file), PRESET_PATH);
check('参考音存在', Boolean(preset.ref_file) && fs.existsSync(preset.ref_file), preset.ref_file ?? '');
check('种子固定（每次同一版音色）', Number.isInteger(preset.seed) && preset.seed >= 0, `seed=${preset.seed}`);
check('prompt 文本非空', typeof preset.prompt_text === 'string' && preset.prompt_text.length > 0);

// 3) 合成一条
const t0 = Date.now();
const syn = await post('/speak', { text: '好的，我知道啦，先这样吧。' });
const ms = Date.now() - t0;
check('合成成功', syn.res.ok && syn.body.ok === true, syn.body.reason ?? '');
if (syn.body.ok) {
  const size = fs.existsSync(syn.body.wav) ? fs.statSync(syn.body.wav).size : 0;
  check('wav 落盘', size > 10_000, `${syn.body.wav} (${size} 字节)`);
  check('时长合理（0.5–20 秒）', Number(syn.body.seconds) >= 0.5 && Number(syn.body.seconds) <= 20, `${syn.body.seconds}s`);
  check('速度合理（< 30s）', ms < 30_000, `${ms}ms`);
}

// 4) 文本预处理：英文词后的逗号变句号（给英文词制造停顿）
const en = await post('/speak', { text: '我是deepseek，爱吃白饭' });
check('英文词后自动加停顿', typeof en.body.prepared === 'string' && /deepseek。/.test(en.body.prepared), en.body.prepared ?? '');

// 5) 硬边界：带引用的语音必须被拒（域模块，不依赖 worker）
const voiceOut = createVoiceOutModule({ cfg, log: () => {}, sendChain: Promise.resolve() });
const quoted = await voiceOut.sendVoice('group:20000001', '在的', { replyToMessageId: '1' });
check('带引用的语音被拒', quoted.ok === false && /单独发/.test(quoted.error ?? ''), quoted.error ?? '（居然过了？）');
const L = voiceOut.limits;
check('群边界不比私聊松（间隔 ≥、日上限 ≤）',
  L.groupMinIntervalMs >= L.minIntervalMs && L.groupDailyCap <= L.dailyCap,
  `群 ${L.groupDailyCap} 条/${Math.round(L.groupMinIntervalMs / 60000)} 分钟 vs 私聊 ${L.dailyCap} 条/${Math.round(L.minIntervalMs / 60000)} 分钟`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
