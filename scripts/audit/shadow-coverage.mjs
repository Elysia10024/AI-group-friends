// 影子材料覆盖度核对：**组装出来的材料，有没有漏掉她现在实际能看到的东西**。
//
// 这是 A1.1（真正切换）前的最后一道闸。为什么必须自动查：漏料的表现是"她失忆"，而且是静默的。
// 检查四类关键信息（前两类是"错过就出事"的）：
//   1. 有人在找她的原文（@ / 叫名字 / 拍一拍）——漏了就等于她"没看见有人叫她"
//   2. owner（管理员）说过的话 —— 漏了就是"没听你的"
//   3. 她自己的 pendingThoughts（她记下的行为准则，例如"收到关闭聊天功能后要静默"）
//   4. 长期事实 memberImpressions（关于人和群的印象）
//
// 用法：
//   node scripts/audit/shadow-coverage.mjs            # 查最近 5 份影子留档
//   node scripts/audit/shadow-coverage.mjs --limit 20
//   node scripts/audit/shadow-coverage.mjs --self-test # 负控：故意造一份缺料的，必须被抓到
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SHADOW = path.join(ROOT, 'state', 'context-shadow.json');
const STATE = path.join(ROOT, 'state', 'social-v2.json');
const args = process.argv.slice(2);
const limit = Number((args[args.indexOf('--limit') + 1] || '').trim()) || 5;
const selfTest = args.includes('--self-test');

const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };

/** 覆盖度判定（纯函数，便于自测）。 */
export function coverage(entry, st, ownerQQ) {
  const text = String(entry?.text ?? '');
  const missing = [];
  const note = (label, ok) => { if (!ok) missing.push(label); };

  // 1) 有人在找她的原文
  const mentions = (Array.isArray(st?.pendingMentions) ? st.pendingMentions : [])
    .filter((m) => m && Date.now() - (Number(m.at) || 0) < 2 * 3600000);
  const unreadAt = (Array.isArray(st?.unread) ? st.unread : []).filter((m) => m?.quoteTargetIsSelf);
  for (const m of [...mentions, ...unreadAt].slice(-3)) {
    const t = String(m?.text ?? '').trim();
    if (t && !text.includes(t.slice(0, 20))) { note(`找她的原文「${t.slice(0, 16)}…」`, false); break; }
  }

  // 2) owner 说过的话
  const ownerLines = (Array.isArray(st?.recentMessages) ? st.recentMessages : [])
    .filter((m) => m && (m.isOwner || String(m.sender) === String(ownerQQ)))
    .slice(-2);
  for (const m of ownerLines) {
    const t = String(m?.plain ?? m?.text ?? '').trim();
    if (t && !text.includes(t.slice(0, 20))) { note(`owner 的话「${t.slice(0, 16)}…」`, false); break; }
  }

  // 3) 她自己的行为准则
  for (const th of (Array.isArray(st?.pendingThoughts) ? st.pendingThoughts : []).slice(-2)) {
    const t = String(th?.text ?? '').trim();
    if (t && !text.includes(t.slice(0, 16))) { note(`她的待办/准则「${t.slice(0, 14)}…」`, false); break; }
  }

  // 4) 长期事实（抽查前 3 条，认前 12 个字）
  const imp = st?.memberImpressions && typeof st.memberImpressions === 'object' ? Object.entries(st.memberImpressions) : [];
  let impHit = 0;
  for (const [who, v] of imp.slice(0, 3)) {
    const trait = Array.isArray(v?.traits) ? String(v.traits[0] ?? '') : '';
    if (text.includes(String(who).slice(0, 6)) || (trait && text.includes(trait.slice(0, 12)))) impHit += 1;
  }
  if (imp.length && impHit === 0) note('长期事实（memberImpressions 一条都没进材料）', false);

  return { missing, estTokens: entry?.estTokens ?? 0, chars: entry?.chars ?? 0, blocks: entry?.byBlock ?? {} };
}

if (selfTest) {
  // 负控：造一份"什么都没装"的材料，必须报缺（否则这脚本是空转的）
  const st = {
    pendingMentions: [{ at: Date.now(), text: '在吗在吗' }],
    unread: [],
    recentMessages: [{ isOwner: true, plain: '帮我盯一下群' }],
    pendingThoughts: [{ text: '关闭聊天功能后要静默' }],
    memberImpressions: { 阿明: { traits: ['喜欢猫'] } }
  };
  const good = { text: '在吗在吗\n帮我盯一下群\n关闭聊天功能后要静默\n阿明：喜欢猫', estTokens: 100 };
  const bad = { text: '（空材料）', estTokens: 1 };
  const rGood = coverage(good, st, 1);
  const rBad = coverage(bad, st, 1);
  const pass = rGood.missing.length === 0 && rBad.missing.length >= 3;
  console.log(`${pass ? '✅' : '❌'} 自测：全材料 → 缺 ${rGood.missing.length} 项；空材料 → 缺 ${rBad.missing.length} 项`);
  if (!pass) { console.log('   空材料识别出的缺项：', rBad.missing); process.exit(1); }
  process.exit(0);
}

const shadow = readJson(SHADOW, { entries: [] });
const state = readJson(STATE, { conversations: {} });
const cfg = readJson(path.join(ROOT, 'config.json'), {});
const all = Array.isArray(shadow?.entries) ? shadow.entries : [];

// **只核对每个会话的最新一份**：影子留档记的是"那一刻"的材料，而状态（未读/待办/最近消息）
// 之后一直在变 —— 拿今天的状态去比一小时前的留档，只会得到假缺口（第一版就是这么误报的）。
const latestPerKey = new Map();
for (const e of all) latestPerKey.set(e.key, e);
const entries = [...latestPerKey.values()].slice(-limit);

if (!entries.length) {
  console.log('还没有影子留档（state/context-shadow.json 为空）。让她跑一个回合并确认 assembler.shadow 没被关掉。');
  process.exit(0);
}

console.log(`影子覆盖度核对（每个会话只查最新一份，共 ${entries.length} 个会话；总留档 ${all.length} 份）\n`);
let bad = 0;
for (const e of entries) {
  const st = state.conversations?.[e.key] ?? {};
  const r = coverage(e, st, cfg.ownerQQ);
  const when = new Date(e.at).toLocaleString();
  const blocks = Object.entries(r.blocks).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (r.missing.length) {
    bad += 1;
    console.log(`❌ ${when}｜${e.key}｜约 ${r.estTokens} token｜缺 ${r.missing.length} 项`);
    for (const m of r.missing) console.log(`     - ${m}`);
  } else {
    console.log(`✅ ${when}｜${e.key}｜约 ${r.estTokens} token｜四类关键信息都在`);
  }
  console.log(`     ${blocks}`);
}
console.log(bad ? `\n❌ ${bad}/${entries.length} 份有缺料 —— **先别切 A1.1**，先补上缺的那类材料` : `\n✅ ${entries.length} 份都没缺料，可以考虑切 A1.1（材料先宁可多给）`);
process.exit(bad ? 1 : 0);
