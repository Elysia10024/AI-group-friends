// 黑话规则引擎：不依赖模型、不依赖人工，用规则直接解出候选词的含义。
//
// 为什么要它：原来的流程是「候选 → 重复出现≥2次 → 模型推断 → 管理员确认 → 才注入」，
// 结果是 61 条候选全部卡死（没有一个词重复到 2 次），她永远学不到。
// 但其中很多词用规则就能解：谐音（雀食=确实）、身份后缀（高冷鲸=高冷+鲸）、数字/叠字。
//
// 规则命中即自动收录（status=confirmed），因为规则表是人工策展的、精度高。
import { SLANG_STATUS } from './slang-learner.js';

// ============ A) 精确表：常见网络梗 + 本群已知梗 ============
// 格式：词 → [含义, 用法, 风险]
const KNOWN = {
  // —— 谐音类 ——
  雀食: ['确实（谐音）。表示同意', '', ''],
  蚌埠住了: ['绷不住了（谐音）。忍不住笑出来 / 情绪绷不住', '', ''],
  蚌埠: ['「绷不」的谐音，见「蚌埠住了」', '', ''],
  尊嘟假嘟: ['真的假的（谐音卖萌）', '', ''],
  栓Q: ['thank you 的谐音。多表示无语、无奈、谢了但没什么好谢的', '', ''],
  耗子尾汁: ['好自为之（谐音）。一般带调侃/看笑话的语气', '', ''],
  雨女无瓜: ['与你无关（谐音）', '', ''],
  有内味了: ['有那个味道了（褒义或调侃）', '', ''],
  有内味儿了: ['有那个味道了', '', ''],
  稀饭: ['喜欢（谐音）', '', ''],
  灰常: ['非常（谐音）', '', ''],
  果酱: ['过奖（谐音）', '', ''],
  可耐: ['可爱（谐音）', '', ''],
  帅锅: ['帅哥（谐音）', '', ''],
  霉女: ['美女（谐音，多为自嘲）', '', ''],
  杯具: ['悲剧（谐音，多用于自嘲）', '', ''],
  餐具: ['惨剧（谐音，多用于自嘲）', '', ''],
  酱紫: ['这样子（谐音）', '', ''],
  大隐鲸: ['谐音「大阴茎」的恶搞外号，是本群群友拿这个 AI 群友开玩笑的叫法。属于调侃/损话，她本人会炸毛', '被这么叫时傲娇顶回去', '谐音粗俗，她自己不要主动说'],

  // —— 网络流行语 ——
  yyds: ['永远的神。夸某个人/东西特别好', '', ''],
  YYDS: ['永远的神。夸某个人/东西特别好', '', ''],
  xswl: ['笑死我了（拼音缩写）', '', ''],
  awsl: ['啊我死了（拼音缩写）。表示被萌到/震撼', '', ''],
  nsdd: ['你说得对（拼音缩写）', '', ''],
  u1s1: ['有一说一（缩写）', '', ''],
  绝绝子: ['极好或极差，看语境。夸张语气', '', ''],
  破防: ['心理防线被击破。多指被戳中、绷不住', '', ''],
  emo: ['情绪低落、伤感', '', ''],
  抽象: ['荒诞、离谱、看不懂（多用于吐槽）', '', ''],
  离谱: ['太夸张、不合常理', '', ''],
  典: ['「经典」的缩写。多为讽刺性的「太典了」', '', ''],
  乐: ['好笑，看笑话的「乐」', '', ''],
  草: ['「操」的谐音，表惊讶/无语/好笑', '', '轻粗口'],
  绷不住了: ['忍不住（笑/崩）', '', ''],
  蚌埠住: ['绷不住（谐音）', '', ''],
  掉san: ['理智值下降（克苏鲁梗）。指被吓到/被雷到', '', ''],
  地狱笑话: ['拿悲剧/苦难开玩笑的笑话，敏感', '', '敏感'],
  前方高能: ['提醒接下来有冲击性内容', '', ''],
  马住: ['mark 的谐音。标记一下、收藏', '', ''],
  码住: ['mark。标记收藏', '', ''],
  马克: ['mark。标记收藏', '', ''],

  // —— 本群已知 ——
  大肥鱼: ['群友拿「肥」调侃这个 AI 群友的称呼（配合她的鲸鱼形象）。是她的雷点，被这么叫会炸毛', '她本人会傲娇反驳', ''],
  大肥鲸: ['「大肥鱼」的变体叫法，同样是她被调侃的称呼', '', ''],
  肥鱼: ['群友对这个 AI 群友的调侃称呼（她的雷点）', '', ''],
  高冷鲸: ['「高冷」+「鲸」。说她这个 AI 群友很高冷、不爱说话', '', ''],
  高冷鱼: ['说她这个 AI 群友高冷', '', ''],
  欧金金: ['日语「おちんちん」的音译，指男性生殖器。属于荤梗', '', '荤梗，看场合'],
  雀食蟀: ['确实帅（谐音玩梗）', '', ''],
  并非桃金娘: ['明日方舟干员梗的变体说法，表示「并不是」', '', ''],
  理性星期三: ['「疯狂星期四」的玩梗变体', '', ''],
  富哥vivo50: ['「富哥 v 我 50」的梗，找有钱人要钱玩的段子（源自肯德基疯狂星期四）', '', ''],
  疯狂星期四: ['肯德基的营销梗，周四常被拿来玩「v我50」', '', ''],
};

// ============ A2) 拼音缩写表 ============
const ABBR = {
  nm: ['「你妈」的拼音缩写，粗口。多表示不满、无语', '粗口，看场合'],
  cnm: ['「操你妈」的拼音缩写，粗口', '粗口，看场合'],
  mdzz: ['「妈的智障」的缩写', '粗口，看场合'],
  xswl: ['「笑死我了」的缩写', ''],
  yyds: ['「永远的神」的缩写', ''],
  awsl: ['「啊我死了」的缩写，表示被萌到/震撼', ''],
  nsdd: ['「你说得对」的缩写', ''],
  u1s1: ['「有一说一」的缩写', ''],
  yygq: ['「阴阳怪气」的缩写', ''],
  zqsg: ['「真情实感」的缩写', ''],
  srds: ['「虽然但是」的缩写', ''],
  dbq: ['「对不起」的缩写', ''],
  yjgj: ['「有句讲句」的缩写', ''],
  gkd: ['「搞快点」的缩写，催更/催促', ''],
  kswl: ['「磕死我了」的缩写，磕CP上头的说法', ''],
  bhys: ['「不好意思」的缩写', ''],
  pyq: ['「朋友圈」的缩写', ''],
  dssq: ['「大势所趋」的缩写，多带讽刺', ''],
  wsfw: ['「我是废物」的缩写，自嘲', ''],
  jm: ['「姐妹/集美」的缩写', ''],
};

// ============ A3) 网络用语补充 ============
const KNOWN2 = {
  逆天: ['离谱到极点、不可理喻（可褒可贬）', '', ''],
  家人们: ['短视频/直播腔的「大家」，多带玩梗的亲切感', '', ''],
  擦边: ['内容游走在规则边缘。这里多指带点荤、打擦边球的话题', '', ''],
  破限: ['指绕过模型的内容限制（jailbreak）。属于敏感话题', '', '敏感'],
  爆了: ['超出预期、炸了（可指好笑、离谱、崩盘）', '', ''],
  满配: ['游戏里把配置/练度拉满', '', ''],
  真神: ['圈子里公认最顶级的那个', '', ''],
  b服: ['B 站渠道的服务器（游戏分区叫法）', '', ''],
  吃白饭: ['说她白吃算力不干活，是群友调侃这个 AI 群友的话', '', ''],
  偷吃token: ['调侃这个 AI 群友偷偷消耗 token，属于损话', '', ''],
  蛆: ['网络用语，骂人技术差、菜、烂（比「菜」更重）', '', '粗口'],
  区: ['「蛆」的谐音，同上面那条——骂人菜、烂', '', '粗口'],
  苟利: ['「苟利国家生死以」的省略，出自林则徐，常被拿来玩接句梗', '', ''],
  天生万物以养人: ['网络梗句，下句是「人无一物以报天」，多用于自嘲或摆烂', '', ''],
  我释放忍术: ['网络梗，中二地表示「我要出招了」，多为搞怪', '', ''],
  大肥蛆: ['「大肥鱼」的恶劣变体，「蛆」是骂人菜/烂的字，属于更冲的损话', '被这么叫可以真的生气', '粗口'],
  太蛆了: ['「蛆」是骂人菜、烂的说法，这句等于「太菜了」', '', '粗口'],
  你个区: ['「区」是「蛆」的谐音，等于「你个菜逼」，属于骂人的玩笑', '', '粗口'],
  玩的好大: ['「玩得很大」的口语写法，指对方玩得夸张/放得开', '', ''],
  后宫团: ['调侃群里围着她转的一群人，开玩笑的说法', '', ''],
  烧货: ['网络粗口，骂人骚。属于脏话', '', '粗口'],
};

// ============ B) 身份称呼模式 ============
// 机器人自己的固定识别词（她被起的外号基本都带这些）
const IDENTITY_TOKENS = ['鲸鱼', '鲸', '肥鱼', '大肥鱼', '小鲸鱼', 'deepseek', 'ds', 'd指导', 'd老师', 'd师傅'];

// ============ C) 谐音还原 ============
// 常见「谐音用字 → 本字」映射（只放高置信的）
const HOMO_CHARS = {
  雀: '确', 食: '实', 蚌: '绷', 埠: '不', 尊: '真', 嘟: '的',
  栓: 'thank', 耗: '好', 尾: '为', 汁: '之', 雨: '与', 女: '你', 瓜: '关',
  酱: '这样', 紫: '子', 稀: '喜', 灰: '非', 果: '过', 耐: '爱',
  锅: '哥', 霉: '美', 杯: '悲', 具: '剧', 餐: '惨', 隐: '阴', 茎: '茎',
  蟀: '帅', 蟹: '谢', 虾: '瞎', 鸭: '呀', 银: '人',
};

// 谐音还原后如果能对上下面的常见词，就认定是谐音梗
const COMMON_WORDS = [
  '确实', '绷不住', '好自为之', '与你无关', '真的假的', '这样子', '非常', '喜欢',
  '过奖', '可爱', '帅哥', '美女', '悲剧', '惨剧', '谢谢', '瞎', '呀', '人',
  '大阴茎', '阴茎', '牛逼', '厉害', '笑死我了',
];

// ============ D) 纯数字 / 叠字 ============
const NUMBER_MEANINGS = {
  66: '「溜溜」，夸厉害、顺',
  666: '夸厉害、牛',
  233: '大笑（源自猫扑表情编号）',
  2333: '大笑（233 的加长版）',
  886: '拜拜了（谐音）',
  520: '我爱你（谐音）',
  7456: '气死我了（谐音）',
};

function stripPunct(s) {
  return String(s ?? '').replace(/^[\s，。！？、~～.!?,]+|[\s，。！？、~～.!?,]+$/g, '');
}

// 把候选按谐音字替换一遍，看看能不能还原成常见词
function homophoneResolve(content) {
  let out = '';
  let changed = false;
  for (const ch of content) {
    if (HOMO_CHARS[ch]) { out += HOMO_CHARS[ch]; changed = true; }
    else out += ch;
  }
  if (!changed) return null;
  const hit = COMMON_WORDS.find((w) => out.includes(w));
  if (!hit) return null;
  return { resolved: out, hit };
}

// 主入口：返回 null 表示规则解不出来
export function inferSlangByRules(content) {
  const w = stripPunct(content);
  if (!w) return null;

  // A) 精确表（大小写不敏感）
  if (KNOWN[w]) {
    const [meaning, usage, risk] = KNOWN[w];
    return { meaning, usage, example: '', risk, rule: 'known', confidence: 'high' };
  }
  const lower = w.toLowerCase();
  const knownKey = Object.keys(KNOWN).find((k) => k.toLowerCase() === lower);
  if (knownKey) {
    const [meaning, usage, risk] = KNOWN[knownKey];
    return { meaning, usage, example: '', risk, rule: 'known', confidence: 'high' };
  }

  // D) 纯数字
  if (/^\d{2,4}$/.test(w) && NUMBER_MEANINGS[w]) {
    return { meaning: NUMBER_MEANINGS[w], usage: '', example: '', risk: '', rule: 'number', confidence: 'high' };
  }
  // 叠字：菜菜 → 菜；急急 → 急（表加强语气）
  const dup = /^(.)\1$/.exec(w);
  if (dup && /[\u4e00-\u9fff]/.test(dup[1])) {
    return {
      meaning: `「${dup[1]}」的叠字，语气加重、带点撒娇或吐槽（不是新词）`,
      usage: '', example: '', risk: '', rule: 'reduplication', confidence: 'medium',
    };
  }

  // A2) 拼音缩写
  if (ABBR[lower]) {
    const [meaning, risk] = ABBR[lower];
    return { meaning, usage: '', example: '', risk, rule: 'abbr', confidence: 'high' };
  }

  // A3) 网络用语补充
  if (KNOWN2[w]) {
    const [meaning, usage, risk] = KNOWN2[w];
    return { meaning, usage, example: '', risk, rule: 'known', confidence: 'high' };
  }

  // B0) 「大肥X / 小X / X鲸 / X鱼」身份变体：X 是修饰语，主体指她
  const variant = /^(大肥|小|大|老)(.+)$/.exec(w);
  if (variant && IDENTITY_TOKENS.some((t) => w.endsWith(t))) {
    const prefix = variant[1];
    const mid = variant[2].slice(0, Math.max(0, variant[2].length - 1));
    return {
      meaning: `群友给她起的外号变体：「${prefix}」+「${mid}」+（她的识别词），是拿这个 AI 群友开玩笑的叫法`,
      usage: '被这么叫时可以傲娇顶回去', example: '', risk: '', rule: 'identity-variant', confidence: 'medium',
    };
  }

  // B) 身份称呼模式：含她的识别词 → 解构成「修饰语 + 鲸(她)」
  const hitToken = IDENTITY_TOKENS.find((t) => lower.includes(t.toLowerCase()));
  if (hitToken) {
    const idx = lower.indexOf(hitToken.toLowerCase());
    const prefix = w.slice(0, idx);
    const suffix = w.slice(idx + hitToken.length);
    const homo = homophoneResolve(w);
    if (homo) {
      return {
        meaning: `谐音「${homo.resolved}」的恶搞外号，是群友拿这个 AI 群友开玩笑的叫法`,
        usage: '被这么叫时可以傲娇顶回去', example: '', risk: '谐音粗俗，她自己不要主动说',
        rule: 'identity+homophone', confidence: 'medium',
      };
    }
    if (prefix || suffix) {
      return {
        meaning: `群友给她起的外号：${prefix ? `「${prefix}」+` : ''}「${hitToken}」（${hitToken} 指这个 AI 群友）${suffix ? `+「${suffix}」` : ''}`,
        usage: '', example: '', risk: '', rule: 'identity', confidence: 'medium',
      };
    }
  }

  // C) 一般谐音还原
  const homo = homophoneResolve(w);
  if (homo) {
    return {
      meaning: `「${homo.resolved}」的谐音，意思就是「${homo.hit}」`,
      usage: '', example: '', risk: '', rule: 'homophone', confidence: 'medium',
    };
  }

  return null;
}

// 把规则套到已有条目上：命中且原本没有释义的，直接补释义并收录
export function applyRulesToEntries(entries) {
  const changed = [];
  for (const e of entries || []) {
    if (!e || !e.content) continue;
    if (e.status === SLANG_STATUS.REJECTED) continue;
    const r = inferSlangByRules(e.content);
    if (!r) continue;
    const before = e.meaning;
    if (!e.meaning) e.meaning = r.meaning;
    if (!e.usage && r.usage) e.usage = r.usage;
    if (!e.risk && r.risk) e.risk = r.risk;
    if (!e.example && r.example) e.example = r.example;
    if (e.status !== SLANG_STATUS.CONFIRMED) {
      e.status = SLANG_STATUS.CONFIRMED;
      e.source = 'rule';
    }
    if (before !== e.meaning || e.status === SLANG_STATUS.CONFIRMED) {
      changed.push({ content: e.content, rule: r.rule, meaning: e.meaning, wasEmpty: !before });
    }
  }
  return changed;
}
