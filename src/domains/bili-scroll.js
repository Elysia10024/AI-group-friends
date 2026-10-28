// 空闲时间自己刷 B 站：热门挑一条 ≤5 分钟的短视频，抓简介/热度前 5 评论 + 每秒一帧。
//
// 只在「梁文谷空闲时段」刷（core/idle-time.js）；每小时最多一次。
// 每天配额 = 当天空闲小时数（工作日 17、周末/节假日 24；见 core/bili-scroll.js）。
// 凌晨 1:00–8:00 只刷不分享：刷到的先进待分享池（state.pending），8 点后再挑着分享。
// 定时器只负责「叫她一次」；真正看视频要走 qq_bili_scroll 工具（配额校验在同一处）。
import path from 'node:path';
import { BILI_SCROLL_DEFAULTS, appendShareItem, inShareQuietHours, pickCandidate, scrollQuota } from '../core/bili-scroll.js';
import { appendNote, makeNote } from '../core/bili-notes.js';
import { idleHoursOnDay, isIdleTime } from '../core/idle-time.js';
import { localDayKey } from '../core/local-day.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function createBiliScrollModule(ctx) {
  const { cfg, log, stateDir, readJsonSafe, atomicWriteJson, biliLook } = ctx;
  const stateFile = path.join(stateDir, 'bili-scroll.json');
  // 看过的视频笔记（2026-10-25）：独立文件，和配额状态分开，方便以后单独检索/注入材料。
  const notesFile = path.join(stateDir, 'bili-notes.json');
  let state = readJsonSafe(stateFile, { version: 1 });
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = { version: 1 };

  let timer = null;
  let firstTimer = null;
  let lastWakeAt = 0;

  const opts = () => ({ ...BILI_SCROLL_DEFAULTS, ...(cfg.biliScroll ?? {}) });

  function save() {
    state.version = 1;
    atomicWriteJson(stateFile, state);
  }

  async function getJson(url) {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(15000)
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`B 站返回非 JSON（HTTP ${res.status}）`);
    }
  }

  async function fetchPopular() {
    const json = await getJson('https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1');
    if (json?.code !== 0) throw new Error(`热门接口 code=${json?.code} ${json?.message ?? ''}`);
    return Array.isArray(json?.data?.list) ? json.data.list : [];
  }

  /**
   * 自己挑一个视频看。手动调用也要过空闲时段/间隔/日上限。
   * @returns {Promise<{text:string,images:Array,bv:string,title:string}>}
   */
  async function scroll(key) {
    const o = opts();
    if (o.enabled === false) throw new Error('自己刷视频已关闭（config.biliScroll.enabled=false）');
    const t = isIdleTime();
    if (!t.idle) throw new Error(`现在是高峰时段（${t.day} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}），只在空闲时段刷`);
    const day = localDayKey();
    const quota = scrollQuota(state, Date.now(), day, o);
    if (!quota.ok) {
      throw new Error(quota.reason === 'interval' ? '刚刷过，至少隔 1 小时' : '今天已经刷够了');
    }
    const list = await fetchPopular();
    const cand = pickCandidate(list, { maxDurationSec: Number(o.maxDurationSec) || 300 });
    if (!cand) throw new Error('热门里没挑到 5 分钟以内的视频');
    const out = await biliLook.watchBv(cand.bvid, { withFrames: o.withFrames !== false });
    const prevCount = state.day === day ? Number(state.count) || 0 : 0;
    state.day = day;
    state.count = prevCount + 1;
    state.lastAt = Date.now();
    state.lastBv = cand.bvid;
    // 凌晨只刷不分享：先记进待分享池，8 点后再端给她（普通聊天不受影响）。
    if (inShareQuietHours(Date.now(), o)) {
      state.pending = appendShareItem(state.pending, { bv: cand.bvid, title: cand.title, at: Date.now() });
    }
    save();
    biliLook.recordHistory({ bv: cand.bvid, title: cand.title, source: 'self', key, frames: out.images.length });
    // 看过的视频落成结构化笔记（内容摘要 + 热评）：只活在当轮上下文里太浪费，
    // 存下来以后才能检索、回灌材料（2026-10-25 第 1 步；她的看法仍走 qq_memory_append）。
    let noted = false;
    try {
      const note = makeNote({
        bv: cand.bvid,
        title: cand.title,
        tname: cand.tname,
        owner: out.view?.owner?.name,
        duration: cand.duration,
        desc: out.view?.desc,
        comments: out.comments,
        key,
        at: Date.now()
      });
      if (note) {
        const store = readJsonSafe(notesFile, { version: 1, notes: [] });
        const notes = appendNote(Array.isArray(store?.notes) ? store.notes : [], note);
        atomicWriteJson(notesFile, { version: 1, notes });
        noted = true;
        log(`[bili-notes] 记下 ${cand.bvid}（共 ${notes.length} 条）`);
      }
    } catch (error) {
      log(`[bili-notes] 笔记写入失败：${error?.message ?? error}`);
    }
    log(`[bili-scroll] ${key} 自己刷了 ${cand.bvid}（${cand.duration}s，今天第 ${state.count} 次）`);
    return { text: out.text, images: out.images, bv: cand.bvid, title: cand.title, noted };
  }

  async function tick(onWake) {
    const o = opts();
    if (o.enabled === false || typeof onWake !== 'function') return;
    const t = isIdleTime();
    if (!t.idle) return;
    const now = Date.now();
    if (now - lastWakeAt < Math.max(60000, Number(o.intervalMs) || BILI_SCROLL_DEFAULTS.intervalMs)) return;
    const day = localDayKey();
    const wakeCount = state.wakeDay === day ? Number(state.wakeCount) || 0 : 0;
    // 唤醒配额和观看配额同一口径：显式给正数才用，否则按当天空闲小时数。
    const wakeCap = Number(o.maxWakePerDay) > 0 ? Number(o.maxWakePerDay) : idleHoursOnDay(now);
    if (wakeCount >= Math.max(1, wakeCap)) return;
    lastWakeAt = now;
    state.wakeDay = day;
    state.wakeCount = wakeCount + 1;
    save();
    try {
      await onWake();
      log(`[bili-scroll] 空闲唤醒（今天第 ${state.wakeCount} 次）`);
    } catch (error) {
      log(`[bili-scroll] 唤醒失败：${error?.message ?? error}`);
    }
  }

  /** 启动定时检查：每 10 分钟看一次是否到了空闲时段。 */
  function start({ onWake } = {}) {
    const o = opts();
    if (o.enabled === false) {
      log('[bili-scroll] 未启用');
      return;
    }
    if (timer) return;
    firstTimer = setTimeout(() => { void tick(onWake); }, 60000);
    firstTimer.unref?.();
    timer = setInterval(() => { void tick(onWake); }, 10 * 60 * 1000);
    timer.unref?.();
    log('[bili-scroll] 已启动：每 10 分钟检查空闲时段（每小时最多一次）');
  }

  function stop() {
    if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
  }

  /**
   * 给唤醒 prompt 用的分享素材：现在是否在「只刷不分享」窗口、攒着哪些视频。
   * 静默窗口里 pending 一律不展示（凌晨刷的留着 8 点后再端出去）。
   */
  function shareMeta() {
    const o = opts();
    const quiet = inShareQuietHours(Date.now(), o);
    return { quiet, pending: quiet ? [] : (Array.isArray(state.pending) ? state.pending.slice(-6) : []) };
  }

  /** 唤醒投递后调用：待分享的视频已经端给她了，清掉池子（同一条不反复提）。 */
  function onWakeDelivered() {
    if (!Array.isArray(state.pending) || !state.pending.length) return;
    if (inShareQuietHours(Date.now(), opts())) return; // 静默期没端出去，留着
    state.pending = [];
    save();
  }

  function status() {
    const t = isIdleTime();
    const o = opts();
    return {
      enabled: o.enabled !== false,
      idle: t.idle,
      reason: t.reason,
      day: state.day,
      count: state.count,
      lastAt: state.lastAt,
      lastBv: state.lastBv,
      wakeCount: state.wakeDay === localDayKey() ? state.wakeCount : 0,
      idleHours: idleHoursOnDay(),
      shareQuiet: inShareQuietHours(Date.now(), o),
      pendingShares: Array.isArray(state.pending) ? state.pending.length : 0
    };
  }

  return { start, stop, scroll, status, shareMeta, onWakeDelivered };
}
