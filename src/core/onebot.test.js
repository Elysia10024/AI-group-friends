// core/onebot.js 的单测（第 5 期 5b；被 src/**/*.test.js 捡到）。
// 用 stub 替换 global fetch：验 URL 规整、鉴权头、失败判据、426 三档措辞。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneBotClient } from './onebot.js';

function stubFetch(response) {
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return response; };
  return calls;
}
const OK = { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { messageId: 1 } }) };

test('成功路径：返回 body.data；尾部斜杠被规整；带 Bearer 头', async () => {
  const calls = stubFetch(OK);
  const { call } = createOneBotClient({ cfg: { snowluma: { httpUrl: 'http://127.0.0.1:3000/', accessToken: 'T' } } });
  const data = await call('send_group_msg', { group_id: 1 });
  assert.deepEqual(data, { messageId: 1 });
  assert.equal(calls[0].url, 'http://127.0.0.1:3000/send_group_msg');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer T');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
});

test('无 token：不挂 authorization 头', async () => {
  const calls = stubFetch(OK);
  const { call } = createOneBotClient({ cfg: {} });
  await call('z', {});
  assert.equal(calls[0].opts.headers.authorization, undefined);
});

test('失败判据：retcode 非零抛错，wording 优先于 retcode/status', async () => {
  stubFetch({ ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 100, wording: 'too fast' }) });
  const { call } = createOneBotClient({ cfg: {} });
  await assert.rejects(() => call('x', {}), /OneBot x 失败: too fast/);
});

test('426 提示三档措辞各自保留（long/short/none）', async () => {
  const bad = { ok: false, status: 426, json: async () => ({}) };
  const cases = [
    ['long', /请检查 config\.json/],
    ['short', /可能指到了/],
    ['none', null],
  ];
  for (const [hint426, re] of cases) {
    stubFetch(bad);
    const { call } = createOneBotClient({ cfg: {} });
    const err = await call('y', {}, { hint426 }).catch((e) => e);
    assert.ok(err instanceof Error, '应抛错');
    // 注意：消息里本来就会带状态码数字（wording||retcode||status 的兜底），
    // 所以 none 档断言的是「没有提示措辞」而不是「没有 426 字样」。
    if (re) assert.match(err.message, re);
    else assert.doesNotMatch(err.message, /HTTP 426/);
  }
});

test('timeoutMs 透传给 AbortSignal.timeout（用调用参数可观测）', async () => {
  const realTimeout = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return realTimeout(ms); };
  try {
    stubFetch(OK);
    const { call } = createOneBotClient({ cfg: {} });
    await call('a', {}, { timeoutMs: 1234 });
    assert.deepEqual(seen, [1234]);
  } finally {
    AbortSignal.timeout = realTimeout;
  }
});
