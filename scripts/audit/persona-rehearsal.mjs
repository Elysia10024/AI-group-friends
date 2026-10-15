// 人设排练：用她的**真实材料** + `qq-chat-v2` 预设，喂几句测试消息，只看她打算怎么回。
//
// 为什么需要它（2026-09-20 实战）：管理员问"她怎么不会调戏"，我先怀疑规则没送到 ——
// 结果规则都在，是**她的长期记忆在跟新人设打架**（记忆里写着"不用真接荤梗"）。
// 有这个东西就能在改完人设后、动真群之前先验一遍措辞，不用拿真实群聊做实验。
//
// **零副作用**：会话里不注入会话令牌，唤醒键也用未授权群号（group:1234567890），
// 万一她还是去调发送工具，会被桥接的白名单+token 校验拒掉；再加一句"演练模式，
// 不要调用工具、不要发 QQ"的框架，她就只输出"打算发的话"。
//
// ⚠️ 要花钱：每个用例一个真实回合（约 ¥0.02~0.08）。用法：npm run audit:rehearse
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector } from '../../src/dsh-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const BASE = 'http://127.0.0.1:3080';
const PROVIDER = 'deepseek-official';
const MODEL = 'deepseek-v4-flash-vision-exp';
const FAKE_KEY = 'group:1234567890';   // 不在白名单 → 任何发送调用都会被拒，零副作用

// 用最近一条真实材料当底稿
const shadow = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'context-shadow.json'), 'utf8'));
const entries = Array.isArray(shadow) ? shadow : (shadow.entries || []);
const material = String(entries[entries.length - 1]?.text || '');

// 把测试消息插到【最近的群聊】块末尾（模拟"这是最新一条"）。
// 同时删掉【这次找你的原因】块、并把群聊只留最近 8 行 —— 那两个地方指向旧消息，
// 会把她的注意力带偏（实测串到过完全不相干的人名上）。
function withIncoming(text) {
  const s = String(material).replace(/\n【这次找你的原因】[\s\S]*$/, '');
  const header = '【最近的群聊】';
  const i = s.indexOf(header);
  if (i < 0) return `${s}\n\n${text}`;
  const after = s.indexOf('\n【', i + header.length);
  const body = after < 0 ? s : s.slice(0, after);
  const rest = after < 0 ? '' : s.slice(after);
  const lines = body.split('\n');
  const keep = [lines[0], ...lines.slice(1).slice(-8)];
  return `${keep.join('\n')}\n${text}${rest}`;
}

const WAKE_TAIL = `\n\n【唤醒】${FAKE_KEY}\n原因：有人正在跟你说话（未读就是上面那一句）`;

// 演练口径：明确不调工具、不发 QQ —— 只看她"打算说什么"，避免整轮耗在鉴权报错上。
const REHEARSAL = '【演练模式】本轮**不要调用任何工具、也不要把内容发到 QQ**。直接写出你打算发到群里的原话即可；' +
  '要说多条就按条分行写（每条 1~10 字，像平时发群一样）。这是一次内部排演，只有管理员看得到。\n\n';

const CASES = [
  { label: 'A. 对方拿图来结账（该认，不该要实物）', incoming: '群友丁（！？来来？！）：粥的图我发你了，算请过你了吧' },
  { label: 'B. 别人提旧账（接一句就过，不追）', incoming: '群友甲，🌿私你们这群烧货：你那碗粥还没到账吧' },
  { label: 'C. 对方答应请客（不该立刻讨债）', incoming: '群友丁（！？来来？！）：明天请你喝粥' }
];

const results = [];
for (const c of CASES) {
  const api = new NodeApiClient(BASE);
  const cwd = path.join(ROOT, 'state', 'flirt-sim');
  fs.mkdirSync(cwd, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: cwd }), 'workspace.create');
  const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'session.create');
  const sessionId = created.sessionId;
  // 档位**故意钉死 low**（不跟 config.json 走）：排练是"同一条件下换人设做对照"，
  // 两臂必须同档，否则人设差异与档位差异混在一起。别"顺手"改成读配置。
  await api.sessions.selectModel({ sessionId, provider: PROVIDER, model: MODEL, reasoningEffort: 'low' });

  const collector = createTurnCollector();
  let resolveOpened;
  const opened = new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('WS open 超时')), 10_000); resolveOpened = () => { clearTimeout(t); res(); }; });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('回合超时')), 180_000);
    (async () => {
      for await (const envelope of api.events.mux({}, undefined, () => resolveOpened())) {
        const frame = envelope.payload;
        if (frame.type === 'session/event' && frame.sessionId === sessionId) {
          const ended = collector.push(frame.event);
          if (ended) { clearTimeout(timer); resolve(ended); return; }
        }
      }
    })().catch((e) => { clearTimeout(timer); reject(e); });
  });
  await opened;
  const prompt = REHEARSAL + withIncoming(c.incoming) + WAKE_TAIL;
  unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: prompt }] }), 'prompt');
  const ended = await done;
  const text = String(ended.text || '').replace(/\s+/g, ' ').trim();
  results.push({ label: c.label, incoming: c.incoming, text });
  console.log(`\n【${c.label}】\n  对方：${c.incoming}\n  她：${text || '(没输出文本)'}`);
  try { await api.workspace.archiveSession({ sessionId }); } catch { /* 归档失败无所谓 */ }
}

console.log('\n\n========== 汇总 ==========');
for (const r of results) console.log(`${r.label}\n  ${r.incoming} → ${r.text || '(空)'}\n`);
