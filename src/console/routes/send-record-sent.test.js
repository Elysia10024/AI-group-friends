// /api/socialV2/record-sent 的 hermetic 测试（2026-10-28 第 44 轮）。
// 内部接口不对外开放：防止持有会话 token 的调用方伪造"我说过…"的历史记录。
// 行为是恒 403，但这条测试的价值在于把"它永远不该能被外部调用"钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSendRecordSentInternal } from './send.js';

test('record-sent：任何调用都 403（仅桥接内部使用）', async () => {
  const sentJson = [];
  const ctx = {
    req: { method: 'POST', headers: { 'x-agent-token': 'T' }, on: () => {} },
    sendJson: (b, s) => sentJson.push({ body: b, status: s }),
    url: new URL('http://127.0.0.1:3100/api/socialV2/record-sent'),
  };
  const handled = await handleSendRecordSentInternal(ctx);
  assert.equal(handled, true);
  assert.equal(sentJson.at(-1).status, 403);
  assert.match(sentJson.at(-1).body.error, /仅桥接内部使用/);
});
