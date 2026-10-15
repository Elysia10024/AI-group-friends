// 从 config.json 生成 config.example.json（剥掉敏感值）。
// 为什么用 Node 而不是 Python：node 的 stdout 是 UTF-8（干净），
// Python 的 stdout 是 GBK，回传到 harness 会变成乱码。
import fs from 'node:fs';

const SRC = 'E:/ai群友/qq-bridge-main/config.json';
const DST = 'E:/ai群友/qq-bridge-main/config.example.json';
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
