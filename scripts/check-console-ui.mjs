// 控制台配置面板（public/console.html）的自动化测试：把页面脚本搬进 Node 跑。
//
// 为什么值得单独做：这个页面是配置项的**唯一编辑入口**，加一个配置项要在"表单元素 + 读 + 写"
// 三处各写一遍，而它在浏览器里、以前一条测试都没有 —— 出了"界面上改了存不下去 / 存下去读不回来"
// 只能靠人去点。这里把 load/save 拉进 Node：假 DOM + 假 fetch，
// 喂一份 config → 跑 load 快照所有表单元素 → 再跑 save 抓 POST body，和**金标准**逐字段比。
//
// 覆盖两个面板：
//   v2     二代仿真配置（/api/socialV2/config）—— 金标准录自重构**之前**的旧实现
//   social 一代社交配置（/api/social）      —— 保存走"点保存按钮"（页面里本来就是内联的点击处理）
//
// 金标准（scripts/fixtures/console-ui-golden.json）是这个前端**唯一**的行为约束。故意改行为时必须
// 显式重录，并在提交信息里说明改了哪一项、为什么：
//     node scripts/check-console-ui.mjs --update       只补缺失的面板（不动已有的金标准）
//     node scripts/check-console-ui.mjs --update-all   全部重录（会覆盖旧实现的证据，慎用）
//
// 有意改掉的行为写在 DIVERGENCE_ASSERTIONS 里单独断言，不进金标准。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PAGE = path.join(ROOT, 'public', 'console.html');
const SCRIPT = path.join(ROOT, 'public', 'console.js');
const GOLDEN = path.join(ROOT, 'scripts', 'fixtures', 'console-ui-golden.json');

const readRealCfg = (key) => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))[key] ?? {}; } catch { return null; }
};

/** 把嵌套对象摊平成 `a.b` 键集合（只用于统计新字段；函数声明会提升，--update 段能用）。 */
function flatKeys(o, p = '', out = {}) {
  if (o === null || typeof o !== 'object') { out[p] = o; return out; }
  for (const [k, v] of Object.entries(o)) flatKeys(v, p ? `${p}.${k}` : k, out);
  return out;
}

// 用例用**冻结快照**（金标准里的 frozen），不是当前 config.json：
// 否则每次调 config（例如把 proactive 打开）守卫都会假红，而它真正要盯的是"前端口径与后端一致"。
const FROZEN = (() => { try { return JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).frozen ?? {}; } catch { return {}; } })();
const v2Real = FROZEN.socialV2 ?? readRealCfg('socialV2');
const socialReal = FROZEN.social ?? readRealCfg('social');

// ── 用例 ────────────────────────────────────────────────────────────────────
const V2_FIXTURES = {
  ...(v2Real ? { '真实 config.json 的 socialV2（冻结快照）': v2Real } : {}),
  '空对象': {},
  '部分字段 + 边界值': {
    enabled: false, autoReplyCheckMs: 1500, tools: { sendPoke: false },
    wake: { preSleepWaitMs: 0 },
    send: { maxMessageChars: 'abc' },
    sticker: { maxListCount: 9999, promptMaxStickers: 0, collect: { maxPerHour: -5 } },
    proactive: { probability: 5 }, context: { recentLimit: null }, feedback: { maxLength: 'x' }
  },
  '全 0 / 全 false': {
    autoReplyCheckMs: 0, enabled: false, tools: { getPrompt: false },
    wake: { preSleepWaitMs: -1, sleepMinMs: 0, sleepMaxMs: 0, maxWakePerMinute: 0, batchWindowMs: 0 },
    send: { burstEnabled: false, burstMaxMessages: 0, maxMessageChars: 0 },
    wait: { defaultMs: 0, minMs: 0, maxMs: 0, defaultQuietMs: 0, minQuietAfterNewMs: 0 },
    sticker: { maxListCount: 0, promptMaxStickers: 0, collect: { maxPerMinute: 0, maxRemarkChars: 0 } },
    feedback: { maxLength: 0, notifyOwnerOnError: true }
  },
  '类型错乱（字符串/null/数组顶替对象）': {
    tools: 'nope', wake: null, send: [], wait: 'x', proactive: 0, sticker: { collect: 5 }, feedback: null, context: undefined
  },
  '概率与字符串含空格': {
    wake: { recommendedProbability: '0.25', recommendedHint: ' 带空格 ' },
    send: { longGapProbability: '0.7' }, proactive: { probability: '1.5' }
  }
};

const SLANG_FIXTURES = {
  ...((FROZEN.slang ?? readRealCfg('slang')) ? { '真实 config.json 的 slang': (FROZEN.slang ?? readRealCfg('slang')) } : {}),
  '空对象': {},
  '典型值': { enabled: true, extractMinMessages: 20, extractCooldownMs: 60000, inferenceThresholds: [2, 5, 9], injectMax: 12, learnerPreset: 'qq-chat', workspaceTitle: '黑话学习', autoResearch: false },
  '缺字段 + 全 false': { enabled: false, inferenceThresholds: [], autoResearch: false },
  '类型错乱': { enabled: 'yes', extractMinMessages: 'abc', inferenceThresholds: null, injectMax: 0, learnerPreset: 5, workspaceTitle: null }
};

// 有意改掉的行为，单独断言（不进金标准）。
// 关键词写成字符串：旧实现 `(v || []).join(', ')` 在字符串上直接抛，被 catch 吞掉 → 表单只加载到一半
// （后面所有字段全空，且"保存"会把这些字段按兜底值写回去）。新实现按逗号拆开显示。
const DIVERGENCE_ASSERTIONS = [
  {
    label: 'v2 关键词写成字符串：不再中途抛异常，后续字段照常加载',
    panel: 'v2',
    cfg: { wake: { recommendedKeywords: '小鲸鱼,大肥鱼' } },
    check: (o) => {
      const problems = [];
      if (o.form.v2RecKeywords !== '小鲸鱼, 大肥鱼') problems.push(`v2RecKeywords=${JSON.stringify(o.form.v2RecKeywords)}（应拆成 "小鲸鱼, 大肥鱼"）`);
      if (o.form.v2FeedbackMaxLength !== 500) problems.push(`v2FeedbackMaxLength=${JSON.stringify(o.form.v2FeedbackMaxLength)}（关键词那行之后的字段没加载完）`);
      if (o.body?.feedback?.maxLength !== 500) problems.push(`保存时的 feedback.maxLength=${JSON.stringify(o.body?.feedback?.maxLength)}`);
      return problems;
    }
  },
  {
    label: 'slang 阈值写成字符串：不再抛异常，其余字段照常加载',
    panel: 'slang',
    // 阈值字段排在 injectMax 之前：旧实现 `(v || fb).join(', ')` 在字符串上抛异常 → 后面的字段加载不到。
    cfg: { inferenceThresholds: '2, 5', injectMax: 12 },
    check: (o) => {
      const problems = [];
      if (o.form.slangThresholds !== '2, 5') problems.push(`slangThresholds=${JSON.stringify(o.form.slangThresholds)}`);
      if (o.form.slangInjectMax !== 12) problems.push(`slangInjectMax=${JSON.stringify(o.form.slangInjectMax)}（应为 12：阈值后面的字段没加载到）`);
      if (JSON.stringify(o.body?.inferenceThresholds) !== JSON.stringify([2, 5])) problems.push(`保存时 inferenceThresholds=${JSON.stringify(o.body?.inferenceThresholds)}`);
      return problems;
    }
  }
];

// ── 把页面搬进 Node ─────────────────────────────────────────────────────────
// 页面脚本现在是独立文件 public/console.js（拆文件之前是内联的 <script>）：
// 独立文件的好处是这里能直接读，也能直接 `node --check`。
function pageScript() {
  const js = fs.readFileSync(SCRIPT, 'utf8');
  // 末尾那两行初始化（真跑一堆 loader）在 Node 里没意义，切掉换成导出。
  const out = js.replace(/\nrefresh\(\); refreshRoles\(\);[\s\S]*$/, '\n;return { loadV2Config, saveV2Config, loadSlangConfig };');
  if (out === js) throw new Error('console.js 末尾的初始化行没匹配上（结构变了？）');
  // 导出名写错（比如删了一个面板却忘了改这里）会在求值时抛 ReferenceError，这里提前给一句人话
  for (const fn of ['loadV2Config', 'saveV2Config', 'loadSlangConfig']) {
    if (!new RegExp(`function ${fn}\\b`).test(js)) throw new Error(`console.js 里没有 ${fn}（面板改名/删除了？改这里的导出清单）`);
  }
  return out;
}

const toolNames = [...fs.readFileSync(PAGE, 'utf8').matchAll(/data-v2-tool="([^"]+)"/g)].map((m) => m[1]);

function makePage(responses) {
  const els = new Map();
  const mkEl = (id) => {
    const el = {
      id, value: '', checked: false, textContent: '', className: '', innerHTML: '', hidden: false,
      children: [], options: [], style: {}, listeners: {},
      dataset: id.startsWith('tool:') ? { v2Tool: id.slice(5) } : {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
      removeEventListener() {}, appendChild(c) { el.children.push(c); }, setAttribute() {},
      getAttribute: () => null, querySelectorAll: () => [], querySelector: () => null, closest: () => null, focus() {}
    };
    return el;
  };
  const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };
  const toolEls = toolNames.map((t) => getEl(`tool:${t}`));
  const doc = {
    getElementById: getEl,
    querySelectorAll: (sel) => (sel === '[data-v2-tool]' ? toolEls : []),
    querySelector: () => null, createElement: () => mkEl('tmp'),
    addEventListener() {}, removeEventListener() {},
    body: mkEl('body'), documentElement: mkEl('html'), readyState: 'complete'
  };
  const posted = [];
  const fetchStub = async (url, init = {}) => {
    if (init.method === 'POST') {
      posted.push({ url, body: JSON.parse(init.body ?? 'null') });
      return { status: 200, json: async () => ({ ok: true }) };
    }
    const key = url.split('?')[0].replace('/api/', '').replace(/\//g, '-');
    if (responses[key] !== undefined) return { status: 200, json: async () => ({ ok: true, ...responses[key] }) };
    return { status: 200, json: async () => ({ ok: true }) };
  };
  const fn = new Function('document', 'window', 'localStorage', 'setInterval', 'setTimeout', 'fetch', 'prompt', 'location', 'navigator', 'console', 'alert', 'confirm', pageScript());
  const page = fn(doc, { addEventListener() {} }, { getItem: () => null, setItem() {}, removeItem() {} },
    () => 0, () => 0, fetchStub, () => null, { href: '', reload() {} }, {}, console, () => {}, () => true);
  const click = async (id) => {
    for (const fn2 of getEl(id).listeners.click ?? []) {
      try { await fn2(); } catch { /* 页面自身的渲染报错不影响"POST 了什么"这个观测 */ }
    }
  };
  return { page, els, posted, click };
}

/** 跑一个面板：load → 快照表单 → save → 抓 POST body。 */
async function observe(panel, cfg) {
  const responses = { [panel.routeKey]: { config: cfg } };
  const p = makePage(responses);
  await p.page[panel.load]();
  // 有的 loader 是"发请求就返回"（内部 .then 填表单），给它一个 tick 把微任务跑完
  await new Promise((r) => setTimeout(r, 0));
  const form = Object.fromEntries([...p.els.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, el]) => [id, el.checked ? true : el.value]));
  p.posted.length = 0;
  if (panel.saveFn) await p.page[panel.saveFn]();
  else await p.click(panel.saveButton);
  return { form, body: p.posted[0]?.body ?? null };
}

const PANELS = {
  v2: { routeKey: 'socialV2-config', load: 'loadV2Config', saveFn: 'saveV2Config', fixtures: V2_FIXTURES },
  slang: { routeKey: 'slang', load: 'loadSlangConfig', saveButton: 'slangConfigSave', fixtures: SLANG_FIXTURES }
};

const observed = {};
for (const [name, panel] of Object.entries(PANELS)) {
  observed[name] = {};
  for (const [label, cfg] of Object.entries(panel.fixtures)) observed[name][label] = await observe(panel, cfg);
}
console.log(`页面脚本语法 OK（已求值）；面板 ${Object.keys(PANELS).length} 个、用例 ${Object.values(observed).reduce((n, o) => n + Object.keys(o).length, 0)} 份`);

const previous = fs.existsSync(GOLDEN) ? JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) : { observed: {} };
if (process.argv.includes('--update') || process.argv.includes('--update-all')) {
  const all = process.argv.includes('--update-all');
  let next;
  if (all) {
    console.log('⚠️ --update-all：全部重录（旧实现的证据会被现在的实现覆盖）');
    next = observed;
  } else {
    next = {};
    // 逐**用例**补：已有金标准的用例一律保留（那是旧实现的证据），只录新的。
    // 用例内容改了但标签没变时不会被悄悄覆盖 —— 比对会红，逼你显式决定（--update-all）。
    //
    // 2026-10-12 补：光"保留整份用例"不够 —— 给页面**加一个表单元素**（例如说说的工具开关）时，
    // 已有的每个用例里都多出这个字段，而旧口径会把整份用例原样保留，于是比对永远红，
    // 逼人去跑 --update-all，把全部旧证据一起覆盖掉（为了 3 个新字段丢掉整个面板的基线，不值）。
    // 现在改成**逐字段**合并：同名字段以旧证据为准（改了就还是红，得显式决定），
    // 只有"旧证据里没有的字段"才录进来。旧有、现在没有的字段也留着 —— 那会让比对红，正是想要的。
    const mergeCase = (prev, now) => {
      const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
      // 用例结构是嵌套的（{form:{...}, body:{...}}），所以必须**递归**合并 ——
      // 只合并一层的话，新增的字段藏在 form 里，会被"整份 prev.form 优先"整个盖掉。
      if (!isObj(prev) || !isObj(now)) return prev === undefined ? now : prev;
      const merged = {};
      for (const k of new Set([...Object.keys(now), ...Object.keys(prev)])) {
        if (k in prev && k in now) merged[k] = mergeCase(prev[k], now[k]);
        else if (k in prev) merged[k] = prev[k];   // 旧有、现在没有：留着 —— 比对会红，正是想要的
        else merged[k] = now[k];                   // 现在有、旧证据没有：录进来
      }
      return merged;
    };
    for (const [name, o] of Object.entries(observed)) {
      const prev = previous.observed?.[name] ?? {};
      next[name] = {};
      let added = 0;
      for (const [label, val] of Object.entries(o)) {
        const p = prev[label];
        if (!p) { next[name][label] = val; added += 1; continue; }
        next[name][label] = mergeCase(p, val);
      }
      for (const [label, val] of Object.entries(prev)) if (!(label in next[name])) next[name][label] = val;
      const newFields = Object.keys(next[name]).filter((k) => k in prev)
        .reduce((n, k) => n + Object.keys(flatKeys(next[name][k])).filter((f) => !(f in flatKeys(prev[k]))).length, 0);
      console.log(`  （${name}：保留 ${Object.keys(prev).filter((k) => k in o).length} 份，新录 ${added} 份${added ? `：${Object.keys(o).filter((k) => !(k in prev)).join('、')}` : ''}${newFields ? `，另外补录 ${newFields} 个新字段` : ''}）`);
    }
    for (const [name, o] of Object.entries(previous.observed ?? {})) if (!next[name]) next[name] = o;
    // 孤儿用例：旧金标准里有、但 fixtures 里已经没有这个标签了（标签改过名就会留下这种）。
    // 它们**永远不会被比对到**，只是一堆死字段；但也不能默默删 —— 所以打出来。
    // （2026-10-12：真出现过一次 —— V2_FIXTURES 的标签从「真实 config.json 的 socialV2」
    //   改成「…（冻结快照）」之后，旧标签那份一直躺在金标准里，247 个字段没人看。）
    for (const [name, cases] of Object.entries(previous.observed ?? {})) {
      const labels = new Set(Object.keys(PANELS[name]?.fixtures ?? {}));
      const orphans = Object.keys(cases).filter((k) => !labels.has(k));
      for (const o of orphans) console.log(`  ⚠️ 丢掉孤儿用例（fixtures 里已经没有这个标签）：${name} / ${o}`);
    }
  }
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, JSON.stringify({ note: '前端配置面板的金标准：故意改行为必须重录并说明原因', fixtures: { v2: V2_FIXTURES, slang: SLANG_FIXTURES }, frozen: FROZEN, observed: next }, null, 2) + '\n', 'utf8');
  console.log(`✅ 已更新金标准 ${path.relative(ROOT, GOLDEN)}`);
  process.exit(0);
}

// ── 比对 ────────────────────────────────────────────────────────────────────
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const flat = (o, p = '', out = {}) => {
  if (o === null || typeof o !== 'object') { out[p] = o; return out; }
  for (const [k, v] of Object.entries(o)) flat(v, p ? `${p}.${k}` : k, out);
  return out;
};

let bad = 0;
for (const [name, panel] of Object.entries(PANELS)) {
  console.log(`\n${name} 面板（${panel.load}）：`);
  const want = golden.observed?.[name] ?? {};
  for (const label of Object.keys(panel.fixtures)) {
    if (!want[label]) { bad += 1; console.log(`  ❌ 没有金标准：${label}（先跑 --update 录一份）`); continue; }
    const a = flat(want[label]); const b = flat(observed[name][label]);
    const diffs = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    if (!diffs.length) { console.log(`  ✅ ${label}`); continue; }
    bad += 1;
    console.log(`  ❌ ${label}：${diffs.length} 处与金标准不同`);
    for (const k of diffs.slice(0, 10)) console.log(`       ${k}: 金标准=${JSON.stringify(a[k])} 现在=${JSON.stringify(b[k])}`);
  }
}

console.log('\n有意改掉的行为（单独断言，不进金标准）：');
for (const t of DIVERGENCE_ASSERTIONS) {
  const problems = t.check(await observe(PANELS[t.panel], t.cfg));
  if (problems.length) { bad += 1; console.log(`  ❌ ${t.label}`); for (const p of problems) console.log(`       ${p}`); }
  else console.log(`  ✅ ${t.label}`);
}

console.log(bad ? `\n❌ ${bad} 项不符` : '\n✅ 前端配置面板与金标准一致');
process.exit(bad ? 1 : 0);
