// check-aa-sync.mjs 的端到端自检：用假日志目录跑真脚本，断言该报的和不该报的。
//
// 为什么要有它：告警器本身没被测过 = 下次出事时它可能一声不响（2026-10-05 的教训）。
//   node scripts/test-aa-health.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, 'check-aa-sync.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-health-'));

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const stop = (minutesAgo, seq = 61) => JSON.stringify({ time: iso(minutesAgo), pid: 1, level: 'info', event: 'sync.stopped', streamId: `s${minutesAgo}`, batchSeq: seq, waitingAck: seq });
const started = (minutesAgo) => JSON.stringify({ time: iso(minutesAgo), pid: 1, level: 'info', event: 'sync.started', streamId: `s${minutesAgo}` });
const completed = (minutesAgo) => JSON.stringify({ time: iso(minutesAgo), pid: 1, level: 'info', event: 'snapshot.completed', sessionId: 'session-x', items: 12, elapsedMs: 300 });
const inventoryDone = (minutesAgo) => JSON.stringify({ time: iso(minutesAgo), pid: 1, level: 'info', event: 'sync.inventory_completed', streamId: `s${minutesAgo}` });

function fixture(name, { runtime = [], connector = [{ time: iso(5), event: 'running' }] } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'dsh-runtime.jsonl'), `${runtime.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'logs', 'connector.jsonl'), `${connector.map((c) => JSON.stringify(c)).join('\n')}\n`, 'utf8');
  return dir;
}

function run(dir) {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, AA_HOME: dir } });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

let failed = 0;
function expect(label, condition, detail = '') {
  console.log(`${condition ? '  PASS  ' : '  FAIL  '}${label}${detail ? `  [${detail}]` : ''}`);
  if (!condition) failed += 1;
}

console.log('1) 事故指纹：20 分钟里 4 次重订阅、0 次成功提交 → 必须报');
{
  const dir = fixture('churn', { runtime: [started(18), stop(17), started(9), stop(8), started(5), stop(4), started(1), stop(0.5)] });
  const { code, out } = run(dir);
  expect('退出码 1', code === 1, `exit=${code}`);
  expect('报出同步卡死', out.includes('同步卡死'), out.split('\n')[0]);
  expect('给出重订阅次数', /4 次重订阅/.test(out), out.split('\n')[1]);
}

console.log('2) 同样有重订阅，但提交成功过 → 不报（重启时的正常抖动）');
{
  const dir = fixture('recovered', { runtime: [started(18), stop(17), started(9), stop(8), started(5), completed(4.5), started(1), stop(0.5)] });
  const { code, out } = run(dir);
  expect('退出码 0', code === 0, `exit=${code}`);
  expect('输出正常', out.includes('正常'), out.trim());
}

console.log('3) 清单同步走完过 → 不报');
{
  const dir = fixture('inventory', { runtime: [started(18), stop(17), started(9), stop(8), started(5), inventoryDone(4), stop(1)] });
  const { code } = run(dir);
  expect('退出码 0', code === 0, `exit=${code}`);
}

console.log('4) 老日志（窗口外）不计入 → 不报');
{
  const dir = fixture('stale', { runtime: [started(90), stop(89), started(70), stop(69), started(50), stop(49)] });
  const { code } = run(dir);
  expect('退出码 0', code === 0, `exit=${code}`);
}

console.log('5) 凭据失效 → 必须报');
{
  const dir = fixture('auth', { runtime: [completed(3)], connector: [{ time: iso(30), event: 'starting' }, { time: iso(29), event: 'running' }, { time: iso(10), event: 'auth_failed' }] });
  const { code, out } = run(dir);
  expect('退出码 1', code === 1, `exit=${code}`);
  expect('报出凭据失效', out.includes('凭据失效'), out.split('\n')[0]);
}

console.log('6) 一切正常 → 安静');
{
  const dir = fixture('healthy', { runtime: [started(30), completed(29), JSON.stringify({ time: iso(2), pid: 1, level: 'debug', event: 'sync.batch', streamId: 's1', batchSeq: 9, operations: 1, kinds: 'notifications' })] });
  const { code, out } = run(dir);
  expect('退出码 0', code === 0, `exit=${code}`);
  expect('无告警字样', !/❌|⚠️/.test(out), out.trim());
}

console.log('7) 告警发不出去时不假装报过（用死端口，不动真实 config.json）');
{
  const dir = fixture('throttle', { runtime: [started(5), stop(4), started(3), stop(2), started(1), stop(0.5)] });
  const stateFile = path.join(__dirname, '..', 'logs', 'aa-health.state.json');
  const logFile = path.join(__dirname, '..', 'logs', 'aa-health.log');
  const before = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').length : 0;
  fs.rmSync(stateFile, { force: true });   // 清掉上一轮留下的节流状态，保证这次真的会尝试发送
  try {
    const r1 = spawnSync(process.execPath, [SCRIPT, '--alert'], {
      encoding: 'utf8',
      env: { ...process.env, AA_HOME: dir, AA_ALERT_HTTP_URL: 'http://127.0.0.1:9' },
    });
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    expect('--alert 失败时不假装报过（lastAlertAt 保持空）', !state.lastAlertAt && state.lastSendError, JSON.stringify(state).slice(0, 120));
    expect('退出码 1（有问题）', r1.status === 1, `exit=${r1.status}`);
    const log = fs.readFileSync(logFile, 'utf8').slice(before);
    expect('留下 ALERT-FAILED 记录', log.includes('ALERT-FAILED'), log.trim().split('\n').slice(-1)[0]);
  } finally {
    fs.rmSync(stateFile, { force: true });
  }
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
