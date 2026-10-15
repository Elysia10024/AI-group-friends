// 单实例锁的存活判定 —— 纯函数，零 I/O。
//
// 为什么要抽出来（2026-09-20 早上实测事故）：桥的锁文件里存的是 PID，进程退出后
// 锁不会自己消失（崩溃时来不及 releaseLock）。重启电脑之后，**PID 会被系统复用**：
// 锁里写的 156024 变成了 SnowLuma 的进程，于是 `process.kill(pid, 0)` 成功 ——
// 桥认为"已有实例在运行"，启动即退出；watchdog 每 45 秒拉一次，每次都一样的死法。
// 那天早上小鲸鱼就是不在线的，而日志里只有一句"已有实例在运行"。
//
// 更糟的是危险面：任何"按锁里的 PID 去杀进程"的脚本（restart-bridge.mjs）会**误杀**
// 那个被复用了 PID 的无辜进程。所以判据不能只看 PID 是否活着。
//
// 修法：给"活着"加一条**心跳新鲜度** —— 运行中的桥每 LOCK_HEARTBEAT_MS touch 一次锁文件，
// mtime 超过 LOCK_STALE_MS 就认为持锁者已经不在了。刚开机时锁文件的 mtime 是旧的，
// 于是自然判为过期；PID 复用也不再能造成假活。

/** 运行中的桥多久 touch 一次锁文件。 */
export const LOCK_HEARTBEAT_MS = 60_000;
/** mtime 超过这么久没更新 → 认为持锁者已经不在。 */
export const LOCK_STALE_MS = 180_000;

/**
 * 判定锁的持有者是否还活着。
 * @param {object} p
 * @param {boolean} p.pidAlive     锁里那个 PID 现在是否还存在（调用方用 process.kill(pid,0) 判断）
 * @param {number} p.mtimeMs       锁文件的 mtime（毫秒）；0/NaN 表示拿不到
 * @param {number} [p.now]
 * @param {number} [p.staleMs]
 * @returns {{live: boolean, reason: 'live'|'pid-dead'|'no-mtime'|'heartbeat-stale'}}
 */
export function lockLiveness({ pidAlive, mtimeMs, now = Date.now(), staleMs = LOCK_STALE_MS }) {
  if (!pidAlive) return { live: false, reason: 'pid-dead' };
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return { live: false, reason: 'no-mtime' };
  if (now - mtimeMs >= staleMs) return { live: false, reason: 'heartbeat-stale' };
  return { live: true, reason: 'live' };
}
