// 「看群友分享的 B 站视频」的纯逻辑：BV 解析、分享者判定、每日配额、格式化。
// IO（HTTP/落盘）在 domains/bili-look.js；这里只放能离线单测的部分。
//
// 配额语义（2026-10-23 用户要求）：**每个群友每天只能让她看一次**。
// 甲今天让她看过视频 A，再分享视频 B 也要拒绝 —— 配额按「人」不按「视频」。
// 管理员（ownerQQ）默认豁免，方便自己测试/管理。

export const BILI_LOOK_DEFAULTS = {
  enabled: true,
  dailyPerUser: 1,
  ownerBypass: true,
  // 评论只看前 5 条，按热度排序（2026-10-23 用户定）。
  maxComments: 5,
  // 抽帧看画面：只看 5 分钟以内的视频，每 2 秒一帧，最多 150 张。
  withFrames: true,
  frameIntervalSec: 2,
  maxFrames: 150,
  maxDurationSec: 300,
  pythonPath: '<外部工具目录>\\bili-videoread\\.venv\\Scripts\\python.exe',
  ffmpegPath: '<外部工具目录>\\bili-videoread\\.venv\\lib\\site-packages\\imageio_ffmpeg\\binaries\\ffmpeg-win-x86_64-v7.1.exe',
  downloadTimeoutMs: 180000
};

/** 从任意文本里抠出第一个 BV 号；没有返回空串。 */
export function extractBv(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : '';
}

/**
 * 在会话最近消息里找「是谁分享了这个视频」：从新到旧找第一条包含该 BV 的非自己消息。
 * @param {Array} recentMessages 二代状态里的 recentMessages
 * @param {string} bv
 * @returns {{userId:string,sender:string,messageId:any,at:number}|null}
 */
export function pickSharer(recentMessages, bv) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  if (!bv) return null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || m.isSelf) continue;
    const text = `${m.text ?? ''}\n${m.plain ?? ''}`;
    if (text.includes(bv)) {
      return {
        userId: m.userId != null ? String(m.userId) : '',
        sender: String(m.sender ?? ''),
        messageId: m.messageId ?? null,
        at: Number(m.time) || 0
      };
    }
  }
  return null;
}

/**
 * 配额判定：同一个人同一天，次数没到 limit 就允许。
 * @param {{day?:string,count?:number}|null|undefined} record
 * @param {string} day 本地日（localDayKey）
 * @param {number} limit 每天几次
 */
export function quotaAllowed(record, day, limit = 1) {
  const cap = Math.max(1, Math.floor(Number(limit) || 1));
  if (!record || record.day !== day) return true;
  return Math.max(0, Math.floor(Number(record.count) || 0)) < cap;
}

/** 成功看过后记一笔（返回新记录，不改原对象）。 */
export function bumpQuota(record, day, bv, at = Date.now()) {
  const sameDay = record && record.day === day;
  return {
    day,
    count: (sameDay ? Math.max(0, Math.floor(Number(record.count) || 0)) : 0) + 1,
    lastBv: String(bv ?? ''),
    at
  };
}

/**
 * 给模型看的正文。评论可能拿不到（评论区关闭/风控），那就只给视频信息。
 */
export function formatLookText({ bv, title, owner, desc, comments }) {
  const lines = [];
  lines.push(`${String(title || '（没拿到标题）').slice(0, 80)}${owner ? ` · ${owner}` : ''}`);
  if (desc) lines.push(`简介：${String(desc).replace(/\s+/g, ' ').slice(0, 200)}`);
  const list = Array.isArray(comments) ? comments : [];
  if (list.length) {
    lines.push(`热评（按热度，${list.length} 条）：`);
    list.forEach((c, i) => {
      const like = Number(c.like) || 0;
      lines.push(`${i + 1}. [${like}赞] ${String(c.content ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
    });
  } else {
    lines.push('热评这次没拿到（评论区关闭或风控）。');
  }
  lines.push(`https://www.bilibili.com/video/${bv}`);
  return lines.join('\n');
}
