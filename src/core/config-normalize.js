// 控制台保存配置时的**类型规整**：按"默认值的类型"决定怎么把面板传来的值收回来。
//
// 为什么要有它：以前每个配置键的类型规整都是在路由里手抄一份键名清单（socialV2.tools 那 29 个
// 工具名、各段的数值键名……），共 60 多个名字。加一个配置项要改三处：config.js 默认值、
// 路由里的键名清单、前端表单。漏掉路由那份 = "界面上能改，但存下去是字符串/不夹范围"。
// 现在类型从 CONFIG_DEFAULTS 推导，路由里不再有键名。
//
// 规则（默认值的类型 → 口径）：
//   布尔     → 严格取布尔（`v === true`）；传了非布尔 → false
//             opts.keepCurrentOnNonBool 里的段落例外：非布尔 → 保留当前值（工具开关的旧口径，别顺手改）
//   整数     → 四舍五入 + 非负；非有限数 → 当前值，当前值没有则用默认值
//   小数     → 按概率夹到 0..1（不取整）；非有限数 → 0
//   数组     → 允许数组，或按逗号/中文逗号/空白拆分；元素转字符串、去掉空串
//   字符串   → String(v ?? '')；CONFIG_ENUMS 里的键只保留允许值，其余回落到**默认值**
//   数值     → CONFIG_ENUMS 里有该键时同样只保留允许值（枚举优先于整数/概率分支）
//   对象     → 递归；传了非对象（null/数组/标量）→ 保留当前值（当前值没有则 {}）
// 默认值里没有的键：**原样带过**（与旧实现一致 —— 旧实现是 `{...current, ...body}`），
// 这样新配置键不会因为这份规整表还没更新就被丢掉。
export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const toInt = (v, cur, fb) => {
  const n = Number(v);
  const base = Number.isFinite(n) ? n : (cur !== undefined && cur !== null ? cur : fb);
  return Math.round(Number(base));
};

/**
 * @param defaults 该层的默认值（决定每个键的类型）
 * @param current  该层当前值（规整不了时的兜底）
 * @param patch    面板传来的那一层
 * @param opts     { prefix?: string, ranges?: object, enums?: object, keepCurrentOnNonBool?: string[] }
 */
export function normalizeByDefaults(defaults, current, patch, opts = {}) {
  const { prefix = '', ranges = {}, enums = {}, keepCurrentOnNonBool = [] } = opts;
  const out = { ...(isPlainObject(current) ? current : {}) };
  if (!isPlainObject(patch)) return out;

  for (const [key, raw] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const def = defaults?.[key];

    if (isPlainObject(def)) {
      // 段落：传了非对象就保留当前值（旧实现就是这么兜的）
      out[key] = isPlainObject(raw)
        ? normalizeByDefaults(def, current?.[key], raw, { ...opts, prefix: path })
        : (isPlainObject(current?.[key]) ? current[key] : {});
      continue;
    }
    if (def === undefined) { out[key] = raw; continue; }        // 默认值里没有的键：原样带过

    const cur = current?.[key];
    const range = ranges[path];

    if (typeof def === 'boolean') {
      // keepCurrentOnNonBool 给的是**段落路径**（如 socialV2.tools），实际 path 是键的完整路径
      // （socialV2.tools.sendPoke）→ 必须按前缀匹配。（第一版写成全等，工具开关那条口径整个失效。）
      const inList = keepCurrentOnNonBool.some((p) => path === p || path.startsWith(`${p}.`));
      out[key] = typeof raw === 'boolean' ? raw : (inList ? cur !== false : false);
      continue;
    }
    if (typeof def === 'number') {
      // 数值型的枚举键（2026-10-12 加 socialV2.qzone.ugcRight 时发现的口径缺口）：
      // CONFIG_ENUMS 原本只对字符串键生效，数值键写了枚举**等于没写**（不报错、静默失效）——
      // 而"权限值只能是 1/4/64 之一"这种约束区间夹不出来。所以枚举优先于整数/概率分支。
      // 对已有的键无影响：在那之前 CONFIG_ENUMS 里没有任何数值键。
      const allowedNums = enums[path];
      if (Array.isArray(allowedNums) && allowedNums.length) {
        const rawN = Number(raw);
        const curN = Number(cur);
        const n = Number.isFinite(rawN) ? rawN : curN;
        out[key] = allowedNums.includes(n) ? n : def;
        continue;
      }
      if (Number.isInteger(def) && !isProbKey(key, def)) {
        out[key] = clampRange(Math.max(0, toInt(raw, cur, def)), range);
      } else {
        // 概率：非有限数回落到当前值（旧实现的口径；回落到 0 会把用户设的概率清掉）
        const n = Number(raw);
        out[key] = clamp01(Number.isFinite(n) ? n : (Number(cur) || 0));
      }
      continue;
    }
    if (Array.isArray(def)) {
      out[key] = (Array.isArray(raw) ? raw : String(raw).split(/[,，\s]+/)).map(String).filter(Boolean);
      continue;
    }
    if (typeof def === 'string') {
      const allowed = enums[path];
      if (allowed) {
        const s = String(raw);
        out[key] = allowed.includes(s) ? s : def;                // 不在允许列表 → 回落默认值
      } else {
        out[key] = String(raw ?? '');
      }
      continue;
    }
    out[key] = raw;
  }
  return out;
}

/** 概率字段：默认值是小数，或者名字以 Probability 结尾（`surrenderProbability: 0` 的默认值是整数 0，
 *  JS 里没法从值区分"0"和"0.0"，所以名字这一条是必要的）。 */
const isProbKey = (key, def) => /Probability$/.test(key) || (typeof def === 'number' && !Number.isInteger(def));

function clamp01(n) { return Math.min(1, Math.max(0, Number(n) || 0)); }

function clampRange(n, range) {
  if (!range) return n;
  const [lo, hi] = range;
  let out = n;
  if (lo !== null && lo !== undefined) out = Math.max(lo, out);
  if (hi !== null && hi !== undefined) out = Math.min(hi, out);
  return out;
}
