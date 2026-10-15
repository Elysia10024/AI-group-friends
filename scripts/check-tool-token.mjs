// 工具令牌接线守卫：v2 工具的会话令牌必须**真的挂到请求头上**，不能只写在工具说明里。
//
// 为什么要有它（2026-10-06 真实事故）：
//   `qq_send_voice` 的说明写着"reserved2 下必须带 token"，代码也把 token 放进了 **body** ——
//   但 `/api/socialV2/*` 是在**请求头** `x-agent-token` 上校验的。于是她真去群里发语音时被
//   403「reserved2 模式发送必须携带 agent token」挡回来，连试两次都失败、只好改发文字。
//   端到端脚本没抓到，因为那个脚本是自己手动塞的头 —— 它验的是路由，不是**工具自己**发的请求。
//
// 这条守卫的做法：把每个 handler 抓出来，喂一份"什么参数都有"的输入 + 一个假的 agentApi，
// 然后看它到底发了什么请求（url / headers / body）。属于**接线**级断言，不是语法检查。
//
//   node scripts/check-tool-token.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerImageLibraryTools } from '../src/mcp/tools/image-library.js';
import { registerQzoneTools } from '../src/mcp/tools/qzone.js';
import { registerMediaTools } from '../src/mcp/tools/media.js';
import { registerMemoryTools } from '../src/mcp/tools/memory.js';
import { registerReadTools } from '../src/mcp/tools/read.js';
import { registerSendTools } from '../src/mcp/tools/send.js';
import { registerSlangTools } from '../src/mcp/tools/slang.js';
import { registerStickerTools } from '../src/mcp/tools/sticker.js';
import { createSnowlumaLib } from '../src/mcp/snowluma-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'TOKEN-CHECK-abc123';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const { unquoteJsonString } = createSnowlumaLib({ ROOT, fs, path });

// 每个 handler 要什么参数就给什么（它自己解构，多余的键无害）
const ARGS = {
  key: 'group:20000001', token: TOKEN, groupId: '20000001', userId: '10000001',
  text: '在的', message: '在的', messages: ['在的'], replyToMessageId: '1', atUserId: '1',
  messageId: '1', targetUserId: '1', id: '1', name: 'x', stickerId: '1', tid: '1',
  image: 'x', maxComments: 5, toUserId: '1', toName: 'x', commentText: 'x',
  query: 'x', q: 'x', count: 1, limit: 1, offset: 0, refresh: false,
  category: 'activeTopic', scope: 'group', content: 'x', target: 'x', extra: {}, context: 'x',
  config: {}, timeoutMs: 1000, minNewMessages: 1, quietMs: 100, gapMode: 'auto', gapMs: 300, gaps: [300],
  level: 'info', verdict: 'ok', tag: 'x', remark: 'x', note: 'x', tags: [], usage: 'x'
};

let failed = 0;
const rows = [];
const fail = (tool, msg) => { failed += 1; rows.push(`  ❌ ${tool}：${msg}`); };
const ok = (tool, msg) => rows.push(`  ✅ ${tool.padEnd(28, ' ')} ${msg}`);

function makeServer() {
  const tools = [];
  return { tools, tool: (name, desc, schema, handler) => tools.push({ name, desc, schema, handler }) };
}

/** 跑一族工具，返回 [{tool, calls, error}] */
async function probe(register, deps) {
  const server = makeServer();
  const calls = [];
  const agentApi = async (apiPath, init = {}) => { calls.push({ path: String(apiPath), init }); return { ok: true }; };
  register(server, { agentApi, unquoteJsonString, cfg, ...deps });
  const out = [];
  for (const t of server.tools) {
    const before = calls.length;
    let error = null;
    try {
      await t.handler({ ...ARGS });
    } catch (e) {
      error = e?.message ?? String(e);
    }
    out.push({ tool: t.name, calls: calls.slice(before), error });
  }
  return out;
}

const probes = [
  ...(await probe(registerSendTools, {})),
  ...(await probe(registerStickerTools, {})),
  ...(await probe(registerMediaTools, {})),
  ...(await probe(registerMemoryTools, {})),
  ...(await probe(registerReadTools, {})),
  ...(await probe(registerSlangTools, {})),
  ...(await probe(registerImageLibraryTools, {})),
  ...(await probe(registerQzoneTools, {}))
];

// v2 命名空间走请求头；/api/send/* 是 v1 老通道，token 在 body 里（历史约定，别改）
const V2 = '/api/socialV2/';
const LEGACY = '/api/send/';

let checkedCalls = 0;
let untested = 0;
for (const { tool, calls, error } of probes) {
  if (!calls.length) {
    untested += 1;
    rows.push(`  ⚠️  ${tool.padEnd(28, ' ')} 没发出请求（${error ? `抛错：${error}` : '参数不足？'}）—— 这条没验到`);
    continue;
  }
  for (const { path: apiPath, init } of calls) {
    const headers = init?.headers ?? {};
    let body = null;
    try { body = init?.body ? JSON.parse(init.body) : null; } catch { /* body 不是 JSON：下面按"没带 token"处理 */ }
    if (apiPath.startsWith(V2)) {
      checkedCalls += 1;
      if (headers['x-agent-token'] !== TOKEN) {
        fail(tool, `打 ${apiPath} 没把 token 放进 x-agent-token 头（现在头里是 ${JSON.stringify(headers['x-agent-token'] ?? null)}）`);
      } else if (body && 'token' in body && body.token !== TOKEN) {
        fail(tool, `打 ${apiPath} 头对了但 body.token 是 ${JSON.stringify(body.token)}（两处不一致，将来会咬人）`);
      } else {
        ok(tool, `→ ${apiPath}（x-agent-token 已带）`);
      }
    } else if (apiPath.startsWith(LEGACY)) {
      checkedCalls += 1;
      if (body?.token !== TOKEN) {
        fail(tool, `打 ${apiPath} 是老通道，token 应该在 body 里（现在是 ${JSON.stringify(body?.token ?? null)}）`);
      } else {
        ok(tool, `→ ${apiPath}（老通道，token 在 body）`);
      }
    } else {
      untested += 1;
      rows.push(`  ⚠️  ${tool.padEnd(28, ' ')} → ${apiPath}（不在巡检范围，跳过）`);
    }
  }
}

console.log('=== 工具令牌接线检查 ===\n');
for (const r of rows) console.log(r);
console.log(`\n检查了 ${checkedCalls} 个请求、${untested} 处未验证。`);
console.log(failed ? `❌ ${failed} 处令牌没接上 —— 她会照说明带 token，但请求里没有，最后被 403 挡住。` : '✅ 所有 v2 工具的 token 都真的挂到请求头上了。');
process.exit(failed ? 1 : 0);
