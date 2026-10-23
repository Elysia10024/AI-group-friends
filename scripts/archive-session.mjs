// 会话归档导出器：把 DSH 会话的原始记录（jsonl.zstd，动辄上百 MB、几万行）
// 瘦成**人可读、可 grep、可进 git**的 markdown 转录，放在 `docs/会话归档/transcripts/`。
//
// 为什么要有它（2026-10-13 主人问"压缩会话会损失什么"）：
//   · 原始记录**本来就在**磁盘上、一直在保存 —— 缺的不是"存"，是"**需要时读得起**"：
//     那个会话解压后 148MB / 5 万行，混着工具返回、base64、重复的系统提示，想找一句话得先解压再翻；
//   · 而真正值钱的是很小一部分：主人的原话、我的结论、跑过什么、交付了什么、以及**压缩点摘要**。
//     实测 148MB 里 text 字段合计 40MB，工具参数 23MB（其中大半是我写进仓库的文件内容，仓库里已有）。
//
// 设计取舍（都是刻意的）：
//   · **白名单式**：只认下面那几类记录；其余（system prompt / 材料 / 请求头 / 流式分片…）一律不写。
//   · **不存思考链**（reasoning）：它是最大的一块，且大多是重复推演；要的话加 `--with-reasoning`。
//   · **不存工具返回正文**（只记工具名 + 失败与否）：那是噪声，要内容就重跑/重读。
//   · 工具参数只挑几个**安全键**（file_path / pattern / description / query…），**绝不写 command**
//     —— 命令行里出现过 `Authorization: Bearer <token>`，写进去就是事故。
//   · **脱敏是硬闸门**：导出后先扫一遍 token/cookie 特征与真实凭据值，命中就**拒绝写盘**并报出位置。
//
// 用法：
//   node scripts/archive-session.mjs                       # 默认：桌面 home 里最近改动的会话
//   node scripts/archive-session.mjs --session 1f6fc39a    # 指定会话 id 前缀
//   node scripts/archive-session.mjs --root legacy         # 桥接那套（dsh-home-legacy）
//   node scripts/archive-session.mjs --all --root desktop  # 该 home 下所有会话（首次建库用）
//   node scripts/archive-session.mjs --dry                 # 只统计，不写盘
//   node scripts/archive-session.mjs --with-reasoning      # 连思考链一起导出（会大很多）
import fs from 'node:fs';
import path from 'node:path';
import { decompressSession } from './audit/audit-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', '会话归档', 'transcripts');
const HOMES = {
  desktop: path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'),
  legacy: '<项目根>/dsh-home-legacy/sessions'
};

const argvVal = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const has = (name) => process.argv.includes(`--${name}`);
const homeName = argvVal('root') ?? 'desktop';
const homeRoot = HOMES[homeName];
if (!homeRoot || !fs.existsSync(homeRoot)) throw new Error(`找不到 home：${homeName}（${homeRoot}）`);
const withReasoning = has('with-reasoning');
const dry = has('dry');
const sessionPrefix = argvVal('session');
const all = has('all');

/** 本地时间 `MM-DD HH:mm`。 */
const stamp = (ms) => {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dayOf = (ms) => {
  const d = new Date(Number(ms) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 工具参数里**允许出现**的键（其余一律不写）。 */
const SAFE_ARG_KEYS = ['file_path', 'path', 'pattern', 'description', 'query', 'queries', 'name', 'url'];
/** 允许的 URL（避免把带签名的图片地址写进归档）。 */
const safeUrl = (u) => {
  const s = String(u ?? '');
  if (!/^https?:\/\//.test(s)) return '';
  if (/[?&](token|sig|sign|signature|key|skey|p_skey|auth)=/i.test(s)) return s.split('?')[0] + '?…(带签名，已省略)';
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
};

function argHint(argsJson) {
  let a = null;
  try { a = typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson; } catch { return ''; }
  if (!a || typeof a !== 'object') return '';
  const bits = [];
  for (const k of SAFE_ARG_KEYS) {
    if (a[k] == null) continue;
    let v = Array.isArray(a[k]) ? a[k].join(' ') : String(a[k]);
    if (k === 'url') { v = safeUrl(v); if (!v) continue; }
    if (k === 'queries') { /* 已 join */ }
    bits.push(v.replace(/\s+/g, ' ').slice(0, 90));
  }
  return bits.join(' · ');
}

/** 收集会话文件（两个文件名都认，取最大的）。 */
function findSessions(root) {
  const out = [];
  for (const ws of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const wsDir = path.join(root, ws);
    for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!s.isDirectory() || !s.name.startsWith('session-')) continue;
      if (sessionPrefix && !s.name.includes(sessionPrefix)) continue;
      const dir = path.join(wsDir, s.name);
      let best = null;
      for (const f of fs.readdirSync(dir)) {
        if (!/^session.*\.jsonl\.zstd$/.test(f)) continue;
        const fp = path.join(dir, f);
        const size = fs.statSync(fp).size;
        if (!best || size > best.size) best = { file: fp, size };
      }
      if (best && best.size > 0) out.push({ sid: s.name, workspace: ws, ...best });
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

/** 把一条会话的原始文本抽成"条目"数组。 */
function extract(raw) {
  const items = [];
  const seenUserIds = new Set();
  const callNames = new Map();   // callId -> tool name
  const failCalls = new Set();
  for (const line of raw.split('\n')) {
    if (!line.includes('"type"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const d = j.data ?? {};
    switch (j.type) {
      case 'session':
        items.push({ t: Number(j.createdAt) || 0, kind: 'meta', text: `会话 ${j.id}｜工作目录 ${j.cwd ?? '?'}｜预设 ${j.agentPreset ?? '?'}` });
        break;
      case 'turn/start':
        items.push({ t: Number(j.time) || 0, kind: 'turn', text: `回合 ${d.turn}` });
        break;
      case 'user/message': {
        // 只留**主人说的**（source.kind === 'user'）；插件/审批提示等系统注入的不进归档
        if (String(d.source?.kind ?? '') !== 'user') break;
        if (d.id && seenUserIds.has(d.id)) break;
        if (d.id) seenUserIds.add(d.id);
        const text = (d.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
        if (text) items.push({ t: Number(j.time) || 0, kind: 'user', text });
        break;
      }
      case 'agent/inbox/spliced': {
        // 回合进行中插进来的话（例如"继续"）也在这里，同样只留 kind=user
        for (const ins of d.inserted ?? []) {
          if (String(ins?.source?.kind ?? '') !== 'user') continue;
          if (ins.id && seenUserIds.has(ins.id)) continue;
          if (ins.id) seenUserIds.add(ins.id);
          const text = (ins.content ?? []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
          if (text) items.push({ t: Number(j.time) || 0, kind: 'user', text });
        }
        break;
      }
      case 'assistant/message': {
        const content = d.message?.content ?? [];
        const text = content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n').trim();
        if (text) items.push({ t: Number(j.time) || 0, kind: 'assistant', text });
        if (withReasoning) {
          const reasoning = content.filter((c) => c?.type === 'reasoning').map((c) => c.text).join('\n').trim();
          if (reasoning) items.push({ t: Number(j.time) || 0, kind: 'reasoning', text: reasoning });
        }
        for (const c of content) {
          if (c?.type === 'tool-call') items.push({ t: Number(j.time) || 0, kind: 'tool', text: `${c.name}${argHint(c.arguments) ? ` — ${argHint(c.arguments)}` : ''}`, callId: c.id });
        }
        break;
      }
      case 'tool/call':
        callNames.set(String(d.callId ?? ''), String(d.name ?? ''));
        break;
      case 'tool/result': {
        const ok = d.ok !== false && d.isError !== true && !(d.error && !d.ok);
        if (!ok) {
          // callId 的坑：`tool/result` 里它藏在 `data.message.source.callId`（不是 data.callId），
          // 于是第一版把工具名全解析成了"工具"；错误正文在 `data.message.content[0].content[0].text`。
          const callId = String(d.callId ?? d.message?.source?.callId ?? d.message?.content?.[0]?.toolCallId ?? '');
          const name = callNames.get(callId) ?? d.name ?? d.tool ?? '工具';
          const inner = d.message?.content?.[0]?.content?.[0]?.text;
          const reason = typeof inner === 'string' && inner.trim()
            ? inner.trim().replace(/\s+/g, ' ')
            : (typeof d.error === 'string' ? d.error : (d.error?.code ?? (d.error ? JSON.stringify(d.error) : '')));
          items.push({ t: Number(j.time) || 0, kind: 'toolfail', text: `${name} 失败${reason ? `：${String(reason).slice(0, 140)}` : ''}` });
        }
        break;
      }
      case 'compaction/summary': {
        const text = String(d.text ?? d.summary ?? '').trim();
        if (text) items.push({ t: Number(j.time) || 0, kind: 'compaction', text });
        break;
      }
      case 'deliverables/presented':
        for (const f of d.files ?? []) {
          const p = typeof f === 'string' ? f : (f?.path ?? '');
          if (p) items.push({ t: Number(j.time) || 0, kind: 'deliverable', text: String(p) });
        }
        break;
      default:
        break;
    }
  }
  return items.sort((a, b) => a.t - b.t);
}

/** 按本地日期分组成 markdown（一天一个文件，避免单文件过大）。 */
function render(items, sid, workspace) {
  const byDay = new Map();
  for (const it of items) {
    const day = dayOf(it.t || Date.now());
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(it);
  }
  const files = [];
  for (const [day, list] of byDay) {
    const lines = [
      `# 会话转录 ${day}（${sid.slice(0, 20)}）`,
      '',
      `> 自动导出，**已脱敏**：只保留主人与我的对话、工具名、压缩点摘要、交付文件。`,
      `> 工具返回正文、思考链、系统提示、材料、命令行原文都**不在**这里 —— 要那些请回原始会话文件。`,
      `> 工作区：\`${workspace}\`｜导出：\`node scripts/archive-session.mjs\``,
      ''
    ];
    let lastTurn = null;
    for (const it of list) {
      if (it.kind === 'meta') { lines.push(`<!-- ${it.text} -->`, ''); continue; }
      if (it.kind === 'turn') {
        if (it.text !== lastTurn) { lines.push('', `### ${it.text}（${stamp(it.t)}）`, ''); lastTurn = it.text; }
        continue;
      }
      if (it.kind === 'user') { lines.push(`**你**（${stamp(it.t)}）：${it.text}`, ''); continue; }
      if (it.kind === 'assistant') { lines.push(`**我**（${stamp(it.t)}）：${it.text}`, ''); continue; }
      if (it.kind === 'reasoning') { lines.push(`<details><summary>思考（${stamp(it.t)}）</summary>`, '', it.text, '', '</details>', ''); continue; }
      if (it.kind === 'tool') { lines.push(`- 🔧 \`${it.text}\``); continue; }
      if (it.kind === 'toolfail') { lines.push(`- ❌ \`${it.text}\``); continue; }
      if (it.kind === 'deliverable') { lines.push(`- 📦 交付 \`${it.text}\``); continue; }
      if (it.kind === 'compaction') { lines.push('', `> **【压缩点】** ${it.text.replace(/\n+/g, ' ').slice(0, 1200)}`, ''); continue; }
    }
    files.push({ day, text: lines.join('\n') + '\n' });
  }
  return files;
}

/** 敏感形态（脱敏与复验共用同一套；改这里两处都跟着变）。 */
function redactionRules() {
  const patterns = [
    [/POI-[A-Za-z0-9_-]{10,}/g, 'OneBot accessToken'],
    [/Bearer\s+[A-Za-z0-9._-]{12,}/g, 'Bearer token'],
    [/\bsk-[A-Za-z0-9]{12,}/g, 'API key'],
    [/(skey|p_skey|p_uin|pt4_token)=[^;\s"']{6,}/g, 'QQ cookie'],
    [/x-console-token["'\s:]+[A-Za-z0-9_-]{12,}/gi, 'console token'],
    [/"(accessToken|consoleToken|agentToken|apiKey)"\s*:\s*"[^"]{12,}"/g, '配置里的令牌字段']
  ];
  // 再把"真实凭据值"逐个精确匹配一遍（防止上面漏掉的形态）
  const secrets = new Set();
  const push = (v) => { const s = String(v ?? '').trim(); if (s.length >= 16) secrets.add(s); };
  try {
    const cfg = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8').replace(/^\uFEFF/, ''));
    push(cfg?.snowluma?.accessToken); push(cfg?.consoleToken);
  } catch { /* 没配置就算了 */ }
  try { push(fs.readFileSync(`${ROOT}/state/console-token`, 'utf8')); } catch { /* 没有就算了 */ }
  try {
    const sv2 = JSON.parse(fs.readFileSync(`${ROOT}/state/social-v2.json`, 'utf8').replace(/^\uFEFF/, ''));
    for (const st of Object.values(sv2.conversations ?? {})) push(st?.agentToken);
  } catch { /* 没有就算了 */ }
  // 「前缀式」泄漏：我平时会在对话/日志里写 `56ab5eec…` 这种**截断的前 8 位**（不是凭据本身，
  // 但它是指向凭据的线索，进 git 不合适）。既然真实值在手，就按前缀精确打掉。
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const s of [...secrets]) {
    if (s.length < 16) continue;
    patterns.push([new RegExp(`${escapeRe(s.slice(0, 8))}…?`, 'g'), '凭据前缀']);
  }
  return { patterns, secrets };
}

/**
 * 就地脱敏：把命中的凭据换成占位符，并报出**种类与数量**（不报值）。
 * 为什么不是"命中就整份作废"：实测这份会话里有 4 处命中，整份作废等于归档永远建不起来；
 * 而只丢那几条消息又会把上下文割碎。就地打码 + **打码后复验**（下面 assertClean）才是可用的。
 */
function redactText(text) {
  const { patterns, secrets } = redactionRules();
  let out = text;
  const hits = [];
  for (const [re, label] of patterns) {
    const m = out.match(re);
    if (!m) continue;
    hits.push(`${label}×${m.length}`);
    out = out.replace(re, `«已脱敏：${label}»`);
  }
  for (const s of secrets) {
    if (!out.includes(s)) continue;
    hits.push('真实凭据值×1');
    out = out.split(s).join('«已脱敏：凭据»');
  }
  return { text: out, hits };
}

/** 复验：脱敏之后**必须一点不剩**，还剩就拒绝写盘（宁可没归档，也不能把凭据写进 git）。 */
function assertClean(text) {
  const { patterns, secrets } = redactionRules();
  const left = [];
  for (const [re, label] of patterns) {
    const m = text.match(re);
    if (m) left.push(`${label} × ${m.length}`);
  }
  for (const s of secrets) if (text.includes(s)) left.push('真实凭据值');
  return left;
}

// ------------------------------------------------------------------ 索引模式
// `--index`：扫已导出的转录，把「日期/文件/体量/那天第一句人话」写进 `docs/会话归档/README.md`
// 的表格区（`<!-- INDEX:BEGIN -->` … `<!-- INDEX:END -->` 之间）。**README 的说明文字是手写的**，
// 只有表格是生成的 —— 这样"目录永远和文件对得上"，而"归档是干嘛的"不用每次重写。
if (has('index')) {
  const dir = OUT_DIR;
  if (!fs.existsSync(dir)) throw new Error(`还没有导出过：${dir}（先跑一次不带参数的导出）`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  // 「纪要」列只报**事实**（那天有没有 L2 纪要文件）——"必须有"是 `check-archive.mjs` 的判据，
  // 政策写在这里就会变成两处真相。注意纪要在 `transcripts/` 的**上一层**。
  const NOTE_DIR = path.join(ROOT, 'docs', '会话归档');
  const hasNote = (day) => fs.existsSync(path.join(NOTE_DIR, `${day}.md`));
  const rows = files.map((f) => {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const kb = Math.round(Buffer.byteLength(text, 'utf8') / 1024);
    const firstUser = /^\*\*你\*\*（[^）]*）：(.+)$/m.exec(text)?.[1] ?? '';
    const mine = (text.match(/^\*\*我\*\*/gm) ?? []).length;
    const tools = (text.match(/^- 🔧/gm) ?? []).length;
    const day = f.slice(0, 10);
    const topic = firstUser.replace(/[|]/g, '\\|').replace(/\s+/g, ' ').slice(0, 60);
    return `| ${day} | \`transcripts/${f}\` | ${kb}KB | ${mine} | ${tools} | ${hasNote(day) ? '✅' : '—'} | ${topic || '（那天没说话）'} |`;
  });
  const noteCount = files.filter((f) => hasNote(f.slice(0, 10))).length;
  const table = [
    '<!-- INDEX:BEGIN -->',
    '',
    `已归档 **${files.length}** 天（生成于 ${new Date().toLocaleString('zh-CN')}）｜其中 **${noteCount}** 天有 L2 纪要。`,
    '',
    '> 「纪要」列 = 那天有没有 `docs/会话归档/<日期>.md`（决策/原因/验证/待办）。',
    '> **哪天"必须有"由守卫 `npm run check:archive` 判定**（目前自 2026-10-13 起算、两天宽限）；',
    '> 更早的日子是"可选补写"——写的时候成本 ≈ ¥0.03/天。',
    '',
    '| 日期 | 文件 | 体量 | 我的消息 | 工具调用 | 纪要 | 那天的第一句人话 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    '<!-- INDEX:END -->'
  ].join('\n');

  const readme = path.join(ROOT, 'docs', '会话归档', 'README.md');
  const INTRO = [
    '# 会话归档（主人 ↔ 我）',
    '',
    '这份归档回答一个问题：**压缩之后，"当时为什么这么决定"还找得回来吗？**',
    '',
    '> ⚠️ 本文（含下面的索引表）**由 `archive-session.mjs --index` 整份生成**，别手改 ——',
    '> 手改会在下次刷索引时被覆盖，也会造成"文档与脚本两处真相"（本仓吃过这个亏）。',
    '> 要改说明文字，改脚本里的 `INTRO`。',
    '',
    '## 三层结构',
    '',
    '| 层 | 在哪 | 回答什么 | 体量 | 谁写 |',
    '|---|---|---|---|---|',
    '| **L1 索引** | 本文 | 哪一天在聊什么 | 几十行 | 脚本 |',
    '| **L2 纪要** | `docs/会话归档/<日期>.md` | 那天的**决策、原因、验证、待办** | 几 KB/天 | **我**（脚本只生成骨架） |',
    '| **L3 转录** | `transcripts/<日期>-<会话>.md` | **逐字的原话**（已脱敏） | 几 MB 总计 | 脚本 |',
    '',
    '原始会话文件（`~/.dsh/sessions/…` 与 `dsh-home-legacy/sessions/…`）是 **L0**：不进 git，',
    '只在需要核对"连工具输出都算上"的细节时才去翻。',
    '',
    '## 工作流（每次收尾 / 每天）',
    '',
    '```bash',
    'npm run archive:note      # ① 生成当天纪要骨架（0 token）：当天量、碰过的文件、失败项、压缩点',
    '#                        # ② 我在骨架上补「决策与原因 / 验证 / 待办」≈ 800 token（这才是要花钱的一步）',
    'npm run archive:session   # ③ 导出 L3 逐字转录（0 token，已脱敏）',
    'npm run archive:index     # ④ 刷新本页索引表（0 token）',
    'npm run check:archive     # ⑤ 守卫：有活动的日子缺纪要 / 转录落后 >7 天 → 红',
    '```',
    '',
    '**成本**：纪要 ≈ ¥0.03/天（同一会话收尾；上下文压缩后更低）。② 之外的每一步都不花模型钱。',
    '**为什么便宜**：贵的从来不是检索，是把历史一直背在上下文里 —— 上下文 40–58 万 token 时',
    '每步请求约 ¥0.02–0.03（实测一天 174 步 ≈ ¥4.9）；按需检索一次只有几百 token。',
    '',
    '## 按需回忆（别把历史背在身上）',
    '',
    '```bash',
    'npm run recall -- "关键词"          # 搜 归档 + CHANGELOG + docs，回 file:line + 一行上下文',
    'npm run recall -- "qzone|说说" --files   # 只看命中分布在哪些文件',
    'npm run recall -- "^## " --since 2026-10-12  # 只搜最近几天',
    '```',
    '',
    '## L3 里有什么、没有什么（刻意的）',
    '',
    '- **有**：主人与我的对话（逐字）、工具名与安全参数提示（file_path/description…）、**失败的工具调用及原因**、',
    '  压缩点摘要、交付过的文件路径。',
    '- **没有**：思考链（reasoning）、工具返回正文、系统提示与材料、命令行原文。',
    '  → 前三类是噪声（占原始体积 95%+）；命令行原文则**可能带凭据**（出现过 `Authorization: Bearer …`）。',
    '- **脱敏是硬闸门**：导出时先就地打码（凭据、**凭据前缀**、cookie、API key），再复验一遍；',
    '  复验不干净就**拒绝写盘**（宁可没归档，也不能把凭据写进 git）。要加规则改 `redactionRules()`。',
    '',
    '## 守卫',
    '',
    '`selfcheck` 里有一条「会话归档新鲜度」，两条判据：',
    '1. **有活动的日子必须有纪要**（从 2026-10-13 起算，两天宽限）—— 转录只给逐字，接不上"当时为什么"，',
    '   记忆就是在这儿断的；',
    '2. 转录落后于最新会话活动 **>7 天** → 红。',
    '',
    '自检钩子（证明它会红，而不是摆设）：',
    '```bash',
    'ARCHIVE_FAKE_SESSION_DAY=2026-11-20 node scripts/check-archive.mjs   # 假装那时还有活动 → 应红',
    'ARCHIVE_NOW=2026-10-16 node scripts/check-archive.mjs                # 配合"删掉某天纪要"验第一条',
    '```',
    '',
    '---',
    '',
    '## 索引',
    ''
  ].join('\n');

  fs.writeFileSync(readme, `${INTRO}\n${table}\n`, 'utf8');
  console.log(`✅ 索引已刷新（整份重写）：${path.relative(ROOT, readme)}（${files.length} 天）`);
  process.exit(0);
}

// ------------------------------------------------------------------ 纪要骨架模式
// `--note [--date YYYY-MM-DD]`：按当天的转录生成 **L2 纪要骨架**（不覆盖已存在的）。
//
// 为什么要有它（主人 2026-10-13 定："由你写 L2" + "记忆损失最少、花的钱更少"）：
//   写纪要是**输出 token 密集型**的动作，而"今天改了哪些文件/调了多少次工具/失败了什么/有几个压缩点"
//   这些**脚本本来就知道**，不该让我用模型一笔一笔复述（那是纯粹的白花钱）。
//   骨架落盘是 0 token 的；我只用填"**为什么/决策**"那几行（~800 token 而不是 ~2000）。
//   另外它还是个"提醒器"：收尾时点开文件就看见 `（待补）`，不靠我记得。
if (has('note') || argvVal('date')) {
  const date = argvVal('date') ?? new Date().toLocaleDateString('sv-SE');   // sv-SE 恰好是 YYYY-MM-DD
  const noteFile = path.join(ROOT, 'docs', '会话归档', `${date}.md`);
  if (fs.existsSync(noteFile)) {
    console.log(`ℹ️ 已有纪要，不动它：${path.relative(ROOT, noteFile)}`);
    process.exit(0);
  }
  const transcripts = fs.existsSync(OUT_DIR)
    ? fs.readdirSync(OUT_DIR).filter((f) => f.startsWith(date) && f.endsWith('.md'))
    : [];
  let youN = 0; let meN = 0; let toolsN = 0; let compactionN = 0;
  const fails = [];
  const files = new Map();
  for (const f of transcripts) {
    const text = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
    youN += (text.match(/^\*\*你\*\*/gm) ?? []).length;
    meN += (text.match(/^\*\*我\*\*/gm) ?? []).length;
    for (const m of text.matchAll(/^- 🔧 `([^`]+)`/gm)) {
      toolsN += 1;
      const hint = m[1].split(' — ')[1] ?? '';
      const p = hint.split(' · ').find((x) => /[\\/][^\s]*\.[A-Za-z]{1,6}$/.test(x));
      if (p) files.set(p.trim(), (files.get(p.trim()) ?? 0) + 1);
    }
    for (const m of text.matchAll(/^- ❌ `([^`]+)`/gm)) fails.push(m[1].slice(0, 100));
    compactionN += (text.match(/【压缩点】/g) ?? []).length;
  }
  const topFiles = [...files].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const body = [
    `# ${date} · 纪要`,
    '',
    '> 骨架由 `archive-session.mjs --note` 生成；**"为什么/决策"那几行要手写**（脚本写不出原因）。',
    `> 逐字原话在 \`transcripts/${date}-*.md\`；规则/人设类的改动另有 \`roles/CHANGELOG.md\`。`,
    '',
    '## 一、当天的量（自动）',
    '',
    `- 转录：${transcripts.length} 个会话文件｜你说 ${youN} 句｜我回 ${meN} 句｜工具调用 ${toolsN} 次｜压缩点 ${compactionN} 个`,
    transcripts.length ? `- 碰过的文件（按次数，前 20）：\n${topFiles.map(([p, n]) => `  - \`${p}\`（${n}）`).join('\n')}` : '- （这天没有导出的转录：先 `npm run archive:session`）',
    fails.length ? `- 失败的工具调用 ${fails.length} 次：\n${[...new Set(fails)].slice(0, 10).map((f) => `  - \`${f}\``).join('\n')}` : '- 没有失败的工具调用',
    '',
    '## 二、决策与原因（**手写**）',
    '',
    '- （待补）为什么这么改、否掉了什么、代价是什么',
    '',
    '## 三、验证（**手写**）',
    '',
    '- （待补）跑了哪些守卫/测试/真机链路，结果如何',
    '',
    '## 四、待办 / 未决（**手写**）',
    '',
    '- [ ] （待补）',
    ''
  ].join('\n');
  fs.mkdirSync(path.dirname(noteFile), { recursive: true });
  fs.writeFileSync(noteFile, body, 'utf8');
  console.log(`✅ 纪要骨架已生成：${path.relative(ROOT, noteFile)}`);
  console.log(`   量：你 ${youN} 句 / 我 ${meN} 句 / 工具 ${toolsN} 次 / 压缩点 ${compactionN} 个 / 碰过 ${files.size} 个文件`);
  process.exit(0);
}

// ------------------------------------------------------------------ 主流程
const sessions = findSessions(homeRoot);
if (!sessions.length) throw new Error(`这个 home 下没有找到会话：${homeRoot}`);
const targets = all ? sessions : [sessions[0]];
console.log(`home=${homeName}（${homeRoot}）｜候选会话 ${sessions.length} 个｜本次导出 ${targets.length} 个`);
if (!dry) fs.mkdirSync(OUT_DIR, { recursive: true });

let wrote = 0;
let totalRaw = 0;
let totalOut = 0;
for (const s of targets) {
  const raw = decompressSession(s.file);
  totalRaw += raw.length;
  const items = extract(raw);
  const counts = items.reduce((a, it) => { a[it.kind] = (a[it.kind] ?? 0) + 1; return a; }, {});
  const rendered = render(items, s.sid, s.workspace);
  let outBytes = 0;
  const redactions = [];
  const leftover = [];
  for (const f of rendered) {
    const r = redactText(f.text);
    f.text = r.text;
    redactions.push(...r.hits);
    leftover.push(...assertClean(f.text));
    outBytes += Buffer.byteLength(f.text, 'utf8');
  }
  totalOut += outBytes;
  const label = `${(raw.length / 1024 / 1024).toFixed(1)}MB → ${(outBytes / 1024).toFixed(0)}KB（${(outBytes / raw.length * 100).toFixed(1)}%）`;
  if (leftover.length) {
    console.log(`\n❌ ${s.sid.slice(0, 20)} ${label}`);
    console.log('   **脱敏后复验仍不干净，未写盘**：');
    for (const h of [...new Set(leftover)]) console.log(`     - ${h}`);
    console.log('   处置：把这个形态加进 redactionRules 的 patterns（不要"先写盘再删"）。');
    process.exitCode = 1;
    continue;
  }
  if (dry) {
    console.log(`\n（dry）${s.sid.slice(0, 20)} ${label}`);
  } else {
    console.log(`\n✅ ${s.sid.slice(0, 20)} ${label}`);
    for (const f of rendered) {
      const out = path.join(OUT_DIR, `${f.day}-${s.sid.replace(/^session-/, '').slice(0, 8)}.md`);
      fs.writeFileSync(out, f.text, 'utf8');
      console.log(`   写 ${path.relative(ROOT, out)}`);
      wrote += 1;
    }
  }
  if (redactions.length) console.log(`   脱敏 ${redactions.length} 处：${[...new Set(redactions)].join('、')}（只记种类与数量，不记值）`);
  console.log(`   条目：你 ${counts.user ?? 0}｜我 ${counts.assistant ?? 0}｜工具 ${counts.tool ?? 0}｜失败 ${counts.toolfail ?? 0}｜压缩点 ${counts.compaction ?? 0}｜交付 ${counts.deliverable ?? 0}${withReasoning ? `｜思考 ${counts.reasoning ?? 0}` : ''}`);
}
console.log(`\n合计：原始 ${(totalRaw / 1024 / 1024).toFixed(1)}MB → 归档 ${(totalOut / 1024).toFixed(0)}KB${dry ? '（dry，没写盘）' : `，写了 ${wrote} 个文件`}`);
