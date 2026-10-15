// 手机连接僵尸记录自愈的**端到端**测试（在临时 DSH_HOME 里造记录，不碰真实环境）。
//
// 为什么要有它：判定逻辑的单测在 src/core/aa-endpoint.test.js 里，但那只是纯函数；这条测的是
// "真的会去看文件、真的会去查进程、真的只在能证明时才改名归档"——2026-10-08 那次事故的自愈能力。
//
//   node scripts/test-aa-endpoint-heal.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queryProcess } from './check-aa-endpoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'check-aa-endpoint.mjs');
let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
  if (!ok) failed += 1;
};
const run = (home, ...args) => {
  const r = spawnSync(process.execPath, [SCRIPT, `--home=${home}`, ...args], { encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const writeEndpoint = (home, obj, { ageMinutes = 0 } = {}) => {
  const dir = path.join(home, 'agents-anywhere', 'bridge');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'endpoint.json');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  if (ageMinutes > 0) {
    const when = new Date(Date.now() - ageMinutes * 60_000);
    fs.utimesSync(file, when, when);
  }
  return file;
};
const archives = (home) => fs.readdirSync(path.join(home, 'agents-anywhere', 'bridge')).filter((f) => f.startsWith('endpoint.json.stale-'));

/** 找一个确实不存在的 pid（用同一个查询函数确认，避免猜）。 */
function findDeadPid() {
  for (let pid = 900000; pid < 900200; pid += 1) {
    const { proc, error } = queryProcess(pid, { timeoutMs: 15000 });
    if (!error && proc === null) return pid;
  }
  throw new Error('找不到一个"确定不存在"的 pid');
}

console.log('=== 手机连接端点自愈 · 端到端 ===\n');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-endpoint-test-'));
console.log(`临时 DSH_HOME：${root}\n`);

// ---------- 1) 只读模式：发现僵尸记录但不许动 ----------
console.log('--- 1. 只读模式（--heal 缺席）不能改任何东西 ---');
const home1 = path.join(root, 'home-readonly');
const deadPid = findDeadPid();
const f1 = writeEndpoint(home1, { version: 1, host: '127.0.0.1', port: 49936, token: 'tok', pid: deadPid }, { ageMinutes: 30 });
const before1 = fs.readFileSync(f1, 'utf8');
const r1 = run(home1);
check('退出码 1（有僵尸记录）', r1.code === 1, `code=${r1.code}`);
check('提示要加 --heal', /--heal/.test(r1.out));
check('文件原封不动', fs.existsSync(f1) && fs.readFileSync(f1, 'utf8') === before1);
check('没有产生归档', archives(home1).length === 0);

// ---------- 2) owner-gone：pid 不存在 → 清理 ----------
console.log('\n--- 2. 记录的 pid 已经不存在 → 自愈 ---');
const home2 = path.join(root, 'home-owner-gone');
const f2 = writeEndpoint(home2, { version: 1, host: '127.0.0.1', port: 49936, token: 'tok', pid: deadPid }, { ageMinutes: 30 });
const r2 = run(home2, '--heal');
check('退出码 0', r2.code === 0, `code=${r2.code}`);
check('第一行是 HEALED owner-gone', /^HEALED owner-gone/m.test(r2.out), r2.out.split('\n')[0]);
check('原文件已清掉', !fs.existsSync(f2));
const arch2 = archives(home2);
check('留下了一份归档', arch2.length === 1, arch2.join(','));
check('归档内容与原件一致', arch2.length === 1 && fs.readFileSync(path.join(home2, 'agents-anywhere', 'bridge', arch2[0]), 'utf8') === before1);
check('再跑一次是"没有记录"（幂等）', /^OK no-endpoint-file/m.test(run(home2, '--heal').out));

// ---------- 3) pid-reused：进程比文件晚启动 → 清理（今天那个坑的形态） ----------
console.log('\n--- 3. pid 被回收（进程比文件晚启动）→ 自愈 ---');
const home3 = path.join(root, 'home-pid-reused');
const sleeper = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 90'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));   // 等它起来
const f3 = writeEndpoint(home3, { version: 1, host: '127.0.0.1', port: 49936, token: 'tok', pid: sleeper.pid }, { ageMinutes: 10 });
const r3 = run(home3, '--heal');
check('退出码 0', r3.code === 0, `code=${r3.code}`);
check('第一行是 HEALED pid-reused', /^HEALED pid-reused/m.test(r3.out), r3.out.split('\n')[0]);
check('原文件已清掉', !fs.existsSync(f3));
check('归档名里带 pid 和原因', archives(home3).some((n) => n.includes(`pid${sleeper.pid}`) && n.includes('pid-reused')), archives(home3).join(','));
sleeper.kill();

// ---------- 4) 活记录：绝不碰 ----------
console.log('\n--- 4. 活记录（本进程写的，进程还活着且早于文件）→ 不碰 ---');
const home4 = path.join(root, 'home-live');
const f4 = writeEndpoint(home4, { version: 1, host: '127.0.0.1', port: 49936, token: 'tok', pid: process.pid });
const before4 = fs.readFileSync(f4, 'utf8');
const r4 = run(home4, '--heal');
check('退出码 0', r4.code === 0, `code=${r4.code}`);
check('第一行是 OK owner-alive', /^OK owner-alive/m.test(r4.out), r4.out.split('\n')[0]);
check('文件一个字节都没动', fs.existsSync(f4) && fs.readFileSync(f4, 'utf8') === before4);
check('没有产生归档', archives(home4).length === 0);

// ---------- 5) 坏内容：刚写坏的先不动，老过 2 分钟才清 ----------
console.log('\n--- 5. 内容坏掉 ---');
const home5 = path.join(root, 'home-broken');
const dir5 = path.join(home5, 'agents-anywhere', 'bridge');
fs.mkdirSync(dir5, { recursive: true });
const f5 = path.join(dir5, 'endpoint.json');
fs.writeFileSync(f5, '{"pid":', 'utf8');
const fresh = run(home5, '--heal');
check('刚写坏的：先等（WAIT）', /^WAIT unparseable-fresh/m.test(fresh.out), fresh.out.split('\n')[0]);
const when = new Date(Date.now() - 10 * 60_000);
fs.utimesSync(f5, when, when);
const old = run(home5, '--heal');
check('老过 2 分钟的：清掉（HEALED unparseable）', /^HEALED unparseable/m.test(old.out), old.out.split('\n')[0]);
check('原文件已清掉', !fs.existsSync(f5));

// ---------- 6) 没有文件：什么都不做 ----------
console.log('\n--- 6. 没有记录 ---');
const r6 = run(path.join(root, 'home-empty'), '--heal');
check('退出码 0 且 OK no-endpoint-file', r6.code === 0 && /^OK no-endpoint-file/m.test(r6.out), r6.out.split('\n')[0]);

fs.rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n❌ ${failed} 项没过` : '\n✅ 全部通过（只读不动手、能证明才清、活记录绝不碰、幂等）');
process.exit(failed ? 1 : 0);
