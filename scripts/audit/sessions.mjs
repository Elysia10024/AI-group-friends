// 会话总账：列出所有会话的改动时间/大小，并标出 `main`（默认审计对象）与 `latest`。
//
// 为什么需要它：小鲸鱼的账单**分散在多个 DSH 会话里**（桥按 QQ 会话建 DSH 会话），
// 而原来的审计脚本全部写死一个 SID —— 只看一个会话就可能漏掉别的会话的开销。
// 先看清"到底有几个会话、各自多大、多久没动"，再决定要不要做跨会话汇总。
//
// 用法：node scripts/audit/sessions.mjs [--workspace <子串>] [--deep]
//   --deep  顺带解压，统计每个会话的 assistant/message 请求数（慢，17MB 级会话约数秒）
import {
  listSessions, decompressSession, MAIN_WORKSPACE, SESSIONS_ROOT,
} from './audit-lib.mjs';

const args = process.argv.slice(2);
const deep = args.includes('--deep');
const wsAt = args.indexOf('--workspace');
const workspace = wsAt >= 0 ? args[wsAt + 1] : null;

const all = listSessions({ workspace });
if (!all.length) {
  console.log(`没找到会话（root=${SESSIONS_ROOT}${workspace ? `, workspace~${workspace}` : ''}）`);
  process.exit(1);
}
const mainHit = all.find((s) => s.workspace.includes(MAIN_WORKSPACE));

console.log(`会话根: ${SESSIONS_ROOT}`);
console.log(`共 ${all.length} 个会话${workspace ? `（workspace 含 "${workspace}"）` : ''}；下面按改动时间倒序\n`);
console.log('  标记   ' + '会话 id'.padEnd(46) + '工作区（去掉共同前缀）'.padEnd(40) + '大小'.padStart(9) + '  改于(UTC)');
for (const s of all) {
  const mark = s === mainHit ? '←main' : (s === all[0] ? '←latest' : '');
  const size = (s.size / 1048576).toFixed(1) + ' MB';
  const mtime = new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
  let extra = '';
  if (deep) {
    const text = decompressSession(s.file);
    const reqs = text.split('\n').filter((l) => l.includes('"usage"')).length;
    extra = `  请求≈${reqs}`;
  }
  console.log(`  ${mark.padEnd(8)}${s.sid.padEnd(46)}${s.workspace.replace('--E-ai~7FA4~53CB-', '').padEnd(40)}${size.padStart(9)}  ${mtime}${extra}`);
}
const totalMb = all.reduce((a, s) => a + s.size, 0) / 1048576;
console.log(`\n合计 ${totalMb.toFixed(1)} MB。`);
console.log(`默认审计对象 = main = ${mainHit ? mainHit.sid : '(未找到，请用 --session latest)'}`);
console.log('注意：这只是「文件层面」的清单；跨会话的金额汇总还没有做（需要按会话分别跑 audit:cost 再相加）。');
