// 控制台路由冒烟测试 —— 契约：**每条路由都不能给出 5xx**。
//
// 为什么需要它：控制台的 3000 行原本闭包在 bridge.js 的 main() 里，2026-09-18 搬到
// src/console/server.js，再按域拆到 src/console/routes/，靠 17 个作用域内绑定 +
// 144 个 deps 名字把作用域接过去。这种搬迁最容易犯的错是**漏注入一个名字** ——
// 语法检查发现不了（`node --check` 只解析语法、不解析 import），只有请求打到那条路由时
// 才 ReferenceError。BUG-004（`text is not a function`）就是这么漏过去的。
//
// 判读：200 正常；400/403/404 是参数或权限问题（路由本身跑通了）；5xx 才是代码炸了。
//
// ── 副作用策略（这段别删）──────────────────────────────────────────────────
//
// 路由表里每条都带 effect：
//
//   'none'     只读，随便跑（默认）
//   'network'  会向 OneBot 发出网请求 —— 只读查询，可以跑
//   'state'    **会改会话状态**，跑之前必须先证明它是空操作
//
// 目前唯一的 'state' 路由是 GET /api/socialV2/unread：它正是 AI 调用
// qq_get_unread_messages 走的那条，语义就是「这些消息她看过了」
// （推进 deliveredSeq / lastFetchedSeq）。群里真有未读时跑它 = 替她把未读标记成已读，
// 她可能因此不再回应那几条。
//
// 处理方式：跑之前先查 unreadCount，**为 0 才跑** —— 此时水位线本来就不动，是真正的空操作；
// 否则跳过并打印原因。
//
// 为什么不「跑完再恢复」：桥的内存里另有一份状态，下一次 saveSocialV2State() 会把
// 磁盘上的恢复覆盖掉，从文件恢复**不可靠**。宁可跳过，也不做看起来在恢复实则无效的动作。
//
// ── 用法 ─────────────────────────────────────────────────────────────────
//   npm run test:console                  # 需要桥在运行（控制台 3100）
//   npm run test:console -- --strict      # 把「跳过」也算失败（想强制全覆盖时用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = process.env.CONSOLE_BASE || 'http://127.0.0.1:3100';
const STRICT = process.argv.includes('--strict');

function readToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch { /* 回退到 state 里的自动令牌 */ }
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readToken();
const authHeaders = () => ({ 'x-console-token': TOKEN });

/** 会话键取自 config 的白名单，不写死群号。 */
function readSessionKey() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const group = cfg.allow?.groups?.[0];
    return group ? `group:${group}` : null;
  } catch {
    return null;
  }
}
const SESSION_KEY = readSessionKey();
const k = SESSION_KEY ? encodeURIComponent(SESSION_KEY) : '';

const r = (method, routePath, opts = {}) => ({ method, path: routePath, effect: 'none', ...opts });

/**
 * 只读路由（外加三条带副作用标记的）。带会话键的那批用真实群 ——
 * 目的是让 handler 完整跑一遍，只测到参数校验处就返回等于没测到注入。
 */
const ROUTES = [
  r('GET', '/'),
  r('GET', '/api/status'),
  r('GET', '/api/presets'),
  r('GET', '/api/roles'),
  r('GET', '/api/slang'),
  r('GET', '/api/sessions'),
  r('GET', '/api/pending'),
  r('GET', '/api/whitelist'),
  r('GET', '/api/security'),
  r('GET', '/api/stickers'),
  r('GET', '/api/socialV2/config'),
  r('GET', '/api/socialV2/activity'),
  r('GET', '/api/socialV2/states'),
  r('GET', '/api/socialV2/tool-log'),
  r('GET', '/api/socialV2/feedback'),
  r('GET', `/api/socialV2/state?key=${k}`),
  r('GET', `/api/socialV2/prompt?key=${k}`, { effect: 'network' }),
  r('GET', `/api/socialV2/unread?key=${k}`, { effect: 'state', noopWhen: 'unreadEmpty' }),
  r('GET', `/api/socialV2/recent?key=${k}`),
  r('GET', `/api/socialV2/my-recent?key=${k}`),
  r('GET', `/api/socialV2/memory?key=${k}`),
  r('GET', `/api/socialV2/sticker-list?key=${k}`),
  r('GET', `/api/socialV2/active-members?key=${k}`),
  r('GET', `/api/socialV2/self-image?key=${k}`),
  r('GET', `/api/socialV2/slang/query?key=${k}&q=__smoke__`),
  r('GET', `/api/socialV2/message-detail?key=${k}&messageId=__smoke__`),
  r('GET', `/api/socialV2/forward-message?key=${k}&id=__smoke__`),
  r('GET', `/api/socialV2/sticker-image?key=${k}&id=__smoke__`),
  r('GET', `/api/images/message?key=${k}&messageId=__smoke__`),
  // 说说的本地账本（只读，不碰 QQ）：它读 state/qzone.json + 算额度，跑一遍能证明
  // 路由与 qzone 域的接线没断（这层接线断过：发送通道整体 500 就是漏注入 deps）。
  r('GET', '/api/socialV2/mood-status'),
  // 另外三条要说说的路由都带 agent token 闸门：这里没带 → 预期 403（403 也证明路由存在、
  // 闸门生效；5xx 才是坏）。带 key 参数是为了让闸门走到"必须有 agent token"那一步。
  r('GET', `/api/socialV2/mood-list?key=${k}`),
  r('GET', `/api/socialV2/mood-comments?key=${k}&tid=__smoke__`),
  r('GET', `/api/socialV2/mood-new-comments?key=${k}`),
  r('GET', `/api/socialV2/qzone-feeds?key=${k}`, { effect: 'network' }),
  r('GET', '/api/__nope__')                       // 兜底分支也要在
];

const SEND_ROUTES = [
  r('POST', '/api/socialV2/send-burst', { body: { messages: ['x'] } }),
  r('POST', '/api/socialV2/send-message', { body: { messages: ['x'] } }),
  r('POST', '/api/socialV2/send-sticker', { body: { stickerId: '__contract__' } })
];

// ---------------------------------------------------------------- 计数与输出

const state = { checked: 0, failed: 0, skipped: 0 };
const ok = (cond, label, detail = '') => {
  state.checked += 1;
  if (!cond) state.failed += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
};
const skip = (label, why) => {
  state.skipped += 1;
  console.log(`  ⏭️  ${label}  — 跳过：${why}`);
};

async function fetchJson(routePath, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(BASE + routePath, {
    method,
    headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* 非 JSON（比如控制台 HTML）不算错 */ }
  return { status: res.status, body: parsed };
}

// ---------------------------------------------------------------- 1) 路由冒烟

console.log('控制台路由冒烟');
console.log(`  目标 ${BASE}${SESSION_KEY ? `  会话键 ${SESSION_KEY}` : ''}`);
console.log('');

/** 会改状态的路由，跑之前先证明它是空操作。 */
async function safeToRun(route) {
  if (route.effect !== 'state') return { safe: true };
  if (route.noopWhen !== 'unreadEmpty') return { safe: false, reason: `未定义的空操作判据（${route.noopWhen}）` };
  if (!SESSION_KEY) return { safe: false, reason: '读不到会话键，无法确认没有未读' };
  try {
    const { body } = await fetchJson(`/api/socialV2/state?key=${k}`, { headers: authHeaders() });
    const unread = Number(body?.unreadCount);
    if (!Number.isFinite(unread)) return { safe: false, reason: 'state 接口没返回 unreadCount' };
    if (unread === 0) return { safe: true };
    return { safe: false, reason: `群里有 ${unread} 条未读，跑它会替她标记成已读` };
  } catch (e) {
    return { safe: false, reason: `查未读数失败：${e?.message ?? e}` };
  }
}

for (const route of ROUTES) {
  const label = `${route.method} ${route.path}`;
  const verdict = await safeToRun(route);
  if (!verdict.safe) { skip(label, verdict.reason); continue; }

  let status = 0;
  let note = '';
  try {
    const res = await fetch(BASE + route.path, { method: route.method, headers: authHeaders() });
    status = res.status;
    if (status >= 500) note = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  } catch (e) {
    note = String(e?.message ?? e);
  }
  ok(status !== 0 && status < 500, label, status ? `${status}${note ? '  ' + note : ''}` : `连不上（${note}）`);
}

// ---------------------------------------------------------------- 2) 发送闸门契约
//
// send-burst / send-message / send-sticker 的前半段闸门原本各内联一份逐字相同的 11 行校验，
// 2026-09-18 抽成 routes/send.js 里的 gateSendTool()。抽公共代码最怕的是**顺序被改动** ——
// 多个条件同时不满足时，先命中的那条决定返回哪条 403 文案，而 MCP 工具的错误提示依赖它。
//
// 这些请求全部在真正发送之前就被拒，不会往 QQ 发任何东西。
// 只测能触达的两种：更靠后的分支（key 格式、白名单）在 agentTokenOk 那里就被挡下了。
console.log('\n发送闸门契约');
{
  const { body: statusBody } = await fetchJson('/api/status', { headers: authHeaders() }).catch(() => ({ body: null }));
  if (statusBody?.mode !== 'reserved2') {
    skip('发送闸门契约', `当前模式是 ${statusBody?.mode ?? '(未知)'}，不是 reserved2`);
  } else if (!SESSION_KEY) {
    skip('发送闸门契约', '读不到会话键');
  } else {
    const CASES = [
      { name: '不带 agent token', token: null, status: 403, error: 'reserved2 模式发送必须携带 agent token' },
      { name: 'agent token 无效', token: 'definitely-not-valid', status: 403, error: 'agent token 无效' }
    ];
    for (const route of SEND_ROUTES) {
      for (const c of CASES) {
        const headers = { ...authHeaders() };
        if (c.token) headers['x-agent-token'] = c.token;
        let status = 0;
        let error = '';
        try {
          const res = await fetchJson(route.path, { method: route.method, headers, body: { key: SESSION_KEY, ...route.body } });
          status = res.status;
          error = res.body?.error ?? '';
        } catch (e) {
          error = String(e?.message ?? e);
        }
        ok(status === c.status && error === c.error,
          `${route.path.replace('/api/socialV2/', '')} · ${c.name}`,
          status === c.status && error === c.error ? `${status} ${error}` : `实得 ${status} ${error}（期望 ${c.status} ${c.error}）`);
      }
    }
  }
}

// ---------------------------------------------------------------- 3) owner 控制面
// 管理员私聊会话的 agentToken 额外算作 owner 级令牌，可以操作其它会话 —— 这是
// "私聊里交代、她在群里执行"的前提；群友会话的令牌照旧只对自己有效。
// 用**只读**的 state 路由验证，不发送任何东西。
console.log('\nowner 控制面（私聊令牌可跨会话，其它令牌不行）');
{
  let entries = [];
  try {
    const v2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8'));
    entries = Object.entries(v2.conversations ?? {});
  } catch { /* 读不到就跳过 */ }
  const owner = entries.find(([k]) => k.startsWith('private:'));
  const group = entries.find(([k]) => k.startsWith('group:'));
  // 静默模式（「关闭聊天功能」）下群会话**按设计**不再被工具读取 —— 那两条断言（跨会话放行）
  // 测的是"没静默时"的行为，所以这里直接跳过并说明原因，而不是把断言放宽。
  let roleMode = 'active';
  try { roleMode = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'current-role.json'), 'utf8')).mode ?? 'active'; } catch { /* 读不到就当 active */ }
  if (roleMode === 'silent') {
    skip('owner 控制面', '当前是静默模式（关闭聊天功能）：群会话按设计不再被工具读取，跨会话放行测不到');
  } else if (!owner?.[1]?.agentToken || !group?.[1]?.agentToken) {
    skip('owner 控制面', '状态里没有同时具备 agentToken 的私聊与群会话');
  } else {
    const stateOf = async (key, token) => {
      const headers = { ...authHeaders() };
      if (token) headers['x-agent-token'] = token;
      const res = await fetchJson(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers });
      return { status: res.status, error: res.body?.error ?? '', ok: res.body?.ok === true };
    };
    const a = await stateOf(group[0], owner[1].agentToken);
    ok(a.status === 200 && a.ok, 'owner 私聊令牌 → 群（跨会话放行）', `${a.status} ok=${a.ok}`);
    const b = await stateOf(owner[0], group[1].agentToken);
    ok(b.status === 403 && b.error === 'agent token 无效', '群令牌 → 私聊（仍拒绝）', `${b.status} ${b.error}`);
    const c = await stateOf(group[0], 'definitely-not-valid');
    ok(c.status === 403 && c.error === 'agent token 无效', '乱令牌 → 群（仍拒绝）', `${c.status} ${c.error}`);
  }
}

// ---------------------------------------------------------------- 4) 活值检查
//
// deps 里被按值传进去的名字会不会变成「启动时的快照」—— 搬迁时踩过：
// `let dshReady = false` 是在 main() 里被 DSH 事件流改成 true 的，控制台只是**读**它，
// 于是被当成只读、传了快照进去，控制台从此永远显示 dshReady=false。不报错、不崩，
// 只是永远看到旧值。
//
// 桥的模式只有在 DSH 就绪之后才会变成 reserved2，所以这两者必须一致。
console.log('\n活值检查');
{
  const { body } = await fetchJson('/api/status', { headers: authHeaders() }).catch(() => ({ body: null }));
  if (!body) {
    skip('/api/status 活值', '读不到 /api/status');
  } else {
    const stale = body.mode === 'reserved2' && body.dshReady !== true;
    ok(!stale, '/api/status 活值', `mode=${body.mode} dshReady=${body.dshReady}` +
      (stale ? '  — 模式已是 reserved2 说明 DSH 早连上了，dshReady 却还是 false：deps 里按值传了快照' : ''));
  }
}

// ---------------------------------------------------------------- 静态资源必须"免令牌"可取
//
// 这条是被真实事故逼出来的：把 console.html 拆成 html/css/js 之后，页面里的 `<link>`/`<script>`
// 会去请求 /console.css 与 /console.js，而**浏览器加载外链资源不会带自定义请求头** →
// 全部 401 → 页面能打开但样式和脚本都没了，看起来就是"UI 没了"。
// 更糟的是页面脚本本身负责把 `?token=` 引导进 localStorage（鸡生蛋），所以它必须免令牌。
//
// 之前没抓到的原因：我自己验证时**带着令牌**去 curl 静态资源，等于验错了对象。
// 所以这里刻意**不带令牌**取，并且是从页面真实引用的路径里取（页面改了资源名也一并覆盖）。
console.log('\n静态资源免令牌检查（模拟浏览器：不带 x-console-token）');
{
  const { status, body } = await fetchJson('/', { headers: authHeaders() });
  if (status !== 200 || typeof body !== 'object') {
    // 页面本身返回的是 HTML，fetchJson 解析不出 JSON，这里单独抓文本
  }
  let html = '';
  try {
    html = await (await fetch(BASE + '/', { headers: authHeaders() })).text();
  } catch (e) {
    skip('页面 HTML', `取不到 /：${e?.message ?? e}`);
  }
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]);
  if (!refs.length) {
    skip('页面引用的静态资源', '页面里没有 href="/..." / src="/..."（内联版？）');
  } else {
    for (const ref of [...new Set(refs)]) {
      let res = null;
      try {
        res = await fetch(BASE + ref);          // ← 刻意不带令牌
      } catch (e) {
        ok(false, `免令牌取 ${ref}`, `请求失败：${e?.message ?? e}`);
        continue;
      }
      ok(res.status === 200, `免令牌取 ${ref}`, `HTTP ${res.status}` +
        (res.status === 401 ? '  — 浏览器加载 <link>/<script> 不带令牌头，会整页失去样式/脚本' : ''));
    }
  }
}

// ---------------------------------------------------------------- 结论

const { checked, failed, skipped } = state;
console.log('');
console.log(`检查 ${checked} 条，失败 ${failed} 条${skipped ? `，跳过 ${skipped} 条` : ''}`);
if (failed) {
  console.log('❌ 5xx 通常意味着某条路由用的名字没注入（拆分/搬迁时漏了依赖）。');
  process.exit(1);
}
if (STRICT && skipped) {
  console.log('❌ --strict：有跳过的检查，视为失败。');
  process.exit(1);
}
console.log(skipped ? '✅ 没有 5xx（有跳过项，见上）' : '✅ 全部通过');
