// 换 API key：**默认只动小鲸鱼那份**，桌面版（你现在这个界面）一个字都不碰。
//
// 为什么要有这个脚本，而不是让你手动改文件：
//   · 凭据文件里除了 `refs.DEEPSEEK_API_KEY`，还有一块 `records.client-connection/browser-session`
//     （本地 UI 的会话授权）——手滑改到它，本地面板就掉登录；
//   · 换 key 最常见的坑是"新 key 没余额/没有这个模型"，那种失败**是静默的**
//     （她的表现只是"突然不理人"），所以换之前先验、换完再验；
//   · 顺手备份原文件，随时能回滚。
//
// 用法：
//   node scripts/set-api-key.mjs sk-新的key                    # 只换她的（bot），先验后换再验
//   node scripts/set-api-key.mjs sk-新的key --check             # 只验证，不写任何文件
//   node scripts/set-api-key.mjs sk-新的key --target desktop    # 明确指定才动桌面版
//   node scripts/set-api-key.mjs sk-新的key --force             # 验不过也硬写（不推荐）
//
// 换完**不用重启内核**：`$DSH_HOME/.credentials.yaml` 被内核用 chokidar watch 着
// （官方注释：external edits hot-publish），下一个回合就用新 key。
import fs from 'node:fs';
import path from 'node:path';
import { CRED_TARGETS, readKeyFromFile, maskKey, botModel, checkKey } from './api-key-lib.mjs';

const args = process.argv.slice(2);
const key = args.find((a) => a.startsWith('sk-'));
const targetName = (() => {
  const i = args.indexOf('--target');
  return i >= 0 ? String(args[i + 1] ?? '').trim() : 'bot';
})();
const dryRun = args.includes('--check');
const force = args.includes('--force');

const file = CRED_TARGETS[targetName];
if (!file) {
  console.log(`❌ 不认识的 --target「${targetName}」。可选：${Object.keys(CRED_TARGETS).join(' / ')}`);
  process.exit(1);
}
if (!key) {
  console.log('用法：node scripts/set-api-key.mjs sk-新的key [--check] [--target bot|desktop] [--force]');
  process.exit(1);
}
if (/[\s"']/.test(key)) {
  console.log('❌ key 里有空格或引号 —— 先把复制带上的杂质去掉。');
  process.exit(1);
}

const { model, from } = botModel();
console.log(`\n=== 换 API key（目标：${targetName}）===`);
console.log(`文件：${file}`);
console.log(`她会用的模型：${model}（来自 ${from}）`);

const before = readKeyFromFile(file);
if (!before) { console.log(`❌ 这个文件里读不到 DEEPSEEK_API_KEY（路径对吗？）：${file}`); process.exit(1); }
if (before === key) { console.log('\nℹ️  新旧 key 一模一样，什么都不用改。'); process.exit(0); }
console.log(`旧 key：${maskKey(before)}`);
console.log(`新 key：${maskKey(key)}`);

console.log('\n--- ① 先验新 key（不改任何文件）---');
const pre = await checkKey(key, { model });
for (const l of pre.lines) console.log(l);
if (!pre.ok && !force && !dryRun) {
  console.log('\n❌ 新 key 没通过自检，**没有改动任何文件**。');
  console.log('   确认无误要硬换：加 --force（换完她会一直调不通）。');
  process.exit(1);
}
if (dryRun) { console.log(pre.ok ? '\n✅ --check：新 key 可用，未改动文件。' : '\n❌ --check：新 key 不可用，未改动文件。'); process.exit(pre.ok ? 0 : 1); }

console.log('\n--- ② 改写 refs.DEEPSEEK_API_KEY（其余字节原样保留）---');
const text = fs.readFileSync(file, 'utf8');
const lineRe = /^([ \t]*DEEPSEEK_API_KEY:[ \t]*)(\S+)([ \t]*)$/m;
if (!lineRe.test(text)) { console.log('❌ 没找到 DEEPSEEK_API_KEY 那一行（格式变了？手动看一眼）'); process.exit(1); }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${file}.bak-${stamp}`;
fs.writeFileSync(backup, text, 'utf8');
const next = text.replace(lineRe, (_m, p1, _p2, p3) => `${p1}${key}${p3}`);
if (next === text) { console.log('❌ 替换没生效（内容没变），已放弃。'); process.exit(1); }
fs.writeFileSync(file, next, 'utf8');
console.log(`  ✅ 已写入。备份：${path.basename(backup)}`);
console.log(`  · records 块（本地 UI 授权）未触碰`);
if (targetName === 'bot') console.log('  · 桌面版那份（' + CRED_TARGETS.desktop + '）未触碰');

console.log('\n--- ③ 用文件里现在这把 key 再验一次 ---');
const after = readKeyFromFile(file);
if (after !== key) { console.log(`❌ 写进去的和预期不一致（读到 ${maskKey(after)}）—— 立刻用备份回滚！`); process.exit(1); }
const post = await checkKey(after, { model });
for (const l of post.lines) console.log(l);

console.log('\n=== 结论 ===');
if (!pre.ok && post.ok) console.log('⚠️  新 key 之前没通过自检但现在是好的 —— 大概率是刚才的瞬时抖动。');
if (post.ok) {
  console.log('✅ 换好了。**不用重启内核**（凭据文件被 watch，下一个回合生效）。');
  console.log('   她会话历史/人设/记忆都在别处，不受影响；前几轮提示词缓存是冷的，之后一样。');
  console.log('   回滚：把备份文件覆盖回去即可 —— ' + backup);
} else {
  console.log('❌ 换完仍然验不过 —— 建议立刻回滚：');
  console.log('   Copy-Item -LiteralPath "' + backup + '" -Destination "' + file + '" -Force');
  process.exit(1);
}
