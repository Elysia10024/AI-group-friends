# scripts 索引（自动生成，勿手改）

> 由 `node scripts/gen-script-index.mjs` 生成；首行注释即用途。
> 「接线」列的 `npm` = 有 npm script 指向它；`selfcheck` = 在每日守卫链里跑。
> 没接线的不等于没用：一次性排障/审计脚本本来就该按需手动跑。

## （根目录）

| 脚本 | 用途 | 接线 |
|---|---|---|
| `api-key-lib.mjs` | API key 自检的共用逻辑（被 check-api-key.mjs 与 set-api-key.mjs 共用）。 | — |
| `archive-session.mjs` | 会话归档导出器：把 DSH 会话的原始记录（jsonl.zstd，动辄上百 MB、几万行） | npm |
| `backup-memory.mjs` | 记忆快照：她的记忆（群友印象/话题/想法）只存在 state/social-v2.json 里， | npm |
| `check-aa-endpoint.mjs` | 手机连接（Agents Anywhere）僵尸记录的自愈：清理 `endpoint.json` 里那条"主人早就死了"的 | npm+selfcheck |
| `check-aa-sync.mjs` | 手机连接（Agents Anywhere）健康巡检 + 私聊告警。 | npm+selfcheck |
| `check-api-key.mjs` | 换 API key 前后的连通性自检（只读，几乎不花钱）。 | npm |
| `check-archive.mjs` | 归档新鲜度守卫：最新的会话活动比最后一次归档晚太多 → 红。 | npm+selfcheck |
| `check-atomic-write.mjs` | check-atomic-write —— 静态守卫：全仓的原子写只允许 core/state-io.js 一个实现。 | npm+selfcheck |
| `check-console-ui.mjs` | 控制台配置面板（public/console.html）的自动化测试：把页面脚本搬进 Node 跑。 | npm+selfcheck |
| `check-dossier.mjs` | 档案新鲜度：`<DS目录>\docs\小鲸鱼档案.md` 的「现状速览」块必须和现状一致。 | selfcheck |
| `check-effort-config.mjs` | 推理档位一致性守卫（纯静态、不联网、不花钱）。 | npm+selfcheck |
| `check-launchers.mjs` | 启动脚本编码守卫 —— 2026-10-03 那次"看门狗活着但什么都不干"的复盘产物。 | npm+selfcheck |
| `check-lines-kept.mjs` | 抬块后的整体校验：**原始文件里的每一行（去空白、非空）都应仍出现在新文件里**， | npm |
| `check-mcp-tools.mjs` | MCP 工具面自检：起一个 stdio 客户端连 src/mcp-snowluma-safe.js，列出工具清单。 | npm |
| `check-module-ctx.mjs` | 模块 ctx 一致性自检：**模块里解构了、但构造时没接进去**的名字。 | npm+selfcheck |
| `check-onebot-status.mjs` | 查询 SnowLuma 网关与 QQ 会话状态：HTTP API + WebSocket | — |
| `check-relation-doc.mjs` | 把文档里写的硬事实，逐条回代码/人格核对（避免"文档说的和实现不一致"）。 | selfcheck |
| `check-reply-resolve.mjs` | 引用解析接线守卫：**凡是接收 body.replyToMessageId 的路由，都必须把它解析成真实 message | npm+selfcheck |
| `check-route-inventory.mjs` | check-route-inventory —— 控制台路由清单守卫（2026-10-28 第 4 期 4a）。 | npm+selfcheck |
| `check-rules.mjs` | check:rules —— 规则层的机器守卫（2026-09-30 重构后新增） | npm+selfcheck |
| `check-tool-flags.mjs` | 工具开关（flag）一致性自检 —— 纯静态，不用起服务。 | npm+selfcheck |
| `check-tool-refs.mjs` | check:tool-refs —— 她读到的规则里，引用的工具名必须真实存在。 | npm+selfcheck |
| `check-tool-schema.mjs` | 工具 schema 与说明的一致性自检：**说明里承诺的参数，schema 里必须真的有**。 | selfcheck |
| `check-tool-token.mjs` | 工具令牌接线守卫：v2 工具的会话令牌必须**真的挂到请求头上**，不能只写在工具说明里。 | npm+selfcheck |
| `check-voice-spec.mjs` | 嗓音配方（<项目根>\tts\her-voice.json）的静态体检：**这个文件是她的声音的唯一真源**， | npm+selfcheck |
| `clean-orphan-comments.mjs` | 清掉"抬块落下的段落路标"。 | — |
| `console-ctx-audit.mjs` | 审计控制台路由的 ctx 依赖：路由模块从 ctx 解构名字，而 ctx 来自 | npm+selfcheck |
| `dedupe-memory.mjs` | 一次性清理：把已经攒下来的**近似重复印象**按 core/memory.js 的同一套规则合并。 | — |
| `doctor.mjs` | doctor.mjs —— 一条命令体检整条链路。 | npm+selfcheck |
| `extract-cluster.mjs` | extract-cluster.mjs —— 把 bridge.js 里 main() 的一个"簇"（一组互相调用的函数 | — |
| `fix-agents-anywhere.mjs` | 应急修复：手机连接（Agents Anywhere）连不上 / DSH 面板 Connector 报「运行异常 / HT | — |
| `gen-route-index.mjs` | gen-route-index —— 生成控制台路由表（第 4 期 4d 的可读那一半，2026-10-28 第 23  | npm+selfcheck |
| `gen-rules-table.mjs` | 生成 docs/规则总表.md —— "改规则之前先看这张表" | npm |
| `gen-script-index.mjs` | gen-script-index —— 给 scripts/ 生成一张索引表（第 6 期 6c，2026-10-28）。 | npm+selfcheck |
| `lift-block.mjs` | 从一个长函数里把一段内聚代码**抬成同工厂内的子函数**。 | — |
| `list-functions.mjs` | 列大函数：按**真实区间**统计 src/ 下每个函数的行数，倒序打印。 | npm |
| `make-config-example.mjs` | 从 config.json 生成 config.example.json（剥掉敏感值）。 | npm+selfcheck |
| `migrate-memory-qq.mjs` | 记忆身份锚点迁移：memberImpressions 的 key 从**名字**改成 **QQ 号**，并把同一个人的多 | — |
| `mom-bot.mjs` | 妈妈回复进程（常驻）：轮询妈妈通道，发现小鲸鱼的新留言 → 以妈妈人设调 DeepSeek 回复。 | — |
| `patch-snowluma-sdk.mjs` | 修复 @snowluma 系列 npm 包的发布打包 bug：dist 内的相对导入缺少 .js 扩展名， | npm |
| `probe-send-quota.mjs` | 端到端验证「预占额度 → 发送失败 → 回滚」这条闭环。 | npm |
| `recall.mjs` | 按需检索：一句话 → 定位到"哪天说过、在哪个文件哪一行"。 | npm |
| `restart-bridge.mjs` | 重启桥，并且**在启动失败时把原因说出来**。 | npm |
| `send-test-group.mjs` | 向指定名称的 QQ 群发送一条测试消息（从桥接侧主动发送，验证 群聊 方向）。 | — |
| `set-api-key.mjs` | 换 API key：**默认只动小鲸鱼那份**，桌面版（你现在这个界面）一个字都不碰。 | npm |
| `setup-dsh.mjs` | setup-dsh.mjs — 在目标设备上安装 qq-bridge 的 DSH 端配置 | — |
| `split-console-domains.mjs` | 把 src/console/server.js 的路由链按域拆成 src/console/routes/*.js ——  | — |
| `split-console.mjs` | split-console.mjs —— 作用域分析工具 + 当年把 startConsoleServer 搬出 bri | — |
| `switch-provider.mjs` | 把小鲸鱼的模型从「DeepSeek 官方」切到「书生·端砚」网关（或一键回滚）。 | — |
| `test-aa-endpoint-heal.mjs` | 手机连接僵尸记录自愈的**端到端**测试（在临时 DSH_HOME 里造记录，不碰真实环境）。 | npm+selfcheck |
| `test-aa-health.mjs` | check-aa-sync.mjs 的端到端自检：用假日志目录跑真脚本，断言该报的和不该报的。 | npm+selfcheck |
| `test-admin-delegated.mjs` | 委派群管理员 · 端到端回归（不经 QQ，直接驱动 runAdminCommands）。 | npm+selfcheck |
| `test-console-routes.mjs` | 控制台路由冒烟测试 —— 契约：**每条路由都不能给出 5xx**。 | npm |
| `test-console-writes.mjs` | 控制台「写路由」的可逆端到端测试。 | npm |
| `test-console.mjs` | 控制台增强功能综合测试（node 直接调 API） | — |
| `test-effort-guard.mjs` | 验证"推理档位守卫"真的抓得住它要抓的东西（不是又一个没测过的守卫）。 | npm+selfcheck |
| `test-forward.mjs` | 合并转发消息能力自检脚本： | npm |
| `test-mcp-exec.mjs` | 测试 @snowluma/mcp 的 write 模式：模拟 DSH MCP 客户端完整握手 | — |
| `test-mcp-host.mjs` | 测试桥接自带的 snowluma-host MCP server（status/start/stop） | — |
| `test-mcp-safe.mjs` | 测试安全版 QQ MCP server：工具清单 + 白名单发送校验 | — |
| `test-mcp-web-search.mjs` | 测试安全 Web Search / Fetch MCP server： | — |
| `test-md-to-plain.mjs` | md-to-plain 纯函数回归测试（不依赖 SnowLuma / DSH / QQ）。 | npm |
| `test-onebot-connection.mjs` | 一次性连接测试：用 @snowluma/sdk 连接 SnowLuma 的 OneBot WebSocket 网关， | — |
| `test-qzone-post.mjs` | 说说链路的端到端验证（**手工跑，不进 selfcheck**）。 | npm |
| `test-slang-learn.mjs` | 黑话学习模块新增功能自检：sources 字段、深度研究 prompt、解析。 | npm |
| `test-stickers.mjs` | 表情包体系自检： | npm |
| `test-v2-wait.mjs` | 二代“对面没说完 / 结束前等待”逻辑测试。 | npm |
| `test-vision-media.mjs` | 视觉/图片链路自检脚本： | npm |
| `test-voice-out.mjs` | 语音输出自检（GSV 时代，2026-10-20 起）：worker 在线 + GSV 服务在线 + 合成成功 + 文本 | npm+selfcheck |
| `test-voice-transcribe.mjs` | 语音转写的端到端自检：拿一段真语音（SILK，7KB）跑本地工具，断言真的认出来了。 | npm+selfcheck |

## audit/

| 脚本 | 用途 | 接线 |
|---|---|---|
| `audit-cohort.mjs` | 按天分队列：看清「调优前 vs 调优后」的真实基线，以及各杠杆的现状值。 | npm |
| `audit-context.mjs` | 深挖：上下文是「回合内被工具调用撑大」还是「跨回合慢慢涨」？压缩是否伤缓存？ | npm |
| `audit-cost.mjs` | 成本审计：把「钱花在哪」拆到请求级 / 回合级 / 小时级，并统计空转回合。 | npm |
| `audit-floor.mjs` | 最后两个未知数：① 压缩后上下文能降到多低（地板）② agent/inbox/spliced 是什么 | npm |
| `audit-lib.mjs` | 成本/会话审计的公共核心：定位会话 → 解压 → 拆行 → 时间窗 → 输出头。 | — |
| `audit-memory-cost.mjs` | 记忆注入的实际成本占比：能不能靠"数据库+定向查找"省下来 | — |
| `audit-schema.mjs` | DSH 会话事件的结构勘察：每类事件多少行、平均/最大多长，并抽一条最大的 assistant 行看字段。 | — |
| `cost-by-day.mjs` | audit:cost —— 每天花了多少钱（她的运行 vs 黑话学习 vs 我的测试） | npm |
| `cost-by-hour.mjs` | 按**小时**看钱花在哪 —— 跨全部工作区（不只是 QQ 主工作区）。 | npm |
| `cost-calc.mjs` | 按 DeepSeek 官方单价计算实际花费 | — |
| `cost-since.mjs` | 按时间窗汇总成本：把"某个时刻之前 / 之后"的真实花费摆在一起比（跨所有会话文件）。 | npm |
| `cost-today.mjs` | 修正版：按 (turn, step) 去重 —— 每个 step 只取最后一次 usage（累积值） | npm |
| `effort-ab.mjs` | 推理等级对比（配对多跑）：her 模式 = 她的真实工作负载（群材料 + 唤醒提示）； | npm |
| `memory-rules.mjs` | 记忆纪律检查：找出**规范她"怎么说话/怎么处事"**的记忆条目（这些本不该进记忆）。 | npm |
| `participation-share.mjs` | 她的发言占比（关系健康度的一个硬指标）。 | npm |
| `persona-rehearsal.mjs` | 人设排练：用她的**真实材料** + `qq-chat-v2` 预设，喂几句测试消息，只看她打算怎么回。 | npm |
| `sessions.mjs` | 会话总账：列出所有会话的改动时间/大小，并标出 `main`（默认审计对象）与 `latest`。 | npm |
| `shadow-coverage.mjs` | 影子材料覆盖度核对：**组装出来的材料，有没有漏掉她现在实际能看到的东西**。 | npm |
| `stance-settle.mjs` | 关系/标签的**抽样审计**（只读）：她的关系判断没法单测（那是感受，不是函数）， | npm |
| `tool-calls-window.mjs` | 今早的工具调用统计（tool-calls.jsonl 里 time 是 ISO 字符串，按它过滤）。 | npm |
| `tool-census.mjs` | 步数普查：把"每回合 3.3 步"拆成"哪个工具 × 几次 × 多少成本"，并推算 B 方案（取消信息类工具）后的请求数 | npm |

## recon/

| 脚本 | 用途 | 接线 |
|---|---|---|
| `audit-anatomy.mjs` | bridge.js 解剖：函数清单 / 体积分布 / 重复概念 / 状态与配置面 | — |
| `audit-console.mjs` | R1 范围勘察：startConsoleServer 里到底装了什么 | — |
| `audit-console2.mjs` | R1 范围勘察 v2：用"全文件声明 ∩ 控制台内引用"算真实依赖，避免属性名污染 | — |
| `audit-consolidate.mjs` | 勘察"可整合项"：找出同一概念的多套实现、死掉的分支、重复的路由族 | — |
| `audit-target.mjs` | 目标模块划分：把 bridge.js 现有 191 个函数按职责归类，得出每个模块的真实体积 | — |
