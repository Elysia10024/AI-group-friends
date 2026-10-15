// 语音转写的端到端自检：拿一段真语音（SILK，7KB）跑本地工具，断言真的认出来了。
//
// 为什么要有它：语音转写是"失败就静默退回 [语音]"的设计 —— 那正是最需要守卫的形状
// （模型丢了、venv 坏了、pilk 升级挂掉，她只会变回聋子，谁也不会发现）。
// 这条在本机跑，2 秒，不花钱、不联网。
//
//   node scripts/test-voice-transcribe.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ASR = path.resolve(ROOT, '..', 'asr');
const PYTHON = process.env.QQ_BRIDGE_ASR_PYTHON || path.join(ASR, 'venv', 'Scripts', 'python.exe');
const SCRIPT = process.env.QQ_BRIDGE_ASR_SCRIPT || path.join(ASR, 'transcribe.py');
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'voice-sample.silk');
const MODEL = path.join(ASR, 'models', 'model.int8.onnx');

let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? '  PASS  ' : '  FAIL  '}${label}${detail ? `  [${detail}]` : ''}`); if (!ok) failed += 1; };

console.log('=== 语音转写自检 ===');
check('转写脚本存在', fs.existsSync(SCRIPT), SCRIPT);
check('venv 里的 python 存在', fs.existsSync(PYTHON), PYTHON);
check('SenseVoice 模型存在', fs.existsSync(MODEL), MODEL);
check('测试语音存在', fs.existsSync(FIXTURE), `${FIXTURE} (${fs.existsSync(FIXTURE) ? fs.statSync(FIXTURE).size : 0} 字节)`);
if (failed) {
  console.error('\n❌ 工具不全，她现在是聋的（语音只会显示 [语音]）。');
  process.exit(1);
}

const t0 = Date.now();
const run = spawnSync(PYTHON, [SCRIPT, FIXTURE, '--json'], { encoding: 'utf8', timeout: 60_000 });
const ms = Date.now() - t0;
let parsed = null;
try { parsed = JSON.parse(String(run.stdout).trim().split('\n').pop() ?? ''); } catch { /* 下面报 */ }

console.log(`  运行：${ms}ms，退出码 ${run.status}`);
check('返回了可解析的 JSON', parsed !== null, String(run.stdout).slice(0, 120) || String(run.stderr).slice(0, 120));
check('转写成功', parsed?.ok === true, parsed?.reason ?? '');
// 固定语音的内容是「我要给你装上耳朵。」—— 只断言关键词，模型小版本升级导致的标点/个别字差异不算红
check('认出了内容（含“耳朵”）', /耳朵/.test(parsed?.text ?? ''), JSON.stringify(parsed?.text ?? ''));
check('速度可接受（< 15s）', ms < 15_000, `${ms}ms`);
check('时长约 2.6 秒', Math.abs((parsed?.seconds ?? 0) - 2.6) < 0.5, `${parsed?.seconds}s`);

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
