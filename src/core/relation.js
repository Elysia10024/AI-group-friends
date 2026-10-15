// 关系档：**跟人走（按 QQ），不跟群走**。
//
// 用户决定（2026-10-02 定、2026-10-12 重申）：关系**不数值化** ——
// "人与人的关系不能被简单归成数字"。所以这里只有档位名字：
// **没有分数、没有倍率、没有阈值、没有计数器**。
//
// 六档（从远到近）：讨厌 < 路人 < 认识但不太熟 < 熟人 < 好朋友 < 家人
//   · 同一个人在不同群**共用一个档**（否则会出现"在 A 群当家人、在 B 群当熟人"的精神分裂）；
//   · **她自己的判断是唯一权威**（2026-10-12 改）：她给什么档就记什么档，可以升也可以降。
//     旧实现写入时用 `closerRelation` 取"更亲近的那个"，结果是**只升不降**——
//     关系一旦变好就再也记不下"变差"（真实 bug：QQ 10000002 骂她那一次暴露出来）。
//     `closerRelation` 保留为工具函数，**写入路径不再使用**。
//   · 只有两条硬边界由代码兜住（用户指定，不是数值化，是安全边界）：
//     ① **主人恒为家人、永不降档**；② **家人档只能由主人指定**，其他人最高"好朋友"。
//   · "为什么是这个档"的证据留在各会话的事实里（印象 + 时间），这里只存结论。

export const RELATION_TIERS = ['讨厌', '路人', '认识但不太熟', '熟人', '好朋友', '家人'];

/** 主人独占的档位：只有 ownerQQ 能是它（别人想设也会被压回 ORDER_BELOW）。 */
export const OWNER_TIER = '家人';
/** 非主人能达到的最高档。 */
export const ORDER_BELOW = '好朋友';

/** 把各种写法归一到六档；认不出就返回 ''（调用方决定是否保留原值）。 */
export function normalizeRelation(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (RELATION_TIERS.includes(s)) return s;
  const alias = {
    讨厌: '讨厌', 烦: '讨厌', 烦人: '讨厌', 不喜欢: '讨厌', 恶心: '讨厌', 恶心人: '讨厌', 烦死: '讨厌',
    陌生: '路人', 陌生人: '路人', 不认识: '路人',
    不太熟: '认识但不太熟', 认识: '认识但不太熟', 有点熟: '认识但不太熟',
    熟人: '熟人', 熟悉的: '熟人',
    好朋友: '好朋友', 朋友: '好朋友', 好哥们: '好朋友',
    家人: '家人', 亲人: '家人', 自己人: '家人'
  };
  return alias[s] ?? '';
}

/**
 * 写入关系时的**唯一裁决点**：采纳她的判断 + 兜住两条硬边界。
 *
 * 为什么要有它：写入路径以前是 `setPersonRelation(qq, closerRelation(prev, rel))`，
 * 永远取更亲近的那个 → 降档永远存不下来。现在改成"她要什么就是什么"，
 * 只有主人相关两条会拦（那是用户明确要求的边界，不是替她判断感情）。
 *
 * @param {{ownerQQ?:string, qq?:string, next?:string}} p
 * @returns {{ok:boolean, tier:string, adjusted:string, reason:string}}
 *   `adjusted` 非空表示"她想要的档被边界改写过"，调用方应当回报给她（别默默改）。
 */
export function resolveRelationWrite({ ownerQQ = '', qq = '', next = '' } = {}) {
  const id = String(qq ?? '').trim();
  const owner = String(ownerQQ ?? '').trim();
  const want = normalizeRelation(next);
  if (!id) return { ok: false, tier: '', adjusted: '', reason: '缺少 QQ 号，改不了关系' };
  if (!want) return { ok: false, tier: '', adjusted: '', reason: '认不出这个档位（可用：讨厌/路人/认识但不太熟/熟人/好朋友/家人）' };
  if (owner && id === owner) {
    return { ok: true, tier: OWNER_TIER, adjusted: want === OWNER_TIER ? '' : '主人恒为家人，不降档', reason: '' };
  }
  if (want === OWNER_TIER) {
    return { ok: true, tier: ORDER_BELOW, adjusted: '家人档只能由主人指定，已按"好朋友"记录', reason: '' };
  }
  return { ok: true, tier: want, adjusted: '', reason: '' };
}

/** 两个档位取更亲近的那个；空值不算数。（**已不用于写入**，只作工具函数保留。） */
export function closerRelation(a, b) {
  const x = normalizeRelation(a);
  const y = normalizeRelation(b);
  if (!x) return y;
  if (!y) return x;
  return RELATION_TIERS.indexOf(x) >= RELATION_TIERS.indexOf(y) ? x : y;
}

/** 从一条印象文本里抠出关系（形如「关系：家人」）。 */
export function relationFromTrait(text) {
  const m = /^关系[：:]\s*(.+)$/.exec(String(text ?? '').trim());
  return m ? normalizeRelation(m[1]) : '';
}

/**
 * 材料里那几行：本会话**出现过**的人各自是什么关系（读全局）。
 * 带上"最近影响关系的那句话 + 时间"（用户 2026-10-12 要求：她能看见自己怎么想的，
 * 语气才好跟着走；控制面板也读同一份数据）。
 *
 * @param {object} p
 * @param {{[qq:string]:{relation?:string, relationNote?:string, relationNoteAt?:number}}} p.people 全局人物表
 * @param {Array<{userId?:string,sender?:string}>} p.speakers 本会话最近说话的人
 * @param {number} [p.max=8]
 * @param {number} [p.now] 当前时间（注入便于测试）
 */
export function relationLines({ people = {}, speakers = [], max = 8, now = Date.now() } = {}) {
  const seen = new Set();
  const out = [];
  for (const s of Array.isArray(speakers) ? speakers : []) {
    const qq = String(s?.userId ?? s?.user_id ?? '').trim();
    const rec = people?.[qq] ?? {};
    const rel = normalizeRelation(rec.relation);
    if (!qq || !rel || seen.has(qq)) continue;
    seen.add(qq);
    const name = String(s?.sender ?? qq).trim() || qq;
    out.push(`- ${name}：${rel}${relationNoteSuffix(rec, now)}`);
    if (out.length >= max) break;
  }
  return out;
}

/** 关系后面那句"（10-12 凌晨：他骂过我，最近有点烦）"；没记过就留空。 */
export function relationNoteSuffix(rec, now = Date.now()) {
  const note = String(rec?.relationNote ?? '').replace(/\s+/g, ' ').trim();
  const at = Number(rec?.relationNoteAt) || 0;
  if (!note && !at) return '';
  const d = at ? new Date(at) : null;
  const stamp = d ? `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  const cut = note.length > 60 ? `${note.slice(0, 60)}…` : note;
  if (stamp && cut) return `（${stamp}：${cut}）`;
  if (stamp) return `（${stamp}）`;
  return `（${cut}）`;
}
