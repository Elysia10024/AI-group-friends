// 换 API key 前后的连通性自检（只读，几乎不花钱）。
//
// 为什么需要：key 换错、或换成一把没余额/没这个模型的 key 时，**她的表现是"突然不理人"**
// —— 现在桥有新告警（src/core/alert.js，改成连续失败会私聊告诉主人），但**换 key 当场就知道**
// 显然更好。所以：改之前先验一把，改完再验一次。
//
// 用法：
//   node scripts/check-api-key.mjs                 # 验当前正在用的（她那份 + 桌面版那份）
//   node scripts/check-api-key.mjs sk-新的key       # 验新的（只读，不改任何文件）
//   node scripts/check-api-key.mjs --no-deep        # 跳过真实补全调用（不花钱）
//   node scripts/check-api-key.mjs --file <凭据文件>
//
// 三步判据见 scripts/api-key-lib.mjs 顶部注释；换 key 请用 scripts/set-api-key.mjs。
import path from 'node:path';
import { CRED_TARGETS, readKeyFromFile, maskKey, botModel, checkKey } from './api-key-lib.mjs';

const args = process.argv.slice(2);
const DEEP = !args.includes('--no-deep');
const fileIdx = args.indexOf('--file');
const files = fileIdx >= 0 ? [args[fileIdx + 1]] : [CRED_TARGETS.bot, CRED_TARGETS.desktop];

const short = (p) => `${path.basename(path.dirname(p))}/${path.basename(p)}`;
const explicit = args.find((a) => a.startsWith('sk-'));
const keys = [];
if (explicit) keys.push({ label: '命令行给的 key', key: explicit });
else for (const f of files) {
  const k = readKeyFromFile(f);
  if (k) keys.push({ label: `${short(f)}　${f}`, key: k });
}
if (!keys.length) {
  console.log('❌ 没拿到任何 key。用法：node scripts/check-api-key.mjs sk-xxxx 或 --file <凭据文件>');
  process.exit(1);
}
if (new Set(keys.map((k) => k.key)).size === 1 && keys.length > 1) {
  console.log(`\n⚠️  两份凭据文件里是**同一把 key**（${maskKey(keys[0].key)}）—— 换的时候记得决定是只换她的、还是两个都换。`);
}

const { model, from } = botModel();
console.log(`\n=== API key 自检（${process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'}）===`);
console.log(`她会用的模型：${model}（来自 ${from}）${DEEP ? '，会真打一次 max_tokens=1' : '，已跳过真实调用'}`);

let bad = 0;
for (const { label, key } of keys) {
  console.log(`\n· ${label}`);
  const r = await checkKey(key, { deep: DEEP, model });
  for (const l of r.lines) console.log(l);
  if (r.ok) console.log('  → ✅ 这把 key 可以直接用');
  else { bad++; console.log(`  → ❌ 不可用：${r.problems.join('、')}`); }
}
console.log(bad ? `\n❌ ${bad} 项有问题 —— 先别换，或换了立刻回滚。\n` : '\n✅ 全部可用。\n');
process.exit(bad ? 1 : 0);
