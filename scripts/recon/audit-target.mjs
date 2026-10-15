// 目标模块划分：把 bridge.js 现有 191 个函数按职责归类，得出每个模块的真实体积
import fs from 'node:fs';

const SRC = '<项目目录>/qq-bridge-main/src/bridge.js';
const lines = fs.readFileSync(SRC, 'utf8').split('\n');

// 采集所有函数 + 行数
const fns = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  if (m) fns.push({ name: m[1], line: i + 1 });
}
for (let k = 0; k < fns.length; k++) fns[k].len = (k + 1 < fns.length ? fns[k + 1].line : lines.length) - fns[k].line;
for (const f of fns) f.idx = f.line;

// 控制台那 3037 行单独算（它内部还有自己的局部函数）
const CONSOLE = { name: 'startConsoleServer', len: 3037 };

// 归类规则：按名字前缀/关键字，顺序即优先级
const RULES = [
  ['console/http',        /^(startConsoleServer|sendJson|readBody|loadOrCreateConsoleToken|redactKnownTokensOnly)/],
  ['send',                /^(sendToQQ|sendBurstToQQ|sendMessagesV2|sendStickerV2|onebotSend|computeGapsV2|splitLongSegment|applySendGaps|recordSentMessagesV2|checkSendAllowed)/i],
  ['wake',                /(wake|Wake|sleep|Sleep|proactive|Proactive|followUp|FollowUp|pendingMention|scheduleReplyCheck)/],
  ['wake-prompt',         /(buildWakePrompt|buildWakeReminderPrompt|buildProactivePrompt|buildBatchPrompt|buildProbePrompt|buildActiveExitPrompt|groupStyleHint|currentRoleHint)/],
  ['memory',              /(memor|Memor|Impression|impression|activeTopic|pendingThought)/],
  ['social-state',        /(socialV2|SocialV2|appendSocial|loadSocialV2|saveSocialV2|getSocialV2|canonicalV2Key|isConversationBusyV2)/],
  ['social-legacy',       /(isSocialEnabled|appendRecentMessage|socialLoopTick|buildSocialState|currentMode)/],
  ['slang',               /(slang|Slang)/],
  ['sticker',             /(sticker|Sticker|face|Face)/],
  ['media',               /(image|Image|media|Media|fetchMedia|fetchOneBotImage|fetchFaceMedia|getImageDimensions|resolveMediaList)/],
  ['identity',            /(resolveAtName|resolveGroupMemberName|resolveReply|isQuoteTargetSelf|selfAlias|refreshSelfAliases|textMentionsSelf|rememberPendingMention|memberName)/],
  ['dsh',                 /(dsh|Dsh|DSH|ensureSession|pumpMux|deliverPrompt|processPromptQueue|drainPrompt|drainAllPromptQueues|createTurn|sessionReset|ensureSlangLearnerSession|invalidateSlangLearnerSession)/],
  ['config',              /(loadConfig|defaultWakeConfigV2|wakePolicyV2|mentionsOnlyV2|allowedKeywordsV2|readRoleState|currentRole|normalize|resolveConfig)/],
  ['state-io',            /(atomicWriteJson|loadOrCreate|readJson|save\w*State|load\w*State|acquireLock|releaseLock|archive)/],
  ['util',                /(segmentsToText|extractMediaFromSegments|looksLike|redact|truncate|sanitize|normalize|format|hasUsable|isNt|dropLegacy|stripForQQ|splitLong)/i]
];

const buckets = new Map(RULES.map(([n]) => [n, []]));
const unassigned = [];
for (const f of fns) {
  if (f.name === 'startConsoleServer') continue;
  const hit = RULES.find(([, re]) => re.test(f.name));
  if (hit) buckets.get(hit[0]).push(f);
  else unassigned.push(f);
}

const EXISTING = new Set(fs.readdirSync('<项目目录>/qq-bridge-main/src'));
const totalFnLines = fns.reduce((a, f) => a + f.len, 0);

console.log('=========== 重构后的模块划分（按职责聚合，数据来自实测）===========\n');
console.log('  模块                函数数   行数   占比   现文件   目标文件');
console.log('  ' + '-'.repeat(88));
const rows = [...buckets.entries()].map(([name, list]) => ({
  name, n: list.length, len: list.reduce((a, f) => a + f.len, 0), list
}));
// 控制台单独一行
const consoleRow = { name: 'console (已测)', n: 1, len: CONSOLE.len, list: [CONSOLE], isConsole: true };
rows.push(consoleRow);
rows.sort((a, b) => b.len - a.len);

const TARGET = {
  'console/http': 'src/console/server.js + routes/*.js',
  'console (已测)': 'src/console/*',
  send: 'src/core/send.js',
  wake: 'src/core/wake.js',
  'wake-prompt': 'src/core/prompt.js  ← 模板化',
  memory: 'src/core/memory.js',
  'social-state': 'src/core/social.js',
  'social-legacy': '（待确认后删除）',
  slang: 'src/slang/*.js',
  sticker: 'src/sticker/*.js',
  media: 'src/media/*.js',
  identity: 'src/core/identity.js',
  dsh: 'src/dsh/*.js',
  config: 'src/config.js  ← 单一入口',
  'state-io': 'src/state.js',
  util: 'src/util/*.js'
};

for (const r of rows) {
  const pct = ((r.len / (totalFnLines + CONSOLE.len)) * 100).toFixed(1);
  console.log('  ' + r.name.padEnd(20) + String(r.n).padStart(4) + '  ' + String(r.len).padStart(6) + '  ' + (pct + '%').padStart(6) + '   ' + (TARGET[r.name] || '').padEnd(20));
}

console.log('\n=========== 未归类的函数（需要人工判断）===========');
console.log('  共 ' + unassigned.length + ' 个 / ' + unassigned.reduce((a, f) => a + f.len, 0) + ' 行');
for (const f of unassigned.sort((a, b) => b.len - a.len).slice(0, 30)) console.log('    ' + String(f.len).padStart(5) + '  ' + f.name);

console.log('\n=========== 遗留：模块外的部分 ===========');
console.log('  src/mcp-snowluma-safe.js  1092 行  → 已是独立模块，改为走内核内调用而非 HTTP 自打（可选）');
console.log('  src/mcp-host-server.js       ? 行  → 独立');
console.log('  src/mcp-web-search-safe.js   ? 行  → 独立');
console.log('  src/dsh-client.js          158 行  → 独立');
console.log('  scripts/*.mjs               17 个   → scripts/test + scripts/audit + scripts/inspect');
console.log('  根目录 *.mjs               109 个   → archive/patches/ + scripts/');
console.log('  SnowLuma 补丁              2 处     → patches/snowluma/ + 启动自检');

console.log('\n=========== 现有 src/ 模块归属 ===========');
for (const f of [...EXISTING].sort()) console.log('    src/' + f);
