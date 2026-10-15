// 手机连接（Agents Anywhere）"本机连接"记录的健康判定 —— **纯函数，不碰磁盘、不查进程**。
//
// 背景（2026-10-08 事故，见 docs/事故-2026-10-08-手机连接僵尸记录.md）：
//   AA 的 bridge 启动时会把自己的端点写进 `<DSH_HOME>\agents-anywhere\bridge\endpoint.json`：
//     {"version":1,"host":"127.0.0.1","port":49936,"token":"…","pid":15424}
//   下次启动时它只做一件事：**读这个文件，看里面的 pid 还活着吗**（`processExists(pid)`）。
//   活着就认定"另一个 DSH 还在管这条连接"，直接抛 BRIDGE_IN_USE —— 面板上就是
//   「本机连接被占用，无法启动」，而且**重启多少次都没用**（文件还在，pid 还在）。
//
// 那个坑的本质：Windows 会**回收 pid**。写文件的 DSH 早就退出了，pid 15424 被系统给了
// RuntimeBroker.exe，于是"pid 还活着"永远为真。
//
// 所以这里的设计目标是**只做能证明的判断**：
//   · 只有能证明"记录里的主人不可能是写这个文件的进程"时才允许清理；
//   · 证据不足（进程查不到、字段缺失、查询失败）一律 keep —— 宁可漏清，绝不误删活记录（误删会
//     把一条正常工作的手机连接弄断，比漏清严重得多）。
//
// 三条"可证明的死法"：
//   1. owner-gone        记录的 pid 已经不存在（进程表里查无此人）；
//   2. pid-reused        进程存在，但**启动时间晚于文件写入时间** —— 写文件的人当时正持有这个 pid，
//                        所以现在这个更晚启动的进程不可能是它（这条与进程名字无关，最硬）；
//   3. foreign-process   进程存在、名字明显不是 DSH 那一路（仅在拿不到启动时间时作兜底）。
// 判定为 live 的唯一形态：进程存在、启动时间不晚于文件、名字在 DSH 白名单里 —— 一律不碰。
//
// 顺带说明为什么"名字判断"要**宽松**（白名单长、只认明确的外人）：名字规则一旦误判成"外人"，
// 就会去删一条活记录。宽松的代价只是偶尔漏清（用户还能手动点「尝试重启」），这个代价是划算的。

/** DSH 那一路的进程名（宽松白名单；不在里面才认为"外人"）。 */
export const DSH_PROCESS_NAMES = ['dsh desktop.exe', 'dsh.exe', 'dsh.cmd', 'node.exe', 'electron.exe'];

/** 进程启动时间必须比文件写入时间晚这么多，才算"pid 被回收"（防止同一秒内的时钟抖动误判）。 */
export const PID_REUSE_GRACE_MS = 2000;

/** 文件解析不了的记录，多久之后才允许清理（刚写坏的先等等，别跟正在发布的进程抢）。 */
export const PARSE_FAILURE_GRACE_MS = 120_000;

/**
 * 一个"解析不了"的文件，**像不像我们知道的那个 schema 的坏版本**。
 *
 * 为什么要这层：将来自愈脚本会长期跑着，而 AA 插件可能改端点文件的写法。如果哪天它换成了
 * 另一种 JSON 形状（比如 `{"endpoint":{…}}`），我们**绝不该**把它当成"坏文件"清掉 ——
 * 那会把一条正常工作的连接弄断。所以只有明显属于这套 schema（出现 version/pid/port/token
 * 这些字段名）却又解析不了时，才认为它是"坏掉的老记录"。
 */
export function looksLikeBrokenEndpoint(text) {
  const s = String(text ?? '');
  return /"(version|pid|port|token|host)"\s*:/.test(s);
}

/**
 * 解析 endpoint.json 的内容。
 * @returns {{ok: true, value: {pid: number, port: number, host: string, token: string|null}}
 *          | {ok: false, reason: string}}
 */
export function parseEndpoint(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `unparseable: ${error?.message ?? error}` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not-an-object' };
  const pid = Number(obj.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return { ok: false, reason: `bad-pid: ${JSON.stringify(obj.pid)}` };
  const port = Number(obj.port);
  return {
    ok: true,
    value: {
      pid,
      port: Number.isSafeInteger(port) && port > 0 ? port : 0,
      host: typeof obj.host === 'string' ? obj.host : '',
      token: typeof obj.token === 'string' ? obj.token : null,
    },
  };
}

/**
 * 这个进程像不像"DSH 那一路"。宽松判定：名字在白名单里，或命令行里出现 dsh 字样。
 * @param {{name?: string|null, commandLine?: string|null}|null|undefined} proc
 */
export function looksLikeDsh(proc) {
  if (!proc) return false;
  const name = String(proc.name ?? '').trim().toLowerCase();
  if (name && DSH_PROCESS_NAMES.includes(name)) return true;
  const cmd = String(proc.commandLine ?? '').toLowerCase();
  // 命令行里带 dsh / deepseek harness 的都放过（桌面端宿主也可能是别的可执行名）
  return /\bdsh\b|dsh desktop|deepseek[- ]harness|dsh-home/.test(cmd);
}

/**
 * 判定该拿这条记录怎么办。
 *
 * @param {object} input
 * @param {boolean} input.exists         endpoint.json 在不在
 * @param {string|null} input.raw        文件内容（不存在时传 null）
 * @param {number|null} input.mtimeMs    文件写入时间（ms）
 * @param {number} input.nowMs           现在（ms）
 * @param {{pid:number,name?:string|null,commandLine?:string|null,startedAtMs?:number|null}|null} input.proc
 *        记录的 pid 对应的进程；`null` = 查过了、确实不存在；
 *        **`undefined` = 查询失败、无法判断**（这时一律 keep）
 * @param {string|null} [input.procQueryError] 查询失败的原因（只用于日志）
 * @returns {{action: 'none'|'keep'|'wait'|'heal', reason: string, detail: string, evidence: object}}
 *          action：none=没有文件；keep=保留（活的/证据不足）；wait=先别动（刚写坏）；
 *                  heal=可以清理（有证明）
 */
export function decideEndpoint({ exists, raw, mtimeMs, nowMs, proc, procQueryError = null }) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!exists) {
    return { action: 'none', reason: 'no-endpoint-file', detail: '没有 endpoint.json（bridge 还没发布过）', evidence: {} };
  }

  const parsed = parseEndpoint(raw);
  const ageMs = Number.isFinite(mtimeMs) ? Math.max(0, now - mtimeMs) : null;

  if (!parsed.ok) {
    // 解析不了：可能正在写（虽然它是"临时文件 + link"原子发布的）、也可能是被别的东西弄坏了。
    // 刚写的先等一等；老过 2 分钟、**而且看得出是我们认识的那套 schema 的坏版本**，才允许清。
    if (!looksLikeBrokenEndpoint(raw)) {
      return {
        action: 'keep',
        reason: 'unknown-format',
        detail: 'endpoint.json 解析不了，而且看不出是这套 schema（可能换版本了）—— 不碰',
        evidence: { raw: String(raw ?? '').slice(0, 200) },
      };
    }
    if (ageMs !== null && ageMs >= PARSE_FAILURE_GRACE_MS) {
      return {
        action: 'heal',
        reason: 'unparseable',
        detail: `endpoint.json 解析不了（${parsed.reason}），且已经 ${Math.round(ageMs / 1000)} 秒没变过`,
        evidence: { raw: String(raw ?? '').slice(0, 200), ageMs, parseError: parsed.reason },
      };
    }
    return {
      action: 'wait',
      reason: 'unparseable-fresh',
      detail: `endpoint.json 现在解析不了（${parsed.reason}），但刚写过（${ageMs === null ? '未知' : Math.round(ageMs / 1000) + ' 秒'}），先不动`,
      evidence: { parseError: parsed.reason, ageMs },
    };
  }

  const { pid, port } = parsed.value;
  const base = { pid, port, ageMs };

  // 查询失败（PowerShell 报错 / 超时）：没有证据，一律不碰。
  if (proc === undefined) {
    return {
      action: 'keep',
      reason: 'proc-query-failed',
      detail: `查不到 pid ${pid} 的进程信息（${procQueryError ?? '原因未知'}），没有证据就不清理`,
      evidence: base,
    };
  }

  // 死法 1：pid 不存在了。
  if (proc === null) {
    return { action: 'heal', reason: 'owner-gone', detail: `记录里的 pid ${pid} 已经不存在（进程早退出了）`, evidence: base };
  }

  const started = Number.isFinite(proc.startedAtMs) ? proc.startedAtMs : null;
  const evidenced = { ...base, procName: proc.name ?? null, procStartedAtMs: started, mtimeMs: mtimeMs ?? null };

  // 死法 2：进程启动时间晚于文件写入时间 —— 写文件的人当时正持有这个 pid，所以它不是写文件的那个。
  if (started !== null && Number.isFinite(mtimeMs) && started > mtimeMs + PID_REUSE_GRACE_MS) {
    const gapMin = Math.round((started - mtimeMs) / 60000);
    return {
      action: 'heal',
      reason: 'pid-reused',
      detail: `pid ${pid} 现在是「${proc.name ?? '?'}」，但它比记录文件晚启动 ${gapMin} 分钟 —— 这个 pid 是被系统回收后给了别的进程（2026-10-08 那个坑）`,
      evidence: evidenced,
    };
  }

  // 死法 3（兜底）：拿不到启动时间时，按名字判断是不是"外人"。
  if (started === null && !looksLikeDsh(proc)) {
    return {
      action: 'heal',
      reason: 'foreign-process',
      detail: `pid ${pid} 现在归「${proc.name ?? '?'}」所有，不是 DSH 那一路的东西`,
      evidence: evidenced,
    };
  }

  return {
    action: 'keep',
    reason: 'owner-alive',
    detail: `pid ${pid}（${proc.name ?? '?'}）还在，且不是"pid 被回收"的形态 —— 这条记录是活的，不碰`,
    evidence: evidenced,
  };
}

/** 归档文件名：一眼能看出是什么时候、因为什么清掉的。 */
export function archiveName({ pid, reason, at = new Date() }) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `endpoint.json.stale-${stamp}-pid${pid}-${reason}.json`;
}
