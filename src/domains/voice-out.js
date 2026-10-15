// 语音输出域：把她说的话变成 QQ 语音消息发出去。
//
// 链路（2026-10-06 打通）：
//   工具 qq_send_voice → 控制台路由 /api/socialV2/send-voice → 本模块
//     → 本机常驻 TTS worker（E:\ai群友\tts\serve.py，127.0.0.1:3210，F5-TTS + 她的嗓音配方）
//     → 拿到 wav → OneBot 发 record 段 → SnowLuma 转 SILK 上传（网关自带，已验证）
//
// 为什么硬边界放在这里（不靠她自觉）：
//   · 群里默认不发（allowGroups，2026-10-06 主人开了）—— 语音在群里的打扰感远大于文字，
//     和她的潜水人设相反；开也是**紧一档**：间隔 10 分钟、每天 4 条；
//   · **语音永远单独发，不带引用** —— QQ 客户端播不出"引用 + 语音"的消息（平台限制，
//     2026-10-06 实测：那条语音谁都听不见）；
//   · 单条字数上限 —— 超过就变成"念稿子"，而且 QQ 语音以短为宜；
//   · 最小间隔 + 每日上限 —— 她连发三条语音比连发三条文字更烦人。
// 失败一律返回 {ok:false,error}，由调用方决定怎么回她；日志照实记，不静默。
import { setTimeout as sleep } from 'node:timers/promises';
import { localDayKey } from '../core/local-day.js';

export function createVoiceOutModule(ctx) {
  const { cfg, log } = ctx;
  const v = cfg.socialV2?.voiceOut ?? {};
  const workerUrl = String(v.workerUrl || process.env.QQ_BRIDGE_TTS_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');
  const allowGroups = v.allowGroups === true;
  const minIntervalMs = Number(v.minIntervalMs) > 0 ? Number(v.minIntervalMs) : 180_000;
  const dailyCap = Number(v.dailyCap) > 0 ? Number(v.dailyCap) : 20;
  const maxChars = Number(v.maxChars) > 0 ? Number(v.maxChars) : 20;
  // 群里的边界比私聊紧一档（2026-10-06 主人开群聊时定的）：群里一条语音是**一群人**在听，
  // 而且她的人设是潜水——出声越少越值钱。私聊 20 条/3 分钟，群里 4 条/10 分钟。
  const groupMinIntervalMs = Number(v.groupMinIntervalMs) > 0 ? Number(v.groupMinIntervalMs) : 600_000;
  const groupDailyCap = Number(v.groupDailyCap) > 0 ? Number(v.groupDailyCap) : 4;
  const lastSentAt = new Map();     // key -> ms
  const sentPerDay = new Map();     // 'YYYY-MM-DD:key' -> n

  // 每日额度的"日"按**本地日**切（2026-10-12 修）：
  // 原来写的是 `new Date().toISOString().slice(0, 10)` = UTC 日，于是本地每天早上 08:00
  // 额度偷偷刷新一次 —— 夜里 00:30 发过、08:01 再发就"从零开始"，"每天 4 条"实际是"每个 UTC 日 4 条"。
  // 判据统一在 core/local-day.js（有单测），别再在这里手写日期。
  function dayKey(key) {
    return `${localDayKey()}:${key}`;
  }

  async function postOneBot(action, params) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}`);
    }
    return body.data;
  }

  async function health() {
    try {
      const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(3000) });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok && body.ok === true, ...body };
    } catch (error) {
      return { ok: false, error: `${typeName(error)}: ${error?.message ?? error}` };
    }
  }

  async function synthesize(text) {
    try {
      const res = await fetch(`${workerUrl}/speak`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: String(text ?? '') }),
        signal: AbortSignal.timeout(120_000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok !== true) {
        return { ok: false, error: `TTS 失败：${body.reason || `HTTP ${res.status}`}` };
      }
      return body;
    } catch (error) {
      return { ok: false, error: `TTS 不可用：${typeName(error)}: ${error?.message ?? error}` };
    }
  }

  /**
   * 发一条语音。硬边界在这里兜住；任何一条不满足都返回 ok:false + error（调用方照实告诉她）。
   * @returns {Promise<{ok:boolean,error?:string,wav?:string,seconds?:number,messageId?:string|null,notes?:string[]}>}
   */
  async function sendVoice(key, text, options = {}) {
    const [kind, id] = String(key ?? '').split(':');
    if (!kind || !id) return { ok: false, error: '会话 key 无效' };
    const isGroup = kind === 'group';
    if (isGroup && !allowGroups) {
      return { ok: false, error: '群里不发语音（她的设定：群里极少打扰；要发就说文字）' };
    }
    // 语音**永远单独发**：QQ 客户端不支持"引用 + 语音"同一条消息 —— 拼上去那条语音对方根本听不见
    // （2026-10-06 群里实测：那条引用了消息的语音谁都没听到，群里的人自己说"引用不能发语音"）。
    // 要指向某条消息：先用 qq_send_message 带引用发一句文字，紧接着再单独发语音。
    const replyTo = options.replyToMessageId;
    if (replyTo !== undefined && replyTo !== null && String(replyTo).trim() !== '') {
      return {
        ok: false,
        error: '语音要单独发（不能带引用）：QQ 的"引用 + 语音"消息对方听不见。要指向某条消息，先用 qq_send_message 带引用发一句文字，再单独发语音。'
      };
    }
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return { ok: false, error: '没有要说的内容' };
    const chars = [...clean].length;
    if (chars > maxChars) {
      return { ok: false, error: `语音只能说到 ${maxChars} 字（这条 ${chars} 字），请说短一点或者改用文字` };
    }
    const intervalMs = isGroup ? groupMinIntervalMs : minIntervalMs;
    const cap = isGroup ? groupDailyCap : dailyCap;
    const now = Date.now();
    const last = lastSentAt.get(key) ?? 0;
    if (now - last < intervalMs) {
      const wait = Math.ceil((intervalMs - (now - last)) / 1000);
      return { ok: false, error: `刚发过语音，${wait} 秒内不要再发（她说话本来就不密，语音更该省着用）` };
    }
    const dk = dayKey(key);
    const used = sentPerDay.get(dk) ?? 0;
    if (used >= cap) {
      return { ok: false, error: `今天语音已经发满 ${cap} 条了，改用文字吧` };
    }

    const syn = await synthesize(clean);
    if (!syn.ok) return { ok: false, error: syn.error };

    const segments = [{ type: 'record', data: { file: syn.wav } }];   // 只发语音段，不带 reply
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = isGroup ? { group_id: Number(id), message: segments } : { user_id: Number(id), message: segments };

    // 与文字/图片共用 sendChain：保证"先说话再发语音"的顺序不被并发工具调用打乱。
    let resolveOut; let rejectOut;
    const result = new Promise((resolve, reject) => { resolveOut = resolve; rejectOut = reject; });
    ctx.sendChain = ctx.sendChain.then(async () => {
      try {
        await sleep(600 + Math.floor(Math.random() * 1000));   // 真人发语音前会顿一下
        resolveOut(await postOneBot(action, params));
      } catch (error) {
        rejectOut(error);
      }
    });
    let data;
    try {
      data = await result;
    } catch (error) {
      log(`[语音] 发送失败 ${key}: ${error?.message ?? error}`);
      return { ok: false, error: `语音发送失败：${error?.message ?? error}` };
    }
    lastSentAt.set(key, Date.now());
    sentPerDay.set(dk, used + 1);
    log(`[语音] 已发送 ${key}：${clean.slice(0, 30)}（${syn.seconds}s，合成 ${syn.ms}ms）`);
    return { ok: true, wav: syn.wav, seconds: syn.seconds, messageId: data?.message_id ?? null, notes: syn.notes ?? [] };
  }

  return {
    health,
    synthesize,
    sendVoice,
    limits: { allowGroups, minIntervalMs, dailyCap, maxChars, groupMinIntervalMs, groupDailyCap, workerUrl },
  };
}

function typeName(error) {
  return error?.name ?? 'Error';
}
