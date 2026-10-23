// B 站订阅播报域：只读轮询 UP 主的投稿视频，发现新款就发到指定群。
//
// 边界（2026-10-23 用户敲定）：
//   · 只要视频（DYNAMIC_TYPE_AV），图文/转发/专栏不播；
//   · 播报带链接；只发 allow.groups 里的群；
//   · 群里 /安静 时不发（跟静默模式一个闸门），不补发；
//   · 夜间不轮询（activeHours），首次运行只建基线；
//   · 不花模型钱：纯 HTTP + 固定文案，不叫醒她。
//
// 数据源用 `feed/space` 而不是 `arc/search`：后者对部分官号（实测明日方舟）直接 -412，
// 前者稳定，且 AV 条目自带 major.archive（bvid/title）。
import path from 'node:path';
import { isChatMuted } from '../core/mute.js';
import { readJsonSafe, atomicWriteJson } from '../core/state-io.js';
import {
  BILIBILI_DEFAULTS,
  normalizeTargets,
  extractVideo,
  diffVideos,
  nextSeen,
  formatVideo,
  signWbi
} from '../core/bilibili.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CRED_TTL_MS = 10 * 60 * 1000;
const ALERT_GAP_MS = 6 * 60 * 60 * 1000;

/** 月份-日期 时:分（本机时区），给提示行用。 */
function fmtShort(ts) {
  const d = new Date(Number(ts) || 0);
  if (!Number.isFinite(d.getTime()) || d.getTime() <= 0) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function createBilibiliModule(ctx) {
  const { cfg, log, onebotSend, sendToQQ, readRoleState, stateDir, sleep } = ctx;
  const stateFile = path.join(stateDir, 'bilibili-seen.json');
  const cookieFile = path.join(stateDir, 'bilibili-cookie.json');

  let state = readJsonSafe(stateFile, { version: 1, uids: {} });
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = { version: 1, uids: {} };
  if (!state.uids || typeof state.uids !== 'object' || Array.isArray(state.uids)) state.uids = {};

  let timer = null;
  let bootstrapTimer = null;
  let running = false;
  let cred = null;
  let lastAlertAt = 0;
  let lastPollAt = 0;
  let lastError = '';
  const failures = new Map();

  const opts = () => ({ ...BILIBILI_DEFAULTS, ...(cfg.bilibili ?? {}) });

  function saveState() {
    state.version = 1;
    atomicWriteJson(stateFile, state);
  }

  /**
   * 给唤醒提示用的那一行事实：关注了谁 + 最近播报了什么。
   * 没有订阅 / 没启用时返回空串（提示里整段不出现，不花 token）。
   */
  function promptText() {
    const o = opts();
    const targets = normalizeTargets(o.targets);
    if (o.enabled !== true || !targets.length) return '';
    const names = targets.map((t) => t.alias).join('、');
    const last = state.lastSent;
    const tail = last && last.title
      ? `；最近播报：${last.alias}《${String(last.title).slice(0, 40)}》（${fmtShort(last.at)}）`
      : '；还没有新视频播报';
    return `【B站订阅】关注了：${names}${tail}。\n\n`;
  }

  async function getJson(url, headers) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error(`HTTP ${res.status}（返回非 JSON）`);
    }
    return json;
  }

  /** 取登录态 + WBI key + 设备指纹；缓存 10 分钟。 */
  async function getCred(force = false) {
    if (cred && !force && Date.now() - cred.at < CRED_TTL_MS) return cred;
    const sessdata = String(readJsonSafe(cookieFile, null)?.sessdata ?? opts().sessdata ?? '').trim();
    if (!sessdata) throw new Error('缺少 SESSDATA（state/bilibili-cookie.json）');

    const spi = await getJson('https://api.bilibili.com/x/frontend/finger/spi', {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/'
    });
    const b3 = String(spi?.data?.b_3 ?? '');
    const b4 = String(spi?.data?.b_4 ?? '');
    const cookie = [
      `SESSDATA=${sessdata}`,
      b3 && `buvid3=${b3}`,
      b4 && `buvid4=${b4}`,
      `b_nut=${Math.round(Date.now() / 1000)}`
    ].filter(Boolean).join('; ');

    const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      cookie,
      referer: 'https://space.bilibili.com/'
    });
    if (nav?.code !== 0 || nav?.data?.isLogin !== true) {
      throw new Error(`B 站登录态无效（code=${nav?.code ?? '?'}）`);
    }
    const imgUrl = String(nav?.data?.wbi_img?.img_url ?? '');
    const subUrl = String(nav?.data?.wbi_img?.sub_url ?? '');
    const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1).split('.')[0];
    const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1).split('.')[0];
    cred = { cookie, imgKey, subKey, at: Date.now() };
    return cred;
  }

  async function fetchItems(target, c) {
    const pages = Math.max(1, Math.min(3, Number(opts().pages) || BILIBILI_DEFAULTS.pages));
    const items = [];
    let offset = '';
    for (let i = 0; i < pages; i += 1) {
      const params = { host_mid: target.uid, timezone_offset: -480, features: 'itemOpusStyle' };
      if (offset) params.offset = offset;
      const qs = signWbi(params, c.imgKey, c.subKey);
      const json = await getJson(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${qs}`, {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        cookie: c.cookie,
        referer: `https://space.bilibili.com/${target.uid}/dynamic`,
        origin: 'https://space.bilibili.com'
      });
      if (json?.code !== 0) throw new Error(`code=${json?.code} ${json?.message ?? ''}`);
      const pageItems = Array.isArray(json?.data?.items) ? json.data.items : [];
      items.push(...pageItems);
      offset = String(json?.data?.offset ?? '');
      if (!offset || !pageItems.length) break;
      if (i + 1 < pages) await sleep(700);
    }
    return items;
  }

  async function alertOnce(message) {
    if (Date.now() - lastAlertAt < ALERT_GAP_MS) return;
    lastAlertAt = Date.now();
    try {
      await sendToQQ(`private:${cfg.ownerQQ}`, `[B站订阅] ${message}`);
    } catch (error) {
      log('[bilibili] 告警发送失败：', error?.message ?? error);
    }
  }

  function inActiveHours(o) {
    const h = new Date().getHours();
    const arr = Array.isArray(o.activeHours) ? o.activeHours : BILIBILI_DEFAULTS.activeHours;
    const start = Math.max(0, Math.min(24, Number(arr[0]) || 0));
    const end = Math.max(0, Math.min(24, Number(arr[1]) || 24));
    return end === 24 ? h >= start : h >= start && h < end;
  }

  /**
   * 跑一轮。dryRun=true 时不发送、不落盘，只打日志（用于上线前验证/控制台"立即检查"）。
   * @returns {Promise<{checked:number,sent:number,baseline:number,skipped:number,errors:string[],fresh:object[]}>}
   */
  async function pollOnce({ dryRun = false } = {}) {
    const o = opts();
    const targets = normalizeTargets(o.targets);
    const result = { checked: 0, sent: 0, baseline: 0, skipped: 0, errors: [], fresh: [] };
    lastPollAt = Date.now();
    lastError = '';
    if (!targets.length) {
      log('[bilibili] 没有订阅目标');
      return result;
    }
    const allowed = new Set((cfg.allow?.groups ?? []).map(Number));
    let c;
    try {
      c = await getCred();
    } catch (error) {
      lastError = String(error?.message ?? error);
      throw error;
    }

    for (const t of targets) {
      if (t.enabled === false) {
        log(`[bilibili] 跳过 ${t.alias}（${t.uid}）：已在控制台暂停`);
        result.skipped += 1;
        continue;
      }
      const groups = t.groups.filter((g) => allowed.has(g));
      if (!groups.length) {
        log(`[bilibili] 跳过 ${t.alias}（${t.uid}）：群不在 allow.groups`);
        result.skipped += 1;
        continue;
      }
      try {
        const items = await fetchItems(t, c);
        const videos = items.map(extractVideo).filter(Boolean);
        const rec = state.uids[t.uid];
        const { baseline, fresh } = diffVideos(rec?.seen ?? null, videos, {
          now: Date.now(),
          maxAgeMs: Number(o.maxAgeMs) || BILIBILI_DEFAULTS.maxAgeMs
        });

        if (!rec) {
          state.uids[t.uid] = { seen: nextSeen([], videos), updatedAt: Date.now() };
          result.baseline += 1;
          log(`[bilibili] ${t.alias} 建立基线：${videos.length} 条视频（不补发历史）`);
        } else {
          const limit = Math.max(1, Number(o.maxPerRun) || BILIBILI_DEFAULTS.maxPerRun);
          for (const v of fresh.slice(0, limit)) {
            const message = formatVideo(o.template, { alias: t.alias, title: v.title, url: v.url });
            result.fresh.push({ uid: t.uid, alias: t.alias, title: v.title, url: v.url, created: v.created });
            if (dryRun) {
              log(`[bilibili][dry] ${t.alias} → ${groups.join(',')}\n${message}`);
              result.sent += 1;
              continue;
            }
            for (const gid of groups) {
              if (isChatMuted(readRoleState().mode, `group:${gid}`)) {
                log(`[bilibili] 群 ${gid} 处于静默，跳过 ${v.id}`);
                result.skipped += 1;
                continue;
              }
              await onebotSend('group', gid, message);
              state.lastSent = { alias: t.alias, title: v.title, url: v.url, group: gid, at: Date.now() };
              result.sent += 1;
            }
          }
          state.uids[t.uid] = { seen: nextSeen(rec.seen, videos), updatedAt: Date.now() };
        }

        if (dryRun && videos[0]) {
          log(`[bilibili][dry] ${t.alias} 文案预览（不是新视频）：\n${formatVideo(o.template, { alias: t.alias, title: videos[0].title, url: videos[0].url })}`);
        }
        if (!dryRun) saveState();
        result.checked += 1;
        failures.delete(t.uid);
      } catch (error) {
        const message = error?.message ?? String(error);
        lastError = message;
        result.errors.push(`${t.alias}: ${message}`);
        log(`[bilibili] ${t.alias}（${t.uid}）失败：${message}`);
        const n = (failures.get(t.uid) ?? 0) + 1;
        failures.set(t.uid, n);
        if (n >= 3) await alertOnce(`${t.alias} 已连续失败 ${n} 次：${message}`);
      }
      await sleep(Math.max(500, Number(o.requestGapMs) || BILIBILI_DEFAULTS.requestGapMs));
    }
    return result;
  }

  async function tick() {
    if (running) return;
    const o = opts();
    if (!inActiveHours(o)) return;
    running = true;
    try {
      await pollOnce();
    } catch (error) {
      lastError = String(error?.message ?? error);
      log('[bilibili] 轮询异常：', error?.message ?? error);
      // getCred 失败（cookie 过期 / 412）会在进入每个 UID 的 try 之前抛出，
      // 不走下面的连续失败计数 —— 这里单独兜一层告警，否则 cookie 废了也没人知道。
      await alertOnce(`轮询异常：${error?.message ?? error}`).catch(() => {});
    } finally {
      running = false;
    }
  }

  function startBilibiliWatch() {
    const o = opts();
    if (o.enabled !== true) {
      log('[bilibili] 未启用（config.bilibili.enabled=false）');
      return;
    }
    if (timer) return;
    const interval = Math.max(120000, Number(o.intervalMs) || BILIBILI_DEFAULTS.intervalMs);
    bootstrapTimer = setTimeout(() => {
      bootstrapTimer = null;
      void tick();
    }, 15000);
    bootstrapTimer.unref?.();
    timer = setInterval(() => { void tick(); }, interval);
    timer.unref?.();
    log(`[bilibili] 已启动：${normalizeTargets(o.targets).length} 个订阅，每 ${Math.round(interval / 60000)} 分钟检查`);
  }

  function stopBilibiliWatch() {
    if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
  }

  /** 控制台用：当前配置 + 每个目标的已见条数 + 最近一次检查/播报。 */
  function status() {
    const o = opts();
    const targets = normalizeTargets(o.targets).map((t) => {
      const rec = state.uids[t.uid];
      return {
        uid: t.uid,
        alias: t.alias,
        groups: t.groups,
        enabled: t.enabled !== false,
        seenCount: Array.isArray(rec?.seen) ? rec.seen.length : 0,
        updatedAt: Number(rec?.updatedAt) || 0
      };
    });
    return {
      enabled: o.enabled === true,
      intervalMs: o.intervalMs,
      activeHours: o.activeHours,
      pages: o.pages,
      maxPerRun: o.maxPerRun,
      template: o.template,
      lastPollAt,
      lastError,
      lastSent: state.lastSent ?? null,
      targets
    };
  }

  /** 控制台保存配置后重建定时器（间隔/启停变了；目标列表不需要重启，下一轮会读到）。 */
  function restart() {
    stopBilibiliWatch();
    startBilibiliWatch();
  }

  /** 控制台"立即检查"：只读跑一轮，不发群、不落盘。 */
  async function checkNow() {
    return pollOnce({ dryRun: true });
  }

  return { startBilibiliWatch, stopBilibiliWatch, pollOnce, promptText, status, restart, checkNow };
}
