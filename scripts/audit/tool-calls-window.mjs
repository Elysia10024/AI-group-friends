// 今早的工具调用统计（tool-calls.jsonl 里 time 是 ISO 字符串，按它过滤）。
import fs from 'node:fs';
const lines = fs.readFileSync('state/tool-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean);
const at = process.argv.indexOf('--since');
const since = at >= 0 ? Date.parse(process.argv[at + 1]) : Date.now() - 3600000;
const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.type === 'result' && Date.parse(r.time) >= since);
console.log(`窗口内工具调用 ${rows.length} 次：`);
const by = {};
for (const r of rows) { const n = String(r.tool || '?').replace(/^mcp__[a-z]+__/, ''); by[n] = (by[n] ?? 0) + 1; }
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
const okFail = rows.reduce((a, r) => { a[r.ok ? 'ok' : 'fail'] += 1; return a; }, { ok: 0, fail: 0 });
console.log(`成功 ${okFail.ok}｜失败 ${okFail.fail}`);
