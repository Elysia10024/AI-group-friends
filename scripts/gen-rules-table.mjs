// 生成 docs/规则总表.md —— "改规则之前先看这张表"
//
// 她的人格与规则分散在五个载体（人格核心 / 速记 / 预设模板 / 每轮提示 / 工具描述），
// 改一处漏一处就是历史上所有翻车的成因。这张表把"每条规则在哪、数值从哪来、被谁引用"摊开，
// 让人在动手前就能看到影响面。跑法： npm run rules:table
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '<项目根>';
const OUT = path.join(ROOT, 'docs/规则总表.md');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');

const core = read(path.join(ROOT, 'roles/小鲸鱼/core.md'));
const digest = read(path.join(ROOT, 'roles/小鲸鱼/速记.core.md'));
const preset = read(path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml'));
const prompt = read(path.join(ROOT, 'src/core/prompt.js'));
const cfg = JSON.parse(read(path.join(ROOT, 'config.json')) || '{}');
const overlays = ['groups', 'private'].flatMap((d) => {
  const dir = path.join(ROOT, 'roles/小鲸鱼', d);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => `roles/小鲸鱼/${d}/${f}`) : [];
});

// 工具描述文件（也是规则载体）
const toolFiles = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.js')) toolFiles.push(p);
  }
};
walk(path.join(ROOT, 'src/mcp/tools'));

// 1) 人格核心的章节
const coreSections = [...core.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());

// 2) 速记规则 + 引用点
const rules = [...digest.matchAll(/R-(\d+)\s+([^：*]+?)\**\s*[：:]/g)].map((m) => ({ id: `R-${m[1]}`, title: m[2].trim() }));
const refSources = [
  ['预设模板', preset], ['每轮提示', prompt],
  ...toolFiles.map((p) => [`工具描述 ${path.basename(p)}`, read(p)])
];
for (const r of rules) {
  r.refs = refSources.filter(([, text]) => new RegExp(r.id.replace('-', '-')).test(text)).map(([n]) => n);
}

// 3) 关键数值：只认 config
const nums = [
  ['单条消息字数上限', '文案里的"≤20 字"', 'roles/小鲸鱼/core.md §四', '（写在文案里，改这里）'],
  ['一次最多几条', '3 条', 'roles/小鲸鱼/core.md §四 + 预设 16', '（写在文案里）'],
  ['记忆每次最多几条', '2 条', '速记 R-11 / 预设 19', '（写在文案里）'],
  ['图与表情频率', '每 3~4 轮最多 1 张', 'roles/小鲸鱼/core.md §十一', '（写在文案里）'],
  ['唤醒上限（每分/每时）', `${cfg?.socialV2?.wake?.maxWakePerMinute ?? '?'} / ${cfg?.socialV2?.wake?.maxWakePerHour ?? '?'}`, 'config.json socialV2.wake', 'config.json'],
  ['必须回唤醒硬顶', `${cfg?.socialV2?.wake?.maxMustWakePerMinute ?? '?'} / ${cfg?.socialV2?.wake?.maxMustWakePerHour ?? '?'}`, 'config.json socialV2.wake', 'config.json'],
  ['发送上限（每分/每时）', `${cfg?.socialV2?.send?.maxSendPerMinute ?? '?'} / ${cfg?.socialV2?.send?.maxSendPerHour ?? '?'}`, 'config.json socialV2.send', 'config.json'],
  ['等待上限', `${cfg?.socialV2?.wait?.maxMs ?? '?'} ms`, 'config.json socialV2.wait', 'config.json'],
  ['主动冒泡', `${cfg?.socialV2?.proactive?.enabled ? '开' : '关'}（每 ${Math.round((cfg?.socialV2?.proactive?.checkIntervalMinMs ?? 0) / 3600000)}~${Math.round((cfg?.socialV2?.proactive?.checkIntervalMaxMs ?? 0) / 3600000)} 小时一次，概率 ${cfg?.socialV2?.proactive?.probability}）`, 'config.json socialV2.proactive', 'config.json'],
  ['记忆展开上限', `${cfg?.socialV2?.context?.memoryMaxMembers ?? '?'} 人 × ${cfg?.socialV2?.context?.memoryMaxTraits ?? '?'} 条 × ${cfg?.socialV2?.context?.memoryTraitChars ?? '?'} 字`, 'config.json socialV2.context', 'config.json'],
  ['材料各块上限', '角色 14000 / 事实 5000 / 记忆 5000 / 黑话 1500 / 状态 800 / 最近 12000 / 触发 6000', 'src/core/assembler.js', 'src/core/assembler.js']
];

const md = [
  '# 规则总表（自动生成，别手改）',
  '',
  `> 生成时间：${new Date().toLocaleString('zh-CN')}　生成命令：\`npm run rules:table\``,
  '> **改规则之前先看这张表**：它告诉你每条规则的权威位置、数值来自哪里、以及被哪些地方引用。',
  '> 原则：**同一件事只写在一个地方**，别处只引用编号（R-xx）。',
  '',
  '## 一、五个载体各管什么',
  '',
  '| 载体 | 文件 | 管什么 |',
  '|---|---|---|',
  `| 人格层 | \`roles/小鲸鱼/core.md\`（${core.length} 字） | 她是谁、性格、情绪、说话方式、关系、撩与荤、冲突、日常 |`,
  `| 规则层 | \`roles/小鲸鱼/速记.core.md\`（${rules.length} 条） | 流程与硬规则（唤醒/收尾/工具/记忆/成本/安全），进预设=系统提示 |`,
  `| 会话层 | ${overlays.length} 个 overlay | 这个群/这个私聊的氛围、熟人、规矩（按会话注入材料） |`,
  `| 预设模板 | \`dsh/agent-presets/qq-chat-v2/agent.cordis.yml\` | 工具协议、安全规则、场景规则 |`,
  `| 每轮提示 | \`src/core/prompt.js\` | 只放"这一轮的事实与机械信息"，不再写人格 |`,
  '',
  '## 二、人格核心的章节（改哪一节看这里）',
  '',
  ...coreSections.map((s) => `- ${s}`),
  '',
  '## 三、速记规则与引用点',
  '',
  '| 编号 | 规则 | 被谁引用 |',
  '|---|---|---|',
  ...rules.map((r) => `| ${r.id} | ${r.title} | ${r.refs.length ? r.refs.join('、') : '—（暂无引用）'} |`),
  '',
  '## 四、关键数值：唯一来源',
  '',
  '| 项目 | 当前值 | 权威位置 | 改哪里 |',
  '|---|---|---|---|',
  ...nums.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`),
  '',
  '## 五、改规则的流程（SOP）',
  '',
  '1. 在这张表里找到**权威位置**（别在别处改）；',
  '2. 只改那一处；如果别处引用了编号，不用动；',
  '3. 跑 `npm run check:rules`（幽灵引用/数字一致/冲突词对/编号有效）；',
  '4. `node scripts/apply-persona.mjs --restart`（守卫不过会拒绝部署）；',
  '5. 在 `roles/CHANGELOG.md` 记一行：改了什么、为什么；',
  '6. 群里抽一句验证真实行为。',
  '',
  '## 六、守卫清单',
  '',
  '| 命令 | 管什么 |',
  '|---|---|',
  '| `npm run check:rules` | 规则层六项：幽灵引用 / 数字一致 / 冲突词对 / 编号有效 / 重复检测 / 覆盖 |',
  '| `npm run check:tool-refs` | 规则里点名的工具必须真实存在 |',
  '| `npm run check:module-ctx` | 模块解构的 ctx 名字都接上了 |',
  '| `npm run check:console-ui` | 前端配置面板与金标准一致 |',
  '| `npm run check:lines` | admin.js 行数上限 |',
  '| `npm run doctor` | 一键体检（内核/桥接/状态/依赖） |',
  '| `npm run selfcheck` | 上面全部跑一遍（watchdog 每天跑一次） |',
  ''
].join('\n');

fs.writeFileSync(OUT, md, 'utf8');
console.log(`已生成 ${OUT}（章节 ${coreSections.length}、规则 ${rules.length}、overlay ${overlays.length}）`);
