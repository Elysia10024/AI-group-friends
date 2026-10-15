// 委派群管理员 · 端到端回归（不经 QQ，直接驱动 runAdminCommands）。
//
// 为什么要有这个脚本：2026-10-03 用户要「让新群里的朋友当那个群的管理员」，
// 功能写完之后有**四处**各自独立地坏了，全都只在真实点击时才会暴露：
//   ① 群里下指令时拿"会话号（群号）"当执行者去查名单 → 委派管理员永远查不到自己，全被拒；
//   ② 静音分支写死 isOwner=true → 委派管理员拿到 owner 权限（/role、/reset 全放行）；
//   ③ /安静、/恢复 落进订阅分支 → /恢复 回一句"用法：/订阅…"，群被关掉就再没人能打开；
//   ④ owner 分支引用了不存在的 idLabel / 未注入的 log → 主人自己用 /安静 直接抛 ReferenceError。
// 纯函数单测（src/core/group-admin.test.js）只能证明"判据对"，证明不了"接线对"——
// 这个脚本补的就是接线。跑法：node scripts/test-admin-delegated.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { createAdminCommandsModule } from '../src/domains/admin-commands.js';
import { createModeModule } from '../src/domains/mode.js';
import { createIdsModule } from '../src/ids.js';

const CFG = {
  ownerQQ: '10000001',
  allow: { private: ['10000001'], groups: ['20000003', '20000001'] },
  deny: { private: [], groups: [] },
  groupAdmins: { 20000003: ['2669073185'] },
};

let failures = 0;
let cases = 0;

function harness() {
  const states = new Map();
  const out = [];
  const logs = [];
  const roleWrites = [];
  const getSocialV2State = (key) => {
    if (!states.has(key)) {
      states.set(key, { muted: false, wakeConfig: { triggers: { speakerIds: [] } }, recentMessages: [] });
    }
    return states.get(key);
  };
  const mod = createAdminCommandsModule({
    ROOT: 'E:\\ai群友\\qq-bridge-main',
    ctx: { sessionEpoch: 0 },
    fs: { existsSync: () => false },
    getSocialV2State,
    groupMemberNameCache: new Map(),
    log: (...a) => logs.push(a.join(' ')),
    readRoleState: () => ({ role: '小鲸鱼', mode: 'active' }),
    resolveGroupMemberName: async () => null,
    saveSocialV2State: () => {},
    saveState: () => {},
    sendToQQ: async (key, text) => { out.push({ key, text: String(text) }); },
    social: { recentMessages: new Map(), states: new Map(), silentTurns: new Set() },
    socialV2: { conversations: new Map() },
    state: { sessions: {} },
    writeRoleState: (role, mode) => roleWrites.push({ role, mode }),
  });
  return { run: mod.runAdminCommands, states, out, logs, roleWrites, state: (k) => getSocialV2State(k) };
}

async function check(name, fn) {
  cases++;
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures++;
    console.log(`  ❌ ${name}\n     ${error?.message ?? error}`);
  }
}

const GKEY = 'group:20000003';
const ADMIN = '2669073185';
const STRANGER = '10001';
const OWNER = '10000001';

console.log('\n=== 委派群管理员 · 接线回归 ===\n');

await check('群里 /安静：关的是这个群，回执发在群里', async () => {
  const h = harness();
  const handled = await h.run(CFG, '20000003', false, GKEY, 'group', '/安静', { role: '小鲸鱼', mode: 'active' }, true, ADMIN);
  assert.equal(handled, true, '应该被管家接管');
  assert.equal(h.state(GKEY).muted, true, '群应该被静音');
  assert.equal(h.out.at(-1)?.key, GKEY, '回执应该发在群里');
  assert.match(h.logs.join('\n'), /委派管理员 2669073185.*quiet/, '日志要写清是谁、执行的哪条');
});

await check('群里 /恢复：能把自己关掉的群开回来（不能是单向陷阱）', async () => {
  const h = harness();
  h.state(GKEY).muted = true;
  const handled = await h.run(CFG, '20000003', false, GKEY, 'group', '/恢复', { role: '小鲸鱼', mode: 'active' }, true, ADMIN);
  assert.equal(handled, true);
  assert.equal(h.state(GKEY).muted, false, '群应该恢复');
  assert.doesNotMatch(h.out.at(-1).text, /用法：\/订阅/, '不能掉进订阅分支');
});

await check('群里 /role off：委派管理员拿不到 owner 权限', async () => {
  const h = harness();
  const handled = await h.run(CFG, '20000003', false, GKEY, 'group', '/role off', { role: '小鲸鱼', mode: 'active' }, true, ADMIN);
  assert.equal(handled, true);
  assert.equal(h.roleWrites.length, 0, '不许改角色');
  assert.match(h.out.at(-1).text, /只有主人/);
});

await check('非管理员在群里 /安静：被拒，且群里没被静音', async () => {
  const h = harness();
  await h.run(CFG, '20000003', false, GKEY, 'group', '/安静', { role: '小鲸鱼', mode: 'active' }, true, STRANGER);
  assert.equal(h.state(GKEY).muted, false);
  assert.match(h.out.at(-1).text, /不是被授权的群管理员/);
});

await check('主人 /安静：照常生效（抓 log/idLabel 那类未定义引用）', async () => {
  const h = harness();
  const handled = await h.run(CFG, '20000003', true, GKEY, 'group', '/安静', { role: '小鲸鱼', mode: 'active' }, true, OWNER);
  assert.equal(handled, true);
  assert.equal(h.state(GKEY).muted, true);
});

await check('私聊 /安静 不带群号：拒绝（避免误伤）', async () => {
  const h = harness();
  await h.run(CFG, ADMIN, false, `private:${ADMIN}`, 'private', '/安静', { role: '小鲸鱼', mode: 'active' }, false, ADMIN);
  assert.match(h.out.at(-1).text, /要带群号/);
});

await check('私聊 /安静 20000001：拒绝（不是他管的群）', async () => {
  const h = harness();
  await h.run(CFG, ADMIN, false, `private:${ADMIN}`, 'private', '/安静 20000001', { role: '小鲸鱼', mode: 'active' }, false, ADMIN);
  assert.equal(h.state('group:20000001').muted, false);
  assert.match(h.out.at(-1).text, /不归你管/);
});

await check('私聊 /安静 20000003：关他那个群，回执回私聊', async () => {
  const h = harness();
  await h.run(CFG, ADMIN, false, `private:${ADMIN}`, 'private', '/安静 20000003', { role: '小鲸鱼', mode: 'active' }, false, ADMIN);
  assert.equal(h.state(GKEY).muted, true);
  assert.equal(h.out.at(-1).key, `private:${ADMIN}`, '回执不该发到群里');
});

await check('群里的自然语言（没点名）：不接管，交给模型当闲聊', async () => {
  const h = harness();
  const handled = await h.run(CFG, '20000003', false, GKEY, 'group', '这个群安静一下', { role: '小鲸鱼', mode: 'active' }, false, ADMIN);
  assert.equal(handled, false);
  assert.equal(h.state(GKEY).muted, false);
});

await check('私聊 /订阅列表：委派管理员能用', async () => {
  const h = harness();
  const handled = await h.run(CFG, ADMIN, false, `private:${ADMIN}`, 'private', '/订阅列表', { role: '小鲸鱼', mode: 'active' }, false, ADMIN);
  assert.equal(handled, true);
  assert.match(h.out.at(-1).text, /当前订阅/);
});

// ── 准入：委派管理员的私聊要放行（他选了"完整私聊"），陌生人依旧被挡 ──────────────
const modeMod = createModeModule({
  STATE_DIR: 'x',
  VALID_MODES: ['reserved2', 'closed-agent'],
  allowed: createIdsModule({}).allowed,
  api: { settings: { describe: async () => ({ namespaces: [] }) } },
  log: () => {},
  memberName: () => '',
  mentionsAlias: () => false,
  cfg: CFG,
  normalizeOwnerQQ: createIdsModule({}).normalizeOwnerQQ,
  path,
  readJsonSafe: () => null,
  selfAliases: () => [],
  unwrap: (x) => x,
});

await check('准入：被委派的管理员私聊能进（完整私聊），陌生人不能', async () => {
  assert.equal(modeMod.modeAllowed(`private:${ADMIN}`, 'private', ADMIN, CFG, 'reserved2'), true);
  assert.equal(modeMod.modeAllowed('private:99999', 'private', '99999', CFG, 'reserved2'), false, '没授权的人私聊照样被丢掉');
  assert.equal(modeMod.modeAllowed(GKEY, 'group', '20000003', CFG, 'reserved2'), true, '白名单群照常');
});

await check('准入：从名单里删掉 = 私聊立刻回到未授权（fail-closed）', async () => {
  const empty = { ...CFG, groupAdmins: {} };
  assert.equal(modeMod.modeAllowed(`private:${ADMIN}`, 'private', ADMIN, empty, 'reserved2'), false);
});

await check('准入：封闭 agent 模式仍然只认主人私聊', async () => {
  assert.equal(modeMod.modeAllowed(`private:${ADMIN}`, 'private', ADMIN, CFG, 'closed-agent'), false);
  assert.equal(modeMod.modeAllowed(`private:${OWNER}`, 'private', OWNER, CFG, 'closed-agent'), true);
});

console.log(`\n${failures ? '❌' : '✅'} 委派群管理员接线：${cases - failures}/${cases} 通过\n`);
process.exit(failures ? 1 : 0);
