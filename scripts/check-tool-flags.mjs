// 工具开关（flag）一致性自检 —— 纯静态，不用起服务。
//
// 为什么需要：给 AI 加一个工具要动三处，而这三处**没法合并**（本来就是三层）：
//   1. `src/mcp/tools/*.js` 里注册 MCP 工具（对外名字是 qq_xxx）；
//   2. `src/config.js` 的 `CONFIG_DEFAULTS.socialV2.tools` 里加开关（服务端按它决定放不放行）；
//   3. `public/console.html` 里加一个 `data-v2-tool` 复选框（用户能关掉它）。
// 漏第 2 步 → `v2ToolEnabled('新flag')` 在界面里**关不掉**（配置里没有这个键）；漏第 3 步 → 配置里有
// 开关但界面没有，同样关不掉。两种情况都只能靠人记得，所以用这个脚本钉住。
//
// 用法：node scripts/check-tool-flags.mjs
//   · 失败条件一：代码里出现 `v2ToolEnabled('X')`，但配置里没有 X
//   · 失败条件二：界面复选框集合 ≠ 配置开关集合（任一方向）
//   · 只提示不失败：配置里有、但代码里只以变量形式引用的开关（`v2ToolEnabled(flag)`）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIG_DEFAULTS } from '../src/config.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfgFlags = Object.keys(CONFIG_DEFAULTS.socialV2.tools);
const uiFlags = [...fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8')
  .matchAll(/data-v2-tool="([A-Za-z]+)"/g)].map((m) => m[1]);

const files = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

const literals = new Map();   // flag → 出现它的文件（前几处）
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const m of src.matchAll(/v2ToolEnabled\(\s*'([A-Za-z]+)'/g)) {
    if (!literals.has(m[1])) literals.set(m[1], []);
    if (literals.get(m[1]).length < 2) literals.get(m[1]).push(rel);
  }
}

let bad = 0;
const missingInConfig = [...literals.keys()].filter((f) => !cfgFlags.includes(f));
if (missingInConfig.length) {
  bad += 1;
  console.log(`❌ 代码里检查了这些开关，但 CONFIG_DEFAULTS.socialV2.tools 里没有（界面上关不掉）：`);
  for (const f of missingInConfig) console.log(`   ${f}  ← ${literals.get(f).join(', ')}`);
}

const onlyInUi = uiFlags.filter((f) => !cfgFlags.includes(f));
const onlyInCfg = cfgFlags.filter((f) => !uiFlags.includes(f));
if (onlyInUi.length || onlyInCfg.length) {
  bad += 1;
  if (onlyInUi.length) console.log(`❌ 界面有、配置没有：${onlyInUi.join(', ')}`);
  if (onlyInCfg.length) console.log(`❌ 配置有、界面没有（用户关不掉）：${onlyInCfg.join(', ')}`);
}

const variableOnly = cfgFlags.filter((f) => !literals.has(f));
console.log(`配置开关 ${cfgFlags.length} 个，界面复选框 ${uiFlags.length} 个，代码里以字面量检查 ${literals.size} 个`);
if (variableOnly.length) console.log(`ℹ️ 只以变量传入（v2ToolEnabled(flag) 这种）的开关：${variableOnly.join(', ')}`);

// ── 第四个地方：`socialV2.js` 里的 `toolMap` ────────────────────────────────
// 它是 `qq_get_prompt` 回给她的**"可用工具"清单**（不是门控，是告知）。
// 2026-10-12 加说说时发现：工具挂上了、开关也开了，但 toolMap 里没写 ——
// 她问"我有什么工具"时看到的清单里没有它，于是**永远不会去用**（静默失效，跟没做一样）。
// 判据双向：默认开关里的每个键都要在 toolMap 里；toolMap 里也不许留默认值里没有的陈旧项。
const toolMapKeys = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'console', 'routes', 'socialV2.js'), 'utf8');
  const m = src.match(/const toolMap = \{([\s\S]*?)\};/);
  if (!m) return null;
  return [...m[1].matchAll(/^\s*([A-Za-z]+):/gm)].map((x) => x[1]);
})();
if (!toolMapKeys) {
  bad += 1;
  console.log('❌ 找不到 socialV2.js 里的 `const toolMap = {…}` —— 脚本需要更新（或那段被改名了）');
} else {
  const notInMap = cfgFlags.filter((f) => !toolMapKeys.includes(f));
  const notInCfg = toolMapKeys.filter((f) => !cfgFlags.includes(f));
  if (notInMap.length || notInCfg.length) {
    bad += 1;
    if (notInMap.length) console.log(`❌ 有开关但 qq_get_prompt 的 toolMap 里没有（她会以为没这个工具）：${notInMap.join(', ')}`);
    if (notInCfg.length) console.log(`❌ toolMap 里有、配置开关里没有（陈旧项）：${notInCfg.join(', ')}`);
  } else {
    console.log(`✅ qq_get_prompt 的 toolMap 与配置开关一致（${toolMapKeys.length} 个）`);
  }
}
console.log(bad ? '\n❌ 工具开关几处不一致' : '\n✅ 工具开关几处一致（配置 / 界面 / 代码引用 / qq_get_prompt 清单）');
process.exit(bad ? 1 : 0);
