// 一次性清理：把已经攒下来的**近似重复印象**按 core/memory.js 的同一套规则合并。
//
// 背景（2026-09-20）：她的去重原来只比较"完全相等"，于是同一件事换个说法就再存一条 ——
// 群友乙的印象攒到 17 条，其中 5 条都是"早八/课后来戳我撒娇 → 接软的 → 专属叫法哦鲸鲸"。
// 这些重复每轮都会原样进组装材料（facts 块还会把 17 条全量倒出来），是白花的 token。
//
// 安全：**桥在跑的时候不能改 state**（桥在内存里握着 socialV2，落盘会覆盖这次清理）。
// 所以默认 dry-run，且检测到 3100 有应答就直接拒绝（要强行跑得显式 --force）。
//
// 用法：
//   node scripts/dedupe-memory.mjs            # 只看会改什么
//   node scripts/dedupe-memory.mjs --apply    # 真写回（原子写）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { mergeTrait } from '../src/core/memory.js';
import { atomicWriteJson } from '../src/core/state-io.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, 'state', 'social-v2.json');
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

async function bridgeAlive() {
  try {
    const token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
    const res = await fetch('http://127.0.0.1:3100/api/status', {
      headers: { 'x-console-token': token },
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch {
    return false;
  }
}

if (await bridgeAlive() && !FORCE) {
  console.error('❌ 桥正在运行（3100 有应答）—— 改 state 会被它内存里的状态覆盖。');
  console.error('   要么先停桥（npm run restart 会重新拉一个…所以请先停 watchdog 或直接 --force 自担风险），');
  console.error('   要么等她离线（比如现在 QQ 没登录）时再跑。');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
let beforeTraits = 0;
let afterTraits = 0;
let beforeChars = 0;
let afterChars = 0;
const changed = [];

for (const [key, conv] of Object.entries(raw.conversations || {})) {
  for (const [name, imp] of Object.entries(conv.memberImpressions || {})) {
    const old = Array.isArray(imp.traits) ? imp.traits : [];
    if (!old.length) continue;
    let merged = [];
    for (const t of old) merged = mergeTrait(merged, t);
    beforeTraits += old.length;
    afterTraits += merged.length;
    beforeChars += old.join('').length;
    afterChars += merged.join('').length;
    if (merged.length !== old.length) {
      changed.push({ key, name, from: old.length, to: merged.length });
      imp.traits = merged;
    }
  }
}

const savedChars = beforeChars - afterChars;
console.log(`会话数：${Object.keys(raw.conversations || {}).length}`);
console.log(`印象条数：${beforeTraits} → ${afterTraits}（合并掉 ${beforeTraits - afterTraits} 条）`);
console.log(`印象字符：${beforeChars} → ${afterChars}（少 ${savedChars} 字，约 ${Math.round(savedChars / 1.5)} token/轮）`);
console.log('\n变化明细（前 20 条）：');
for (const c of changed.slice(0, 20)) console.log(`  ${c.key} / ${c.name}：${c.from} → ${c.to} 条`);
if (changed.length > 20) console.log(`  …还有 ${changed.length - 20} 条`);

if (!changed.length) {
  console.log('\n没有需要合并的（已经干净）。');
  process.exit(0);
}
if (!APPLY) {
  console.log('\n（dry-run）确认无误后加 --apply 写回。');
  process.exit(0);
}

// 原子写 + 备份：这份文件是她的长期记忆，改坏了很难恢复。
const backup = path.join(ROOT, 'state', `social-v2.json.before-dedupe-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.bak`);
fs.copyFileSync(STATE, backup);
atomicWriteJson(STATE, raw);
console.log(`\n✅ 已写回（备份：${path.basename(backup)}）`);
