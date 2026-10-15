// 记忆纪律检查：找出**规范她"怎么说话/怎么处事"**的记忆条目（这些本不该进记忆）。
//
// 为什么要这个检查（2026-09-20）：管理员发现"记忆影响太大"——她的记忆里攒了 24 条
// "怎么应对他""别上火力""接下来只接被点名的"这种**规矩**，而规矩本该只由人设（速记/角色卡）决定。
// 更糟的是记忆里的规矩会跟人设打架：人设要她主动调戏，记忆却叫她"只接被点名的、不主动加火力"，
// 结果她变得又被动又拖（群里评价"能拖则拖吗这是"）。
//
// 所以：记忆只该记**事实**（谁是谁/喜欢什么/作息/外号/答应过的事/发生过的事）。
// 用法：npm run audit:memory —— 理想输出是"没有规范类条目"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.resolve(HERE, '../../state/social-v2.json');
const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));

// 只匹配**祈使/规范**句式，不匹配"他喜欢被撩"这类事实描述（那是允许的）。
// 注意 `接一句` 要带后续（"接一句就行/就够/不带刺"）——光"接一句"会误伤"他接一句梗"这种事实描述。
const RULE = /(应对|接法|接一句(就行|就够|不带刺|带过)|别上火力|别对他凶|别太冷|别凶|别怼|可以怼|收手|别追|软档|给台阶|别自证|不接前提|上火力|顶回去|要主动|主动压|怎么接|该给|别真回答|不用接|别接|别去搜|规矩|策略|套路|处理方式|保持主动|占便宜|只接被点名|不主动加火力|别再|不许再|下次|以后遇到)/;

let ruleN = 0;
let factN = 0;
const hits = [];
for (const [key, conv] of Object.entries(st.conversations || {})) {
  for (const [name, v] of Object.entries(conv.memberImpressions || {})) {
    for (const t of v.traits || []) {
      if (RULE.test(String(t))) { ruleN++; hits.push(`[印象] ${key} / ${name}：${t}`); } else factN++;
    }
  }
  for (const t of conv.activeTopics || []) {
    if (RULE.test(String(t?.text ?? ''))) { ruleN++; hits.push(`[话题] ${key}：${t.text}`); } else factN++;
  }
  for (const t of conv.pendingThoughts || []) {
    if (RULE.test(String(t?.text ?? ''))) { ruleN++; hits.push(`[想法] ${key}：${t.text}`); } else factN++;
  }
}

console.log(`记忆条目：事实类 ${factN} 条，疑似规范类 ${ruleN} 条`);

// 人称指代检查（只提醒、不算失败）：印象条目**以"他/她"开头**时，指代容易串人。
// 真实事故（2026-10-02）：一条以"她"开头的印象，让她在群里把两个人的名字答成同一个人。
const PRONOUN = /^\s*(他|她|祂|它|ta|TA)[的了]?/;
const pronounHits = [];
for (const [key, conv] of Object.entries(st.conversations || {})) {
  for (const [name, v] of Object.entries(conv.memberImpressions || {})) {
    for (const t of v.traits || []) {
      const s = String(t);
      if (!/^关系：/.test(s) && PRONOUN.test(s)) pronounHits.push(`[印象] ${key} / ${name}：${s}`);
    }
  }
}
if (pronounHits.length) {
  console.log(`\n⚠️ 有 ${pronounHits.length} 条印象以"他/她"开头，指代容易串人（建议改成"名字：…"）：`);
  for (const h of pronounHits.slice(0, 8)) console.log('  - ' + h);
  if (pronounHits.length > 8) console.log(`  ……还有 ${pronounHits.length - 8} 条`);
}
if (ruleN) {
  console.log('\n⚠️ 下面这些像"告诉她该怎么办"，本该只在人设里：');
  for (const h of hits) console.log('  - ' + h);
  console.log('\n处理：能改成事实就改成事实（"他是谁/发生过什么"），改不了就删。');
  process.exit(1);
}
console.log('✅ 没有规范类条目：记忆只记事实。');
