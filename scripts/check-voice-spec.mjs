// 嗓音配方（<项目根>\voice-stack\preset.json）的静态体检：**这个文件是她的声音的唯一真源**，
// 写坏了不会有任何报错 —— worker 只在启动时读一次，读失败就是"她不会说话了"。
//
// 2026-11-11 重写：语音栈已从 F5-TTS 换成 GPT-SoVITS（voice-stack/serve-gsv.py），
// 配方字段变成 ref_file/pitch_semitones/speed/seed；旧的 cfg_strength/nfe_step/
// particle_gain/question_rise 和 tts/serve.py 都不再适用（tts 目录已删除）。
//   node scripts/check-voice-spec.mjs
import fs from 'node:fs';
import path from 'node:path';
import { aiqunyouPath } from './lib/paths.mjs';

const PRESET = aiqunyouPath('voice-stack/preset.json');

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { failed += 1; console.log(`  ❌ ${m}`); };

console.log('=== 嗓音配方体检（GPT-SoVITS / preset.json） ===\n');
let preset = null;
try {
  preset = JSON.parse(fs.readFileSync(PRESET, 'utf8'));
  ok(`preset.json 能解析（${fs.statSync(PRESET).size} 字节）`);
} catch (error) {
  bad(`preset.json 解析失败：${error.message} —— worker 一重启她就哑了，先修这个`);
}

if (preset) {
  const refFile = String(preset.ref_file ?? '').trim();
  if (!refFile) bad('参考音没写（ref_file）');
  else if (!fs.existsSync(refFile)) bad(`参考音不存在：${refFile}`);
  else ok(`参考音存在：${path.basename(refFile)}`);

  const speed = Number(preset.speed);
  if (!Number.isFinite(speed) || speed < 0.4 || speed > 1.6) bad(`speed = ${preset.speed}（应在 0.4~1.6）`);
  else ok(`speed = ${speed}`);

  const pitch = Number(preset.pitch_semitones);
  if (!Number.isFinite(pitch) || pitch < -12 || pitch > 12) bad(`pitch_semitones = ${preset.pitch_semitones}（应在 -12~12）`);
  else ok(`pitch_semitones = ${pitch}`);

  const seed = Number(preset.seed);
  if (!Number.isInteger(seed)) bad(`seed = ${preset.seed}（应为固定整数，保证每次同一版音色）`);
  else ok(`seed = ${seed}（固定，可复现）`);

  if (!String(preset.ref_id ?? '').trim()) bad('ref_id 为空（参考音没有稳定标识）');
  else ok(`ref_id = ${preset.ref_id}`);
}

console.log(failed ? `\n❌ ${failed} 项没过` : '\n✅ 嗓音配方全部通过');
process.exit(failed ? 1 : 0);
