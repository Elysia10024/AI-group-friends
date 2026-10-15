// 推理档位一致性守卫（纯静态、不联网、不花钱）。
//
// 为什么需要它：2026-10-05 发现同一个值在三处各写一遍并且打架 ——
//   config.json = low、src/config.js 默认 = max、scripts/test-vision-media.mjs 断言 = max。
// 那条断言守卫因此长期是红的，而它不在每日体检里，所以没人发现。
// 这个守卫盯住的是"这个值只有一个来源"，而不是"它必须是某一档"：
// 档位是可以按成本/效果调的（合法档：low/high/max，DeepSeek 的模型元数据里
// deepseek-flash 的 default_level 是 high），但**不允许再有互相矛盾的字面量**。
//
// 用法：node scripts/check-effort-config.mjs   （在 npm run check:effort / 每日 selfcheck 里）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DEFAULTS, CONFIG_ENUMS, DEFAULT_REASONING_EFFORT, REASONING_EFFORTS } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const problems = [];
const notes = [];

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

console.log('=== 推理档位守卫 ===');

// 1) 常量本身
if (!REASONING_EFFORTS.includes(DEFAULT_REASONING_EFFORT)) {
  problems.push(`src/config.js: DEFAULT_REASONING_EFFORT=${DEFAULT_REASONING_EFFORT} 不在合法档 ${REASONING_EFFORTS.join('/')} 里`);
}
if (CONFIG_DEFAULTS.dsh.reasoningEffort !== DEFAULT_REASONING_EFFORT) {
  problems.push(`src/config.js: CONFIG_DEFAULTS.dsh.reasoningEffort=${CONFIG_DEFAULTS.dsh.reasoningEffort} 与 DEFAULT_REASONING_EFFORT=${DEFAULT_REASONING_EFFORT} 不一致`);
}
// 面板保存路径也要锁住：不然在设置界面手填一个不存在的档位就会被存进 config.json
if (JSON.stringify(CONFIG_ENUMS['dsh.reasoningEffort']) !== JSON.stringify(REASONING_EFFORTS)) {
  problems.push('src/config.js: CONFIG_ENUMS 没有把 dsh.reasoningEffort 锁到合法档（面板手填非法值会存进去）');
}

// 2) 真实配置与模板
const config = readJson(path.join(ROOT, 'config.json'));
const example = readJson(path.join(ROOT, 'config.example.json'));
const live = config.dsh?.reasoningEffort;
const sample = example.dsh?.reasoningEffort;
if (!REASONING_EFFORTS.includes(live)) problems.push(`config.json: reasoningEffort=${live} 不是合法档`);
if (!REASONING_EFFORTS.includes(sample)) problems.push(`config.example.json: reasoningEffort=${sample} 不是合法档`);
if (sample !== live) notes.push(`config.example.json=${sample} 与 config.json=${live} 不同（模板落后于实际配置，建议对齐）`);

// 3) 代码路径里不许再有第二个字面量（defaults 与常量本身除外）
const SRC = path.join(ROOT, 'src');
const literal = /reasoningEffort\s*[:=]\s*['"](low|high|max)['"]/g;
for (const file of fs.readdirSync(SRC, { recursive: true })) {
  const full = path.join(SRC, String(file));
  if (!fs.statSync(full).isFile() || !/\.m?js$/.test(full)) continue;
  if (full.endsWith(path.join('src', 'config.js'))) continue;   // 常量就住在那里
  const text = fs.readFileSync(full, 'utf8');
  for (const m of text.matchAll(literal)) {
    problems.push(`${path.relative(ROOT, full)}: 写死了档位字面量 ${m[0].trim()}（应改用 DEFAULT_REASONING_EFFORT）`);
  }
  if (/reasoningEffort\s*\|\|\s*['"](low|high|max)['"]/.test(text)) {
    problems.push(`${path.relative(ROOT, full)}: 兜底值又写成了字面量（应改用 DEFAULT_REASONING_EFFORT）`);
  }
}

console.log(`  合法档：${REASONING_EFFORTS.join(' / ')}    代码默认：${DEFAULT_REASONING_EFFORT}`);
console.log(`  当前配置：${live}    （模型自己的默认档是 high；low = 主动降级，max = 往上限顶）`);
for (const n of notes) console.log(`  ⚠️  ${n}`);
if (problems.length) {
  for (const p of problems) console.error(`  ❌ ${p}`);
  console.error(`\n❌ 推理档位不干净：${problems.length} 处问题。`);
  process.exit(1);
}
console.log('  ✅ 档位只有一个来源，没有打架的字面量。');
