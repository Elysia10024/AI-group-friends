// 记忆快照：她的记忆（群友印象/话题/想法）只存在 state/social-v2.json 里，
// 而这份文件是被 gitignore 的 —— 一旦被误删就真的没了。
// 2026-09-20 我就误清过一次，全靠"影子组装记录里当时渲染出来的记忆块"才捞回来。
// 这个脚本把两个会话的记忆导出成带时间戳的快照，保留最近 40 份（与 memory.js 破坏性写入前的快照统一，2026-10-28 审计第 13 条）。
//
// 用法：npm run backup:memory
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BACKUP_DIR = path.join(ROOT, 'state', 'backups');
const KEEP = 40;   // 与 memory.js 的 40 份对齐：同一个 state/backups 目录，绝不能两套 retention 互相裁

const token = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const BASE = 'http://127.0.0.1:3100';

async function main() {
  const sessions = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'sessions.json'), 'utf8'));
  const keys = Object.keys(sessions.sessions ?? sessions ?? {}).filter((k) => /^(group|private):/.test(k));
  if (!keys.length) { console.error('没找到会话键（state/sessions.json）'); process.exit(1); }

  const out = { at: new Date().toISOString(), conversations: {} };
  for (const key of keys) {
    const res = await fetch(`${BASE}/api/socialV2/memory?key=${encodeURIComponent(key)}`, {
      headers: { 'x-console-token': token }
    });
    if (!res.ok) { console.error(`取 ${key} 失败：HTTP ${res.status}`); continue; }
    const j = await res.json();
    out.conversations[key] = j?.raw ?? null;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const name = `memory-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`;
  const file = path.join(BACKUP_DIR, name);
  fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');

  const traits = Object.values(out.conversations)
    .map((c) => Object.values(c?.memberImpressions ?? {}).reduce((a, v) => a + (v?.traits?.length ?? 0), 0))
    .reduce((a, b) => a + b, 0);
  console.log(`✅ 快照已存：state/backups/${name}（${keys.length} 个会话，${traits} 条印象）`);

  const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('memory-')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
    fs.unlinkSync(path.join(BACKUP_DIR, old));
    console.log(`   删掉最旧的一份：${old}`);
  }
}

main().catch((e) => { console.error('备份失败：', e?.message ?? e); process.exit(1); });
