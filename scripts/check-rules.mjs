// check:rules —— 规则层的机器守卫（2026-09-30 重构后新增）
//
// 为什么需要它：她的人格/规则散在"人格核心 + 速记 + 预设模板 + 工具描述 + 每轮提示"五处，
// 历史上出过的所有翻车（自我打架、幽灵工具、数字对不上、规则指向被锁死的字段）都是"改了一处漏了另一处"。
// 这个脚本把六件事一次查完，红了就别部署：
//   1) 幽灵引用：规则文本里点名的工具必须真实存在；
//   2) 数字一致：文案里的关键数字必须等于 config 里的真值；
//   3) 冲突词对：同一主题不能同时出现互斥表述；
//   4) 编号有效：速记里的 R-xx 编号唯一且被引用时存在；
//   5) 重复检测：两条规则太像 → 提示合并（不判失败）；
//   6) 覆盖检查：人格核心/速记/群 overlay 必须存在且非空。
// 跑法： npm run check:rules
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '<项目根>';
const fail = [];
const warn = [];
const ok = [];

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const ROLE = '小鲸鱼';
const CORE_FILE = path.join(ROOT, 'roles', ROLE, 'core.md');
const DIGEST_FILE = path.join(ROOT, 'roles', ROLE, '速记.core.md');
const PRESET_FILE = path.join(ROOT, 'dsh/agent-presets/qq-chat-v2/agent.cordis.yml');
const PROMPT_FILE = path.join(ROOT, 'src/core/prompt.js');
const core = read(CORE_FILE);
const digest = read(DIGEST_FILE);
const preset = read(PRESET_FILE);
const prompt = read(PROMPT_FILE);
const cfg = JSON.parse(read(path.join(ROOT, 'config.json')) || '{}');

// ---------- 1) 幽灵引用 ----------
{
  const registered = new Set();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.js')) {
        const s = fs.readFileSync(p, 'utf8');
        for (const m of s.matchAll(/server\.tool\(\s*'([^']+)'/g)) registered.add(m[1]);
      }
    }
  };
  walk(path.join(ROOT, 'src/mcp'));
  const HOST_TOOLS = ['snowluma_status', 'start_snowluma', 'stop_snowluma'];
  for (const t of HOST_TOOLS) registered.add(t);
  const gh = read(path.join(ROOT, 'src/mcp-host-server.js'));
  for (const m of gh.matchAll(/server\.tool\(\s*'([^']+)'/g)) registered.add(m[1]);

  const sources = [
    ['人格核心', core], ['速记', digest], ['预设', preset], ['每轮提示', prompt],
    ['配置', read(path.join(ROOT, 'config.json'))]
  ];
  const phantom = new Map();
  for (const [label, text] of sources) {
    for (const m of text.matchAll(/\bqq_[a-z0-9_]+|\bmcp__snowluma__[a-z0-9_]+/gi)) {
      const name = m[0].replace(/^mcp__snowluma__/, '');
      if (!registered.has(name)) {
        const k = `${name}`;
        phantom.set(k, [...(phantom.get(k) ?? []), label]);
      }
    }
  }
  if (phantom.size) {
    for (const [name, where] of phantom) fail.push(`幽灵引用：${name}（出现在：${[...new Set(where)].join('、')}）——它没注册，她照着调只会失败`);
  } else ok.push(`幽灵引用：规则里点名的 ${registered.size} 个工具全部真实存在`);
}

// ---------- 2) 数字一致 ----------
{
  // 关键数字的唯一来源是 config；文案里出现的这些数字必须与 config 一致
  const want = [
    { name: '单条字数上限', text: /≤\s*(\d+)\s*字/g, expect: Number(cfg?.socialV2?.voiceOut?.maxChars ?? 20) },
    { name: '分条上限', text: /最多\s*(\d+)\s*条/g, expect: 3 },
    { name: '记忆条数', text: /每次唤醒最多\s*(\d+)\s*条|记\s*(\d+)\s*[~～-]\s*(\d+)\s*条/g, expect: 2 },
    // 图与表情：2026-10-03 起改成「相关就发、语境刹车」，不再按轮次限频；
    // 所以这里反过来查——文案里不该再出现轮次频率（否则又会和人格打架）。
    { name: '图频不该有轮次数字', text: /每\s*\d+\s*(?:[~～-]\s*\d+\s*)?轮(?:最多)?一张/g, expect: -1 }
  ];
  // 同一个文案里现在有**两套**"字数/条数"限制（QQ 消息 与 空间评论），所以再按**主语**分行判一次：
  // 行里出现"空间评论"就按空间评论的 config 值对，别拿 QQ 消息的 20 字/3 条去套它
  // （2026-10-13 加 R-22 时这条守卫真的红了，红得对 —— 它只是不知道有两个主语）。
  const Q = cfg?.socialV2?.qzone ?? {};
  const lineScoped = [
    { name: '空间评论·单条字数', subject: /空间评论|qq_comment_mood/, text: /不超过\s*(\d+)\s*字/g, expect: Number(Q.commentMaxChars ?? 120) },
    { name: '空间评论·窗口内回几条', subject: /空间评论|qq_comment_mood/, text: /只回\s*(\d+)\s*条|最多\s*(\d+)\s*条/g, expect: Number(Q.commentReplyCap ?? 2) },
    { name: '空间评论·窗口分钟数', subject: /空间评论|qq_comment_mood/, text: /(\d+)\s*分钟内/g, expect: Math.round(Number(Q.commentReplyWindowMs ?? 1800000) / 60000) }
  ];
  const all = `${core}\n${digest}\n${preset}`;
  const lines = all.split('\n');
  const lineOf = (needle) => lines.find((l) => l.includes(needle)) ?? '';
  for (const w of want) {
    for (const m of all.matchAll(w.text)) {
      const line = lineOf(m[0]);
      // 这一行说的是别的功能（空间评论）→ 交给下面的行级检查，别用消息的限制去套它
      if (lineScoped.some((s) => s.subject.test(line))) continue;
      const nums = m.slice(1).filter(Boolean).map(Number);
      if (!nums.includes(w.expect)) {
        fail.push(`数字不一致：${w.name} 规则里写的是「${m[0]}」，应为 ${w.expect}（${line.trim().slice(0, 60)}…）`);
      }
    }
  }
  for (const w of lineScoped) {
    for (const line of lines) {
      if (!w.subject.test(line)) continue;
      for (const m of line.matchAll(w.text)) {
        const nums = m.slice(1).filter(Boolean).map(Number);
        if (!nums.includes(w.expect)) {
          fail.push(`数字不一致：${w.name}（空间评论那一行）写的是「${m[0]}」，应为 ${w.expect}（${line.trim().slice(0, 60)}…）`);
        }
      }
    }
  }
  const waitMax = Number(cfg?.socialV2?.wait?.maxMs ?? 0);
  if (/等\s*5\s*[~～-]\s*10\s*分钟/.test(all)) fail.push(`数字不一致：规则里还写着"等 5~10 分钟"，而工具上限是 ${waitMax}ms`);
  ok.push(`数字一致：关键数字与 config 对齐（等待上限 ${waitMax}ms；空间评论 ${Q.commentMaxChars ?? 120} 字 / ${Q.commentReplyCap ?? 2} 条 / ${Math.round(Number(Q.commentReplyWindowMs ?? 1800000) / 60000)} 分钟）`);
}

// ---------- 3) 冲突词对 ----------
{
  const PAIRS = [
    { topic: '收尾要不要调工具', a: /每轮[^\n]{0,12}(都)?(要)?调[^\n]{0,10}set_wake_config|回完(就)?直接(调|收尾)[^\n]{0,6}set_wake_config/, b: /只在需要改[^\n]{0,20}才调/ },
    { topic: '嘴硬', a: /先嘴硬|要嘴硬|嘴硬但/, b: /不(许|要)嘴硬|不嘴硬/ },
    { topic: '硬线条数', a: /唯一(的)?硬线是违法内容/, b: /不碰家人|三条线/ },
    { topic: '说话长度', a: /≤\s*30\s*字/, b: /≤\s*20\s*字|1\s*[~～-]\s*10\s*字/ },
    { topic: '默认不回', a: /其余情况默认不回|没叫你时[^\n]{0,6}不要插话/, b: /不是没被叫就装死|不必一直沉默/ },
    { topic: '图片/表情频率', a: /每\s*3\s*[~～-]\s*5\s*轮/, b: /每\s*3\s*[~～-]\s*4\s*轮/ }
  ];
  for (const p of PAIRS) {
    const hitA = core.match(p.a) || digest.match(p.a) || preset.match(p.a);
    const hitB = core.match(p.b) || digest.match(p.b) || preset.match(p.b);
    if (hitA && hitB) fail.push(`冲突词对：${p.topic} —— 同时出现「${String(hitA[0]).slice(0, 30)}」和「${String(hitB[0]).slice(0, 30)}」`);
  }
  if (!fail.some((f) => f.startsWith('冲突词对'))) ok.push('冲突词对：六组历史冲突都没再出现');
}

// ---------- 4) 编号有效 ----------
{
  const ids = [...digest.matchAll(/R-(\d+)/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) fail.push(`编号重复：速记里 R-${[...new Set(dup)].join('、R-')} 出现了多次`);
  const others = `${core}\n${preset}`;
  for (const m of others.matchAll(/R-(\d+)/g)) {
    if (!ids.includes(m[1])) fail.push(`编号悬空：别处引用了 R-${m[1]}，但速记里没有这条`);
  }
  const noId = digest.split('\n').filter((l) => /^\s*-\s*\*\*[^*]+\*\*/.test(l) && !/R-\d+/.test(l));
  if (noId.length) warn.push(`速记里有 ${noId.length} 条没有编号（引用会失效）：${noId[0].trim().slice(0, 40)}…`);
  ok.push(`编号：速记 ${ids.length} 条规则、编号唯一${others.match(/R-\d+/g)?.length ? `、被引用 ${others.match(/R-\d+/g).length} 处` : ''}`);
}

// ---------- 5) 重复检测 ----------
{
  const grams = (s) => { const g = new Set(); const t = s.replace(/[\s*`，。、；：！？（）()【】]/g, ''); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
  const jac = (a, b) => { const A = grams(a), B = grams(b); if (!A.size || !B.size) return 0; let n = 0; for (const x of A) if (B.has(x)) n += 1; return n / (A.size + B.size - n); };
  const lines = `${core}\n${digest}`.split('\n').map((l) => l.trim()).filter((l) => l.length > 24);
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const s = jac(lines[i], lines[j]);
      if (s >= 0.75) warn.push(`疑似重复（${(s * 100).toFixed(0)}%）：\n      A ${lines[i].slice(0, 50)}\n      B ${lines[j].slice(0, 50)}`);
    }
  }
  ok.push('重复检测：已扫描人格核心与速记的所有长句');
}

// ---------- 6) 覆盖检查 ----------
{
  if (!core.trim()) fail.push('人格核心为空：roles/小鲸鱼/core.md');
  if (!digest.trim()) fail.push('速记为空：roles/小鲸鱼/速记.core.md');
  if (!/【人设速记/.test(digest)) fail.push('速记缺少【人设速记…】开头，apply-persona 会找不到注入点');
  if (!preset.includes('【人设速记')) fail.push('预设里没有【人设速记】块，apply-persona 无法同步');
  const dir = path.join(ROOT, 'roles', ROLE);
  const overlays = ['groups', 'private'].flatMap((d) => {
    const p = path.join(dir, d);
    return fs.existsSync(p) ? fs.readdirSync(p).map((f) => `${d}/${f}`) : [];
  });
  ok.push(`覆盖：人格核心 ${core.length} 字、速记 ${digest.split('\n').filter((l) => l.trim()).length} 行、会话 overlay ${overlays.length} 个`);
}

// ---------- 输出 ----------
console.log('=== check:rules ===\n');
for (const s of ok) console.log(`  ✅ ${s}`);
if (warn.length) {
  console.log('');
  for (const s of warn) console.log(`  ⚠️  ${s}`);
}
if (fail.length) {
  console.log('');
  for (const s of fail) console.log(`  ❌ ${s}`);
  console.log(`\n共 ${fail.length} 处必须修（规则层是她的行为来源，红了别部署）。`);
  process.exit(1);
}
console.log('\n✅ 规则层没有发现打架/幽灵/数字不一致。');
