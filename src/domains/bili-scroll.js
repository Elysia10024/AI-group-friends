// 空闲时间自己刷 B 站：热门挑一条 ≤5 分钟的短视频，抓简介/热度前 5 评论 + 每 2 秒一帧。
//
// 只在「梁文谷空闲时段」刷（core/idle-time.js）；每小时最多一次；每天有上限。
// 定时器只负责「叫她一次」；真正看视频要走 qq_bili_scroll 工具（配额校验在同一处）。
import path from 'node:path';
import { BILI_SCROLL_DEFAULTS, pickCandidate, scrollQuota } from '../core/bili-scroll.js';
import { isIdleTime } from '../core/idle-time.js';
import { localDayKey } from '../core/local-day.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function createBiliScrollModule(ctx) {
  const { cfg, log, stateDir, readJsonSafe, atomicWriteJson, biliLook } = ctx;
  const stateFile = path.join(stateDir, 'bili-scroll.json');
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
    state.day = day;
    state.count = (state.day === day ? Number(state.count) || 0 : 0) + 1;
    state.lastAt = Date.now();
    state.lastBv = cand.bvid;
    save();
    biliLook.recordHistory({ bv: cand.bvid, title: cand.title, source: 'self', key, frames: out.images.length });
    log(`[bili-scroll] ${key} 自己刷了 ${cand.bvid}（${cand.duration}s，今天第 ${state.count} 次）`);
    return { text: out.text, images: out.images, bv: cand.bvid, title: cand.title };
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
    if (wakeCount >= Math.max(1, Number(o.maxWakePerDay) || BILI_SCROLL_DEFAULTS.maxWakePerDay)) return;
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

  function status() {
    const t = isIdleTime();
    return {
      enabled: opts().enabled !== false,
      idle: t.idle,
      reason: t.reason,
      day: state.day,
      count: state.count,
      lastAt: state.lastAt,
      lastBv: state.lastBv,
      wakeCount: state.wakeDay === localDayKey() ? state.wakeCount : 0
    };
  }

  return { start, stop, scroll, status };
}
