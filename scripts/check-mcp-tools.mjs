// MCP 工具面自检：起一个 stdio 客户端连 src/mcp-snowluma-safe.js，列出工具清单。
//
// 用途有两个：
//   1. 冒烟：改了 mcp 相关代码后，确认服务端还能起来、36 处注册都执行了；
//   2. 等价性对照：每行是 `工具名\tsha256(描述+inputSchema)`，排序后可直接 diff ——
//      拆模块/加工具时，用它证明"对外可见的东西"变了还是没变。
//
// 用法：
//   node scripts/check-mcp-tools.mjs            # 打印清单 + 数量
//   node scripts/check-mcp-tools.mjs --full     # 另外打印每个工具的完整描述与 schema
//   node scripts/check-mcp-tools.mjs --expect 34  # 数量不符即退出码 1（可当 CI 断言）
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2);
const full = args.includes('--full');
const expectAt = args.indexOf('--expect');
const expect = expectAt >= 0 ? Number(args[expectAt + 1]) : null;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp-snowluma-safe.js'],
  stderr: 'pipe',
});
const client = new Client({ name: 'check-mcp-tools', version: '0.0.0' }, { capabilities: {} });

let failed = false;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const rows = tools.map((t) => {
    const detail = `${t.description ?? ''}${JSON.stringify(t.inputSchema ?? {})}`;
    const hash = crypto.createHash('sha256').update(detail).digest('hex').slice(0, 12);
    return { name: t.name, hash, detail };
  }).sort((a, b) => a.name.localeCompare(b.name));

  for (const r of rows) console.log(full ? `${r.name}\t${r.hash}\n    ${r.detail}` : `${r.name}\t${r.hash}`);
  console.log(`### 工具数 ${rows.length}`);
  if (expect != null && rows.length !== expect) {
    console.log(`### ❌ 期望 ${expect} 个，实际 ${rows.length} 个`);
    failed = true;
  }
  if (expect != null && rows.length === expect) console.log(`### ✅ 数量符合期望（${expect}）`);
} catch (err) {
  console.log('### 连接失败: ' + (err?.message ?? err));
  failed = true;
} finally {
  await client.close().catch(() => { /* 关闭失败无关紧要 */ });
}
process.exit(failed ? 1 : 0);
