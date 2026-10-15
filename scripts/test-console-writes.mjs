// 控制台「写路由」的可逆端到端测试。
//
// 与 test-console-routes.mjs 的分工：
//   · 那边：只读路由不许 5xx（外加发送闸门契约、活值检查）
//   · 这里：会改状态的写路由，一条条走
//           「读原值 → 改 → 断言真的改了 → 还原 → 断言真的还原了」
//
// ── 加新用例之前，先看这两条硬规矩 ──────────────────────────────────────────
//
// 1. **只收可逆的操作。**
//    发消息（/api/test-send）、推进已读水位线（/api/socialV2/mark-read）、各种 clear
//    都是不可逆的 —— 它们不该出现在能反复跑的测试里。需要验就单独做一次性探针，
//    别往这里塞（这也是为什么本文件只有两条用例，而不是把十几条写路由都列上）。
//
// 2. **「改动生效」和「还原成功」都必须被断言。**
//    · 只发请求不断言效果 = 假测试：路由 500 或者静默不生效，它照样"通过"；
//    · 只还原不断言 = 不知道还原成功没有，下次跑就从被污染的状态出发 ——
//      那正是"越跑越脏"的来源，也是这个文件存在的理由。
//
// ── 用例的形状 ─────────────────────────────────────────────────────────────
//
// 每个用例四个函数。`read()` 返回**既可比对、又能原样喂回写接口**的最小投影；
// 框架负责前后两次 read 的比对，所以用例自己不用写"还原校验"：
//
//   read    : () => 当前值（投影）
//   apply   : (orig) => 改成新值（发请求）
//   changed : (orig, now) => 是否真的变了
//   restore : (orig) => 写回 orig
//
// 用法：
//   npm run test:console:writes          # 需要桥在运行
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = process.env.CONSOLE_BASE || 'http://127.0.0.1:3100';

function readToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch { /* 回退到 state 里的自动令牌 */ }
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readToken();

async function api(method, routePath, body) {
  const headers = { 'x-console-token': TOKEN };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + routePath, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* 非 JSON 当空处理 */ }
  return { status: res.status, body: parsed };
}

/** 键名排序后的规范化字符串，用于比对（避免键序不同造成假失败）。 */
const canon = (v) => JSON.stringify(v, (key, val) =>
  val && typeof val === 'object' && !Array.isArray(val)
    ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
    : val);

/** 临时塞进白名单的测试群号：一旦因为异常留在配置里，一眼能认出来。 */
const TEST_GROUP = 999000001;

/**
 * 白名单 id 统一成字符串再比对。
 * 起因：`GET /api/whitelist` 返回的是内存里的 `cfg.allow` —— 桥启动时从文件加载是**字符串**，
 * 而 POST 走过 `toNum()` 之后变成**数字**。于是"改一次再还原"会让同一份配置前后类型不同，
 * 看上去像还原失败（其实 config.json 字节都没变）。这是**既有**的小不一致
 * （`allowed()` 里一律 `String(id)` 比较，所以不影响行为），这里只做归一化，不去改桥的逻辑。
 */
const ids = (arr) => (arr ?? []).map(String);

// ---------------------------------------------------------------- 用例

const CASES = [
  {
    name: '白名单：临时加一个测试群',
    route: 'POST /api/whitelist',
    read: async () => {
      const { allow, deny } = (await api('GET', '/api/whitelist')).body ?? {};
      return {
        allow: { private: ids(allow?.private), groups: ids(allow?.groups) },
        deny: { private: ids(deny?.private), groups: ids(deny?.groups) }
      };
    },
    apply: async (orig) => {
      const groups = [...new Set([...orig.allow.groups, String(TEST_GROUP)])];
      return api('POST', '/api/whitelist', { allow: { private: orig.allow.private, groups }, deny: orig.deny });
    },
    changed: (orig, now) => now.allow.groups.includes(String(TEST_GROUP))
      && !orig.allow.groups.includes(String(TEST_GROUP)),
    restore: async (orig) => api('POST', '/api/whitelist', { allow: orig.allow, deny: orig.deny })
  },
  {
    name: '安全拦截通知：翻转 interceptNotify',
    route: 'POST /api/security',
    read: async () => {
      const { security } = (await api('GET', '/api/security')).body ?? {};
      return { security };
    },
    apply: async (orig) => api('POST', '/api/security', { interceptNotify: !orig.security?.interceptNotify }),
    changed: (orig, now) => typeof orig.security?.interceptNotify === 'boolean'
      && now.security?.interceptNotify === !orig.security.interceptNotify,
    restore: async (orig) => api('POST', '/api/security', { interceptNotify: orig.security?.interceptNotify })
  }
];

// ---------------------------------------------------------------- 跑

let failed = 0;
const pass = () => console.log('');
const report = (okFlag, label, detail = '') => {
  if (!okFlag) failed += 1;
  console.log(`  ${okFlag ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
};

console.log('控制台写路由（可逆）');
console.log(`  目标 ${BASE}`);
console.log('');

for (const c of CASES) {
  console.log(`${c.name}  [${c.route}]`);
  let orig = null;
  try {
    orig = await c.read();
  } catch (e) {
    report(false, '读取原值', String(e?.message ?? e));
    pass();
    continue;
  }

  // 无论是断言失败还是抛错，**一定**尝试还原 —— 这是本文件唯一不能省的结构。
  let mutateStatus = 0;
  let now = null;
  let err = null;
  try {
    const res = await c.apply(orig);
    mutateStatus = res.status;
    now = await c.read();
    report(c.changed(orig, now), '改动生效', canon(orig) === canon(now) ? '值没变' : '');
  } catch (e) {
    err = e;
    report(false, '改动生效', String(e?.message ?? e));
  } finally {
    try {
      const res = await c.restore(orig);
      if (res.status >= 500) report(false, '还原请求', `HTTP ${res.status}`);
    } catch (e) {
      report(false, '还原请求', String(e?.message ?? e));
    }
  }

  if (!err) {
    let final = null;
    try {
      final = await c.read();
    } catch (e) {
      report(false, '还原后读取', String(e?.message ?? e));
    }
    if (final) {
      const restored = canon(final) === canon(orig);
      report(restored, '还原成功', restored ? '' : `\n      原值 ${canon(orig)}\n      现值 ${canon(final)}`);
    }
  }
  if (mutateStatus >= 500) report(false, '写接口没 5xx', `HTTP ${mutateStatus}`);
  pass();
}

console.log(`失败 ${failed} 条`);
if (failed) {
  console.error('❌ 有写路由用例失败 —— 若"还原成功"是红的，先去 config.json 人工核对再重跑。');
  process.exit(1);
}
console.log('✅ 全部通过，且状态已还原');
