// 记忆注入的实际成本占比：能不能靠"数据库+定向查找"省下来
import fs from 'node:fs';

const STATE = '<项目根>/state/social-v2.json';
const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const st = j.conversations['group:20000001'] ?? {};

const members = st.memberImpressions ?? {};
const topics = st.activeTopics ?? [];
const thoughts = st.pendingThoughts ?? [];

let traitCount = 0, traitChars = 0;
for (const [who, v] of Object.entries(members)) {
  const traits = Array.isArray(v?.traits) ? v.traits : (Array.isArray(v) ? v : []);
  traitCount += traits.length;
  for (const t of traits) traitChars += String(typeof t === 'string' ? t : (t?.text ?? '')).length;
}

console.log('=== 1) 记忆库现状 ===');
console.log('  成员印象: ' + Object.keys(members).length + ' 人 / ' + traitCount + ' 条 / ' + traitChars + ' 字符');
console.log('  进行中话题: ' + topics.length + ' 条');
console.log('  未说出口的想法: ' + thoughts.length + ' 条');

// 复现 formatMemoryV2 的渲染规则（memoryMaxMembers=24, memoryMaxTraits=3, memoryTraitChars=170）
const MAX_MEMBERS = 24, MAX_TRAITS = 3, TRAIT_CHARS = 170;
const sorted = Object.entries(members)
  .map(([k, v]) => ({ name: k, lastSeenAt: Number(v?.lastSeenAt || 0), traits: Array.isArray(v?.traits) ? v.traits : (Array.isArray(v) ? v : []) }))
  .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  .slice(0, MAX_MEMBERS);

let rendered = 0;
const perMember = [];
for (const m of sorted) {
  const ts = m.traits.slice(-MAX_TRAITS).map((t) => String(typeof t === 'string' ? t : (t?.text ?? '')).slice(0, TRAIT_CHARS));
  const len = m.name.length + ts.join('').length + 8;
  rendered += len;
  perMember.push({ name: m.name, len, traits: ts.length });
}
let topicRendered = 0;
for (const t of topics.slice(0, 10)) topicRendered += String(t?.topic ?? t?.text ?? JSON.stringify(t)).length + 12;
let thoughtRendered = 0;
for (const t of thoughts.slice(0, 5)) thoughtRendered += String(t?.text ?? t).length + 12;

console.log('\n=== 2) formatMemoryV2 每回合实际注入 ===');
console.log('  成员印象段: ' + rendered + ' 字符（渲染 ' + sorted.length + ' 人，上限 24）');
console.log('  话题段:     ' + topicRendered + ' 字符');
console.log('  想法段:     ' + thoughtRendered + ' 字符');
const totalChars = rendered + topicRendered + thoughtRendered;
const estTokens = Math.round(totalChars / 1.8);
console.log('  合计:       ' + totalChars + ' 字符 ≈ ' + estTokens + ' token/回合');
console.log('  最长 5 个成员: ' + perMember.sort((a, b) => b.len - a.len).slice(0, 5).map((m) => m.name + '(' + m.len + ')').join(', '));

console.log('\n=== 3) 换算成钱（用实测的稳态参数）===');
const MISS_PEAK = 0.30 / 1e6;      // 未命中价（97% 落在高峰）
const HIT_PEAK = 0.006 / 1e6;      // 命中价
const CTX = 176638;                // 上下文
const CNY = 7.1;
const PER_TURN = 0.0668;           // 实测 ¥/回合

const memCostUsd = estTokens * MISS_PEAK;   // 唤醒提示词是新的 user 消息 → 未命中价
console.log('  记忆注入本身（未命中价）: $' + memCostUsd.toFixed(6) + ' = ¥' + (memCostUsd * CNY).toFixed(4) + '/回合');
console.log('  占实测 ¥0.0668/回合 的: ' + ((memCostUsd * CNY / PER_TURN) * 100).toFixed(1) + '%');

console.log('\n=== 4) 如果改成「她调工具定向查记忆」===');
const addHit = CTX * HIT_PEAK;
const addMiss = 6000 * MISS_PEAK;
const addCost = addHit + addMiss;
console.log('  +1 次请求 = 重读上下文 $' + addHit.toFixed(6) + ' + 新增内容 $' + addMiss.toFixed(6));
console.log('  = $' + addCost.toFixed(6) + ' = ¥' + (addCost * CNY).toFixed(4) + '/回合');
console.log('  省下的记忆注入: ¥' + (memCostUsd * CNY).toFixed(4) + '/回合');
const net = addCost * CNY - memCostUsd * CNY;
console.log('  净变化: ' + (net > 0 ? '贵了 ¥' + net.toFixed(4) : '省了 ¥' + (-net).toFixed(4)) + '/回合  （倍数 ' + (addCost / memCostUsd).toFixed(1) + 'x）');

console.log('\n=== 5) 如果改成「桥用代码查好再注入」===');
// 只注入当前上下文里出现的人（假设最近群聊 60 条里有 5 个人）
const activeNames = new Set();
for (const m of (st.recentMessages ?? []).slice(-60)) { if (m && !m.isSelf && m.sender) activeNames.add(String(m.sender)); }
let targeted = 0;
for (const m of sorted) if ([...activeNames].some((n) => n.includes(m.name) || m.name.includes(n))) targeted += perMember.find((x) => x.name === m.name).len;
console.log('  最近 60 条里出现过的发言人: ' + activeNames.size + ' 个');
console.log('  定向后成员段: ' + targeted + ' 字符（原 ' + rendered + '，省 ' + Math.round((1 - targeted / Math.max(1, rendered)) * 100) + '%）');
const savedUsd = Math.round((rendered - targeted) / 1.8) * MISS_PEAK;
console.log('  省下: $' + savedUsd.toFixed(6) + ' = ¥' + (savedUsd * CNY).toFixed(4) + '/回合  （占 ' + ((savedUsd * CNY / PER_TURN) * 100).toFixed(1) + '%）');
console.log('  额外请求: 0（桥侧做完再拼进 prompt）');
