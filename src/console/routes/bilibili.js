// 控制台路由：B 站视频订阅管理（2026-10-23）。
//
// 5 条路由（全部只走控制台令牌，带 agent token 的一律拒绝——这是管理面，不是她用的工具）：
//   GET  /api/bilibili                 读当前配置 + 运行状态
//   POST /api/bilibili/config          保存全局设置（启停 / 间隔 / 时段 / 页数 / 模板）
//   POST /api/bilibili/targets         新增或更新一个监视目标（uid / 别名 / 群 / 启停）
//   POST /api/bilibili/targets/remove  取消监视
//   POST /api/bilibili/check           立即只读检查一轮（不发群、不写基线）
//
// 持久化：写 config.json 的 bilibili 段（原子写），同时热更新内存 cfg.bilibili ——
// 模块的 opts() 每轮都读 cfg，所以下一次轮询就按新配置跑，不用重启桥接。
import { BILIBILI_DEFAULTS, normalizeTargets } from '../../core/bilibili.js';

const clampInt = (v, min, max, fallback) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export async function handleBilibili(ctx) {
  const {
    cfg,
    req,
    url,
    sendJson,
    readBody,
    readJsonSafe,
    atomicWriteJson,
    ROOT,
    path,
    log,
    bilibili
  } = ctx;

  const allowedGroups = () => new Set((cfg.allow?.groups ?? []).map(Number));
  const configFile = () => path.join(ROOT, 'config.json');

  if (req.method === 'GET' && url.pathname === '/api/bilibili') return routeGet();
  if (req.method === 'POST' && url.pathname === '/api/bilibili/config') return await routeSaveConfig();
  if (req.method === 'POST' && url.pathname === '/api/bilibili/targets') return await routeUpsertTarget();
  if (req.method === 'POST' && url.pathname === '/api/bilibili/targets/remove') return await routeRemoveTarget();
  if (req.method === 'POST' && url.pathname === '/api/bilibili/check') return await routeCheck();
  return false;

  function routeGet() {
    sendJson({
      ok: true,
      status: bilibili?.status?.() ?? null,
      allowedGroups: [...allowedGroups()]
    });
    return true;
  }

  async function routeSaveConfig() {
    const body = await readBody();
    const prev = { ...(cfg.bilibili ?? {}) };
    const next = { ...prev };

    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (body.intervalMs !== undefined) {
      next.intervalMs = clampInt(body.intervalMs, 120000, 3600000, BILIBILI_DEFAULTS.intervalMs);
    }
    if (Array.isArray(body.activeHours) && body.activeHours.length === 2) {
      const start = clampInt(body.activeHours[0], 0, 24, 8);
      const end = clampInt(body.activeHours[1], 0, 24, 24);
      next.activeHours = [start, Math.max(start, end)];
    }
    if (body.pages !== undefined) next.pages = clampInt(body.pages, 1, 3, BILIBILI_DEFAULTS.pages);
    if (body.maxPerRun !== undefined) next.maxPerRun = clampInt(body.maxPerRun, 1, 20, BILIBILI_DEFAULTS.maxPerRun);
    if (body.template !== undefined) {
      const template = String(body.template ?? '').trim();
      if (!template) { sendJson({ ok: false, error: '播报模板不能为空' }, 400); return true; }
      if (template.length > 500) { sendJson({ ok: false, error: '播报模板不能超过 500 字' }, 400); return true; }
      if (!template.includes('{url}')) { sendJson({ ok: false, error: '播报模板必须包含 {url}' }, 400); return true; }
      next.template = template;
    }
    // 目标列表只接受已经存在的形状；没传就原样保留。
    if (Array.isArray(body.targets)) next.targets = normalizeTargets(body.targets);

    const file = readJsonSafe(configFile(), null, true);
    file.bilibili = next;
    atomicWriteJson(configFile(), file);
    cfg.bilibili = next;

    const needsRestart = (prev.enabled === true) !== (next.enabled === true)
      || Number(prev.intervalMs) !== Number(next.intervalMs);
    if (needsRestart) bilibili?.restart?.();
    log(`控制台：B 站订阅配置已更新（enabled=${next.enabled === true}，interval=${Math.round(Number(next.intervalMs) / 60000)}min，目标 ${(next.targets ?? []).length} 个）`);
    sendJson({ ok: true, status: bilibili?.status?.() ?? null });
    return true;
  }

  async function routeUpsertTarget() {
    const body = await readBody();
    const uid = Number(body.uid);
    if (!Number.isInteger(uid) || uid <= 0) {
      sendJson({ ok: false, error: 'UID 必须是正整数' }, 400);
      return true;
    }
    const prev = { ...(cfg.bilibili ?? {}) };
    const targets = normalizeTargets(prev.targets);
    const at = targets.findIndex((t) => t.uid === uid);

    // 只改启停时（控制台"暂停/恢复"按钮）不传 alias/groups：沿用原值。
    const alias = body.alias !== undefined
      ? (String(body.alias).trim().slice(0, 24) || String(uid))
      : (at >= 0 ? targets[at].alias : String(uid));
    let groups;
    if (body.groups === undefined && at >= 0) {
      groups = targets[at].groups;
    } else {
      const allowed = allowedGroups();
      groups = [...new Set((Array.isArray(body.groups) ? body.groups : String(body.groups ?? '').split(/[,，\s]+/))
        .map(Number)
        .filter((g) => Number.isInteger(g) && g > 0))].filter((g) => allowed.has(g));
    }
    if (!groups.length) {
      sendJson({ ok: false, error: '至少给一个群号，且必须在 allow.groups 白名单里' }, 400);
      return true;
    }
    const enabled = body.enabled !== false;

    const item = { uid, alias, groups, enabled };
    if (at >= 0) targets[at] = { ...targets[at], ...item };
    else targets.push(item);

    const next = { ...prev, targets };
    const file = readJsonSafe(configFile(), null, true);
    file.bilibili = next;
    atomicWriteJson(configFile(), file);
    cfg.bilibili = next;
    log(`控制台：B 站订阅${at >= 0 ? '更新' : '新增'} ${alias}（${uid}）→ 群 ${groups.join(',')}${enabled ? '' : '（暂停）'}`);
    sendJson({ ok: true, status: bilibili?.status?.() ?? null });
    return true;
  }

  async function routeRemoveTarget() {
    const body = await readBody();
    const uid = Number(body.uid);
    if (!Number.isInteger(uid) || uid <= 0) {
      sendJson({ ok: false, error: 'UID 必须是正整数' }, 400);
      return true;
    }
    const prev = { ...(cfg.bilibili ?? {}) };
    const targets = normalizeTargets(prev.targets).filter((t) => t.uid !== uid);
    const next = { ...prev, targets };
    const file = readJsonSafe(configFile(), null, true);
    file.bilibili = next;
    atomicWriteJson(configFile(), file);
    cfg.bilibili = next;
    log(`控制台：B 站订阅已取消 ${uid}（剩 ${targets.length} 个）`);
    sendJson({ ok: true, status: bilibili?.status?.() ?? null });
    return true;
  }

  async function routeCheck() {
    try {
      const result = await bilibili.checkNow();
      sendJson({ ok: true, result });
    } catch (error) {
      sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
    }
    return true;
  }
}
