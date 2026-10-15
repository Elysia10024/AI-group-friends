// 配置合并：默认值 + config.json 覆盖。
//
// 为什么需要它：默认值结构里有**嵌套对象**（socialV2.tools / socialV2.sticker.collect / security…），
// 用 `{ ...默认, ...file }` 这种浅 spread 合并时，旧 config.json 里只要出现过 `"tools"` 这一层，
// 整个子对象就被**替换**掉 —— 新加的默认开关静默消失。以前是靠"在下面再手写一遍完整的默认值
// 再 `...file.X` 一次"来兜，于是同一份默认值清单存在两三处（socialV2.tools 列了两遍、
// sticker.collect 在同一个字面量里写了两遍），加一个键要改多处、漏一处就出 bug。
//
// 规则（这是"配置文件"的语义，不是通用深合并，别随手指望通用）：
//   · 普通对象 → **递归**合并，新加的默认键永远不会被旧配置顶掉；
//   · 数组、标量 → 后者覆盖（数组不合并：配置里的数组就是要整体替换）；
//   · `null` / `undefined` → 视为"没配"，保留默认（旧配置里常见 null 占位）。
// 返回值全部是**新对象/新数组**（纯函数，不与入参共享引用）。
export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const cloneVal = (v) => (isPlainObject(v) ? deepMerge(v, undefined)
  : Array.isArray(v) ? v.map(cloneVal) : v);

export function deepMerge(base, over) {
  const out = {};
  for (const [k, v] of Object.entries(isPlainObject(base) ? base : {})) out[k] = cloneVal(v);
  for (const [k, v] of Object.entries(isPlainObject(over) ? over : {})) {
    if (v === null || v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : cloneVal(v);
  }
  return out;
}
