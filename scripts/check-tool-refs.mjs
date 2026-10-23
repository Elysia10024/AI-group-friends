// check:tool-refs —— 她读到的规则里，引用的工具名必须真实存在。
//
// 为什么要有这道检查（真实事故 2026-09-29）：qq_mark_read / qq_get_unread_messages
// 早就被删掉/改名了，但规则里还留着 19 处 + 9 处引用，她照着调 → 每次调用都失败
// （桥接流水实测 6/6、8/8 全失败），白烧 step、还让她以为工具坏了。
// 工具删了/改名时没人会去 grep 全仓库的规则文本 —— 所以让机器每次替我们查。
//
// 用法：node scripts/check-tool-refs.mjs    （有幽灵引用则退出码 1）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：不要用 new URL(import.meta.url).pathname —— 中文路径会被 percent-encode
// （<项目根>\… → ENOENT）。fileURLToPath 才是对的。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_DIR = path.join(ROOT, 'src/mcp/tools');

// ── 1) 实际注册的工具名
const real = new Set();
const registries = [
  ...fs.readdirSync(TOOL_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(TOOL_DIR, f)),
  path.join(ROOT, 'src/mcp-snowluma-safe.js'),
  path.join(ROOT, 'src/mcp-host-server.js'),
  path.join(ROOT, 'src/mcp-web-search-safe.js')
];
for (const f of registries) {
  if (!fs.existsSync(f)) continue;
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/server\.tool\(\s*'([a-zA-Z0-9_]+)'/g)) real.add(m[1]);
}

// ── 2) 她能读到的文本（规则、工具说明、推荐值）
const SOURCES = [
  'dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
  ...fs.readdirSync(path.join(ROOT, 'roles')).filter((f) => f.endsWith('.md')).map((f) => 'roles/' + f),
  'src/core/prompt.js',
  'src/config.js',
  'config.example.json',
  ...fs.readdirSync(TOOL_DIR).filter((f) => f.endsWith('.js')).map((f) => 'src/mcp/tools/' + f)
];

// 只查没被 mcp__ 前缀限定的短名（带前缀的由下面统一去前缀后再查）
const refs = new Map();
for (const rel of SOURCES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\b((?:qq|web|snowluma)_[a-z_]{3,}|start_snowluma|stop_snowluma)\b/g)) {
      const name = m[1];
      const g = refs.get(name) ?? [];
      g.push(`${rel}:${i + 1}`);
      refs.set(name, g);
    }
  });
}

const phantom = [...refs.entries()].filter(([name]) => !real.has(name)).sort();
console.log(`已注册工具 ${real.size} 个；规则文本引用 ${refs.size} 个不同名字`);
if (!phantom.length) {
  console.log('✅ 规则里没有引用不存在的工具');
  process.exit(0);
}
console.log(`\n❌ 规则引用了 ${phantom.length} 个不存在的工具（她照着调只会失败）：`);
for (const [name, where] of phantom) {
  console.log(`  · ${name}  —— ${where.length} 处：${where.slice(0, 8).join(' , ')}${where.length > 8 ? ' …' : ''}`);
}
console.log('\n修法：要么把规则里的引用改成现有工具，要么恢复该工具（两者必须一致）。');
process.exit(1);
