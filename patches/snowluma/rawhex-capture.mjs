// 给 SnowLuma 的 protobuf 解码器补丁：未知字段保留原始字节（hex），并写进日志
import fs from 'node:fs';

const F = '<项目根>/SnowLuma/index.mjs';
let t = fs.readFileSync(F, 'utf8');

// ---------- 补丁 A：820 个解码块，给 _unknown 对象加 rawHex ----------
const ANCHOR = 'totalByteLength: _unknownByteLength\n';
const REPL = 'totalByteLength: _unknownByteLength,\n' +
  '\t\t\t\t\t\trawHex: _unknownByteLength >= 150 ? (() => { try { return Buffer.from(data.subarray(_unknownStart, offset)).toString("hex"); } catch { return ""; } })() : ""\n';

const countA = t.split(ANCHOR).length - 1;
console.log(`  锚点 A（totalByteLength 行）命中: ${countA}`);
if (countA > 0 && !t.includes('rawHex: _unknownByteLength >=')) {
  t = t.split(ANCHOR).join(REPL);
  console.log(`  ✅ 补丁A 已应用到 ${countA} 处`);
} else if (t.includes('rawHex: _unknownByteLength >=')) {
  console.log('  · 补丁A 已存在，跳过');
} else {
  console.log('  ❌ 补丁A 锚点未命中，中止');
  process.exit(1);
}

// ---------- 补丁 B：日志里把 hex 打出来 ----------
const LOGOLD = 'for (const unknown of metadata.fields) unknownElementLog.debug("wire element ignored unknownTag=%d wireType=%d count=%d bytes=%d reason=no schema decoder path=%s", unknown.fieldNumber, unknown.wireType, unknown.count, unknown.totalByteLength, path);';
const LOGNEW = LOGOLD +
  '\n\tfor (const unknown of metadata.fields) if (unknown.rawHex) unknownElementLog.debug("wire element RAWHEX tag=%d bytes=%d path=%s hex=%s", unknown.fieldNumber, unknown.totalByteLength, path, unknown.rawHex);';

const countB = t.split(LOGOLD).length - 1;
console.log(`  锚点 B（日志行）命中: ${countB}`);
if (countB === 1 && !t.includes('wire element RAWHEX')) {
  t = t.replace(LOGOLD, LOGNEW);
  console.log('  ✅ 补丁B 已应用');
} else if (t.includes('wire element RAWHEX')) {
  console.log('  · 补丁B 已存在，跳过');
} else {
  console.log('  ⚠️ 补丁B 未命中（不致命，可以只靠 rawHex 字段）');
}

fs.writeFileSync(F, t, 'utf8');
console.log(`\n  文件大小: ${(fs.statSync(F).size / 1048576).toFixed(2)} MB`);
console.log(`  rawHex 出现次数: ${t.split('rawHex: _unknownByteLength >=').length - 1}`);
console.log(`  RAWHEX 日志次数: ${t.split('wire element RAWHEX').length - 1}`);
