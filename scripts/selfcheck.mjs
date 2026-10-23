// selfcheck —— 一条命令跑完所有守卫，给人看一行结论（给 watchdog 每天调用）
//
//   npm run selfcheck        （跑测试 + 全部 check:* + doctor）
//   npm run selfcheck -- --quick   （跳过 npm test，只跑守卫，适合 watchdog 每天跑）
//
// 退出码：0 全绿；1 有红的（watchdog 会把它写进日志，并在有异常时提醒管理员）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const ROOT = '<项目根>';
const QUICK = process.argv.includes('--quick');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const STEPS = [
  ...(QUICK ? [] : [['测试', [npm, 'test']]]),
  ['规则层', ['node', 'scripts/check-rules.mjs']],
  ['幽灵工具引用', ['node', 'scripts/check-tool-refs.mjs']],
  ['模块 ctx', ['node', 'scripts/check-module-ctx.mjs']],
  // 控制台路由的 ctx 接线（静态）：路由从 ctx 解构、而 bridge 的 startConsoleServer 没传，
  // 症状是那几条路由 500 —— 2026-09 发送通道整体坏掉就是这么坏的，而 check:mcp-tools /
  // check:tool-token 都验不到它（它们验的是工具发的请求，不是路由手里的名字）。
  ['控制台 ctx 接线', ['node', 'scripts/console-ctx-audit.mjs']],
  ['前端金标准', ['node', 'scripts/check-console-ui.mjs']],
  ['工具开关', ['node', 'scripts/check-tool-flags.mjs']],
  // 工具令牌接线：2026-10-06 语音工具把 token 只放进了 body，而 /api/socialV2/* 看的是
  // x-agent-token 头 —— 她真去群里发语音时被 403 挡回来，连试两次只好改发文字。
  // 这条把每个 handler 真发的请求抓出来看头/体，专治"说明里写了、代码里没接"。
  ['工具令牌接线', ['node', 'scripts/check-tool-token.mjs']],
  // 工具说明与 schema 的一致性：2026-10-13 抓到 qq_memory_append 的说明教她写 `extra.relation` /
  // `extra.tag`，而 schema 里没这两个键 —— zod 对未声明的键是**静默丢掉**：她试过 8 次写标签，
  // 一条都没落库（改关系更是一次没生效过）。这条专治"说明里承诺了、schema 里没有"。
  ['工具 schema', ['node', 'scripts/check-tool-schema.mjs']],
  // 引用解析接线：2026-10-06 语音路由漏了 seq→message id 的解析，她传本地 seq 时
  // 群里显示"引用的消息无法定位"、语音也看不见。这条盯着"读了引用就必须解析"。
  ['引用解析接线', ['node', 'scripts/check-reply-resolve.mjs']],
  // 关系规则文档（docs/关系升降档规则.md）是给主人看的人话版规格：它引的档位名/上限/硬边界
  // 必须在代码与人格里真的成立。关系这条链路曾经静默坏过一次（schema 吞字段，11 天没人发现），
  // 所以让文档也进守卫：改人设或改上限时，它会提醒你同步文档。
  ['关系规则文档', ['node', 'scripts/check-relation-doc.mjs']],
  // 会话归档新鲜度：归档是"给压缩后的我用的记忆"，落后于现实就会误导人 —— 比没有归档更糟。
  // 判据：最新会话活动 vs 最后归档日期（差 >7 天就红）。自检钩子见脚本头（ARCHIVE_FAKE_SESSION_DAY）。
  ['会话归档新鲜度', ['node', 'scripts/check-archive.mjs']],
  // 档案新鲜度：`docs/小鲸鱼档案.md` 的「现状速览」是**生成块**（tools/bridge-facts.mjs），
  // 但生成块不会自己变新 —— 忘了 --write 它就悄悄过期（那份档案已经烂过 27 天，还写着"傲娇"）。
  // 工具不在时这条**报红而不是跳过**：本仓有过"守卫指向的路径悄悄失效、连续 12 天报绿"的教训。
  ['档案新鲜度', ['node', 'scripts/check-dossier.mjs']],
  // 启动脚本编码：2026-10-03 看门狗因为"UTF-8 无 BOM + PS 5.1 按 GBK 读"整整一天没干活，
  // 而且全链路安静。这条守卫专门盯住那个坑（详见 scripts/check-launchers.mjs 注释）。
  ['启动脚本编码', ['node', 'scripts/check-launchers.mjs']],
  // 管理指令的**接线**（不是纯函数判据）：2026-10-03 委派群管理员有四处各坏各的、
  // 单测全绿也照样跑不通，所以把这条端到端脚本挂进体检，每天都会被跑一遍。
  ['管理指令接线', ['node', 'scripts/test-admin-delegated.mjs']],
  // 手机连接巡检器本身也要每天被验一次：2026-10-05 那次手机连接静默卡死两个多小时没人知道，
  // 告警器如果自己坏了，下次还是静默（详见 scripts/check-aa-sync.mjs 顶部注释）。
  ['手机连接巡检', ['node', 'scripts/test-aa-health.mjs']],
  // 手机连接的"僵尸端点记录"：2026-10-08 AA 起不来、面板报「本机连接被占用」、**重启也没用** ——
  // endpoint.json 里记的 pid 被 Windows 回收给了别的进程，AA 就永远以为"另一个 DSH 占着连接"。
  // 第一条只读（有僵尸记录就红，说明自愈没生效）；第二条在临时目录里真跑一遍自愈的全套动作。
  ['手机连接·僵尸记录', ['node', 'scripts/check-aa-endpoint.mjs']],
  ['僵尸记录自愈自检', ['node', 'scripts/test-aa-endpoint-heal.mjs']],
  // 推理档位：2026-10-05 之前 config.json=low / 代码默认=max / 一条守卫断言=max 三处打架，
  // 那条断言长期是红的也没人知道。现在档位只有一个来源，这两条盯着它（含守卫自身的自检）。
  ['推理档位', ['node', 'scripts/check-effort-config.mjs']],
  ['档位守卫自检', ['node', 'scripts/test-effort-guard.mjs']],
  // 语音转写（她的"耳朵"）：失败会静默退回 [语音]，所以必须每天真的转一条来证明它还在工作。
  ['语音转写', ['node', 'scripts/test-voice-transcribe.mjs']],
  // 语音输出（她的"嘴"）：常驻 TTS worker 挂了、配置被改坏、句尾轻声/问句上扬丢了，
  // 现象都是"她还是正常回文字，只是永远不发语音"——同样必须每天真的合一条来证明。
  ['语音输出', ['node', 'scripts/test-voice-out.mjs']],
  // 嗓音配方本身：her-voice.json 写坏（比如 JSON 里混进 ASCII 双引号）不会有任何报错，
  // worker 一重启她就哑了。2026-10-06 我自己踩过一次，所以让它每天红一次。
  ['嗓音配方', ['node', 'scripts/check-voice-spec.mjs']],
  ['一键体检', ['node', 'scripts/doctor.mjs']]
];

const rows = [];
let bad = 0;
for (const [name, cmd] of STEPS) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const failed = r.status !== 0;
  if (failed) bad += 1;
  // 抓一行最有信息量的摘要
  const line = out.split('\n').map((l) => l.trim()).filter((l) => l && !/^>|^$/.test(l)).slice(-1)[0] ?? '';
  rows.push({ name, ok: !failed, line: line.slice(0, 100) });
}

const at = new Date().toLocaleString('zh-CN');
const head = `=== selfcheck ${at}${QUICK ? '（quick）' : ''} ===`;
console.log(head);
for (const r of rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.name.padEnd(12, ' ')} ${r.line}`);
console.log(bad ? `\n❌ ${bad} 项没过 —— 去看上面的明细。` : '\n✅ 全部通过。');

// 留一份滚动日志（watchdog 用它判断"今天体检过没有"）
try {
  fs.appendFileSync('<项目根>/logs/selfcheck.log', `${head}\n${rows.map((r) => `  ${r.ok ? 'OK  ' : 'FAIL'} ${r.name}: ${r.line}`).join('\n')}\n\n`, 'utf8');
} catch { /* 日志写不了不影响结论 */ }

process.exit(bad ? 1 : 0);
