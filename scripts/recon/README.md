# scripts/recon —— 一次性勘察脚本（历史归档）

这些脚本是**某一次改造开工前的勘察工具**，不是日常仪表。它们被移到这里，是因为
留在仓库根会让人误以为它们还在维护、还在给出可信数字。

| 脚本 | 当年为哪次改造服务 | 现在还能用吗 |
|---|---|---|
| `audit-anatomy.mjs` | 拆 `main()` 前的 bridge.js 解剖（函数清单/体积/状态面） | ❌ **体积估算是错的**，见下 |
| `audit-console.mjs` | 控制台瘦身（R1）范围勘察 | ⚠️ 只对当时那版 `startConsoleServer` 有效 |
| `audit-console2.mjs` | 同上 v2（改用"全文件声明 ∩ 控制台内引用"算依赖） | ⚠️ 同上 |
| `audit-consolidate.mjs` | 找"同一概念的多套实现 / 死分支 / 重复路由族" | ⚠️ 一次性结论已落进重构提交 |
| `audit-target.mjs` | 把 bridge.js 的 191 个函数按职责归类，得出模块划分 | ⚠️ 当年就**逐条落地**了；现在的模块是它的产物 |

## `audit-anatomy.mjs` 为什么不能再用

它的函数体积是**按"到下一个 `function` 的距离"估的**，而且只认 `function` 声明、
不认 `const x = () => {}`。在拆完 `main()` 之后，这个估法会给出假数字：

```
它报的            真值（大括号配对实测，2026-09-18）
setupSleepTimerV2  467 行   →   37 行
redactKnownTokensOnly 309 行 →   7 行
async main         263 行   →   1188 行（它只算到下一个 function 声明）
```

一个会输出假数字的取证工具比没有更糟 —— 这正是它被移走的原因。

**替代品**（这两个是活工具，做了真正的词法/作用域分析）：

- `scripts/split-console.mjs` —— 作用域分析库：`blankCode` / `functionSites`（**认箭头常量**，
  且标了 `kind:'const'`）/ `declaredInside` / `collectIdentifiers` / `refSites` / `matchBraces`
- `scripts/extract-cluster.mjs` —— 按簇搬函数进模块：三道守卫 + "逆变换逐字还原原文"验证

想再看"哪个函数又变大了"，用 `split-console.mjs` 的 `functionSites` 配大括号配对重写一遍
即可（比原来那版还简单），不必用这里的旧脚本。
