// 把小鲸鱼的模型从「DeepSeek 官方」切到「书生·端砚」网关（或一键回滚）。
//
// 为什么要有脚本而不是手改三个文件：
//   · 要动三处（凭据 .credentials.yaml / 内核 settings.yaml / 桥 config.json），漏一处就是"半切换"状态；
//   · 用户明确要求"谨慎些，不要弄出不可挽回的损失"——所以每次切换都先备份，并提供 --rollback。
//
// 机制（读内核源码确认过）：
//   · provider 仍是 `deepseek-official`，适配器是 @deepseek-ai/dsh-llm-deepseek；
//   · 它的配置可以在 **$DSH_HOME/settings.yaml 的 `llm-deepseek:` 段**里覆盖，而且**热生效**（Models 页面就是这么写的）；
//   · `baseURL` 指到网关、`apiKeyEnv` 指到凭据名、`models` 是**权威模型目录**（决定能不能选这个模型、
//     以及它能不能收图 —— 换成文本模型她会"看不见图"）；
//   · 具体用哪个模型由**桥**决定（config.json 的 dsh.provider / dsh.model，会话创建时下发）。
//
// 用法：
//   node scripts/switch-provider.mjs --status
//   node scripts/switch-provider.mjs --to inkstone --model qwen3.8-27b [--key sk-xxx]
//   node scripts/switch-provider.mjs --rollback
import fs from 'node:fs';
import path from 'node:path';

const HOME = '<项目目录>/dsh-home-legacy';
const CRED = `${HOME}/.credentials.yaml`;
const SETTINGS = `${HOME}/settings.yaml`;
const BRIDGE_CFG = '<项目目录>/qq-bridge-main/config.json';
const KEY_FILE = '<项目目录>/tmp/new-key.txt';
const BACKUP_DIR = '<项目目录>/tmp/provider-switch-backups';
const REF_NAME = 'INKSTONE_API_KEY';
const GATEWAY = 'https://discovery-api.intern-ai.org.cn/v1';
const MARK_BEGIN = '# === inkstone-gateway BEGIN (由 scripts/switch-provider.mjs 写入) ===';
const MARK_END = '# === inkstone-gateway END ===';

// 网关实际提供的模型（/models 拉到的原始清单 + 探测结论）
const CATALOG = {
  'qwen3.8-27b': { name: 'Qwen3.8-27B', image: true, ctx: 262144 },
  'kimi-k2.6': { name: 'Kimi-K2.6', image: true, ctx: 262144 },
  'deepseek-v4-flash-vision': { name: 'DeepSeek-V4-Flash-Vision', image: true, ctx: 262144 },
  'deepseek-v4-flash-0731': { name: 'DeepSeek-V4-Flash-0731', image: true, ctx: 262144 },
  'deepseek-v4-pro-0813': { name: 'DeepSeek-V4-Pro-0813', image: false, ctx: 262144 },
  'intern-s2': { name: '书生-S2', image: true, ctx: 262144 },
  'glm-5.3': { name: 'GLM-5.3', image: false, ctx: 262144 },
  'minimax-m3': { name: 'MiniMax-M3', image: false, ctx: 262144 },
  'Agents-A1': { name: 'Agents-A1', image: true, ctx: 262144 },
  'Atria-Dawn-Preview': { name: 'Atria-Dawn-Preview', image: false, ctx: 262144 }
};

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = '') => { const i = args.indexOf(f); return i >= 0 ? String(args[i + 1] ?? d) : d; };

const readKey = () => val('--key') || (fs.existsSync(KEY_FILE) ? fs.readFileSync(KEY_FILE, 'utf8').trim() : '');
const mask = (k) => (k ? `${k.slice(0, 10)}…${k.slice(-6)}` : '(无)');

function status() {
  const cred = fs.existsSync(CRED) ? fs.readFileSync(CRED, 'utf8') : '';
  const st = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, 'utf8') : '';
  const cfg = JSON.parse(fs.readFileSync(BRIDGE_CFG, 'utf8'));
  const hasBlock = st.includes(MARK_BEGIN);
  const hasRef = new RegExp(`^\\s*${REF_NAME}:`, 'm').test(cred);
  console.log('\n=== 当前状态 ===');
  console.log(`  网关覆盖（settings.yaml 里的 llm-deepseek 段）：${hasBlock ? '✅ 有 → 走书生·端砚' : '❌ 无 → 走 DeepSeek 官方'}`);
  console.log(`  新凭据 ${REF_NAME}：${hasRef ? '✅ 已在 .credentials.yaml 里' : '❌ 还没写'}`);
  console.log(`  DeepSeek 官方凭据 DEEPSEEK_API_KEY：${/^\s*DEEPSEEK_API_KEY:/m.test(cred) ? '✅ 仍在（回滚用）' : '❌ 不见了'}`);
  console.log(`  桥下发的模型：${cfg.dsh?.provider}/${cfg.dsh?.model}（effort=${cfg.dsh?.reasoningEffort}）`);
}

function backup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of [CRED, SETTINGS, BRIDGE_CFG]) {
    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
  }
  console.log(`  备份到：${dir}`);
  return dir;
}

function stripBlock(text) {
  const i = text.indexOf(MARK_BEGIN);
  if (i < 0) return text;
  const j = text.indexOf(MARK_END, i);
  const end = j < 0 ? text.length : j + MARK_END.length;
  return (text.slice(0, i) + text.slice(end)).replace(/\n{3,}/g, '\n\n');
}

function block(model) {
  const c = CATALOG[model];
  if (!c) throw new Error(`未知模型 ${model}（可用：${Object.keys(CATALOG).join(', ')}）`);
  const lines = [
    MARK_BEGIN,
    '# 把 deepseek-official 这个 provider 指到书生·端砚的 OpenAI 兼容网关。',
    '# 删掉这一段就回到 DeepSeek 官方（credentials 里两把 key 都留着，随时可切）。',
    'llm-deepseek:',
    `  baseURL: ${GATEWAY}`,
    `  apiKeyEnv: ${REF_NAME}`,
    '  models:',
    `    - id: ${model}`,
    `      name: ${c.name}`,
    `      inputModalities: [text${c.image ? ', image' : ''}]`,
    `      contextWindow: ${c.ctx}`,
    `      maxTokens: 32768`,
    MARK_END
  ];
  return lines.join('\n');
}

function setBridgeModel(model) {
  const raw = fs.readFileSync(BRIDGE_CFG, 'utf8');
  const cfg = JSON.parse(raw);
  const prev = cfg.dsh.model;
  cfg.dsh.model = model;
  fs.writeFileSync(BRIDGE_CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return prev;
}

// ── 动作 ────────────────────────────────────────────────────────────────
if (has('--status') || args.length === 0) { status(); process.exit(0); }

if (has('--rollback')) {
  console.log('\n=== 回滚到 DeepSeek 官方 ===');
  backup();
  const st = stripBlock(fs.readFileSync(SETTINGS, 'utf8'));
  fs.writeFileSync(SETTINGS, st, 'utf8');
  console.log('  ✅ settings.yaml 已移除网关覆盖');
  const prev = setBridgeModel('deepseek-v4-flash-vision-exp');
  console.log(`  ✅ 桥模型：${prev} → deepseek-v4-flash-vision-exp`);
  console.log('  ℹ️  凭据文件没动（两把 key 都在；DEEPSEEK_API_KEY 仍是官方那把）');
  console.log('  下一步：重启桥让模型设置生效 —— npm run restart（内核不用重启，settings 热生效）');
  status();
  process.exit(0);
}

if (has('--to')) {
  const to = val('--to');
  const model = val('--model');
  if (to !== 'inkstone') { console.log(`❌ 只支持 --to inkstone（收到 ${to}）`); process.exit(1); }
  if (!model) { console.log('❌ 要指定 --model。可用：' + Object.keys(CATALOG).join(', ')); process.exit(1); }
  const key = readKey();
  if (!key.startsWith('sk-')) { console.log('❌ 没拿到新 key（放 tmp/new-key.txt 或用 --key 传）'); process.exit(1); }

  console.log(`\n=== 切到书生·端砚网关（模型 ${model}）===`);
  backup();

  // 1) 凭据：新增一个 ref，不动 DEEPSEEK_API_KEY
  let cred = fs.readFileSync(CRED, 'utf8');
  if (new RegExp(`^\\s*${REF_NAME}:`, 'm').test(cred)) {
    cred = cred.replace(new RegExp(`^(\\s*${REF_NAME}:\\s*)\\S+`, 'm'), `$1${key}`);
    console.log(`  ✅ 更新凭据 ${REF_NAME} = ${mask(key)}`);
  } else {
    cred = cred.replace(/^refs:\s*$/m, `refs:\n  ${REF_NAME}: ${key}`);
    console.log(`  ✅ 新增凭据 ${REF_NAME} = ${mask(key)}（DEEPSEEK_API_KEY 保持不动）`);
  }
  fs.writeFileSync(CRED, cred, 'utf8');

  // 2) 内核：settings.yaml 里加覆盖段（热生效）
  const st = stripBlock(fs.readFileSync(SETTINGS, 'utf8')).replace(/\s*$/, '\n');
  fs.writeFileSync(SETTINGS, `${st}\n${block(model)}\n`, 'utf8');
  console.log('  ✅ settings.yaml 已写入 llm-deepseek 覆盖（内核热生效，不用重启）');

  // 3) 桥：下发新模型
  const prevModel = setBridgeModel(model);
  console.log(`  ✅ 桥模型：${prevModel} → ${model}`);

  console.log('\n  下一步：');
  console.log('   1) npm run restart            # 重启桥，让它把新模型下发给新会话');
  console.log('   2) 触发一轮验证（控制台 notify-ai，或直接在 QQ 里 @ 她一句）');
  console.log('   3) 出问题就回滚：node scripts/switch-provider.mjs --rollback && npm run restart');
  status();
  process.exit(0);
}

console.log('用法：--status | --to inkstone --model <id> | --rollback');
process.exit(1);
