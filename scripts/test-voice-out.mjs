// 语音输出自检（本地、不花 QQ 消息）：worker 在不在 + 能不能合成一条像样的音频。
//
// 为什么要有它：语音输出"失败就退回文字"，静默降级正是最需要守卫的形状 ——
// worker 挂了、模型丢了、显存爆了，她只会变回不会说话，没人会发现。
// 这条只合成、不发 QQ；真正的发送路径由 tmp/test-voice-out.mjs 手工验（会真发消息）。
//
//   node scripts/test-voice-out.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoiceOutModule } from '../src/domains/voice-out.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));

let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? '  PASS  ' : '  FAIL  '}${label}${detail ? `  [${detail}]` : ''}`); if (!ok) failed += 1; };

const voiceOut = createVoiceOutModule({ cfg, log: () => {}, sendChain: Promise.resolve() });

console.log('=== 语音输出自检 ===');
const health = await voiceOut.health();
check('TTS worker 在线', health.ok === true, JSON.stringify(health).slice(0, 160));
check('模型已加载', health.model_loaded === true, `device=${health.device} load=${health.load_ms}ms`);

const t0 = Date.now();
const syn = await voiceOut.synthesize('好的，我知道啦，先这样吧。');
const ms = Date.now() - t0;
check('合成成功', syn.ok === true, syn.error ?? '');
if (syn.ok) {
  const exists = fs.existsSync(syn.wav);
  const size = exists ? fs.statSync(syn.wav).size : 0;
  check('wav 落盘', exists && size > 10_000, `${syn.wav} (${size} 字节)`);
  check('时长合理（1–8 秒）', syn.seconds >= 1 && syn.seconds <= 8, `${syn.seconds}s`);
  check('速度合理（< 20s）', ms < 20_000, `${ms}ms`);
  check('句尾轻声已生效', syn.tail && syn.tail.particle_gain < 1, JSON.stringify(syn.tail));
}
const q = await voiceOut.synthesize('喂，在忙吗？');
check('问句上扬已生效', q.ok === true && q.tail && q.tail.glide_semitones > 0, JSON.stringify(q.tail ?? q.error));
// 句尾语气词一律轻声：含疑问句的「吗/呢」（2026-10-06 主人明确要求）。
// 这一句同时要满足两件事：上方上扬（问句）+ 尾段轻声（语气词）—— 两者叠加，不是二选一。
check('疑问句尾的「吗」也轻声（与上扬叠加）',
  q.ok === true && q.tail && q.tail.particle_gain < 1 && q.tail.glide_semitones > 0,
  JSON.stringify(q.tail ?? q.error));
const la = await voiceOut.synthesize('我知道啦');
check('陈述句尾的「啦」轻声', la.ok === true && la.tail && la.tail.particle_gain < 1, JSON.stringify(la.tail ?? la.error));

// 群聊（2026-10-06 主人开）：群里一条语音是**一群人**在听，边界必须比私聊紧，不能反过来。
const L = voiceOut.limits;
check('群聊边界不比私聊松（间隔 ≥、日上限 ≤）',
  L.groupMinIntervalMs >= L.minIntervalMs && L.groupDailyCap <= L.dailyCap,
  `群 ${L.groupDailyCap} 条/${Math.round(L.groupMinIntervalMs / 60000)} 分钟 vs 私聊 ${L.dailyCap} 条/${Math.round(L.minIntervalMs / 60000)} 分钟`);

// 带引用的语音必须被拒，而且要在合成之前就拒 —— QQ 播不出"引用 + 语音"，拼上去那条语音谁都听不见
// （2026-10-06 事故）。这里**不能**发一条不带引用的群语音来"验证能发"，那会真往群里丢语音。
const t1 = Date.now();
const quoted = await voiceOut.sendVoice('group:20000001', '在的', { replyToMessageId: '1' });
const quotedMs = Date.now() - t1;
check('带引用的语音被拒', quoted.ok === false && /单独发/.test(quoted.error ?? ''), quoted.error ?? '（居然过了？）');
check('拒在合成之前（没白烧 GPU）', quotedMs < 1000, `${quotedMs}ms`);

// 种子（2026-10-06 第十六轮）：F5-TTS 默认每次自抽随机种子 → 同一句话每次都是新的一版"发挥"，
// 语气/节奏/音色都会漂（主人当时的原话："音色不对，怎么不是之前我们商量好的那种"）。
// 所以：固定种子 → 必须可复现；还没固定 → 每次至少要知道用的是哪个种子（好回查是哪一版）。
const specPath = '<项目目录>/tts/her-voice.json';
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));
if (spec.seed != null) {
  const a = await voiceOut.synthesize('这是可复现性检查');
  const b = await voiceOut.synthesize('这是可复现性检查');
  const same = a.ok && b.ok && fs.readFileSync(a.wav).equals(fs.readFileSync(b.wav));
  check('固定种子后输出可复现（同一句话 → 同一段音频）', same, `seed=${spec.seed}`);
} else {
  check('随机种子会回报 seed（便于回查是哪一版）', typeof syn.seed === 'number' && syn.seed > 0, `seed=${syn.seed}`);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
