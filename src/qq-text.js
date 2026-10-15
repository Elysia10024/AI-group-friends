// QQ 文本与媒体域：从 bridge.js 的模块级整体搬出来的一个"簇"（7 个互相调用的函数）。
//
// 搬出来的理由：bridge.js 是个巨型文件（main() 曾占 86%），想读这一段得跨过整个文件。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且**在构造点之前**声明的名字走解构；
//   · **可写的**和**在构造点之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）；
//   · 被更早的构造点引用的名字，在那个更早的构造处要包 thunk（`name: (...a) => name(...a)`）。
//
// 正文与搬迁前**逐字相同**，只有上述 2 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
import { voiceLabel } from './core/voice-label.js';

export function createQqTextModule(ctx) {
  const {
    SENSITIVE_RE,
    forwardIdFromData,
  } = ctx;

function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}
function isSendToolName(name) {
  return ctx.SEND_TOOL_RE.test(String(name ?? ''));
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch { /* 脱敏正则构造失败就退回原文：宁可少打码，也不能让写日志整体抛错（正则来自常量，正常不会失败） */ }
  for (const token of ctx.KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch { /* 不是 JSON 就按普通字符串处理 —— 这是预期分支，输入本来就可能是裸文本 */ }
  }
  return value;
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, resolveRecord, includeReply = true, selfId = null } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else if (selfId != null && String(d.qq) === String(selfId)) {
          // @ 的是机器人自己：必须明确标成"你"。否则一旦群名片被改过，
          // AI 会看到一个陌生的名字，误判成"这是在 @ 别人"而不作回应。
          out.push('@你');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'redbag': {
        // 真红包：SnowLuma 解出 elem tag 24 后给出的段。留言单独标出来，
        // 她才知道要不要接红包上写的那句话（QQ 默认留言「恭喜发财」不值得接）。
        const rpGreeting = String(d.greeting ?? '').trim();
        out.push(rpGreeting ? `[真红包 留言：「${rpGreeting}」]` : '[真红包]');
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': {
        // 语音：有本地转写就写成「语音：文字」（她要知道这是说出来的），转不出来就保持 [语音]。
        // 解析器由 domains/voice.js 提供（本地 SenseVoice，失败/超时一律返回 null）。
        let heard = null;
        if (resolveRecord) {
          try { heard = await resolveRecord(d.file ?? d.url ?? ''); } catch { heard = null; }
        }
        out.push(voiceLabel(heard));
        break;
      }
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch { /* 引用信息解析失败就用「[引用消息]」兜底，不阻塞消息处理 */ }
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: d.subType != null ? String(d.subType) : '',
        summary: String(d.summary ?? '')
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? '')
      });
    }
  }
  return media;
}


  return { isSilentMarker, isSendToolName, redactSensitiveText, escapeCqText, unquoteJsonString, segmentsToText, extractMediaFromSegments };
}
