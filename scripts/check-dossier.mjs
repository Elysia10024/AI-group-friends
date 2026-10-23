// 档案新鲜度：`docs/小鲸鱼档案.md` 的「现状速览」块必须和现状一致。
//
// 为什么要有它：那份档案 2026-09-17 之后烂了 27 天 —— 里面还写着"傲娇是外壳"，而 09-30 的人设重构
// 就把傲娇废掉了。主人 10-14 让我同步它，同步完我意识到：**只要还是手抄，它一定还会再烂一次**。
// 所以数字改成脚本生成（`E:\DS\tools\bridge-facts.mjs --write`），这条守卫负责让"忘了刷新"变红。
//
// 两点刻意的设计：
//   · **工具不在了也红**（不是"跳过"）。这个仓库已经有过一次教训：一条守卫指向的路径悄悄失效，
//     它连续 12 天报绿而实际什么都没查。所以宁可不绿，也不装作查过了。
//   · 官方事实源仍是 `roles/CHANGELOG.md` 与源码；这条只管档案里那一段**数字**对不对。
//
//   node scripts/check-dossier.mjs
//   DOSSIER_FACTS_TOOL=<别的路径> node scripts/check-dossier.mjs   # 换机/搬目录时用
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const TOOL = process.env.DOSSIER_FACTS_TOOL ?? 'tools/bridge-facts.mjs';

if (!fs.existsSync(TOOL)) {
  // 公开版不带本机的档案快照工具：没有工具就明确跳过，而不是报红吓人。
  console.log('（跳过：未找到档案快照工具；需要时用 DOSSIER_FACTS_TOOL 指定路径）');
  process.exit(0);
}

const r = spawnSync(process.execPath, [TOOL, '--check'], { encoding: 'utf8', shell: process.platform === 'win32' });
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
process.exit(r.status ?? 1);
