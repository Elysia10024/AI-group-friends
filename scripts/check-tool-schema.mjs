// 工具 schema 与说明的一致性自检：**说明里承诺的参数，schema 里必须真的有**。
//
// 为什么要有它（2026-10-13 抓到的真实静默失败）：
//   `qq_memory_append` 的说明一直在教她"用 `extra.relation` 改关系、`extra.tag` 写小标签"，
//   但 schema 的 `extra` 只声明了 5 个键 —— zod 对**未声明的键是静默丢掉**（不报错、不提示）。
//   后果：她**试过 8 次写 tag，一条都没落库**（人物表里唯一的标签是手工写的）；
//   改关系更是一次都没生效过。她以为写了、我们以为好了，中间什么都没发生。
//   同类风险：`category` 的枚举与说明里提到的类别（例如 `mood`）也要对得上。
//
// 判据（只扫我们自己的工具文件，风格统一，所以用正则就够）：
//   1. 说明字符串里出现的 `extra.<名字>` → 必须在**同一个工具**的 `extra: z.object({...})` 里有；
//   2. 说明字符串里出现的 `category` 取值（形如 `mood=` 或 "category=mood"）→ 必须在 `z.enum([...])` 里。
//
//   node scripts/check-tool-schema.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'src/mcp/tools');

/** 取 `server.tool(...)` 的每一段调用文本（按括号配对）。 */
function toolCalls(src) {
  const out = [];
  const re = /server\.tool\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const start = src.indexOf('(', m.index);
    let depth = 0;
    for (let i = start; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') { depth -= 1; if (depth === 0) { out.push({ name: m[1], body: src.slice(start, i + 1) }); break; } }
    }
  }
  return out;
}

/** 从 `extra: z.object({ ... })` 里取顶层键名。 */
function extraKeys(body) {
  const m = /extra:\s*z\.object\(\{([\s\S]*?)\}\)/.exec(body);
  if (!m) return null;
  const keys = [];
  for (const line of m[1].split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('//')) continue;
    const k = /^([A-Za-z_$][\w$]*)\s*:/.exec(t);
    if (k) keys.push(k[1]);
  }
  return keys;
}

/** 从 `category: z.enum([...])` 里取允许值。 */
function categoryEnum(body) {
  const m = /category:\s*z\.enum\(\[([^\]]*)\]\)/.exec(body);
  return m ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : null;
}

const problems = [];
let checked = 0;
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.js')).sort()) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  for (const { name, body } of toolCalls(src)) {
    checked += 1;
    // 说明字符串 = 第一个参数（可能是拼接的，那就整段当说明扫）
    const descEnd = body.indexOf(`'${name}'`) + name.length + 2;
    const desc = body.slice(descEnd, Math.max(descEnd, body.indexOf('{', descEnd)));
    const keys = extraKeys(body);
    const mentioned = new Set([...desc.matchAll(/extra\.([A-Za-z_$][\w$]*)/g)].map((x) => x[1]));
    for (const key of mentioned) {
      if (keys && keys.includes(key)) continue;
      if (!keys && /extra\.[A-Za-z_$]/.test(desc)) {
        problems.push(`${file} · ${name}：说明里提到 extra.${key}，但这个工具没有 extra 参数`);
        continue;
      }
      if (keys) problems.push(`${file} · ${name}：说明里提到 extra.${key}，但 schema 的 extra 里没有它（zod 会**静默丢掉**）`);
    }
    const cats = categoryEnum(body);
    if (cats) {
      for (const cm of desc.matchAll(/category\s*[=＝]\s*['"]?([A-Za-z]+)/g)) {
        if (!cats.includes(cm[1])) problems.push(`${file} · ${name}：说明里提到 category=${cm[1]}，但枚举里只有 ${cats.join('/')}`);
      }
      // 说明里以 `mood=` 这种简写提到的类别
      for (const cm of desc.matchAll(/[（(]\s*([A-Za-z]+)=/g)) {
        const v = cm[1];
        if (['activeTopic', 'pendingThought', 'memberImpression', 'mood'].includes(v) && !cats.includes(v)) {
          problems.push(`${file} · ${name}：说明里提到类别 ${v}，但 category 枚举里没有它`);
        }
      }
    }
  }
}

if (problems.length) {
  console.log('❌ 工具说明与 schema 不一致（说明里承诺的参数，schema 里必须真有）：\n');
  for (const p of [...new Set(problems)]) console.log(`   ${p}`);
  console.log('\n症状：zod 对未声明的键**静默丢掉** —— 她以为写了、桥接什么都没收到，全程无人报错。');
  process.exit(1);
}
console.log(`✅ 检查了 ${checked} 个工具的说明与 schema：说明里提到的参数/类别都在 schema 里`);
