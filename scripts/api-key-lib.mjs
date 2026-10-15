// API key 自检的共用逻辑（被 check-api-key.mjs 与 set-api-key.mjs 共用）。
//
// 三步判据：
//   ① GET /models         —— key 是否有效（不花 token）
//   ② GET /user/balance   —— 余额是否可用（换 key 最常见的坑）
//   ③ POST /chat/completions 一条 max_tokens=1 —— **她实际用的那个模型**能不能跑（约 ¥0.0002）
//      这一步才是真判据：`deepseek-v4-flash-vision-exp` 这类 exp 别名不在 /models 列表里，
//      服务端把它解析成 deepseek-flash，只有真打一次才知道新 key 认不认。
import fs from 'node:fs';

export const DEFAULT_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

/** 两台 DSH 的凭据文件：她（legacy 内核）与桌面版（就是你现在这个界面）。 */
export const CRED_TARGETS = {
  bot: 'E:/ai群友/dsh-home-legacy/.credentials.yaml',
  desktop: 'C:/Users/竹沥半夏/.dsh/.credentials.yaml'
};

export function readKeyFromFile(file) {
  try {
    const m = /DEEPSEEK_API_KEY:\s*(\S+)/.exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : '';
  } catch { return ''; }
}

export const maskKey = (k) => (k ? `${String(k).slice(0, 9)}…${String(k).slice(-4)}（${String(k).length} 字符）` : '(空)');

/** 她实际用的模型：优先桥的 config.json，其次内核 settings.yaml，最后退默认。 */
export function botModel() {
  try {
    const cfg = JSON.parse(fs.readFileSync('E:/ai群友/qq-bridge-main/config.json', 'utf8'));
    if (cfg?.dsh?.model) return { model: cfg.dsh.model, from: 'qq-bridge config.json' };
  } catch { /* 往下退 */ }
  try {
    const y = fs.readFileSync('E:/ai群友/dsh-home-legacy/settings.yaml', 'utf8');
    const m = /agent-default-model:[\s\S]*?model:\s*(\S+)/.exec(y);
    if (m) return { model: m[1], from: '内核 settings.yaml' };
  } catch { /* 往下退 */ }
  return { model: 'deepseek-flash', from: '默认值' };
}

async function req(pathname, key, init = {}, base = DEFAULT_BASE) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { Authorization: `Bearer ${key}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(30000),
    ...init
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 就原样看 */ }
  return { status: res.status, json, text };
}

/**
 * 验一把 key。返回 { ok, problems:[], lines:[] }；lines 是给人看的逐行结论。
 * @param {string} key
 * @param {{deep?:boolean, base?:string, model?:string}} [opts]
 */
export async function checkKey(key, { deep = true, base = DEFAULT_BASE, model = botModel().model } = {}) {
  const problems = [];
  const lines = [];
  if (!key) return { ok: false, problems: ['没拿到 key'], lines: ['  ❌ 没拿到 key'] };
  lines.push(`  key：${maskKey(key)}${key.startsWith('sk-') ? '' : '   ⚠️ 不以 sk- 开头，格式可疑（复制时多了空格/引号？）'}`);
  try {
    const models = await req('/models', key, {}, base);
    if (models.status === 200) {
      const ids = (models.json?.data ?? []).map((m) => m.id);
      lines.push(`  ① /models ✅（${ids.length} 个：${ids.join('、')}）`);
    } else if (models.status === 401 || models.status === 403) {
      lines.push(`  ① /models ❌ ${models.status}：key 无效或被吊销`);
      problems.push('key 无效');
    } else {
      lines.push(`  ① /models ❌ HTTP ${models.status}：${models.text.slice(0, 160)}`);
      problems.push(`/models ${models.status}`);
    }

    const bal = await req('/user/balance', key, {}, base);
    if (bal.status === 200) {
      const avail = bal.json?.is_available;
      const info = (bal.json?.balance_infos ?? []).map((b) => `${b.currency} ${b.total_balance}`).join('　');
      lines.push(`  ② 余额 ${avail === false ? '❌ 不可用（会被拒）' : '✅ 可用'}　${info || '(无明细)'}`);
      if (avail === false) problems.push('余额不可用');
    } else {
      lines.push(`  ② 余额查询 ⚠️ HTTP ${bal.status}（不影响判断）`);
    }

    if (deep) {
      const chat = await req('/chat/completions', key, {
        method: 'POST',
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false })
      }, base);
      if (chat.status === 200) {
        const used = chat.json?.model;
        lines.push(`  ③ 模型调用 ✅ 200（服务端解析为 ${used}${used && used !== model ? '，别名有效' : ''}）`);
      } else {
        const msg = chat.json?.error?.message ?? chat.text.slice(0, 200);
        lines.push(`  ③ 模型调用 ❌ HTTP ${chat.status}：${msg}`);
        problems.push(`模型调用 ${chat.status}`);
      }
    } else {
      lines.push('  ③ 模型调用（已跳过）');
    }
  } catch (error) {
    lines.push(`  ❌ 请求失败：${error?.message ?? error}`);
    problems.push('网络错误');
  }
  return { ok: problems.length === 0, problems, lines };
}
