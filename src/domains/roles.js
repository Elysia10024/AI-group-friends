// 角色状态文件域：从 bridge.js 的模块级整体搬出来的一个"簇"（4 个互相调用的函数）。
//
// 搬出来的理由：bridge.js 是个巨型文件（main() 曾占 86%），想读这一段得跨过整个文件。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且**在构造点之前**声明的名字走解构；
//   · **可写的**和**在构造点之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）；
//   · 被更早的构造点引用的名字，在那个更早的构造处要包 thunk（`name: (...a) => name(...a)`）。
//
// 正文与搬迁前**逐字相同**，只有上述 0 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
export function createRolesModule(ctx) {
  const {
    ROLE_STATE_FILE,
    ROOT,
    atomicWriteJson,
    fs,
    path,
    readJsonSafe,
  } = ctx;


function listRoles() {
  try {
    const dir = path.join(ROOT, 'roles');
    const files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !['README.md', 'CHANGELOG.md'].includes(f) && !f.startsWith('_'))
      .map((f) => f.slice(0, -3));
    // 模块化角色是**目录**（roles/<名字>/core.md）：控制台/指令要把它们一起列出来，
    // 否则"小鲸鱼"这种目录式角色会在面板上凭空消失（2026-09-30 踩过）。
    const dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'core.md')))
      .map((d) => d.name);
    return [...new Set([...files, ...dirs])].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

/** 角色是否存在：目录式（<名字>/core.md）或单文件式（<名字>.md）都算。 */
function roleExists(name) {
  const safe = String(name ?? '').trim();
  if (!safe || /[\\/]/.test(safe) || safe === '.' || safe === '..') return false;
  return fs.existsSync(path.join(ROOT, 'roles', safe, 'core.md')) || fs.existsSync(path.join(ROOT, 'roles', safe + '.md'));
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  const prev = readRoleState();
  const nextRole = role ?? null;
  const next = { role: nextRole, mode: mode ?? 'active' };
  if (prev?.role !== nextRole) {
    // 角色切换：记住上一个角色。材料里要用它提醒"你刚才在扮演 X"，
    // 否则切回小鲸鱼后她会把扮演时说过的话当成自己说过的（2026-10-19 主人要求）。
    next.previous = prev?.role ?? null;
    next.switchedAt = Date.now();
  } else {
    // 模式切换（active/silent）不算角色切换，保留原记录
    if (prev?.previous !== undefined) next.previous = prev.previous;
    if (prev?.switchedAt !== undefined) next.switchedAt = prev.switchedAt;
  }
  atomicWriteJson(ROLE_STATE_FILE, next);
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}


  return { listRoles, roleExists, readRoleState, writeRoleState, sanitizeRoleName };
}
