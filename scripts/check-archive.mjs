// 归档新鲜度守卫：最新的会话活动比最后一次归档晚太多 → 红。
//
// 为什么要有它：**没有守卫的归档会变成谎话。** 这个仓库里已经有三起"写了但没人读/路径悄悄失效"的先例：
//   · doctor 的「内核人设新鲜度」指向 12 天前归档的路径 → 空转 12 天；
//   · 前端金标准里一份标签改名后遗留的孤儿用例（247 个死字段）长期没人发现；
//   · 工具说明承诺 `extra.relation`/`extra.tag` 而 schema 里没有 → 她 8 次徒劳，11 天没人知道。
// 归档是"给压缩后的我用的记忆"，它一旦落后于现实，读它的我就会被误导 —— 比没有归档更糟。
//
// 三条判据：
//   ① 落后：最新会话文件的修改时间 vs `transcripts/` 里最大的日期（差 >7 天）。
//      只比"会话活动"不比"今天" —— 主人一周没用 DSH 时本来就没什么可归档，不该红。
//   ② 缺纪要：有活动的日子必须有 `docs/会话归档/<日期>.md`（自 NOTE_SINCE 起、两天宽限）——
//      转录免费但要人写纪要，"漏写"才是记忆真正断掉的地方（只给逐字，接不上"当时为什么"）。
//   ③ 索引腐烂：README 的表格是 `--index` 生成的，忘了重跑它就开始撒谎（详注释见该段）。
//   自检钩子（两个，缺一不可 —— 第一版只留了 ARCHIVE_NOW，结果**自检根本红不了**：
//     它把"最新会话活动"夹到"现在"，而假装的未来时间让夹取失效，守卫看着绿其实没被测到）：
//       ARCHIVE_FAKE_SESSION_DAY=2026-11-20 node scripts/check-archive.mjs   # 假装"那时还有活动" → 应红
//       ARCHIVE_NOW=2026-11-20T12:00:00+08:00 node scripts/check-archive.mjs # 只改"现在" → 仍绿（没活动，不该红）
//   ②③ 的验红法写在各自那一段的注释里。
//
//   node scripts/check-archive.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const ARCHIVE_DIR = path.join(ROOT, 'docs', '会话归档');
const TRANSCRIPT_DIR = path.join(ARCHIVE_DIR, 'transcripts');
const HOMES = [
  path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions'),
  'E:/ai群友/dsh-home-legacy/sessions'
];
const MAX_GAP_DAYS = 7;

/** 归档里最新的那一天（看文件名前缀 YYYY-MM-DD）。 */
function latestArchivedDay() {
  if (!fs.existsSync(TRANSCRIPT_DIR)) return null;
  let best = null;
  for (const f of fs.readdirSync(TRANSCRIPT_DIR)) {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(f);
    if (!m) continue;
    if (!best || m[1] > best) best = m[1];
  }
  return best;
}

/** 两地会话文件里最新的修改时间。 */
function latestSessionMtime() {
  let best = 0;
  for (const home of HOMES) {
    if (!fs.existsSync(home)) continue;
    for (const ws of fs.readdirSync(home, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const wsDir = path.join(home, ws.name);
      for (const s of fs.readdirSync(wsDir, { withFileTypes: true })) {
        if (!s.isDirectory() || !s.name.startsWith('session-')) continue;
        const dir = path.join(wsDir, s.name);
        for (const f of fs.readdirSync(dir)) {
          if (!/^session.*\.jsonl\.zstd$/.test(f)) continue;
          const t = fs.statSync(path.join(dir, f)).mtimeMs;
          if (t > best) best = t;
        }
      }
    }
  }
  return best;
}

const dayOf = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const archived = latestArchivedDay();
if (!archived) {
  console.log(`❌ 还没有归档：${path.relative(ROOT, TRANSCRIPT_DIR)} 是空的（先跑 node scripts/archive-session.mjs）`);
  process.exit(1);
}

const nowMs = process.env.ARCHIVE_NOW ? Date.parse(process.env.ARCHIVE_NOW) : Date.now();
if (!Number.isFinite(nowMs)) throw new Error(`ARCHIVE_NOW 解析不了：${process.env.ARCHIVE_NOW}`);
const sessionMs = latestSessionMtime() || nowMs;
// "该归档到哪一天" = 最新会话活动的日期，但不超过"现在"。
// 自检要红，得**假装那时还有会话活动**（ARCHIVE_FAKE_SESSION_DAY）—— 只改"现在"不会红，
// 因为"没有新活动"本来就不该催归档。
const fakeDay = process.env.ARCHIVE_FAKE_SESSION_DAY;
if (fakeDay && !/^\d{4}-\d{2}-\d{2}$/.test(fakeDay)) throw new Error(`ARCHIVE_FAKE_SESSION_DAY 格式应为 YYYY-MM-DD：${fakeDay}`);
const sessionDay = fakeDay ?? dayOf(Math.min(sessionMs, nowMs));
const gap = Math.round((Date.parse(`${sessionDay}T00:00`) - Date.parse(`${archived}T00:00`)) / 86400000);

const files = fs.readdirSync(TRANSCRIPT_DIR).filter((f) => f.endsWith('.md')).length;
const notes = fs.existsSync(ARCHIVE_DIR) ? fs.readdirSync(ARCHIVE_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).length : 0;

// ── 第二条判据（2026-10-13 主人定"由你写 L2"之后加的）：**有活动的日子必须有纪要** ──
// 转录是脚本免费导的，纪要要人（我）写 —— 所以"漏写"才是记忆真正断掉的地方：
// 转录只给逐字，接不上"当时为什么"。给两天的宽限（当天还在做事，别催）。
// 只从 NOTE_SINCE 起算：之前 20 多天本来就没写，追溯只会造一条永久红。
const NOTE_SINCE = '2026-10-13';
const transcriptDays = [...new Set(fs.readdirSync(TRANSCRIPT_DIR)
  .map((f) => /^(\d{4}-\d{2}-\d{2})/.exec(f)?.[1])
  .filter(Boolean))].sort();
const graceDay = dayOf(nowMs - 2 * 86400000);
const missingNotes = transcriptDays.filter((d) => d >= NOTE_SINCE && d <= graceDay
  && !fs.existsSync(path.join(ARCHIVE_DIR, `${d}.md`)));

if (missingNotes.length) {
  console.log(`❌ 有活动却没有纪要的日子 ${missingNotes.length} 天：${missingNotes.join('、')}`);
  console.log('   转录只有逐字，接不上"当时为什么" —— 记忆就是在这儿断的。补法：');
  console.log('     node scripts/archive-session.mjs --note --date <日期>   # 生成骨架，再补"决策与原因"那几行');
  process.exit(1);
}

// ── 第三条判据：**索引表和文件必须对得上** ──
// README 的表格是 `--index` 生成的：写了纪要/导了转录却忘了重跑，表就开始撒谎
// （最阴的一种：文件明明在，表里那格还是"—"，而读索引的人会以为那天没纪要）。
// 这就是本仓反复吃过的"文档与脚本两处真相"，所以让守卫按天比对，而不是靠人记得重跑。
// 自检（真文件，不用假环境变量）：造一份幽灵转录再跑守卫 —— 应红；删掉恢复绿：
//   Set-Content docs/会话归档/transcripts/2099-01-01-x.md "# 幽灵"; node scripts/check-archive.mjs
const readmePath = path.join(ARCHIVE_DIR, 'README.md');
function indexDrift() {
  if (!fs.existsSync(readmePath)) return ['README.md 不存在'];
  const m = /<!-- INDEX:BEGIN -->([\s\S]*?)<!-- INDEX:END -->/.exec(fs.readFileSync(readmePath, 'utf8'));
  if (!m) return ['README.md 里找不到 <!-- INDEX:BEGIN -->…<!-- INDEX:END --> 区块（被手改坏了？）'];
  const rows = new Map();
  for (const line of m[1].split('\n')) {
    const r = /^\| (\d{4}-\d{2}-\d{2}) \| `transcripts\/([^`]+)` \|.*\| (✅|—) \| /.exec(line);
    if (r) rows.set(r[1], { note: r[3] === '✅' });
  }
  const bad = [];
  for (const d of transcriptDays) if (!rows.has(d)) bad.push(`表里少了 ${d}`);
  for (const d of rows.keys()) if (!transcriptDays.includes(d)) bad.push(`表里有 ${d}，但转录文件不在`);
  for (const [d, v] of rows) {
    const real = fs.existsSync(path.join(ARCHIVE_DIR, `${d}.md`));
    if (real !== v.note) bad.push(`${d} 的「纪要」列写着 ${v.note ? '✅' : '—'}，实际${real ? '有' : '没有'}纪要`);
  }
  return bad;
}
const drift = indexDrift();
if (drift.length) {
  console.log(`❌ 索引表与现实不符 ${drift.length} 处：${drift.slice(0, 6).join('；')}${drift.length > 6 ? ' …' : ''}`);
  console.log('   README 的表格是生成的，改了文件就要重跑：node scripts/archive-session.mjs --index');
  process.exit(1);
}

if (gap > MAX_GAP_DAYS) {
  console.log(`❌ 归档落后了 ${gap} 天：最后归档到 ${archived}，而最新会话活动是 ${sessionDay}`);
  console.log(`   跑一次：node scripts/archive-session.mjs && node scripts/archive-session.mjs --index`);
  process.exit(1);
}
console.log(`✅ 归档新鲜：最后归档 ${archived}，最新会话活动 ${sessionDay}（差 ${gap} 天）｜转录 ${files} 天、纪要 ${notes} 篇（${NOTE_SINCE} 起有活动就有纪要）`);
