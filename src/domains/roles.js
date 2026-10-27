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

// 读取角色/模式状态。支持**按群角色**（2026-10-27 用户要求，第二轮：不同群不同人格）：
//   · 全局 role/mode = 私聊和没覆盖的群（默认是小鲸鱼）；
//   · groupOverrides = 单群覆盖（{ "group:20000001": "鲸鲸宝宝" }）——优先级最高；
//   · groupRole = 群聊默认覆盖（历史遗留；一般不用，保留兼容）；
//   · 传 key 时：group:* → groupOverrides[key] ?? groupRole ?? 全局；private → 全局。
// 现状：宠物在主群（20000001），小鲸鱼在 20000003 等其余群/私聊。
function readRoleState(key) {
  const st = readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
  const overrides = st?.groupOverrides && typeof st.groupOverrides === 'object' && !Array.isArray(st.groupOverrides)
    ? st.groupOverrides
    : {};
  const base = {
    role: st?.role ?? null,
    mode: st?.mode ?? 'active',
    groupRole: st?.groupRole ?? null,
    groupOverrides: overrides,
    previous: st?.previous,
    switchedAt: st?.switchedAt
  };
  const k = String(key ?? '').trim();
  if (k.startsWith('group:')) {
    const own = overrides[k];
    if (own) return { ...base, role: own };
    if (base.groupRole) return { ...base, role: base.groupRole };
  }
  return base;
}
// 写角色状态：默认写全局；opts.group === true 写「群聊默认角色」（groupRole）；
// opts.groupKey = 'group:xxx' 时写「这个群的单独角色」（groupOverrides；role=null 表示删除该覆盖）。
function writeRoleState(role, mode, opts = {}) {
  const st = readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
  const next = { ...st };
  const nextRole = role ?? null;
  const groupKey = String(opts?.groupKey ?? '').trim();
  if (groupKey.startsWith('group:')) {
    const overrides = st?.groupOverrides && typeof st.groupOverrides === 'object' && !Array.isArray(st.groupOverrides)
      ? { ...st.groupOverrides }
      : {};
    const prevOwn = overrides[groupKey] ?? null;
    if (prevOwn !== nextRole) {
      next.previous = prevOwn;
      next.switchedAt = Date.now();
    }
    if (nextRole) overrides[groupKey] = nextRole;
    else delete overrides[groupKey];
    next.groupOverrides = overrides;
  } else if (opts?.group === true) {
    const prevGroup = st?.groupRole ?? null;
    if (prevGroup !== nextRole) {
      next.previous = prevGroup;
      next.switchedAt = Date.now();
    }
    next.groupRole = nextRole;
  } else {
    if ((st?.role ?? null) !== nextRole) {
      next.previous = st?.role ?? null;
      next.switchedAt = Date.now();
    }
    next.role = nextRole;
  }
  next.mode = mode ?? st?.mode ?? 'active';
  atomicWriteJson(ROLE_STATE_FILE, next);
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}


  return { listRoles, roleExists, readRoleState, writeRoleState, sanitizeRoleName };
}
