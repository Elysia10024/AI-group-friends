// 推理等级对比（配对多跑）：her 模式 = 她的真实工作负载（群材料 + 唤醒提示）；
// reason 模式 = 单步纯推理题（不调工具），用来看 effort 到底有没有作用。
//
// 单样本会被"这一轮恰好多调了两次工具"淹没，所以每种配置跑 N 次取中位数。
//
// ⚠️ 这个脚本**要花钱**：每个回合都是真实调用（her 模式约 ¥0.05~0.08/回合），
//    默认 2 次/档 × 2 档 × 2 模式 ≈ ¥0.5。它不在日常巡检里，只在要动 effort 时才跑。
//
// 用法：npm run audit:effort [每档次数]
// 实测（2026-09-20，deepseek-v4-flash-vision-exp routed to V4.1-Flash）：
//   her   : low 中位 ¥0.0544 / high 中位 ¥0.0722 → **high 约 +33%**（两档区间不重叠）
//           输出的推理 token 只从 2645 涨到 2910（+10%），成本涨的主要是每步要重发的未命中内容
//   reason: low ¥0.0013 / high ¥0.0013 —— 单步纯推理题上两者**没有可测差异**
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../../src/dsh-client.js';
import { listSessions, decompressSession } from './audit-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const BASE = 'http://127.0.0.1:3080';
const PROVIDER = 'deepseek-official';
const MODEL = 'deepseek-v4-flash-vision-exp';
const RUNS = Number(process.argv[2]) || 2;

const shadow = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'context-shadow.json'), 'utf8'));
const entries = Array.isArray(shadow) ? shadow : (shadow.entries || []);
const HER_PROMPT = String(entries[entries.length - 1]?.actualPrompt || entries[entries.length - 1]?.text || '').trim();
const REASON_PROMPT = '一个水池有甲乙两个进水管和一个出水管。甲管单独注满需 6 小时，乙管单独注满需 4 小时，'
  + '出水管单独排空需 12 小时。三管同时打开，多少小时能注满水池？请只回答最终答案和一句话理由。';

function usageOf(sessionId) {
  const hit = listSessions({}).find((s) => s.sid === sessionId);
  if (!hit) return null;
  const text = decompressSession(hit.file);
  const byStep = new Map();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (d.turn == null || d.step == null) continue;
    const m = line.match(/"usage":\{[^{}]*"inputTokens"[^{}]*\}/);
    if (!m) continue;
    let u; try { u = JSON.parse(m[0].slice(8)); } catch { continue; }
    byStep.set(`${d.turn}:${d.step}`, { miss: u.inputTokens || 0, hit: u.cacheReadTokens || 0, out: u.outputTokens || 0, reason: u.reasoningTokens || 0 });
  }
  return [...byStep.values()].reduce((a, r) => ({ miss: a.miss + r.miss, hit: a.hit + r.hit, out: a.out + r.out, reason: a.reason + r.reason, steps: a.steps + 1 }), { miss: 0, hit: 0, out: 0, reason: 0, steps: 0 });
}

const P = { hit: { off: 0.003, peak: 0.006 }, miss: { off: 0.15, peak: 0.30 }, out: { off: 0.6, peak: 1.2 } };
const CNY = 7.1;
const isPeak = (ms) => { const d = new Date(ms); const day = d.getUTCDay(); if (day === 0 || day === 6) return false; const h = d.getUTCHours(); return (h >= 1 && h < 4) || (h >= 6 && h < 10); };
const costCNY = (r, ms) => { const mode = isPeak(ms) ? 'peak' : 'off'; return ((r.miss / 1e6) * P.miss[mode] + (r.hit / 1e6) * P.hit[mode] + (r.out / 1e6) * P.out[mode]) * CNY; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

async function runOnce(effort, promptText) {
  const api = new NodeApiClient(BASE);
  const cwd = path.join(ROOT, 'state', 'effort-ab');
  fs.mkdirSync(cwd, { recursive: true });
  const created = unwrap(await api.sessions.create({ cwd }), 'session.create');
  const sessionId = created.sessionId;
  const sel = unwrap(await api.sessions.selectModel({ sessionId, provider: PROVIDER, model: MODEL, reasoningEffort: effort }), 'selectModel');
  const collector = createTurnCollector();
  let resolveOpened;
  const opened = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('WS open 超时')), 10_000); resolveOpened = () => { clearTimeout(t); res(); }; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('回合超时')), 240_000);
    (async () => {
      for await (const envelope of api.events.mux({}, undefined, () => resolveOpened())) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) { clearTimeout(timer); resolve(ended); return; }
        }
      }
    })().catch((e) => { clearTimeout(timer); reject(e); });
  });
  await opened;
  const t0 = Date.now();
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }), 'prompt');
  await done;
  const wallMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 1200));
  const u = usageOf(sessionId);
  try { await api.workspace.archiveSession({ sessionId }); } catch { /* 归档失败无所谓 */ }
  return { effort, applied: sel.selected?.reasoningEffort, wallMs, ...(u ?? {}), cny: u ? costCNY(u, t0) : 0 };
}

for (const [mode, promptText] of [['her', HER_PROMPT], ['reason', REASON_PROMPT]]) {
  if (!promptText) continue;
  console.log(`\n=========== 模式 ${mode}（输入 ${promptText.length} 字，每档 ${RUNS} 次）===========`);
  const all = [];
  for (const effort of ['low', 'high']) {
    for (let i = 1; i <= RUNS; i++) {
      const r = await runOnce(effort, promptText);
      all.push(r);
      console.log(`  ${effort.padEnd(5)} #${i}  步数 ${r.steps}  输出 ${r.out}（推理 ${r.reason}） 耗时 ${(r.wallMs / 1000).toFixed(1)}s  ¥${r.cny.toFixed(4)}  [生效 ${r.applied}]`);
    }
  }
  for (const effort of ['low', 'high']) {
    const rs = all.filter((r) => r.effort === effort);
    console.log(`  → ${effort} 中位数：步数 ${median(rs.map((r) => r.steps))}  输出 ${median(rs.map((r) => r.out))}  推理 ${median(rs.map((r) => r.reason))}  成本 ¥${median(rs.map((r) => r.cny)).toFixed(4)}`);
  }
}
