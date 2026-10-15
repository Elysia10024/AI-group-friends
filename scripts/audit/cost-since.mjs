// 按时间窗汇总成本：把"某个时刻之前 / 之后"的真实花费摆在一起比（跨所有会话文件）。
//
// 为什么需要：A1.1 之后每个回合都是**新会话**，audit:cost 只看"最近改动的那一个会话"，
// 于是只能看到最后一个回合。要评估改动效果，必须跨会话按时间窗汇总。
//
// 用法：
//   node scripts/audit/cost-since.mjs                                  # 切换前 vs 切换后
//   node scripts/audit/cost-since.mjs --from "2026-09-19T06:00" --to "2026-09-19T07:00"
//                                                                      # 只看这个窗口（本地时间），
//                                                                      # 并给出"同样请求数在切换前要花多少"的对照
//   不给 --since 时，默认用 state/config.json.before-a11.bak 的修改时间（= A1.1 切换时刻）
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, listSessions, decompressSession, MAIN_WORKSPACE } from './audit-lib.mjs';

const args = parseArgs();
const ROOT = path.resolve(import.meta.dirname, '..', '..');

const bakPath = path.join(ROOT, 'state', 'config.json.before-a11.bak');
const fallbackSince = fs.existsSync(bakPath) ? fs.statSync(bakPath).mtimeMs : Date.now();
const sinceMs = args.since ? Date.parse(args.since) : fallbackSince;
if (!Number.isFinite(sinceMs)) throw new Error(`时间格式看不懂：${args.since}`);

const isPeak = (ms) => { const d = new Date(ms); const day = d.getUTCDay(); if (day === 0 || day === 6) return false; const h = d.getUTCHours(); return (h >= 1 && h < 4) || (h >= 6 && h < 10); };
const P = { hit: { off: 0.003, peak: 0.006 }, miss: { off: 0.15, peak: 0.30 }, out: { off: 0.6, peak: 1.2 } };
const CNY = 7.1;

const sessions = listSessions({ workspace: args.workspace ?? MAIN_WORKSPACE });
const mkBucket = () => ({ turns: 0, reqs: 0, hit: 0, miss: 0, out: 0, usd: 0, ctxs: new Set() });
const bucket = { before: mkBucket(), after: mkBucket() };
// 电价档位要分开算：高峰(UTC 1-4 / 6-10)与低谷单价差一倍。拿"混合平均单价"去折算某一小时是不公平的，
// 所以旧体制的单价按档位各存一份，做对照时用**同档位**的那个。
const byClass = { beforePeak: mkBucket(), beforeOff: mkBucket(), winPeak: mkBucket(), winOff: mkBucket() };

// 可选：只看一个时间窗（本地时间）。用来回答"某几个小时里花了多少、和以前比省了多少"。
// 注意：audit-lib 的 parseArgs 不认 --from/--to（它只到 --since/--until），所以这里直接读 argv。
const argvVal = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const fromArg = argvVal('from'); const toArg = argvVal('to');
const fromMs = fromArg ? Date.parse(fromArg) : null;
const toMs = toArg ? Date.parse(toArg) : null;
if ((fromArg && !Number.isFinite(fromMs)) || (toArg && !Number.isFinite(toMs))) throw new Error('--from/--to 时间格式看不懂');
const win = (fromMs || toMs) ? mkBucket() : null;
const inWindow = (t) => (!fromMs || t >= fromMs) && (!toMs || t < toMs);

for (const s of sessions) {
  let raw;
  try { raw = decompressSession(s.file); } catch { continue; }
  const side = s.mtimeMs >= sinceMs ? 'after' : 'before';
  const seen = new Set();
  const seenSteps = new Set();          // 去重：同一个 (turn,step) 会有多行带 usage（踩过：金额与请求数翻倍）
  for (const line of raw.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const d = e.data || {};
    if (d.turn == null || d.step == null) continue;
    const stepKey = `${d.turn}:${d.step}`;
    if (seenSteps.has(stepKey)) continue;
    seenSteps.add(stepKey);
    const m = line.match(/"usage":\{[^{}]*\}/);
    if (!m) continue;
    let u; try { u = JSON.parse(m[0].slice(8)); } catch { continue; }
    const miss = u.inputTokens || 0; const hit = u.cacheReadTokens || 0; const out = u.outputTokens || 0;
    const t = Number(e.time) || s.mtimeMs;
    const peak = isPeak(t) ? 'peak' : 'off';
    const usd = (miss / 1e6) * P.miss[peak] + (hit / 1e6) * P.hit[peak] + (out / 1e6) * P.out[peak];
    for (const b of [bucket[side], ...(win && inWindow(t) ? [win] : [])]) {
      b.reqs += 1;
      b.hit += hit; b.miss += miss; b.out += out;
      b.usd += usd;
      b.ctxs.add(hit + miss);
      b.turnsSet ??= new Set();
      b.turnsSet.add(`${s.sid}:${d.turn}`);
    }
    // 同档位对照桶
    const cls = [];
    if (side === 'before') cls.push(peak === 'peak' ? byClass.beforePeak : byClass.beforeOff);
    if (win && inWindow(t)) cls.push(peak === 'peak' ? byClass.winPeak : byClass.winOff);
    for (const b of cls) { b.reqs += 1; b.hit += hit; b.miss += miss; b.out += out; b.usd += usd; b.ctxs.add(hit + miss); }
    seen.add(`${s.sid}:${d.turn}`);
  }
  bucket[side].turns += seen.size;
}
for (const b of [bucket.before, bucket.after, ...(win ? [win] : [])]) {
  if (b.turnsSet) b.turns = b.turnsSet.size;
}

const med = (set) => { const a = [...set].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const fmt = (n, d = 2) => n.toLocaleString('en-US', { maximumFractionDigits: d });

console.log(`成本对照（切换时刻：${new Date(sinceMs).toLocaleString()}）`);
console.log(`会话文件：${sessions.length} 个（主工作区 ${args.workspace ?? MAIN_WORKSPACE}）\n`);
for (const [label, key] of [['切换前（长会话）', 'before'], ['切换后（每回合新会话 + 组装）', 'after']]) {
  const b = bucket[key];
  if (!b.reqs) { console.log(`${label}：无数据\n`); continue; }
  console.log(`【${label}】`);
  console.log(`  回合 ${fmt(b.turns, 0)}｜请求 ${fmt(b.reqs, 0)}｜每回合请求 ${fmt(b.reqs / Math.max(1, b.turns), 2)}`);
  console.log(`  单次上下文中位 ${fmt(med(b.ctxs), 0)}｜平均 ${fmt((b.hit + b.miss) / b.reqs, 0)}`);
  console.log(`  token：命中 ${fmt(b.hit / 1e6, 1)}M｜未命中 ${fmt(b.miss / 1e6, 2)}M｜输出 ${fmt(b.out / 1e3, 0)}k`);
  console.log(`  花费 ¥${fmt(b.usd * CNY)}｜每回合 ¥${fmt((b.usd * CNY) / Math.max(1, b.turns), 4)}｜每请求 ¥${fmt((b.usd * CNY) / b.reqs, 4)}`);
  console.log('');
}

const before = bucket.before; const after = bucket.after;
if (before.reqs && after.reqs && before.turns && after.turns) {
  const perTurnBefore = (before.usd * CNY) / before.turns; const perTurnAfter = (after.usd * CNY) / after.turns;
  console.log(`结论：每回合 ¥${fmt(perTurnBefore, 4)} → ¥${fmt(perTurnAfter, 4)}，降低 ${fmt((1 - perTurnAfter / perTurnBefore) * 100, 0)}%（${fmt(perTurnBefore / perTurnAfter, 1)}×）`);
  console.log(`      单次上下文中位 ${fmt(med(before.ctxs), 0)} → ${fmt(med(after.ctxs), 0)}（${fmt(med(before.ctxs) / Math.max(1, med(after.ctxs)), 1)}×）`);
  console.log(`      按切换后的每回合成本推算：一天 226 回合 ≈ ¥${fmt(perTurnAfter * 226)}`);
}

// 时间窗模式：把"同一批请求在切换前要花多少"算出来 —— 请求数取决于群里聊了多少，不取决于我们改了什么，
// 所以"同样请求数下的单价对比"才是公平的成效口径。
if (win) {
  console.log('\n=========== 时间窗汇总 ===========');
  if (!win.reqs) { console.log('（这个窗口内没有请求）'); process.exit(0); }
  const w = fromArg ?? ''; const w2 = toArg ?? '';
  console.log(`窗口：${w || '不限'} ~ ${w2 || '不限'}（本地时间）`);
  console.log(`  请求 ${fmt(win.reqs, 0)}｜回合 ${fmt(win.turns, 0)}｜每回合请求 ${fmt(win.reqs / Math.max(1, win.turns), 2)}`);
  console.log(`  单次上下文中位 ${fmt(med(win.ctxs), 0)}｜平均 ${fmt((win.hit + win.miss) / win.reqs, 0)}`);
  console.log(`  token：命中 ${fmt(win.hit / 1e6, 2)}M｜未命中 ${fmt(win.miss / 1e6, 2)}M｜输出 ${fmt(win.out / 1e3, 1)}k`);
  console.log(`  花费 ¥${fmt(win.usd * CNY, 4)}｜每请求 ¥${fmt((win.usd * CNY) / win.reqs, 4)}｜每回合 ¥${fmt((win.usd * CNY) / Math.max(1, win.turns), 4)}`);
  if (before.reqs) {
    const perReqBefore = (before.usd * CNY) / before.reqs;
    const perReqWin = (win.usd * CNY) / win.reqs;
    console.log(`\n  对照（混合平均单价）：同样 ${fmt(win.reqs, 0)} 个请求，按切换前 ¥${fmt(perReqBefore, 4)}/请求 ≈ ¥${fmt(perReqBefore * win.reqs, 4)}；实际 ¥${fmt(win.usd * CNY, 4)}（${fmt(perReqBefore / perReqWin, 1)}×）`);
    // **同电价档位**的对照才是公平的：这个窗口多数落在哪一档，就拿旧体制那一档的单价来折。
    const winPeakReq = byClass.winPeak.reqs; const winOffReq = byClass.winOff.reqs;
    const usePeak = winPeakReq >= winOffReq;
    const ref = usePeak ? byClass.beforePeak : byClass.beforeOff;
    if (ref.reqs) {
      const refPerReq = (ref.usd * CNY) / ref.reqs;
      console.log(`  对照（同电价档位·${usePeak ? '高峰' : '低谷'}）：旧体制 ¥${fmt(refPerReq, 4)}/请求 → 同样 ${fmt(win.reqs, 0)} 个请求 ≈ ¥${fmt(refPerReq * win.reqs, 4)}；实际 ¥${fmt(win.usd * CNY, 4)}（${fmt(refPerReq / perReqWin, 1)}×）`);
    }
    console.log(`        单次上下文 ${fmt(med(before.ctxs), 0)} → ${fmt(med(win.ctxs), 0)}（${fmt(med(before.ctxs) / Math.max(1, med(win.ctxs)), 1)}×）`);
  }
}
