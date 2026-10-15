// 按需检索：一句话 → 定位到"哪天说过、在哪个文件哪一行"。
//
// 为什么要有它（主人 2026-10-13 定："记忆损失最少、花的钱更少"）：
//   压缩之后"我记不起来"是常态；**贵的不是检索，是把历史一直背在上下文里**。
//   （实测：上下文 40–58 万 token 时每步请求约 ¥0.02–0.03，一天 174 步就是 ¥4.9；
//     而按需 grep 一次的输出只有几 KB ≈ 几百 token。）
//   所以把"回忆"做成一条**便宜的命令**：搜归档转录 + 纪要 + CHANGELOG + docs，
//   只回**命中行的上下文一小截**，让人（和我）再决定要不要读全文。
//
// 用法：
//   node scripts/recall.mjs "把屎山拆掉"
//   node scripts/recall.mjs "schema" --limit 10 --files      # 只看命中在哪些文件
//   node scripts/recall.mjs --re "qzone|说说" --since 2026-10-12
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const argvVal = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };
const has = (n) => args.includes(`--${n}`);
const reArg = argvVal('re');
const pattern = reArg ?? args.find((a) => !a.startsWith('--') && a !== argvVal('limit') && a !== argvVal('since'));
if (!pattern) {
  console.log('用法：node scripts/recall.mjs <关键词或正则> [--re <正则>] [--limit 20] [--files] [--since YYYY-MM-DD]');
  process.exit(2);
}
const limit = Math.max(1, Number(argvVal('limit')) || 20);
const since = argvVal('since');
const filesOnly = has('files');

let re;
const isRe = Boolean(reArg);
if (isRe) {
  try { re = new RegExp(pattern, 'i'); } catch (e) {
    console.error(`正则写错了：${e?.message ?? e}`);
    process.exit(2);
  }
}
// 默认模式**忽略空白**：实测「17 个子代理」搜不到「17个子代理」（就差一个空格），
// 而人写字时空格随手加 —— 这种"明明有却搜不到"最伤检索的信任度。
// 正则模式（--re）不这么做：那里空白是有意义的。
const squash = (s) => String(s).replace(/\s+/g, '');
const needle = isRe ? null : squash(pattern);

/** 搜索面：归档（纪要 + 转录）、规则与人设变更日志、文档、她的人格（这几处是"我们做过什么"的全集）。 */
function collect() {
  const out = [];
  const pushDir = (dir, filter = () => true) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) { pushDir(p, filter); continue; }
      if (filter(f)) out.push(p);
    }
  };
  pushDir(path.join(ROOT, 'docs'), (f) => /\.(md|txt)$/.test(f));
  pushDir(path.join(ROOT, 'roles'), (f) => /\.(md)$/.test(f));
  return out;
}

const hits = [];
for (const file of collect()) {
  if (since) {
    const day = /(\d{4}-\d{2}-\d{2})/.exec(path.basename(file))?.[1];
    if (day && day < since) continue;
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (!(isRe ? re.test(text) : squash(text).includes(needle))) continue;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (!(isRe ? re.test(lines[i]) : squash(lines[i]).includes(needle))) continue;
    hits.push({ file: path.relative(ROOT, file), line: i + 1, text: lines[i].trim().slice(0, 160) });
    if (hits.length > 400) break;
  }
  if (hits.length > 400) break;
}

if (!hits.length) {
  console.log(`没有命中「${pattern}」。`);
  console.log('提示：更早的对话在 docs/会话归档/transcripts/（没导出就先 `npm run archive:session`）；');
  console.log('      原始会话文件（含工具输出）不在检索面内 —— 那是 L0，只在核对细节时才翻。');
  process.exit(0);
}

if (filesOnly) {
  const byFile = new Map();
  for (const h of hits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);
  console.log(`命中 ${hits.length} 处，分布在 ${byFile.size} 个文件：`);
  for (const [f, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, limit)) console.log(`  ${String(n).padStart(4)}  ${f}`);
  process.exit(0);
}

console.log(`命中 ${hits.length} 处（显示前 ${Math.min(limit, hits.length)} 处）：\n`);
for (const h of hits.slice(0, limit)) console.log(`  ${h.file}:${h.line}\n    ${h.text}`);
if (hits.length > limit) console.log(`\n（还有 ${hits.length - limit} 处，用 --limit 调大，或 --files 先看分布）`);
