// 从 config.json 生成 config.example.json（剥掉敏感值）。
// 为什么用 Node 而不是 Python：node 的 stdout 是 UTF-8（干净），
// Python 的 stdout 是 GBK，回传到 harness 会变成乱码。
import fs from 'node:fs';
import { projectPath } from './lib/paths.mjs';

const SRC = projectPath('config.json');
const DST = projectPath('config.example.json');
const SECRET_RE = /token|secret|password|apikey|api_key|cookie/i;
const PLACEHOLDER = '<在这里填你自己的值>';

function scrub(value, keyPath) {
  if (Array.isArray(value)) return value.map((v, i) => scrub(v, keyPath + '[' + i + ']'));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_RE.test(k) && typeof v === 'string' && v
        ? PLACEHOLDER
        : scrub(v, keyPath + '.' + k);
    }
    return out;
  }
  return value;
}

const raw = fs.readFileSync(SRC, 'utf8');
const clean = scrub(JSON.parse(raw), '');

// --check 模式：只比对模板与实配的叶子键集是否一致，不写文件（接进 selfcheck，2026-10-27 第 1 期）。
// 起因：example 曾落后实配 19 天、缺 29 个键，且 proactive.enabled 与实配反向——
// 复制模板起服务等于默认替人打开每轮花钱的主动冒泡。
function leafKeys(o, p = '') {
  const out = [];
  for (const [k, v] of Object.entries(o)) {
    const kp = p ? p + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leafKeys(v, kp));
    else out.push(kp);
  }
  return out;
}
if (process.argv.includes('--check')) {
  const existing = JSON.parse(fs.readFileSync(DST, 'utf8'));
  const want = leafKeys(clean).sort();
  const have = leafKeys(existing).filter((k) => k !== '_comment').sort();
  const missing = want.filter((k) => !have.includes(k));
  const extra = have.filter((k) => !want.includes(k));
  if (missing.length || extra.length) {
    console.error('❌ config.example.json 与 config.json 键集不一致（跑 node scripts/make-config-example.mjs 重新生成）');
    if (missing.length) console.error('   模板缺: ' + missing.join(', '));
    if (extra.length) console.error('   模板多: ' + extra.join(', '));
    process.exit(1);
  }
  console.log('✅ check:config-example 键集一致（' + want.length + ' 个叶子键）');
  process.exit(0);
}

const header = {
  _comment: [
    '这是 config.json 的模板，敏感值已替换为占位符。',
    '用法：复制成 config.json，把 <在这里填你自己的值> 换成真实值。',
    'config.json 已被 .gitignore 排除，不会进版本库。',
    '生成时间：' + new Date().toISOString()
  ]
};
fs.writeFileSync(DST, JSON.stringify({ ...header, ...clean }, null, 2) + '\n', 'utf8');

// 自检：模板里绝不能残留真实凭据的特征子串
const out = fs.readFileSync(DST, 'utf8');
const suspicious = [];
for (const m of out.matchAll(/"([^"]+)"\s*:\s*"([^"]{12,})"/g)) {
  const k = m[1], v = m[2];
  if (SECRET_RE.test(k) && v !== PLACEHOLDER) suspicious.push(k + '=' + v.slice(0, 8) + '...');
}
const leaked = /POI-|bKfq|Ym_9|Vqsh/.test(out);

console.log('已写出 ' + DST);
console.log('原文件字节 ' + raw.length + ' -> 模板 ' + out.length);
console.log('模板里可疑残留: ' + (suspicious.length ? suspicious.join(', ') : '无'));
console.log('已知凭据特征串残留: ' + (leaked ? '有（失败！）' : '无 ✓'));
process.exit(leaked || suspicious.length ? 1 : 0);
