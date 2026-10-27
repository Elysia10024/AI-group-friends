// aa-endpoint 判定的单测：**这套判断只允许"能证明"的清理**，所以测试就是逐条钉死
// "什么形态算死、什么形态必须留着、什么形态证据不足要放过"。
//
// 事故背景见 src/core/aa-endpoint.js 顶部与 docs/事故-2026-10-08-手机连接僵尸记录.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideEndpoint, parseEndpoint, looksLikeDsh, archiveName, PID_REUSE_GRACE_MS, PARSE_FAILURE_GRACE_MS } from './aa-endpoint.js';

const NOW = Date.parse('2026-10-08T02:00:00Z');
const mtime = (minutesAgo) => NOW - minutesAgo * 60_000;
const file = (pid = 15424, port = 49936) => JSON.stringify({ version: 1, host: '127.0.0.1', port, token: 'tok', pid });

test('没有文件：什么都不做', () => {
  const d = decideEndpoint({ exists: false, raw: null, mtimeMs: null, nowMs: NOW, proc: null });
  assert.equal(d.action, 'none');
});

test('死法 1：pid 已经不存在 → 清理', () => {
  const d = decideEndpoint({ exists: true, raw: file(), mtimeMs: mtime(600), nowMs: NOW, proc: null });
  assert.equal(d.action, 'heal');
  assert.equal(d.reason, 'owner-gone');
});

test('死法 2：pid 存在但比文件晚启动 → 清理（2026-10-08 的真实形态）', () => {
  // 文件 10-07 01:20 写的（pid 15424），现在这个 pid 是 10-07 11:34 启动的 RuntimeBroker
  const d = decideEndpoint({
    exists: true, raw: file(), mtimeMs: Date.parse('2026-10-07T01:20:54+08:00'), nowMs: NOW,
    proc: { pid: 15424, name: 'RuntimeBroker.exe', startedAtMs: Date.parse('2026-10-07T11:34:21+08:00') },
  });
  assert.equal(d.action, 'heal');
  assert.equal(d.reason, 'pid-reused');
  assert.match(d.detail, /晚启动/);
});

test('pid 存在、启动时间早于文件 → 活的，绝不碰', () => {
  const d = decideEndpoint({
    exists: true, raw: file(16368, 62205), mtimeMs: mtime(3), nowMs: NOW,
    proc: { pid: 16368, name: 'DSH Desktop.exe', startedAtMs: mtime(8) },
  });
  assert.equal(d.action, 'keep');
  assert.equal(d.reason, 'owner-alive');
});

test('启动时间与写入时间几乎同时（<2 秒）→ 当作活的，不碰', () => {
  const d = decideEndpoint({
    exists: true, raw: file(), mtimeMs: mtime(10), nowMs: NOW,
    proc: { pid: 15424, name: 'DSH Desktop.exe', startedAtMs: mtime(10) + PID_REUSE_GRACE_MS - 500 },
  });
  assert.equal(d.action, 'keep');
});

test('死法 3（兜底）：拿不到启动时间，且名字明显是外人 → 清理', () => {
  const d = decideEndpoint({
    exists: true, raw: file(), mtimeMs: mtime(600), nowMs: NOW,
    proc: { pid: 15424, name: 'RuntimeBroker.exe', startedAtMs: null },
  });
  assert.equal(d.action, 'heal');
  assert.equal(d.reason, 'foreign-process');
});

test('拿不到启动时间、但名字像 DSH → 放过（宁可漏清）', () => {
  const d = decideEndpoint({
    exists: true, raw: file(), mtimeMs: mtime(600), nowMs: NOW,
    proc: { pid: 15424, name: 'node.exe', startedAtMs: null },
  });
  assert.equal(d.action, 'keep');
  assert.equal(d.reason, 'owner-alive');
});

test('进程查询失败（proc=undefined）→ 一律放过，不清理', () => {
  const d = decideEndpoint({ exists: true, raw: file(), mtimeMs: mtime(600), nowMs: NOW, proc: undefined, procQueryError: 'PowerShell timeout' });
  assert.equal(d.action, 'keep');
  assert.equal(d.reason, 'proc-query-failed');
  assert.match(d.detail, /PowerShell timeout/);
});

test('内容解析不了：刚写的先等，老过 2 分钟才清', () => {
  const fresh = decideEndpoint({ exists: true, raw: '{"pid":', mtimeMs: mtime(0.5), nowMs: NOW, proc: null });
  assert.equal(fresh.action, 'wait');
  const old = decideEndpoint({ exists: true, raw: '{"pid":', mtimeMs: mtime(10), nowMs: NOW, proc: null });
  assert.equal(old.action, 'heal');
  assert.equal(old.reason, 'unparseable');
  assert.ok(mtime(10) < NOW - PARSE_FAILURE_GRACE_MS);
});

test('解析不了、又不像这套 schema 的（将来换版本了）→ 一律不碰', () => {
  // 将来的 AA 可能换成别的形状；我们绝不该把一条可能是活的记录当"坏文件"清掉
  const d = decideEndpoint({ exists: true, raw: '{"endpoint":{"address":"127.0.0.1:1234"}}', mtimeMs: mtime(600), nowMs: NOW, proc: null });
  assert.equal(d.action, 'keep');
  assert.equal(d.reason, 'unknown-format');
});

test('pid 字段坏掉（0 / 负数 / 字符串）按"解析不了"处理', () => {
  for (const bad of ['{"pid":0}', '{"pid":-5}', '{"pid":"abc"}', '{"port":1}', 'null', '[1,2]', '']) {
    const p = parseEndpoint(bad);
    assert.equal(p.ok, false, `应判为坏内容：${bad}`);
  }
});

test('parseEndpoint 认得好内容并归一化字段', () => {
  const p = parseEndpoint(file(123, 456));
  assert.equal(p.ok, true);
  assert.equal(p.value.pid, 123);
  assert.equal(p.value.port, 456);
  assert.equal(p.value.host, '127.0.0.1');
});

test('looksLikeDsh：白名单与命令行都要认', () => {
  assert.equal(looksLikeDsh({ name: 'DSH Desktop.exe' }), true);
  assert.equal(looksLikeDsh({ name: 'node.exe' }), true);
  assert.equal(looksLikeDsh({ name: 'whatever.exe', commandLine: '<DS目录>\\\DSH Desktop\\DSH Desktop.exe --type=utility' }), true);
  assert.equal(looksLikeDsh({ name: 'RuntimeBroker.exe', commandLine: 'C:\\Windows\\System32\\RuntimeBroker.exe -Embedding' }), false);
  assert.equal(looksLikeDsh(null), false);
});

test('归档文件名能一眼看出时间/pid/原因', () => {
  const name = archiveName({ pid: 15424, reason: 'pid-reused', at: new Date('2026-10-08T02:00:00Z') });
  assert.equal(name, 'endpoint.json.stale-20261008-020000-pid15424-pid-reused.json');
});
