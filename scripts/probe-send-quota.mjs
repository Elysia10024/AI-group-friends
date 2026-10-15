// 端到端验证「预占额度 → 发送失败 → 回滚」这条闭环。
//
// 为什么要专门验它：限流逻辑里最容易写错、也最难发现的不是判断，而是**回滚**。
// 漏了回滚的后果是"发失败几次之后就再也发不出去了"（假 429），而它在群里表现为
// 「她今天怎么不理人」—— 不会报错，也没有日志。
//
// 手法：拿一个**不存在的 stickerId** 打 /api/socialV2/send-sticker。请求会通过限额
// 检查、预占额度，然后在真正发送时报「找不到表情」，走 catch 回滚。所以：
//   · 响应不能是 429（429 说明还没走到发送环节，等于没测）；
//   · 回调时间窗内不许在 sendTimes 里留下任何记录（= 确实回滚了）；
//   · sendTimes 不许变长。
//
// 不会往 QQ 发任何东西。需要桥在跑，并且需要该会话的 agentToken（从状态文件读）。
//
// 注意 sendTimes 顶到 500 上限时的既有语义：预占会把最旧一条挤掉，回滚补不回来，
// 长度会 500 → 499。这是原实现就有的（src/core/ratelimit.test.js 有差分测试覆盖），
// 所以这里只断言"窗口内无残留"和"不变长"，不断言长度完全不变。
//
// 用法：
//   npm run probe:quota
//   node scripts/probe-send-quota.mjs group:20000001
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, 'state', 'social-v2.json');
const TOKEN_FILE = path.join(ROOT, 'state', 'console-token');
const BASE = process.env.CONSOLE_BASE || 'http://127.0.0.1:3100';
const KEY = process.argv[2] || 'group:20000001';
const BOGUS_STICKER = '__probe_no_such_sticker__';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function convOf() {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  return st.conversations?.[KEY] ?? {};
}

const conv = convOf();
const agentToken = conv.agentToken;
if (!agentToken) {
  console.error(`❌ ${KEY} 没有 agentToken（先让桥以 reserved2 模式跑起来并产生会话）`);
  process.exit(1);
}
const consoleToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

const t0 = Date.now();
const before = convOf().sendTimes ?? [];
console.log(`会话 ${KEY}`);
console.log(`打之前 sendTimes：${before.length} 条`);

let status = 0;
let bodyText = '';
for (let i = 0; i < 3; i++) {
  const res = await fetch(`${BASE}/api/socialV2/send-sticker`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-console-token': consoleToken,
      'x-agent-token': agentToken
    },
    body: JSON.stringify({ key: KEY, stickerId: BOGUS_STICKER })
  });
  status = res.status;
  bodyText = await res.text();
  if (i === 0) console.log(`响应：HTTP ${status}  ${bodyText.replace(/\s+/g, ' ').slice(0, 150)}`);
  await sleep(400);
}
const t1 = Date.now();

await sleep(2500);                       // 等 saveSocialV2State 落盘
const after = convOf().sendTimes ?? [];
console.log(`打之后 sendTimes：${after.length} 条`);

const reachedSend = status !== 429;
const leaked = after.filter((t) => t >= t0 && t <= t1);
const rolledBack = leaked.length === 0;
const notGrown = after.length <= before.length;

console.log('');
console.log(`  走到了发送环节（非 429）: ${reachedSend ? '✅' : '❌ 被 429 拦下了，这次验证无效'}`);
console.log(`  额度已回滚（无窗口内残留）: ${rolledBack ? '✅' : `❌ 残留 ${leaked.length} 条`}`);
console.log(`  长度未增长:                ${notGrown ? '✅' : '❌'}`);

if (!reachedSend || !rolledBack || !notGrown) {
  console.log('\n❌ 预占/回滚闭环有问题 —— 检查 src/console/server.js 里各发送路由的 catch 分支');
  process.exit(1);
}
console.log('\n✅ 失败发送不会吃掉发送额度');
