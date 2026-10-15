// 心情（跨会话的**全局**状态）+ 说话时的脱敏规则。
//
// 用户要求（2026-10-02）：
//   · 心情要**串联不同群**——在 A 群受的影响，到 B 群还在（像真人）；
//   · 但她心里要清楚**这份心情来自哪个群**（避免把气撒错地方）；
//   · **对外不说群名**：别的群的人可能根本不知道还有别的群，所以谈起来只说"别处/刚才在别的地方"；
//   · 随机情绪（无来由）照旧说"说不上为什么，有点闷"。
//
// 纯函数：只做"记一条心情 / 渲染成一行 / 按说话次数和睡觉衰减"，读写文件由调用方负责。
import { convLabel } from './memory-recall.js';

export const TONES = ['平静', '开心', '得意', '有点闷', '烦躁', '期待', '心虚', '难过'];

/** 新的一条心情覆盖旧的（心情是"当前状态"，不是流水账）。 */
export function applyMoodEvent(prev, { tone, intensity, because = '', sourceKey = '', now = Date.now() } = {}) {
  const t = TONES.includes(String(tone)) ? String(tone) : String(tone || '').trim() || '平静';
  const i = Math.max(1, Math.min(3, Number(intensity) || 1));
  return {
    tone: t,
    intensity: i,
    because: String(because ?? '').slice(0, 80),
    sourceKey: String(sourceKey ?? ''),      // 内部记录来源会话（渲染时不外泄群名）
    since: now,
    exchangesLeft: decayFor(t),
    sleptSince: false
  };
}

/** 这条心情大概还能影响几句（强度越高越久）。 */
function decayFor(tone) {
  if (tone === '难过') return 5;
  if (tone === '烦躁' || tone === '有点闷') return 3;
  if (tone === '开心' || tone === '得意' || tone === '期待') return 2;
  return 1;
}

/**
 * 衰减：说过几句就淡一档；睡过一觉再淡一档（跨过凌晨或长时间潜水＝睡了一觉）。
 * @returns {{mood:object, changed:boolean}}
 */
export function decayMood(mood, { exchanges = 1, slept = false } = {}) {
  if (!mood) return { mood: null, changed: false };
  let m = { ...mood };
  m.exchangesLeft = Math.max(0, Number(m.exchangesLeft ?? 1) - Math.max(0, Number(exchanges) || 0));
  if (slept && !m.sleptSince) {
    m.sleptSince = true;
    m.exchangesLeft = Math.max(0, m.exchangesLeft - 1);
    m.intensity = Math.max(1, Number(m.intensity ?? 1) - 1);
  }
  if (m.exchangesLeft <= 0) return { mood: null, changed: true };   // 淡到没有 = 回到平静
  return { mood: m, changed: true };
}

/**
 * 渲染成材料里的一行。**绝不写出别的群的名字/群号**。
 * @param {object} mood
 * @param {string} convKey 当前会话
 */
export function moodLine(mood, convKey = '') {
  if (!mood || !mood.tone || mood.tone === '平静') return '';
  const sameConv = mood.sourceKey && mood.sourceKey === convKey;
  let why;
  if (!mood.because) why = '说不上为什么';                       // 随机情绪：照实说"说不清"
  else if (sameConv) why = '因为刚才那几句';
  else why = '别处的事（别人不一定知道别的群，**别提是哪个群**）';
  const strong = Number(mood.intensity) >= 3 ? '（挺明显的）' : '';
  return `心情：${mood.tone}${strong}，${why}`;
}

/** 内部诊断用：这份心情来自哪个会话（只给日志/控制台看，不进材料）。 */
export function moodSourceLabel(mood) {
  if (!mood?.sourceKey) return '';
  return convLabel(mood.sourceKey);
}
