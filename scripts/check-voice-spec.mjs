// 嗓音配方（E:\ai群友\tts\her-voice.json）的静态体检：**这个文件是她的声音的唯一真源**，
// 写坏了不会有任何报错 —— worker 只在启动时读一次，读失败就是"她不会说话了"，
// 而且 2026-10-06 我自己就在这个文件里踩过一次：JSON 字符串里写了 ASCII 双引号（嫌"听不清"），
// 文件当场解析不了（好在 worker 还捧着内存里那份旧配置，没炸）。
//
// 所以这条守卫只做一件事：让"配方坏了"在每天的体检里变红。
//   node scripts/check-voice-spec.mjs
import fs from 'node:fs';

const SPEC = 'E:/ai群友/tts/her-voice.json';
const PARTICLES = '吧啊啦呀哦嘛噢咯吗呢呗嘞喽喔';

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => { failed += 1; console.log(`  ❌ ${m}`); };

console.log('=== 嗓音配方体检 ===\n');
let spec;
try {
  spec = JSON.parse(fs.readFileSync(SPEC, 'utf8').replace(/^\uFEFF/, ''));
  ok(`her-voice.json 能解析（${fs.statSync(SPEC).size} 字节）`);
} catch (error) {
  bad(`her-voice.json 解析失败：${error.message} —— worker 一重启她就哑了，先修这个`);
  console.log(`\n❌ 1 项没过`);
  process.exit(1);
}

// 参考音：文件必须真的在（模型按路径读，路径写错 = 合成直接抛错）
const ref = spec.reference?.file;
if (ref && fs.existsSync(ref)) ok(`参考音在：${ref}`);
else bad(`参考音不存在：${ref ?? '(没写)'}`);

// 参数：都要是数字，而且范围不离谱
const p = spec.params ?? {};
for (const [k, lo, hi] of [['speed', 0.4, 1.6], ['cfg_strength', 1, 6], ['nfe_step', 8, 128]]) {
  const v = Number(p[k]);
  if (Number.isFinite(v) && v >= lo && v <= hi) ok(`${k} = ${v}`);
  else bad(`${k} = ${JSON.stringify(p[k])}（应在 ${lo}~${hi}）`);
}

// 种子：null（每次随机，会漂）或整数（固定那一版）
if (spec.seed === null || spec.seed === undefined) {
  console.log('  ⚠️  seed 没固定 —— 同一句话每次都是新的一版"发挥"（音色会漂）。2026-10-06 定的是 seed=2');
} else if (Number.isInteger(spec.seed)) ok(`seed = ${spec.seed}（固定，可复现）`);
else bad(`seed = ${JSON.stringify(spec.seed)}（应为 null 或整数）`);

// 句尾轻声：音量必须真的压下来（1.0 = 没生效）
const post = spec.postprocess ?? {};
const gain = Number(post.particle_gain);
if (Number.isFinite(gain) && gain > 0 && gain < 1) ok(`句尾轻声音量 = ${gain}（尾段 ${post.particle_ms}ms）`);
else bad(`postprocess.particle_gain = ${JSON.stringify(post.particle_gain)}（应 < 1 且 > 0，1.0 等于没轻声）`);

// 问句上扬
const rise = spec.question_rise ?? {};
if (Number(rise.glide_semitones) > 0 && Number(rise.glide_ms) > 0) ok(`问句上扬 = +${rise.glide_semitones} 半音 / ${rise.glide_ms}ms`);
else bad(`question_rise 不完整：${JSON.stringify(rise)}`);

// 主人 2026-10-06 明确要求：句尾语气词一律轻声（含疑问句的「吗/呢」）。
// serve.py 的 PARTICLES 与这里的说明必须对得上，否则"她看到的规则"和"代码做的事"会打架。
const serveSrc = fs.readFileSync('E:/ai群友/tts/serve.py', 'utf8');
const m = /PARTICLES\s*=\s*'([^']+)'/.exec(serveSrc);
if (!m) bad('serve.py 里找不到 PARTICLES 定义（轻声词表）');
else {
  const list = m[1];
  const missing = [...PARTICLES].filter((c) => !list.includes(c));
  if (missing.length) bad(`serve.py 的 PARTICLES 少了：${missing.join('')}（主人要求句尾语气词一律轻声）`);
  else ok(`轻声词表 ${list.length} 个字，含「吗」「呢」`);
  const rule = String(spec.text_rules?.question_particles ?? '');
  if (/同样轻声|一律轻声/.test(rule)) ok('配方里的规则说明与代码一致（疑问句语气词也轻声）');
  else bad(`text_rules.question_particles 没写"同样轻声"：${rule.slice(0, 40)}…（规则与代码会打架）`);
}

// 记录完整性：决策要留痕（半年后还得能回答"这条规则怎么来的"）
if (Array.isArray(spec.decided_by) && spec.decided_by.length >= 5) ok(`decided_by 留痕 ${spec.decided_by.length} 条`);
else bad('decided_by 太少（决策没留痕）');

console.log(failed ? `\n❌ ${failed} 项没过 —— 她的声音配置有问题。` : '\n✅ 配方可用（参考音/参数/种子/轻声/上扬/规则一致）');
process.exit(failed ? 1 : 0);
