// 启动脚本编码守卫 —— 2026-10-03 那次"看门狗活着但什么都不干"的复盘产物。
//
// 事故经过：autostart\watchdog.ps1 被存成 **UTF-8 无 BOM**，而计划任务是用
// wscript -> powershell.exe（Windows PowerShell 5.1）拉起它的。5.1 在没有 BOM 时按
// 系统 ANSI（这台机器是 GBK）解码 .ps1，于是代码里的 '<项目根>' 变成了 '<项目根>'：
//   · 所有路径全部指到一个不存在的目录 → DSH / SnowLuma / 桥 一个都起不来；
//   · 它自己的日志写进了那个乱码目录 → 用户盯着的 logs\watchdog.log 一直是旧的；
//   · 它还在活着、还在每 45 秒转一圈，只是每圈都抛 LiteralPath 为空 —— 全链路没有任何红灯。
//
// 判据（能提前抓住这类事故的最小集）：
//   1. autostart\*.ps1：要么**纯 ASCII**，要么**带 UTF-8 BOM**（两者必居其一）；
//   2. 纯 ASCII 的脚本里不许出现写死的中文路径（应该用 $PSScriptRoot 推）。
// 跑法：node scripts/check-launchers.mjs（npm run check:launchers；已挂进 selfcheck）
import fs from 'node:fs';
import path from 'node:path';
import { aiqunyouPath } from './lib/paths.mjs';

const DIR = aiqunyouPath('autostart');
const BOM = [0xef, 0xbb, 0xbf];

const problems = [];
let checked = 0;

for (const name of fs.readdirSync(DIR)) {
  if (!name.toLowerCase().endsWith('.ps1')) continue;
  checked++;
  const file = path.join(DIR, name);
  const buf = fs.readFileSync(file);
  const hasBom = buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
  const nonAscii = buf.filter((b) => b >= 0x80).length;

  if (nonAscii === 0) {
    // 纯 ASCII：5.1 怎么读都不会错。唯一要防的是有人又写死中文路径。
    const text = buf.toString('latin1');
    const hard = /['"][A-Za-z]:\\\\?ai[^'"]*['"]/.exec(text);
    if (hard && !/\$PSScriptRoot/.test(text)) {
      problems.push(`${name}：含写死的绝对路径 ${hard[0]}（纯 ASCII 脚本请用 $PSScriptRoot 推根目录）`);
    }
    continue;
  }
  if (!hasBom) {
    problems.push(`${name}：含 ${nonAscii} 个非 ASCII 字节却没有 UTF-8 BOM —— PowerShell 5.1 会按 GBK 解码，中文路径会变成乱码（这就是 2026-10-03 看门狗失效的原因）`);
  }
}

console.log('\n=== 启动脚本编码守卫 ===\n');
console.log(`  检查了 ${checked} 个 autostart\\*.ps1`);
if (problems.length) {
  for (const p of problems) console.log(`  ❌ ${p}`);
  console.log(`\n❌ ${problems.length} 个脚本有编码隐患 —— 修法：存成「UTF-8 带 BOM」，或把脚本写成纯 ASCII（推荐，见 watchdog.ps1 顶部注释）。\n`);
  process.exit(1);
}
console.log('  ✅ 编码安全：非 ASCII 的脚本都带 BOM，纯 ASCII 的脚本没有写死路径\n');
