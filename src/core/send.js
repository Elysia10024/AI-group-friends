// 出站消息的「成形」纯逻辑：文本切分、按空格分条、以及条间间隔计算。
// 从 bridge.js 抽出来（R1' 第 5 步）。
//
// 注意这一步**只抽纯计算**，不动 5 条发送路径的合并 —— 合并会改变行为，
// 属于独立的一次改动（见 重构方案.md R1'-5 的说明）。
//
// 抽出来的理由：这段逻辑有真实的坑且全在边界上——
//   · 超长消息必须硬拆但不能丢内容、不能把 URL 拆断；
//   · "空格分条"的判据是"两侧只要一侧是汉字"，中英混排很容易判错；
//   · 间隔要夹在 [burstIntervalMinMs, maxGapMs] 之间，写错了就是刷屏或被限流。
// 现在这些边界都能离线测。

/** 折叠换行与连续空格，得到"单行"文本。 */
export function singleLineForQQ(s) {
  return String(s ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
// URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
export function splitLongSegment(segment, max) {
  const s = String(segment ?? '').trim();
  if (!s) return [];
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
  if (s.length <= safeMax) return [s];

  const urlRe = /https?:\/\/[^\s，。；、]+/g;
  const urls = [];
  const masked = s.replace(urlRe, (m) => {
    urls.push(m);
    return `\u0000URL${urls.length - 1}\u0000`;
  });

  const raw = masked.split(/([，、；：,;:])/);
  const tokens = [];
  for (let i = 0; i < raw.length; i += 2) {
    tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
  }
  const out = [];
  let cur = '';
  for (const tok of tokens) {
    if (!tok) continue;
    if (tok.length > safeMax) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < tok.length; i += safeMax) out.push(tok.slice(i, i + safeMax));
    } else if (cur.length + tok.length <= safeMax) {
      cur += tok;
    } else {
      out.push(cur);
      cur = tok;
    }
  }
  if (cur) out.push(cur);

  return out
    .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
    .filter(Boolean);
}

// 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
// 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
export function isCjkChar(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x4E00 && code <= 0x9FFF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0xF900 && code <= 0xFAFF)
  );
}

// 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
// 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
// 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
export function splitByCjkSpaces(src) {
  const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
  if (tokens.length <= 1) return tokens;
  const groups = [];
  let cur = tokens[0];
  for (let i = 1; i < tokens.length; i++) {
    const prevLast = [...cur].pop() || '';
    const currFirst = [...tokens[i]][0] || '';
    // 空格两侧只要有一侧是汉字，就视为分条信号。
    if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
      groups.push(cur);
      cur = tokens[i];
    } else {
      cur = cur + ' ' + tokens[i];
    }
  }
  if (cur) groups.push(cur);
  return groups;
}

// 新分句逻辑：分句权交给 AI。
// AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
// 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
export function planSocialTimeline(text, socialCfg) {
  const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
  const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
  const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
  const enabled = socialCfg?.burstEnabled !== false;
  if (!src) return { main: [], followUp: null };

  // 关闭分条：整条作为一条消息发送，只做安全硬拆
  if (!enabled) {
    return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
  }

  // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
  const parts = splitByCjkSpaces(src);
  if (parts.length <= 1) {
    return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
  }

  const main = [];
  for (const part of parts) {
    main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
  }
  return { main: main.filter(Boolean), followUp: null };
}

/** 把间隔夹到 [burstIntervalMinMs, maxGapMs] 之间。 */
export function clampGap(ms, sendCfg) {
  const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
  const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
  return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
}

function randInt(min, max, random) {
  if (min > max) [min, max] = [max, min];
  return Math.floor(min + random() * (max - min + 1));
}

/**
 * 计算相邻消息之间的发送间隔。
 * @param {string[]} messages
 * @param {'auto'|'fixed'|'byLength'} gapMode
 * @param {number} gapMs fixed 模式的固定间隔
 * @param {number[]} gaps fixed 模式的逐条间隔
 * @param {object} sendCfg 发送配置
 * @param {() => number} [random] 随机源，默认 Math.random（便于确定性测试）
 * @returns {number[]} 长度 = messages.length - 1
 */
export function computeGaps(messages, gapMode, gapMs, gaps, sendCfg, random = Math.random) {
  const delays = [];
  if (!messages || messages.length <= 1) return delays;
  const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
  if (mode === 'fixed') {
    if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
      for (let i = 0; i < messages.length - 1; i++) delays.push(clampGap(gaps[i], sendCfg));
    } else {
      const g = clampGap(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
      for (let i = 0; i < messages.length - 1; i++) delays.push(g);
    }
  } else if (mode === 'byLength') {
    const base = Number(sendCfg.gapBaseMs) || 800;
    const perChar = Number(sendCfg.gapPerCharMs) || 20;
    for (let i = 0; i < messages.length - 1; i++) {
      const chars = Math.max(1, String(messages[i] || '').length);
      delays.push(clampGap(base + chars * perChar, sendCfg));
    }
  } else {
    const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
    for (let i = 0; i < messages.length - 1; i++) {
      const useLong = longProb > 0 && random() < longProb;
      const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
      const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
      delays.push(clampGap(randInt(Math.max(100, min), Math.max(100, max), random), sendCfg));
    }
  }
  return delays;
}
