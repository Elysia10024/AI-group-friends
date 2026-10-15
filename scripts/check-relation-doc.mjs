// 把文档里写的硬事实，逐条回代码/人格核对（避免"文档说的和实现不一致"）。
import fs from 'node:fs';
const ROOT = '<项目目录>/qq-bridge-main';
const doc = fs.readFileSync(`${ROOT}/docs/关系升降档规则.md`, 'utf8');
const rel = fs.readFileSync(`${ROOT}/src/core/relation.js`, 'utf8');
const core = fs.readFileSync(`${ROOT}/roles/小鲸鱼/core.md`, 'utf8');
const social = fs.readFileSync(`${ROOT}/src/domains/social-state.js`, 'utf8');
const msg = fs.readFileSync(`${ROOT}/src/core/msg-line.js`, 'utf8');
const route = fs.readFileSync(`${ROOT}/src/console/routes/memory.js`, 'utf8');
const tool = fs.readFileSync(`${ROOT}/src/mcp/tools/memory.js`, 'utf8');

const TIERS = ['讨厌', '路人', '认识但不太熟', '熟人', '好朋友', '家人'];
const checks = [
  ['六档名字：代码里就是这六个', TIERS.every((t) => rel.includes(`'${t}'`))],
  ['六档名字：文档表格齐', TIERS.every((t) => doc.includes(`| **${t}** |`))],
  ['六档行为：人格里有对应表格行', TIERS.every((t) => core.includes(`| **${t}** |`))],
  ['主人恒为家人（代码裁决）', rel.includes('OWNER_TIER') && rel.includes('主人恒为家人')],
  ['家人只能给主人（代码裁决）', rel.includes('家人档只能由主人指定')],
  ['被改写会如实回报 adjusted（代码）', rel.includes('adjusted') && route.includes('decision.adjusted')],
  ['讨厌三条够格情形（人格）', core.includes('他冲你这个人来') && core.includes('踩硬线') && core.includes('明显冒犯还毫不收敛')],
  ['不算的四种（人格）', core.includes('一次难听话、玩梗、荤梗') && core.includes('心情差')],
  ['刚被惹那轮先别改档（人格）', core.includes('刚被惹到的那一轮先别改档')],
  ['心情不改档（人格）', core.includes('不用为此改档位')],
  ['升级靠被在意（人格）', core.includes('升级靠') && core.includes('被在意') && core.includes('被接住、被记得、被维护')],
  ['夸你不算（人格）', core.includes('夸你不算')],
  ['说得出哪件事才动（人格）', core.includes('说得出是哪件事、哪句话吗')],
  ['只给信息不给关系（人格）', core.includes('只给信息，不给关系')],
  ['记仇可以追击不行（人格）', core.includes('记仇可以，追击不行')],
  ['升档不用凑次数（人格）', core.includes('不用凑次数、不用攒什么')],
  ['relationNote 200 字上限（代码）', social.includes('relationNote = text.slice(0, 200)')],
  ['tag 40 字上限 + 空串清除（代码）', social.includes('tag = text.slice(0, 40)') && social.includes('delete rec.tag')],
  ['消息行只给三档挂标签（代码）', msg.includes("new Set(['讨厌', '好朋友', '家人'])")],
  ['改档只走 memory-append 一条路（代码）', route.includes('setPersonRelation(qq, decision.tier, content)')],
  ['「关系：X」也能认（代码）', route.includes('relationFromTrait(content)')],
  ['认不出人时印象照写、关系跳过（代码）', route.includes('认不出「') && route.includes('印象已经写进去了')],
  ['工具 schema 里 relation/tag 真的在（代码）', tool.includes('relation: z.enum(') && tool.includes('tag: z.string()')],
  ['文档点名了真相源文件', doc.includes('roles/小鲸鱼/core.md') && doc.includes('src/core/relation.js')],
  ['文档给出了 audit:stance 变更轨迹入口', doc.includes('audit:stance')],
];

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✅' : '❌'} ${name}`);
}
console.log(bad ? `  ❌ ${bad} 条与实现不符 —— 文档要改` : '  ✅ 文档里的硬事实全部与代码/人格一致');
