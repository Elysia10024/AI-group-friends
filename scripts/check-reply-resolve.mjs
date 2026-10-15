// 引用解析接线守卫：**凡是接收 body.replyToMessageId 的路由，都必须把它解析成真实 message id。**
//
// 为什么要有它（2026-10-06 事故）：她的材料里看到的消息编号是**本地 seq**（如 5418），
// 而 QQ 只认自己的 message id。文本/表情/图库那几条路由都调了 resolveReplyTargetV2 做映射，
// 新加的语音路由漏了这一步 → `[CQ:reply,id=5418]` 发出去，网关解析不到就退化成 `[回复 0]`，
// 群里显示「引用的消息无法定位」，那条语音也跟着看不见了。
//
// 这条守卫按**函数块**扫（不是按文件）：同一个文件里有的路由要解析、有的明确拒绝引用。
//
//   node scripts/check-reply-resolve.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'src/console/routes/send.js',
  'src/console/routes/media.js'
];
// 明确不需要解析的：路由自己就把引用拒了（用户能看懂原因），或根本不发引用段
const ALLOW = [
  { file: 'src/console/routes/send.js', fn: 'routeSendBurst', why: 'send-burst 明确拒绝引用（qq_send_burst 暂不支持引用）' },
  { file: 'src/console/routes/send.js', fn: 'routeSendVoice', why: '语音明确拒绝引用（QQ 播不出"引用 + 语音"，语音必须单独发）' }
];

const chunks = [];
for (const rel of FILES) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lines = src.split('\n');
  let cur = null;
  lines.forEach((line, i) => {
    const m = /^\s{2}(?:async\s+)?function\s+(\w+)\s*\(/.exec(line);
    if (m) {
      if (cur) chunks.push(cur);
      cur = { file: rel, fn: m[1], start: i + 1, body: '' };
    }
    if (cur) cur.body += `${line}\n`;
  });
  if (cur) chunks.push(cur);
}

const reading = chunks.filter((c) => /body\.replyToMessageId/.test(c.body));
const rows = [];
let bad = 0;
for (const c of reading) {
  const allowed = ALLOW.find((a) => a.file === c.file && a.fn === c.fn);
  const resolves = /resolveReplyTargetV2\s*\(/.test(c.body);
  if (resolves) {
    rows.push(`  ✅ ${c.fn.padEnd(24, ' ')} ${c.file}:${c.start} —— 读了引用，也解析了`);
  } else if (allowed) {
    rows.push(`  ✅ ${c.fn.padEnd(24, ' ')} ${c.file}:${c.start} —— ${allowed.why}`);
  } else {
    bad += 1;
    rows.push(`  ❌ ${c.fn.padEnd(24, ' ')} ${c.file}:${c.start} —— 读了 body.replyToMessageId 却**没有**解析成真实 message id`);
  }
}

console.log('=== 引用解析接线检查 ===\n');
for (const r of rows) console.log(r);
console.log(`\n扫了 ${chunks.length} 个路由函数，其中 ${reading.length} 个读引用。`);
console.log(bad
  ? `❌ ${bad} 处没解析 —— 她传本地 seq 时，QQ 会显示"引用的消息无法定位"，整条消息跟着废。`
  : '✅ 每个读引用的路由都把本地 seq 解析成了真实 message id。');
process.exit(bad ? 1 : 0);
