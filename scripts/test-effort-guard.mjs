// 验证"推理档位守卫"真的抓得住它要抓的东西（不是又一个没测过的守卫）。
//
// 做法：在**临时沙箱目录**里复制一份最小仓库（src + 两个配置 + 守卫脚本），
// 在那里把两处改回出问题的样子 → 守卫必须变红；恢复 → 必须变绿。
// 全程不碰真实仓库，所以这条测试可以安全地进每日体检。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAND = fs.mkdtempSync(path.join(os.tmpdir(), 'effort-guard-'));

// 最小可运行子集：守卫只 import 了 src/config.js，config.js 只 import 了 core/deep-merge.js
// 和 core/msg-density.js（densityWake 的默认值从那边取，见 config.js 顶部）。
// ⚠️ 这份清单必须跟着 config.js 的 import 走：少复制一个模块，沙箱里 config.js 直接 import 失败，
// 于是"现在的状态必须通过"这一步先红，后面几项跟着全红 —— 2026-10-14 加 msg-density.js 时就这么
// 红过一次（守卫本身坏了，而不是它要盯的档位坏了）。
for (const rel of ['src/config.js', 'src/core/deep-merge.js', 'src/core/msg-density.js', 'src/domains/session.js',
  'config.json', 'config.example.json', 'scripts/check-effort-config.mjs']) {
  const dest = path.join(SAND, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
}

const SESSION = path.join(SAND, 'src/domains/session.js');
const CONFIG = path.join(SAND, 'config.json');
const GUARD = path.join(SAND, 'scripts/check-effort-config.mjs');
const sessionOrig = fs.readFileSync(SESSION, 'utf8');
const configOrig = fs.readFileSync(CONFIG, 'utf8');

let failed = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? '  PASS  ' : '  FAIL  '}${label}${detail ? `  [${detail}]` : ''}`); if (!ok) failed += 1; };
const runGuard = () => spawnSync(process.execPath, [GUARD], { encoding: 'utf8' });

try {
  console.log(`沙箱：${SAND}`);

  console.log('1) 现在的状态必须通过');
  const ok = runGuard();
  check('退出码 0', ok.status === 0, `exit=${ok.status}`);
  check('报出当前档位', /当前配置：high/.test(ok.stdout));

  console.log('2) 兜底值改回字面量 max（历史事故的样子）→ 必须红');
  fs.writeFileSync(SESSION, sessionOrig.replace('DEFAULT_REASONING_EFFORT);', "'max');"), 'utf8');
  const bad = runGuard();
  check('退出码 1', bad.status === 1, `exit=${bad.status}`);
  check('指出 session.js 写了字面量', /session\.js.*(写死|兜底)/.test(`${bad.stdout}${bad.stderr}`));
  fs.writeFileSync(SESSION, sessionOrig, 'utf8');

  console.log('3) config.json 改成非法档 → 必须红');
  fs.writeFileSync(CONFIG, configOrig.replace('"reasoningEffort": "high"', '"reasoningEffort": "ultra"'), 'utf8');
  const bad2 = runGuard();
  check('退出码 1', bad2.status === 1, `exit=${bad2.status}`);
  check('指出 config.json 不是合法档', /config\.json.*不是合法档/.test(`${bad2.stdout}${bad2.stderr}`));
  fs.writeFileSync(CONFIG, configOrig, 'utf8');

  console.log('4) 模板与实际配置不一致 → 只提醒，不算失败（档位本身是可调的）');
  fs.writeFileSync(CONFIG, configOrig.replace('"reasoningEffort": "high"', '"reasoningEffort": "low"'), 'utf8');
  const warn = runGuard();
  check('仍然退出 0', warn.status === 0, `exit=${warn.status}`);
  check('提醒模板不一致', /模板落后/.test(`${warn.stdout}${warn.stderr}`));
  fs.writeFileSync(CONFIG, configOrig, 'utf8');

  console.log('5) 恢复后必须通过');
  const back = runGuard();
  check('退出码 0', back.status === 0, `exit=${back.status}`);

  console.log('6) 真实仓库没被这条测试碰过');
  const realConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const realSession = fs.readFileSync(path.join(ROOT, 'src/domains/session.js'), 'utf8');
  check('真实 config.json 仍是 high', realConfig.dsh?.reasoningEffort === 'high', `当前 ${realConfig.dsh?.reasoningEffort}`);
  check('真实 session.js 仍用常量兜底', realSession.includes('|| DEFAULT_REASONING_EFFORT'), '');
} finally {
  fs.rmSync(SAND, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
