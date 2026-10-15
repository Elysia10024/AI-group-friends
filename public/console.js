(function () {
  // 如果通过 ?token= 进入（控制台启用鉴权时根路径会重定向带 token），存到 localStorage
  const qs = new URLSearchParams(location.search);
  const token = qs.get('token');
  if (token) {
    localStorage.setItem('consoleToken', token);
    history.replaceState({}, '', location.pathname);
  }
})();

async function api(path, method, body, _retried = 0) {
  const headers = body ? {'content-type':'application/json'} : {};
  const token = localStorage.getItem('consoleToken');
  if (token) headers['x-console-token'] = token;
  const res = await fetch(path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 401) {
    if (_retried >= 2) {
      localStorage.removeItem('consoleToken');
      throw new Error('未授权');
    }
    const t = prompt('请输入控制台访问令牌：');
    if (t) {
      localStorage.setItem('consoleToken', t.trim());
      return api(path, method, body, _retried + 1);
    }
    localStorage.removeItem('consoleToken');
    throw new Error('未授权');
  }
  return res.json();
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function refresh() {
  try {
    const s = await api('/api/status');
    document.querySelectorAll('#modeRow button').forEach(b => b.classList.toggle('active', b.dataset.mode === s.mode));
    document.getElementById('roleText').textContent = s.role || '无';
    document.getElementById('roleModeText').textContent = s.roleMode === 'silent' ? '静默' : '正常';
    const modeLabel = s.mode === 'reserved2' ? '二代仿真模式' : s.mode === 'closed-agent' ? '封闭 Agent' : s.mode;
    document.getElementById('statusText').textContent = 'DSH: ' + (s.dshReady ? '在线' : '离线') + ' ｜ 模式: ' + modeLabel + ' ｜ 管理员: ' + (s.ownerQQ || '未设置') + ' ｜ 群白名单: ' + (s.allowGroups.join(', ') || '无') + ' ｜ 私聊白名单: ' + (s.allowPrivate.join(', ') || '无');
    document.getElementById('activity').textContent = s.activity || '（空）';
    const presetSel = document.getElementById('closedPreset');
    if (presetSel && document.activeElement !== presetSel) presetSel.value = s.closedAgentPreset || '';
  } catch (e) { document.getElementById('statusText').textContent = '连接失败: ' + e; }
}

async function refreshPresets() {
  try {
    const r = await api('/api/presets');
    const sel = document.getElementById('closedPreset');
    sel.innerHTML = '';
    for (const p of r.presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.id + (p.trust === 'user' ? '（用户）' : '');
      sel.appendChild(opt);
    }
    refresh();
  } catch {}
}

async function saveMode(mode) {
  const preset = document.getElementById('closedPreset').value || 'router-standard';
  const r = await api('/api/mode', 'POST', { mode, closedAgentPreset: preset });
  if (r.ok) refresh(); else alert(r.error || '切换失败');
  return r;
}

async function refreshRoles() {
  try {
    const r = await api('/api/roles');
    const box = document.getElementById('roleList');
    box.innerHTML = r.roles.length ? '' : '<span class="meta">暂无角色，可在下方新建</span>';
    for (const name of r.roles) {
      const tag = document.createElement('span');
      tag.className = 'tag' + (name === r.current ? ' active' : '');
      tag.textContent = name;
      tag.addEventListener('click', async () => { const res = await api('/api/role', 'POST', { role: name }); if (!res.ok) alert(res.error); refreshRoles(); refresh(); });
      box.appendChild(tag);
    }
  } catch (e) { document.getElementById('roleList').textContent = '加载失败'; }
}

async function refreshWhitelist() {
  try {
    const w = await api('/api/whitelist');
    document.getElementById('wlGroups').value = (w.allow.groups || []).join(', ');
    document.getElementById('wlPrivate').value = (w.allow.private || []).join(', ');
    document.getElementById('ownerQQ').value = w.ownerQQ != null ? String(w.ownerQQ) : '';
    document.getElementById('dnGroups').value = (w.deny.groups || []).join(', ');
    document.getElementById('dnPrivate').value = (w.deny.private || []).join(', ');
  } catch {}
}

async function refreshSessions() {
  try {
    const s = await api('/api/sessions');
    const box = document.getElementById('sessionList');
    if (!s.sessions.length) { box.innerHTML = '<span class="meta">暂无会话</span>'; return; }
    let html = '<table><tr><th>QQ 会话</th><th>DSH 会话 ID</th><th>类型</th><th></th></tr>';
    for (const x of s.sessions) {
      const isP = x.key.startsWith('private:');
      const type = isP ? '<span class="pill b">私聊</span>' : '<span class="pill g">群</span>';
      const ownerTag = x.owner ? ' <span class="pill r">管理员</span>' : '';
      html += `<tr><td>${esc(x.key)}${ownerTag}</td><td><code>${esc(x.sessionId)}</code></td><td>${type}</td><td><button class="small" data-reset-key="${esc(x.key)}">清除上下文</button></td></tr>`;
    }
    box.innerHTML = html + '</table>';
    box.querySelectorAll('[data-reset-key]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('确定清除该会话的上下文？下次消息将开新会话。')) return;
      const r = await api('/api/session/reset', 'POST', { key: btn.dataset.resetKey });
      alert(r.ok ? '✅ 已清除上下文' : ('❌ ' + (r.error || '失败')));
      refreshSessions();
    }));
  } catch {}
}

async function refreshPending() {
  try {
    const p = await api('/api/pending');
    const box = document.getElementById('pendingList');
    if (!p.pending.length) { box.innerHTML = '<span class="meta">无挂起请求</span>'; return; }
    let html = '<table><tr><th>会话</th><th>类型</th><th>详情</th></tr>';
    for (const x of p.pending) {
      const kind = x.kind === 'approval' ? '<span class="pill r">审批</span>' : '<span class="pill b">提问</span>';
      let detail = '';
      if (x.kind === 'approval') detail = `${esc(x.toolName)}${x.reason ? '：' + esc(x.reason) : ''}`;
      else if (x.questions) detail = x.questions.map(q => esc(q.question)).join(' / ');
      html += `<tr><td>${esc(x.key)}</td><td>${kind}</td><td>${detail}</td></tr>`;
    }
    box.innerHTML = html + '</table>';
  } catch {}
}

document.querySelectorAll('#modeRow button').forEach(b => b.addEventListener('click', async () => {
  if (b.disabled) return;
  await saveMode(b.dataset.mode);
}));
document.getElementById('closedPreset').addEventListener('change', async () => {
  // 切换预设立即保存（若当前是 closed-agent 则即时生效，否则供下次切换使用）
  const active = document.querySelector('#modeRow button.active');
  const mode = active ? active.dataset.mode : 'reserved2';
  await saveMode(mode);
});
document.getElementById('roleSet').addEventListener('click', async () => {
  const r = await api('/api/role', 'POST', { role: document.getElementById('roleInput').value.trim() });
  if (r.ok) refreshRoles(); else alert(r.error || '设置失败');
});
document.getElementById('roleClear').addEventListener('click', async () => { await api('/api/role', 'POST', { role: null }); refreshRoles(); refresh(); });
document.getElementById('roleCreate').addEventListener('click', async () => {
  const name = document.getElementById('newRoleName').value.trim();
  const content = document.getElementById('newRoleContent').value.trim();
  const r = await api('/api/roles/create', 'POST', { name, content });
  document.getElementById('roleCreateMsg').textContent = r.ok ? '✅ 已创建' : ('❌ ' + (r.error || '失败'));
  document.getElementById('roleCreateMsg').className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) { document.getElementById('newRoleName').value = ''; document.getElementById('newRoleContent').value = ''; refreshRoles(); }
});
document.getElementById('silentOn').addEventListener('click', async () => { await api('/api/role-mode', 'POST', { mode: 'silent' }); refresh(); });
document.getElementById('silentOff').addEventListener('click', async () => { await api('/api/role-mode', 'POST', { mode: 'active' }); refresh(); });
document.getElementById('wlSave').addEventListener('click', async () => {
  const parse = (s) => s.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  const r = await api('/api/whitelist', 'POST', {
    allow: { private: parse(document.getElementById('wlPrivate').value), groups: parse(document.getElementById('wlGroups').value) },
    deny: { private: parse(document.getElementById('dnPrivate').value), groups: parse(document.getElementById('dnGroups').value) },
    ownerQQ: document.getElementById('ownerQQ').value.trim()
  });
  if (r.ok) { refreshWhitelist(); refresh(); alert('白名单已保存并生效'); }
  else alert(r.error || '保存失败');
});
document.getElementById('tsSend').addEventListener('click', async () => {
  const r = await api('/api/test-send', 'POST', {
    kind: document.getElementById('tsKind').value,
    id: document.getElementById('tsId').value.trim(),
    message: document.getElementById('tsMsg').value
  });
  document.getElementById('tsMsg2').textContent = r.ok ? ('✅ 已发送 message_id=' + r.message_id) : ('❌ ' + (r.error || '失败'));
  document.getElementById('tsMsg2').className = r.ok ? 'meta ok' : 'meta err';
});
document.getElementById('restartBtn').addEventListener('click', async () => {
  if (!confirm('确定重启桥接？')) return;
  const r = await api('/api/restart', 'POST', {});
  document.getElementById('restartMsg').textContent = r.message || '正在重启…';
});
document.getElementById('clearWsBtn').addEventListener('click', async () => {
  if (!confirm('确定清空整个「QQ 聊天」工作区？\n将归档全部 QQ 会话、清除所有上下文映射、清空活动日志。\n此操作不可撤销。')) return;
  const r = await api('/api/workspace/reset', 'POST', {});
  document.getElementById('clearWsMsg').textContent = r.ok ? (`✅ 已归档 ${r.archivedCount} 个会话，工作区已清空`) : ('❌ ' + (r.error || '失败'));
  document.getElementById('clearWsMsg').className = r.ok ? 'meta ok' : 'meta err';
  refreshSessions(); refresh();
});
document.getElementById('aiNotifySend').addEventListener('click', async () => {
  const kind = document.getElementById('aiNotifyKind').value;
  const id = document.getElementById('aiNotifyId').value.trim();
  const message = document.getElementById('aiNotifyMessage').value.trim();
  if (!id || !message) { alert('请填写群号/QQ 号和提醒内容'); return; }
  const r = await api('/api/console/notify-ai', 'POST', { key: kind + ':' + id, message });
  const msg = document.getElementById('aiNotifyMsg');
  msg.textContent = r.ok ? ('✅ 已投递到 DSH：' + r.sessionId) : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
});

// ── 二代仿真模式（reserved2）配置 ─────────────────────────────────────────
// 配置项**只写一遍**：下面这张表一行一个字段（表单元素 id → 配置路径 → 取值/写值口径）。
//
// 以前每个字段写三处：表单元素一处、loadV2Config 里一行、saveV2Config 里一行。加一个配置项
// 要改三处，漏一处就表现为"界面上改了存不下去"或"存下去了读不回来"。现在加配置项 = 表里加一行
// + 表单里加个元素（两处，且测试 tmp/equiv-ui.mjs 那套能逐字段比对）。
//
// kind 一览（load = 配置 → 表单；save = 表单 → 配置）：
//   bool     默认开的开关：load `v !== false`            save `el.checked`
//   boolT    默认关的开关：load `v === true`             save `el.checked`
//   text     文本：load `v || ''`                        save `el.value`（trim:true 时 trim）
//   mode     枚举：load 只认 'active'，其余一律 'diving'  save `el.value`
//   int      整数：load `v ?? loadFb`                    save `Math.round(Number(v) || saveFb)`
//   num      概率等小数：load `v ?? loadFb`               save `Number(v) || 0`
//   ms       毫秒↔显示单位：load `Math.round((v || loadFb) / unit)`  save `Math.round(Number(v) || saveFb) * unit`
//   lenient  数字但空值算默认、负数归零（等待时长那两项）
//   preSleep 沉睡前观察窗口（分钟 ↔ 毫秒，且负数视为没填）
//   kw       关键词数组 ↔ 逗号分隔文本
//
// 数值项的 clamp: [min, max] 在 save 侧生效（和原实现一致，超范围会被夹住）。
const V2_FIELDS = [
  ['v2Enabled', 'enabled', 'bool'],
  ['v2AgentPreset', 'agentPreset', 'text', { trim: true }],
  ['v2ProvideRecommendations', 'provideRecommendations', 'bool'],
  ['v2AutoReplyCheckSec', 'autoReplyCheckMs', 'ms', { unit: 1000, loadFb: 30000, saveFb: 30 }],
  // wake
  ['v2WakeDefaultMode', 'wake.defaultMode', 'mode'],
  ['v2RecDefaultInfinite', 'wake.recommendedDefaultInfinite', 'bool'],
  ['v2PreSleepWaitEnabled', 'wake.preSleepWaitEnabled', 'bool'],
  ['v2PreSleepWaitMin', 'wake.preSleepWaitMs', 'preSleep'],
  ['v2RecSleepMin', 'wake.recommendedSleepMinMs', 'ms', { unit: 60000, loadFb: 300000, saveFb: 5 }],
  ['v2RecSleepMax', 'wake.recommendedSleepMaxMs', 'ms', { unit: 60000, loadFb: 7200000, saveFb: 120 }],
  ['v2RecProb', 'wake.recommendedProbability', 'num', { loadFb: 0.05 }],
  ['v2RecKeywords', 'wake.recommendedKeywords', 'kw'],
  ['v2RecAt', 'wake.recommendedAtMention', 'bool'],
  ['v2RecName', 'wake.recommendedNameMention', 'bool'],
  ['v2RecQuestion', 'wake.recommendedQuestion', 'bool'],
  ['v2RecPoke', 'wake.recommendedPoke', 'bool'],
  ['v2WakeHint', 'wake.recommendedHint', 'text'],
  ['v2SleepMinMs', 'wake.sleepMinMs', 'ms', { unit: 1000, loadFb: 60000, saveFb: 0 }],
  ['v2SleepMaxMs', 'wake.sleepMaxMs', 'ms', { unit: 1000, loadFb: 0, saveFb: 0 }],
  ['v2MaxWakeMin', 'wake.maxWakePerMinute', 'int', { loadFb: 1, saveFb: 0 }],
  ['v2MaxWakeHour', 'wake.maxWakePerHour', 'int', { loadFb: 12, saveFb: 0 }],
  ['v2BatchWindowMs', 'wake.batchWindowMs', 'int', { loadFb: 8000, saveFb: 8000 }],
  ['v2NoActionLimit', 'wake.noActionLimit', 'int', { loadFb: 3, saveFb: 3 }],
  ['v2MaxWakeConfigReminders', 'wake.maxWakeConfigReminders', 'int', { loadFb: 2, saveFb: 2 }],
  // send
  ['v2BurstEnabled', 'send.burstEnabled', 'bool'],
  ['v2BurstMax', 'send.burstMaxMessages', 'int', { loadFb: 8, saveFb: 8 }],
  ['v2BurstMin', 'send.burstIntervalMinMs', 'int', { loadFb: 1000, saveFb: 1000 }],
  ['v2BurstMaxMs', 'send.burstIntervalMaxMs', 'int', { loadFb: 3000, saveFb: 3000 }],
  ['v2LongGapProb', 'send.longGapProbability', 'num', { loadFb: 0.2 }],
  ['v2LongGapMin', 'send.longGapMinMs', 'int', { loadFb: 5000, saveFb: 5000 }],
  ['v2LongGapMax', 'send.longGapMaxMs', 'int', { loadFb: 10000, saveFb: 10000 }],
  ['v2MaxSendMin', 'send.maxSendPerMinute', 'int', { loadFb: 8, saveFb: 0 }],
  ['v2MaxSendHour', 'send.maxSendPerHour', 'int', { loadFb: 60, saveFb: 0 }],
  ['v2MaxMsgChars', 'send.maxMessageChars', 'int', { loadFb: 500, saveFb: 500 }],
  ['v2MaxGapMs', 'send.maxGapMs', 'int', { loadFb: 10000, saveFb: 10000 }],
  ['v2GapBaseMs', 'send.gapBaseMs', 'int', { loadFb: 800, saveFb: 800 }],
  ['v2GapPerCharMs', 'send.gapPerCharMs', 'int', { loadFb: 20, saveFb: 20 }],
  ['v2SendHint', 'send.recommendedHint', 'text'],
  // wait
  ['v2WaitDefaultMs', 'wait.defaultMs', 'int', { loadFb: 30000, saveFb: 5000 }],
  ['v2WaitMinMs', 'wait.minMs', 'int', { loadFb: 5000, saveFb: 1000 }],
  ['v2WaitMaxMs', 'wait.maxMs', 'int', { loadFb: 600000, saveFb: 10000 }],
  ['v2WaitDefaultQuietMs', 'wait.defaultQuietMs', 'lenient', { loadFb: 8000, saveFb: 8000 }],
  ['v2MinQuietAfterNewMs', 'wait.minQuietAfterNewMs', 'lenient', { loadFb: 10000, saveFb: 10000 }],
  // proactive
  ['v2ProactiveEnabled', 'proactive.enabled', 'bool'],
  ['v2ProactiveIntervalMin', 'proactive.checkIntervalMinMs', 'ms', { unit: 60000, loadFb: 1800000, saveFb: 30 }],
  ['v2ProactiveIntervalMax', 'proactive.checkIntervalMaxMs', 'ms', { unit: 60000, loadFb: 5400000, saveFb: 90 }],
  ['v2ProactiveIdleThreshold', 'proactive.idleThresholdMs', 'ms', { unit: 60000, loadFb: 900000, saveFb: 15 }],
  ['v2ProactiveProbability', 'proactive.probability', 'num', { loadFb: 0.3 }],
  // sticker
  ['v2StickerEnabled', 'sticker.enabled', 'bool'],
  ['v2StickerSyncTtlSec', 'sticker.syncTtlMs', 'ms', { unit: 1000, loadFb: 60000, saveFb: 60, clamp: [1000, null] }],
  ['v2StickerMaxList', 'sticker.maxListCount', 'int', { loadFb: 100, saveFb: 100, clamp: [1, 500] }],
  ['v2StickerIncludePrompt', 'sticker.includeInPrompt', 'bool'],
  ['v2StickerPromptMax', 'sticker.promptMaxStickers', 'int', { loadFb: 8, saveFb: 8, clamp: [1, 30] }],
  ['v2StickerCollectEnabled', 'sticker.collect.enabled', 'bool'],
  ['v2StickerCollectPerMin', 'sticker.collect.maxPerMinute', 'int', { loadFb: 2, saveFb: 0, clamp: [0, null] }],
  ['v2StickerCollectPerHour', 'sticker.collect.maxPerHour', 'int', { loadFb: 10, saveFb: 0, clamp: [0, null] }],
  ['v2StickerCollectRemarkMax', 'sticker.collect.maxRemarkChars', 'int', { loadFb: 20, saveFb: 20, clamp: [1, 50] }],
  // context / feedback
  ['v2ContextRecentLimit', 'context.recentLimit', 'int', { loadFb: 100, saveFb: 100 }],
  ['v2ContextUnreadLimit', 'context.unreadLimit', 'int', { loadFb: 30, saveFb: 30 }],
  ['v2ContextWindow', 'context.contextWindow', 'int', { loadFb: 20, saveFb: 20 }],
  ['v2FeedbackMaxLength', 'feedback.maxLength', 'int', { loadFb: 500, saveFb: 500 }],
  ['v2FeedbackNotifyOwner', 'feedback.notifyOwnerOnError', 'boolT']
];

const V2_KINDS = {
  load: {
    bool: (v) => v !== false,
    boolT: (v) => v === true,
    text: (v) => v || '',
    mode: (v) => (v === 'active' ? 'active' : 'diving'),
    int: (v, o) => v ?? o.loadFb,
    num: (v, o) => v ?? o.loadFb,
    ms: (v, o) => Math.round((v || o.loadFb) / o.unit),
    lenient: (v, o) => v ?? o.loadFb,
    preSleep: (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) / 60000) : 5),
    // 关键词：正常是数组；写成字符串（"a,b"）也认 —— 旧实现直接 `.join` 会抛，被 catch 吞掉后
    // 整个表单只加载到一半，之后一保存就把后面那些字段按兜底值写回去。
    kw: (v) => (Array.isArray(v) ? v : v == null ? [] : String(v).split(/[,，]/).map((s) => s.trim()).filter(Boolean)).join(', ')
  },
  save: {
    bool: (el) => el.checked,
    boolT: (el) => el.checked,
    text: (el, o) => (o.trim ? el.value.trim() : el.value),
    mode: (el) => el.value,
    int: (el, o) => clampNum(Math.round(Number(el.value) || o.saveFb), o.clamp),
    num: (el) => Number(el.value) || 0,
    ms: (el, o) => clampNum(Math.round(Number(el.value) || o.saveFb) * o.unit, o.clamp),
    lenient: (el, o) => (Number.isFinite(Number(el.value)) ? Math.max(0, Math.round(Number(el.value))) : o.saveFb),
    preSleep: (el) => (Number.isFinite(Number(el.value)) && Number(el.value) >= 0 ? Math.round(Number(el.value)) : 5) * 60000,
    kw: (el) => el.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
  }
};
function clampNum(n, range) {
  if (!range) return n;
  const [lo, hi] = range;
  let out = n;
  if (lo !== null && lo !== undefined) out = Math.max(lo, out);
  if (hi !== null && hi !== undefined) out = Math.min(hi, out);
  return out;
}
/** 取 `wake.sleepMinMs` 这种点号路径。 */
const v2At = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
/** 按点号路径写进嵌套对象（会自动建中间层）。 */
function v2Put(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (const k of parts.slice(0, -1)) cur = (cur[k] ??= {});
  cur[parts[parts.length - 1]] = val;
}

async function loadV2Config() {
  try {
    const r = await api('/api/socialV2/config');
    const c = r.config || {};
    for (const [id, path, kind, opt] of V2_FIELDS) {
      const el = document.getElementById(id);
      const val = V2_KINDS.load[kind](v2At(c, path), opt || {});
      if (kind === 'bool' || kind === 'boolT') el.checked = val;
      else el.value = val;
    }
    document.querySelectorAll('[data-v2-tool]').forEach(el => {
      el.checked = (c.tools && c.tools[el.dataset.v2Tool] !== false);
    });
  } catch {}
}

async function saveV2Config() {
  const tools = {};
  document.querySelectorAll('[data-v2-tool]').forEach(el => { tools[el.dataset.v2Tool] = el.checked; });
  const body = {};
  // 顶层字段（路径里没有点）按表序先写，再插 tools，最后写各分段 —— 这样 POST body 的键序
  // 和重构前逐字节相同（后端按名字读，键序无所谓；保持一致是为了 diff 干净、也便于等价比对）。
  for (const [id, path, kind, opt] of V2_FIELDS) {
    if (!path.includes('.')) body[path] = V2_KINDS.save[kind](document.getElementById(id), opt || {});
  }
  body.tools = tools;
  for (const [id, path, kind, opt] of V2_FIELDS) {
    if (path.includes('.')) v2Put(body, path, V2_KINDS.save[kind](document.getElementById(id), opt || {}));
  }
  const r = await api('/api/socialV2/config', 'POST', body);
  const msg = document.getElementById('v2ConfigMsg');
  msg.textContent = r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadV2Config();
}
async function viewV2State() {
  const key = document.getElementById('v2StateKey').value.trim();
  if (!key) { alert('请输入会话 key'); return; }
  const r = await api('/api/socialV2/state?key=' + encodeURIComponent(key));
  document.getElementById('v2StateOutput').textContent = JSON.stringify(r, null, 2);
}

function v2ToolLogStatus(entry) {
  if (entry.type === 'result') {
    const ok = entry.ok !== false;
    return `<span class="pill ${ok ? 'g' : 'r'}">${ok ? '成功' : '失败'}</span>`;
  }
  return '<span class="pill b">调用</span>';
}
function summarizeToolArgs(tool, args) {
  let obj = args;
  if (typeof args === 'string') {
    try { obj = JSON.parse(args); } catch { return args || ''; }
  }
  if (!obj || typeof obj !== 'object') return String(obj ?? '');
  const parts = [];
  const push = (k, v) => {
    if (v === undefined || v === null || v === '') return;
    parts.push(`${k}=${v}`);
  };
  const t = String(tool || '');
  if (t.includes('qq_set_wake_config')) {
    const cfg = (obj.config && typeof obj.config === 'object') ? obj.config : obj;
    push('mode', cfg.mode);
    push('infinite', cfg.infinite);
    const sleepUntil = cfg.sleepUntil || obj.sleepUntil;
    const sleepMs = cfg.sleepMs !== undefined ? cfg.sleepMs : obj.sleepMs;
    if (sleepUntil) push('sleepUntil', sleepUntil);
    else if (sleepMs !== undefined) push('sleepMs', sleepMs + 'ms');
    else push('sleep', '未设置时间');
    const tr = (cfg.triggers && typeof cfg.triggers === 'object') ? cfg.triggers : {};
    const trigs = [];
    if (tr.atMention) trigs.push('@');
    if (tr.nameMention) trigs.push('名字');
    if (tr.question) trigs.push('提问');
    if (tr.poke) trigs.push('拍一拍');
    if (Array.isArray(tr.keywords) && tr.keywords.length) trigs.push('关键词:' + tr.keywords.join(','));
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) trigs.push('指定成员:' + tr.speakerIds.join(','));
    if (tr.anyMessage) trigs.push('anyMessage');
    if (Number(tr.probability) > 0) trigs.push('概率:' + tr.probability);
    if (trigs.length) push('triggers', trigs.join('|'));
  } else if (t.includes('qq_wait_for_messages')) {
    push('timeoutMs', obj.timeoutMs != null ? obj.timeoutMs : '默认30000');
    push('minNewMessages', obj.minNewMessages != null ? obj.minNewMessages : 1);
    push('quietMs', obj.quietMs != null ? obj.quietMs : '默认8000');
  } else if (t.includes('qq_send_message')) {
    const msgs = Array.isArray(obj.messages) ? obj.messages : (obj.messages != null ? [obj.messages] : []);
    push('条数', msgs.length);
    if (msgs.length) push('首条', String(msgs[0]).slice(0, 30));
    push('gapMode', obj.gapMode || 'auto');
    if (obj.gapMs != null) push('gapMs', obj.gapMs);
    if (Array.isArray(obj.gaps) && obj.gaps.length) push('gaps', obj.gaps.join(','));
    if (obj.replyToMessageId != null && obj.replyToMessageId !== '') push('引用id', obj.replyToMessageId);
  } else if (t.includes('qq_send_burst')) {
    const msgs = Array.isArray(obj.messages) ? obj.messages : [];
    push('条数', msgs.length);
    if (msgs.length) push('首条', String(msgs[0]).slice(0, 30));
  } else if (t.includes('qq_send_poke')) {
    push('key', obj.key);
    if (obj.targetUserId != null && obj.targetUserId !== '') push('target', obj.targetUserId);
  } else if (t.includes('qq_get_forward_msg')) {
    push('key', obj.key);
    if (obj.id != null && obj.id !== '') push('id', String(obj.id).slice(0, 40));
  } else if (t.includes('qq_get_prompt') || t.includes('qq_get_unread_messages') || t.includes('qq_get_recent_messages') || t.includes('qq_social_state') || t.includes('qq_get_my_recent_messages') || t.includes('qq_get_message_detail') || t.includes('qq_get_active_members')) {
    push('key', obj.key);
    if (obj.messageId != null) push('messageId', obj.messageId);
    if (obj.limit != null) push('limit', obj.limit);
  } else {
    push('key', obj.key);
  }
  return parts.join(' | ') || JSON.stringify(obj);
}
function v2ToolLogCell(value, tool) {
  const text = value == null ? '' : String(value);
  if (!text) return '<span class="meta">-</span>';
  const summary = tool ? summarizeToolArgs(tool, text) : text;
  const short = summary.length > 100 ? summary.slice(0, 100) + '…' : summary;
  return `<span class="tool-log-cell" data-full="${esc(text)}" data-short="${esc(short)}" title="点击查看完整 JSON">${esc(short)}</span>`;
}
function renderV2ToolLog(entries) {
  const box = document.getElementById('v2ToolLogOutput');
  const list = entries || [];
  if (!list.length) { box.innerHTML = '<span class="meta">（空）</span>'; return; }
  let html = '<table><tr><th>时间</th><th>会话 key</th><th>工具名</th><th>状态</th><th>参数</th><th>错误信息</th></tr>';
  for (const e of list) {
    const time = e.time ? new Date(e.time).toLocaleString() : '-';
    const key = esc(e.key || '');
    const tool = esc(e.tool || '-');
    const status = v2ToolLogStatus(e);
    const params = e.type === 'call' ? v2ToolLogCell(e.args, e.tool) : '<span class="meta">-</span>';
    const error = e.type === 'result' ? v2ToolLogCell(e.error) : '<span class="meta">-</span>';
    html += `<tr><td>${esc(time)}</td><td>${key}</td><td>${tool}</td><td>${status}</td><td>${params}</td><td>${error}</td></tr>`;
  }
  html += '</table>';
  box.innerHTML = html;
}
function loadV2ToolLog() {
  return api('/api/socialV2/tool-log?limit=200')
    .then(r => { renderV2ToolLog(r.entries || []); })
    .catch(() => { renderV2ToolLog([]); });
}
document.getElementById('v2ToolLogOutput').addEventListener('click', (ev) => {
  const cell = ev.target.closest('.tool-log-cell');
  if (!cell) return;
  const full = cell.dataset.full;
  const short = cell.dataset.short;
  if (cell.classList.contains('expanded')) {
    cell.classList.remove('expanded');
    cell.textContent = short;
  } else {
    cell.classList.add('expanded');
    cell.textContent = full;
  }
});

function renderV2Memory(data) {
  const box = document.getElementById('v2MemoryOutput');
  if (!data || !data.ok) {
    box.innerHTML = '<span class="meta">加载失败</span>';
    return;
  }
  const raw = data.raw || {};
  const topics = Array.isArray(raw.activeTopics) ? raw.activeTopics : [];
  const thoughts = Array.isArray(raw.pendingThoughts) ? raw.pendingThoughts : [];
  const impressions = raw.memberImpressions && typeof raw.memberImpressions === 'object' ? raw.memberImpressions : {};
  let html = '<div style="padding:8px">';
  html += '<div class="memory-section"><b>进行中的话题</b> <button class="small" data-action="clear" data-cat="activeTopic">清空</button>';
  if (!topics.length) html += '<div class="meta">（空）</div>';
  for (const t of topics) {
    const text = esc(String(t?.text || ''));
    const extra = t?.pendingQuestion ? `；待追问：${esc(String(t.pendingQuestion))}` : '';
    html += `<div style="margin:4px 0">📌 ${text}${extra} <button class="small" data-action="edit" data-cat="activeTopic" data-content="${esc(String(t?.text || ''))}">编辑</button> <button class="small" data-action="remove" data-cat="activeTopic" data-content="${esc(String(t?.text || ''))}">删除</button></div>`;
  }
  html += '</div>';
  html += '<div class="memory-section"><b>你想说但还没说的</b> <button class="small" data-action="clear" data-cat="pendingThought">清空</button>';
  if (!thoughts.length) html += '<div class="meta">（空）</div>';
  for (const t of thoughts) {
    html += `<div style="margin:4px 0">💭 ${esc(String(t?.text || ''))}${t?.motivation ? `（${esc(String(t.motivation))}）` : ''} <button class="small" data-action="edit" data-cat="pendingThought" data-content="${esc(String(t?.text || ''))}">编辑</button> <button class="small" data-action="remove" data-cat="pendingThought" data-content="${esc(String(t?.text || ''))}">删除</button></div>`;
  }
  html += '</div>';
  html += '<div class="memory-section"><b>对群友的印象</b> <button class="small" data-action="clear" data-cat="memberImpression">清空</button>';
  const names = Object.keys(impressions);
  if (!names.length) html += '<div class="meta">（空）</div>';
  for (const name of names) {
    const im = impressions[name] || {};
    const traits = Array.isArray(im.traits) ? im.traits : [];
    html += `<div style="margin:4px 0">👤 ${esc(name)}：${traits.length ? esc(traits.join('、')) : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次） <button class="small" data-action="edit" data-cat="memberImpression" data-target="${esc(name)}" data-traits="${esc(traits.join(', '))}">编辑</button> <button class="small" data-action="remove" data-cat="memberImpression" data-target="${esc(name)}">删除</button></div>`;
  }
  html += '</div></div>';
  box.innerHTML = html;
}
function loadV2Memory() {
  const key = document.getElementById('v2MemoryKey').value.trim();
  const msg = document.getElementById('v2MemoryMsg');
  if (!key) { msg.textContent = '请输入会话 key'; msg.className = 'meta err'; return; }
  msg.textContent = '加载中…';
  msg.className = 'meta';
  return api('/api/socialV2/memory?key=' + encodeURIComponent(key))
    .then(r => {
      renderV2Memory(r);
      msg.textContent = r.ok ? '✅ 已加载' : ('❌ ' + (r.error || '失败'));
      msg.className = r.ok ? 'meta ok' : 'meta err';
    })
    .catch(e => {
      msg.textContent = '❌ ' + (e.message || e);
      msg.className = 'meta err';
    });
}
document.getElementById('v2MemoryLoad').addEventListener('click', loadV2Memory);
document.getElementById('v2MemoryClearAll').addEventListener('click', async () => {
  const key = document.getElementById('v2MemoryKey').value.trim();
  const msg = document.getElementById('v2MemoryMsg');
  if (!key) { msg.textContent = '请输入会话 key'; msg.className = 'meta err'; return; }
  if (!confirm('确定清空该会话全部轻量记忆？')) return;
  const r = await api('/api/socialV2/memory-clear', 'POST', { key, category: '' });
  msg.textContent = r.ok ? '✅ 已清空全部记忆' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadV2Memory();
});
document.getElementById('v2MemoryOutput').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const key = document.getElementById('v2MemoryKey').value.trim();
  const msg = document.getElementById('v2MemoryMsg');
  if (!key) { msg.textContent = '请输入会话 key'; msg.className = 'meta err'; return; }
  const cat = btn.dataset.cat;
  const action = btn.dataset.action;
  let r;
  if (action === 'clear') {
    r = await api('/api/socialV2/memory-clear', 'POST', { key, category: cat });
  } else if (action === 'edit') {
    let newContent;
    let newExtra = {};
    if (cat === 'memberImpression') {
      const input = prompt(`编辑对 ${btn.dataset.target} 的印象特质（逗号分隔）：`, btn.dataset.traits || '');
      if (input === null) return;
      newContent = input;
    } else {
      const input = prompt(`编辑${cat === 'activeTopic' ? '话题' : '想法'}内容：`, btn.dataset.content || '');
      if (input === null) return;
      newContent = input;
    }
    r = await api('/api/socialV2/memory-update', 'POST', { key, category: cat, oldContent: btn.dataset.content || '', target: btn.dataset.target || '', newContent, newExtra });
  } else {
    r = await api('/api/socialV2/memory-remove', 'POST', { key, category: cat, content: btn.dataset.content || '', target: btn.dataset.target || '' });
  }
  msg.textContent = r.ok ? '✅ 已更新' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadV2Memory();
});

function formatWakeStatus(r) {
  if (!r || !r.ok) return '<span class="meta">加载失败</span>';
  const wc = r.wakeConfig || {};
  const lines = [];
  const mode = wc.mode === 'active' ? '活跃（任何消息都会唤醒）' : (wc.mode === 'diving' ? '潜水' : (wc.mode || '未知'));
  lines.push(`<div><b>模式：</b>${esc(mode)}</div>`);
  lines.push(`<div><b>无限期：</b>${wc.infinite ? '是' : '否'}</div>`);
  const safety = r.wakeSafety || {};
  const badge = safety.guaranteed ? '🟢 已保证' : '🔴 无保证';
  lines.push(`<div><b>唤醒保证：</b>${badge}${safety.stale ? '（配置较旧，未确认）' : ''}</div>`);
  let next = '';
  if (wc.mode === 'active' || wc.triggers?.anyMessage) {
    next = '任何新消息都会唤醒';
  } else if (wc.sleepUntil) {
    const until = new Date(wc.sleepUntil).getTime();
    const remain = until - Date.now();
    if (!Number.isFinite(remain)) next = '时间格式无效';
    else if (remain > 0) next = `约 ${Math.max(1, Math.round(remain / 1000))} 秒后（${new Date(wc.sleepUntil).toLocaleString()}）`;
    else next = '已到期，等待下一次唤醒';
  } else if (wc.infinite) {
    next = '无限期潜水，等待指定条件';
  } else {
    next = '未设置时间';
  }
  lines.push(`<div><b>下次唤醒：</b>${esc(next)}</div>`);
  const tr = wc.triggers || {};
  const conds = [];
  if (tr.atMention) conds.push('@');
  if (tr.nameMention) conds.push('名字');
  if (Array.isArray(tr.keywords) && tr.keywords.length) conds.push('关键词：' + tr.keywords.join('、'));
  if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) conds.push('指定成员：' + tr.speakerIds.join('、'));
  if (tr.question) conds.push('提问');
  if (tr.poke) conds.push('拍一拍');
  if (tr.anyMessage) conds.push('任何消息');
  if (Number(tr.probability) > 0) conds.push('普通消息概率 ' + Number(tr.probability));
  lines.push(`<div><b>提前唤醒条件：</b>${conds.length ? esc(conds.join('；')) : '（无）'}</div>`);
  lines.push(`<div><b>最近唤醒原因：</b>${esc(r.lastWakeReason || '-')}</div>`);
  lines.push(`<div><b>唤醒次数：</b>${Number(wc.wakeCount) || 0}</div>`);
  if (wc.confirmedAt) {
    const ago = Math.max(0, Math.round((Date.now() - wc.confirmedAt) / 60000));
    lines.push(`<div><b>配置确认：</b>${ago} 分钟前（${esc(wc.confirmedBy || 'unknown')}）</div>`);
  }
  if (r.lastAiReplyAt) {
    const ago = Math.max(0, Math.round((Date.now() - r.lastAiReplyAt) / 60000));
    lines.push(`<div><b>上次发言：</b>${ago} 分钟前</div>`);
  }
  lines.push(`<div><b>未读：</b>${Number(r.unreadCount) || 0} 条</div>`);
  return '<div style="padding:8px">' + lines.join('') + '</div>';
}
function loadV2WakeStatus() {
  const key = document.getElementById('v2WakeKey').value.trim();
  const msg = document.getElementById('v2WakeStatusMsg');
  if (!key) { msg.textContent = '请输入会话 key'; msg.className = 'meta err'; return; }
  msg.textContent = '加载中…';
  msg.className = 'meta';
  return api('/api/socialV2/state?key=' + encodeURIComponent(key))
    .then(r => {
      document.getElementById('v2WakeStatusOutput').innerHTML = formatWakeStatus(r);
      msg.textContent = r.ok ? '✅ 已加载' : ('❌ ' + (r.error || '失败'));
      msg.className = r.ok ? 'meta ok' : 'meta err';
    })
    .catch(e => {
      msg.textContent = '❌ ' + (e.message || e);
      msg.className = 'meta err';
    });
}
document.getElementById('v2WakeStatusLoad').addEventListener('click', loadV2WakeStatus);

async function loadV2SessionOptions() {
  const sel = document.getElementById('v2SessionSelect');
  const prev = sel.value;
  try {
    const r = await api('/api/status');
    const groups = Array.isArray(r.allowGroups) ? r.allowGroups : [];
    const privates = Array.isArray(r.allowPrivate) ? r.allowPrivate : [];
    const options = [{ value: '', label: '选择白名单群/私聊…' }];
    for (const g of groups) options.push({ value: 'group:' + g, label: '群 ' + g });
    for (const p of privates) options.push({ value: 'private:' + p, label: '私聊 ' + p });
    sel.innerHTML = options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
    if (prev && options.some((o) => o.value === prev)) sel.value = prev;
  } catch (e) {
    sel.innerHTML = '<option value="">无法加载白名单</option>';
  }
}
document.getElementById('v2SessionRefresh').addEventListener('click', loadV2SessionOptions);
document.getElementById('v2SessionSelect').addEventListener('change', (ev) => {
  const key = ev.target.value;
  if (!key) return;
  document.getElementById('v2StateKey').value = key;
  document.getElementById('v2MemoryKey').value = key;
  document.getElementById('v2WakeKey').value = key;
});

document.getElementById('v2ConfigSave').addEventListener('click', saveV2Config);
document.getElementById('v2ConfigSaveTop').addEventListener('click', saveV2Config);
async function refreshV2Activity() {
  try {
    const r = await api('/api/socialV2/activity');
    const el = document.getElementById('v2ActivityStatus');
    el.textContent = r.paused ? '已暂停' : '运行中';
    el.className = r.paused ? 'meta err' : 'meta ok';
  } catch {}
}
document.getElementById('v2PauseBtn').addEventListener('click', async () => {
  await api('/api/socialV2/activity', 'POST', { paused: true });
  refreshV2Activity();
});
document.getElementById('v2ResumeBtn').addEventListener('click', async () => {
  await api('/api/socialV2/activity', 'POST', { paused: false });
  refreshV2Activity();
});
document.getElementById('v2ResetBtn').addEventListener('click', async () => {
  if (!confirm('确定重置二代 AI 状态？\n将清空所有二代会话、唤醒配置、未读消息和定时器；工具调用日志会保留。')) return;
  const r = await api('/api/socialV2/reset', 'POST', {});
  const msg = document.getElementById('v2ConfigMsg');
  msg.textContent = r.ok ? '✅ 已重置二代状态' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  refreshV2Activity();
  document.getElementById('v2AllStatesOutput').textContent = '（全部会话状态：空）';
  document.getElementById('v2StateOutput').textContent = '（空）';
});
document.getElementById('v2StateView').addEventListener('click', viewV2State);
document.getElementById('v2ForceWake').addEventListener('click', async () => {
  const key = document.getElementById('v2StateKey').value.trim();
  if (!key) { alert('请输入会话 key'); return; }
  const r = await api('/api/socialV2/wake', 'POST', { key, reason: 'admin' });
  const msg = document.getElementById('v2ConfigMsg');
  msg.textContent = r.ok ? '✅ 已发送唤醒' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
});
document.getElementById('v2StatesList').addEventListener('click', async () => {
  const r = await api('/api/socialV2/states');
  document.getElementById('v2AllStatesOutput').textContent = JSON.stringify(r.conversations || [], null, 2);
});
document.getElementById('v2FeedbackLoad').addEventListener('click', async () => {
  const r = await api('/api/socialV2/feedback');
  document.getElementById('v2FeedbackOutput').textContent = JSON.stringify(r.entries || [], null, 2);
});
document.getElementById('v2FeedbackClear').addEventListener('click', async () => {
  if (!confirm('确定清空全部 AI 反馈？')) return;
  const r = await api('/api/socialV2/feedback-clear', 'POST', {});
  const msg = document.getElementById('v2FeedbackMsg');
  msg.textContent = r.ok ? '✅ 已清空' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) document.getElementById('v2FeedbackOutput').textContent = '（空）';
});
document.getElementById('v2ToolLogLoad').addEventListener('click', async () => {
  const msg = document.getElementById('v2ToolLogMsg');
  msg.textContent = '';
  await loadV2ToolLog();
});
document.getElementById('v2ToolLogClear').addEventListener('click', async () => {
  if (!confirm('确定清空全部工具调用日志？')) return;
  const r = await api('/api/socialV2/tool-log/clear', 'POST', {});
  const msg = document.getElementById('v2ToolLogMsg');
  msg.textContent = r.ok ? '✅ 已清空' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  renderV2ToolLog([]);
});

// 只在页面加载/保存成功后填充输入框（避免自动刷新覆盖用户正在编辑的值）
let slangEntriesCache = [];
let slangSelected = new Set();
let slangActiveTab = 'candidate';
let slangModalId = null;
let slangModalMode = 'confirm'; // confirm | edit

function slangStatusLabel(status) {
  return { candidate: '候选', confirmed: '已确认', rejected: '已拒绝' }[status] || esc(status);
}
function slangStatusClass(status) {
  return { candidate: 'pill b', confirmed: 'pill g', rejected: 'pill r' }[status] || 'pill';
}
function slangSourceLabel(e) {
  if (e.source === 'manual') return '手动';
  if (Array.isArray(e.evidence) && e.evidence.some((ev) => ev.sender === 'AI提交')) return 'AI提交';
  return '自动提取';
}
function slangEvidenceHtml(e) {
  return Array.isArray(e.evidence) && e.evidence.length
    ? e.evidence.slice(-2).map((ev) => `<span class="meta">${esc(String(ev.sender || '未知'))}：${esc(String(ev.text || '').slice(0, 30))}</span>`).join('<br>')
    : '<span class="meta">—</span>';
}
function slangSourcesHtml(e) {
  return Array.isArray(e.sources) && e.sources.length
    ? e.sources.slice(0, 5).map((s) => `<span class="meta">🔗 ${esc(s)}</span>`).join('<br>')
    : '';
}
function slangSearchFields(e) {
  return [e.content, e.meaning, e.usage, e.example, e.risk, Array.isArray(e.sources) ? e.sources.join(' ') : '', Array.isArray(e.evidence) ? e.evidence.map((x) => x.text || '').join(' ') : ''].join(' ').toLowerCase();
}
function getSlangLimit() {
  const id = slangActiveTab === 'candidate' ? 'slangLimitCand' : slangActiveTab === 'confirmed' ? 'slangLimitConfirmed' : 'slangLimitRejected';
  return Math.max(10, Number(document.getElementById(id)?.value) || 100);
}
function getSlangSearch() {
  const id = slangActiveTab === 'candidate' ? 'slangSearchCand' : slangActiveTab === 'confirmed' ? 'slangSearchConfirmed' : 'slangSearchRejected';
  return String(document.getElementById(id)?.value || '').trim().toLowerCase();
}
function selectedIdsForStatus(status) {
  return [...slangSelected].filter((id) => slangEntriesCache.some((e) => e.id === id && e.status === status));
}
function setSlangMsg(text, ok = true) {
  const msg = document.getElementById('slangMsg');
  if (!msg) return;
  msg.textContent = text;
  msg.className = ok ? 'meta ok' : 'meta err';
}
function setSlangTab(tab) {
  slangActiveTab = tab;
  document.querySelectorAll('.slang-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.slangTab === tab));
  document.querySelectorAll('.slang-panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'slangPanel' + tab[0].toUpperCase() + tab.slice(1)));
  renderSlangPanel();
}
function updateSlangSelectAll(status) {
  const id = status === 'candidate' ? 'slangCandidateSelectAll' : status === 'confirmed' ? 'slangConfirmedSelectAll' : 'slangRejectedSelectAll';
  const el = document.getElementById(id);
  if (!el) return;
  const list = slangEntriesCache.filter((e) => e.status === status);
  const q = getSlangSearch();
  const filtered = q ? list.filter((e) => slangSearchFields(e).includes(q)) : list;
  el.checked = filtered.length > 0 && filtered.every((e) => slangSelected.has(e.id));
  el.indeterminate = filtered.some((e) => slangSelected.has(e.id)) && !el.checked;
}

function renderSlangPanel() {
  const status = slangActiveTab;
  const containerId = status === 'candidate' ? 'slangCandidateList' : status === 'confirmed' ? 'slangConfirmedList' : 'slangRejectedList';
  const box = document.getElementById(containerId);
  if (!box) return;
  const list = slangEntriesCache.filter((e) => e.status === status);
  const q = getSlangSearch();
  const filtered = q ? list.filter((e) => slangSearchFields(e).includes(q)) : list;
  if (!filtered.length) {
    box.innerHTML = '<div class="meta" style="padding:8px">' + (list.length ? '没有符合条件的词条' : (status === 'candidate' ? '暂无候选黑话，等 DSH 自动提取、AI 提交或手动添加' : status === 'confirmed' ? '暂无已确认黑话' : '暂无已拒绝词条')) + '</div>';
    updateSlangSelectAll(status);
    return;
  }
  const limit = getSlangLimit();
  const shown = filtered.slice(0, limit);
  let html = `<div class="meta" style="padding:6px 8px">共 ${filtered.length} 条，显示 ${shown.length} 条（可滚动查找）</div>`;
  html += '<table><tr><th>选择</th><th>词条</th><th>次数</th><th>来源</th><th>含义 / 用法 / 示例</th><th>参考来源</th><th>语境证据</th><th>操作</th></tr>';
  for (const e of shown) {
    const meaning = e.meaning ? esc(e.meaning) : (status === 'candidate' ? '<span class="meta">待研究</span>' : '<span class="meta">无</span>');
    const checked = slangSelected.has(e.id) ? ' checked' : '';
    const actions = [];
    if (status === 'candidate') {
      actions.push(`<button class="small" data-slang-confirm="${esc(e.id)}">确认</button>`);
      actions.push(`<button class="small" data-slang-edit="${esc(e.id)}">编辑</button>`);
      actions.push(`<button class="small" data-slang-reject="${esc(e.id)}">拒绝</button>`);
    } else if (status === 'confirmed') {
      actions.push(`<button class="small" data-slang-edit="${esc(e.id)}">编辑</button>`);
    } else {
      actions.push(`<button class="small" data-slang-restore="${esc(e.id)}">恢复候选</button>`);
    }
    actions.push(`<button class="small danger" data-slang-del="${esc(e.id)}">删</button>`);
    html += `<tr>
      <td><input type="checkbox" data-slang-select="${esc(e.id)}"${checked}></td>
      <td><b>${esc(e.content)}</b><br><span class="${slangStatusClass(status)}">${slangStatusLabel(status)}</span></td>
      <td>${esc(e.count)}</td>
      <td>${esc(slangSourceLabel(e))}</td>
      <td>${meaning}${e.usage ? '<br><span class="meta">用法：' + esc(e.usage) + '</span>' : ''}${e.example ? '<br><span class="meta">例：' + esc(e.example) + '</span>' : ''}${e.risk ? '<br><span class="meta">风险：' + esc(e.risk) + '</span>' : ''}</td>
      <td>${slangSourcesHtml(e) || '<span class="meta">—</span>'}</td>
      <td>${slangEvidenceHtml(e)}</td>
      <td class="row">${actions.join('')}</td>
    </tr>`;
  }
  box.innerHTML = html + '</table>';
  box.querySelectorAll('[data-slang-select]').forEach((cb) => cb.addEventListener('change', () => {
    const id = cb.dataset.slangSelect;
    if (cb.checked) slangSelected.add(id); else slangSelected.delete(id);
    updateSlangSelectAll(status);
  }));
  box.querySelectorAll('[data-slang-confirm]').forEach((btn) => btn.addEventListener('click', () => openSlangModal(btn.dataset.slangConfirm, 'confirm')));
  box.querySelectorAll('[data-slang-edit]').forEach((btn) => btn.addEventListener('click', () => openSlangModal(btn.dataset.slangEdit, 'edit')));
  box.querySelectorAll('[data-slang-reject]').forEach((btn) => btn.addEventListener('click', async () => {
    const r2 = await api('/api/slang/' + btn.dataset.slangReject + '/reject', 'POST', {});
    if (!r2.ok) alert(r2.error || '拒绝失败');
    setSlangMsg(r2.ok ? '✅ 已拒绝' : ('❌ ' + (r2.error || '失败')), r2.ok);
    refreshSlang();
  }));
  box.querySelectorAll('[data-slang-restore]').forEach((btn) => btn.addEventListener('click', async () => {
    const e = slangEntriesCache.find((x) => x.id === btn.dataset.slangRestore);
    if (!e) return;
    const r2 = await api('/api/slang/' + e.id, 'PATCH', { status: 'candidate' });
    if (!r2.ok) alert(r2.error || '恢复失败');
    setSlangMsg(r2.ok ? '✅ 已恢复为候选' : ('❌ ' + (r2.error || '失败')), r2.ok);
    refreshSlang();
  }));
  box.querySelectorAll('[data-slang-del]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('确定删除该黑话？')) return;
    const r2 = await api('/api/slang/' + btn.dataset.slangDel, 'DELETE', {});
    if (!r2.ok) alert(r2.error || '删除失败');
    setSlangMsg(r2.ok ? '✅ 已删除' : ('❌ ' + (r2.error || '失败')), r2.ok);
    slangSelected.delete(btn.dataset.slangDel);
    refreshSlang();
  }));
  updateSlangSelectAll(status);
}

async function refreshSlang() {
  try {
    const r = await api('/api/slang');
    slangEntriesCache = r.entries || [];
    renderSlangPanel();
  } catch (e) {
    const box = document.getElementById('slangCandidateList');
    if (box) box.innerHTML = '<span class="meta">加载失败</span>';
  }
}

function openSlangModal(id, mode) {
  const e = slangEntriesCache.find((x) => x.id === id);
  if (!e) return;
  slangModalId = id;
  slangModalMode = mode;
  document.getElementById('slangModalTitle').textContent = mode === 'confirm' ? `确认黑话：${e.content}` : `编辑黑话：${e.content}`;
  document.getElementById('slangModalContent').textContent = mode === 'confirm'
    ? '你可以直接填写含义/用法并转正，也可以先送 DSH 深度联网研究，研究结果回来后在此处删改再确认。'
    : '修改后保存；候选不会转正，已确认仍保持已确认。';
  document.getElementById('slangModalMeaning').value = e.meaning || '';
  document.getElementById('slangModalUsage').value = e.usage || '';
  document.getElementById('slangModalExample').value = e.example || '';
  document.getElementById('slangModalRisk').value = e.risk || '';
  document.getElementById('slangModalSources').value = Array.isArray(e.sources) ? e.sources.join('\n') : '';
  document.getElementById('slangModalDirectConfirm').textContent = mode === 'confirm' ? '直接确认（转正）' : '保存修改';
  document.getElementById('slangModalSendResearch').style.display = mode === 'confirm' && e.status === 'candidate' ? '' : 'none';
  document.getElementById('slangModalOverlay').classList.add('open');
}
function closeSlangModal() {
  document.getElementById('slangModalOverlay').classList.remove('open');
  slangModalId = null;
}
function readSlangModalPayload() {
  return {
    meaning: document.getElementById('slangModalMeaning').value.trim(),
    usage: document.getElementById('slangModalUsage').value.trim(),
    example: document.getElementById('slangModalExample').value.trim(),
    risk: document.getElementById('slangModalRisk').value.trim(),
    sources: document.getElementById('slangModalSources').value.split(/\n/).map((s) => s.trim()).filter(Boolean)
  };
}

document.querySelectorAll('.slang-tab').forEach((btn) => btn.addEventListener('click', () => setSlangTab(btn.dataset.slangTab)));
document.getElementById('slangSearchCand').addEventListener('input', renderSlangPanel);
document.getElementById('slangSearchConfirmed').addEventListener('input', renderSlangPanel);
document.getElementById('slangSearchRejected').addEventListener('input', renderSlangPanel);
document.getElementById('slangLimitCand').addEventListener('change', renderSlangPanel);
document.getElementById('slangLimitConfirmed').addEventListener('change', renderSlangPanel);
document.getElementById('slangLimitRejected').addEventListener('change', renderSlangPanel);
document.getElementById('slangCandidateSelectAll').addEventListener('change', (e) => {
  const list = slangEntriesCache.filter((x) => x.status === 'candidate');
  const q = getSlangSearch();
  const filtered = q ? list.filter((x) => slangSearchFields(x).includes(q)) : list;
  for (const x of filtered) { if (e.target.checked) slangSelected.add(x.id); else slangSelected.delete(x.id); }
  renderSlangPanel();
});
document.getElementById('slangConfirmedSelectAll').addEventListener('change', (e) => {
  const list = slangEntriesCache.filter((x) => x.status === 'confirmed');
  const q = getSlangSearch();
  const filtered = q ? list.filter((x) => slangSearchFields(x).includes(q)) : list;
  for (const x of filtered) { if (e.target.checked) slangSelected.add(x.id); else slangSelected.delete(x.id); }
  renderSlangPanel();
});
document.getElementById('slangRejectedSelectAll').addEventListener('change', (e) => {
  const list = slangEntriesCache.filter((x) => x.status === 'rejected');
  const q = getSlangSearch();
  const filtered = q ? list.filter((x) => slangSearchFields(x).includes(q)) : list;
  for (const x of filtered) { if (e.target.checked) slangSelected.add(x.id); else slangSelected.delete(x.id); }
  renderSlangPanel();
});
document.getElementById('slangBatchResearch').addEventListener('click', async () => {
  const ids = selectedIdsForStatus('candidate');
  if (!ids.length) { alert('请先勾选要研究的候选词'); return; }
  const r = await api('/api/slang/research', 'POST', { ids });
  setSlangMsg(r.ok ? `✅ 已送 ${r.count} 条候选到 DSH 深度联网研究，完成后刷新查看结果` : ('❌ ' + (r.error || '失败')), r.ok);
  if (r.ok) refreshSlang();
});
document.getElementById('slangBatchConfirm').addEventListener('click', async () => {
  const ids = selectedIdsForStatus('candidate');
  if (!ids.length) { alert('请先勾选要确认的候选词'); return; }
  if (!confirm(`确定批量确认 ${ids.length} 条候选？缺少含义的会被跳过。`)) return;
  const r = await api('/api/slang/batch-confirm', 'POST', { ids });
  setSlangMsg(r.ok ? `✅ 已确认 ${r.confirmedCount} 条，跳过 ${r.skippedCount} 条` : ('❌ ' + (r.error || '失败')), r.ok);
  if (r.ok) { slangSelected.clear(); refreshSlang(); }
});
document.getElementById('slangBatchReject').addEventListener('click', async () => {
  const ids = selectedIdsForStatus('candidate');
  if (!ids.length) { alert('请先勾选要拒绝的候选词'); return; }
  if (!confirm(`确定拒绝 ${ids.length} 条候选？`)) return;
  const r = await api('/api/slang/batch-reject', 'POST', { ids });
  setSlangMsg(r.ok ? `✅ 已拒绝 ${r.rejectedCount} 条` : ('❌ ' + (r.error || '失败')), r.ok);
  if (r.ok) { slangSelected.clear(); refreshSlang(); }
});
document.getElementById('slangBatchDeleteCand').addEventListener('click', async () => {
  const ids = selectedIdsForStatus('candidate');
  if (!ids.length) { alert('请先勾选要删除的候选词'); return; }
  if (!confirm(`确定删除 ${ids.length} 条候选？此操作不可恢复！`)) return;
  const r = await api('/api/slang/batch-delete', 'POST', { ids });
  setSlangMsg(r.ok ? `✅ 已删除 ${r.removedCount} 条候选` : ('❌ ' + (r.error || '失败')), r.ok);
  if (r.ok) { slangSelected.clear(); refreshSlang(); }
});
document.getElementById('slangBatchDeleteConfirmed').addEventListener('click', async () => {
  const ids = selectedIdsForStatus('confirmed');
  if (!ids.length) { alert('请先勾选要删除的已确认词条'); return; }
  if (!confirm(`确定删除 ${ids.length} 条已确认黑话？此操作不可恢复！`)) return;
  const r = await api('/api/slang/batch-delete', 'POST', { ids });
  setSlangMsg(r.ok ? `✅ 已删除 ${r.removedCount} 条已确认` : ('❌ ' + (r.error || '失败')), r.ok);
  if (r.ok) { slangSelected.clear(); refreshSlang(); }
});
document.getElementById('slangBatchDeleteRejected').addEventListener('click', async () => {
  const ids = selectedIdsForStatus('rejected');
  if (!ids.length) { alert('请先勾选要删除的已拒绝词条'); return; }
  if (!confirm(`确定删除 ${ids.length} 条已拒绝词条？此操作不可恢复！`)) return;
  const r = await api('/api/slang/batch-delete', 'POST', { ids });
  setSlangMsg(r.ok ? `✅ 已删除 ${r.removedCount} 条已拒绝` : ('❌ ' + (r.error || '失败')), r.ok);
  if (r.ok) { slangSelected.clear(); refreshSlang(); }
});
document.getElementById('slangBatchRestore').addEventListener('click', async () => {
  const ids = selectedIdsForStatus('rejected');
  if (!ids.length) { alert('请先勾选要恢复的已拒绝词条'); return; }
  let okCount = 0;
  for (const id of ids) {
    const r = await api('/api/slang/' + id, 'PATCH', { status: 'candidate' });
    if (r.ok) okCount++;
  }
  setSlangMsg(`✅ 已恢复 ${okCount}/${ids.length} 条为候选`);
  if (okCount) { slangSelected.clear(); refreshSlang(); }
});
document.getElementById('slangModalDirectConfirm').addEventListener('click', async () => {
  if (!slangModalId) return;
  const payload = readSlangModalPayload();
  if (!payload.meaning) { alert('请先填写含义，确认后才会注入 AI 上下文'); return; }
  const e = slangEntriesCache.find((x) => x.id === slangModalId);
  if (!e) return;
  const path = slangModalMode === 'confirm' ? `/api/slang/${e.id}/confirm` : `/api/slang/${e.id}`;
  const r2 = await api(path, slangModalMode === 'confirm' ? 'POST' : 'PATCH', payload);
  if (!r2.ok) alert(r2.error || '保存失败');
  setSlangMsg(r2.ok ? (slangModalMode === 'confirm' ? '✅ 已确认转正' : '✅ 已保存') : ('❌ ' + (r2.error || '失败')), r2.ok);
  closeSlangModal();
  refreshSlang();
});
document.getElementById('slangModalSendResearch').addEventListener('click', async () => {
  if (!slangModalId) return;
  const r = await api('/api/slang/research', 'POST', { ids: [slangModalId] });
  setSlangMsg(r.ok ? `✅ 已送「${slangEntriesCache.find((x) => x.id === slangModalId)?.content || ''}」到 DSH 深度联网研究，稍后刷新查看结果` : ('❌ ' + (r.error || '失败')), r.ok);
  closeSlangModal();
  refreshSlang();
});
document.getElementById('slangModalCancel').addEventListener('click', closeSlangModal);
document.getElementById('slangModalOverlay').addEventListener('click', (e) => { if (e.target.id === 'slangModalOverlay') closeSlangModal(); });

document.getElementById('slangAdd').addEventListener('click', async () => {
  const content = document.getElementById('slangContent').value.trim();
  const meaning = document.getElementById('slangMeaning').value.trim();
  const usage = document.getElementById('slangUsage').value.trim();
  const example = document.getElementById('slangExample').value.trim();
  if (!content) { alert('词条不能为空'); return; }
  const r = await api('/api/slang', 'POST', { content, meaning, usage, example });
  document.getElementById('slangMsg').textContent = r.ok ? '✅ 已添加' : ('❌ ' + (r.error || '失败'));
  document.getElementById('slangMsg').className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) {
    document.getElementById('slangContent').value = '';
    document.getElementById('slangMeaning').value = '';
    document.getElementById('slangUsage').value = '';
    document.getElementById('slangExample').value = '';
    refreshSlang();
  }
});
document.getElementById('slangExtract').addEventListener('click', async () => {
  const r = await api('/api/slang/extract', 'POST', {});
  setSlangMsg(r.ok ? '✅ 已触发提取' : ('❌ ' + (r.error || '失败')), r.ok);
});
document.getElementById('slangResearch').addEventListener('click', async () => {
  const r = await api('/api/slang/research', 'POST', {});
  setSlangMsg(r.ok ? ('✅ 已触发研究 ' + r.count + ' 条') : ('❌ ' + (r.error || '失败')), r.ok);
});
// 黑话参数面板：同样一张表（元素 id → 配置路径 → 口径）。
const L_FIELDS = [
  ['slangEnabled', 'enabled', 'bool'],
  ['slangExtractMin', 'extractMinMessages', 'intOr', { loadFb: 10, saveFb: 10 }],
  ['slangCooldown', 'extractCooldownMs', 'intOr', { loadFb: 300000, saveFb: 300000 }],
  ['slangThresholds', 'inferenceThresholds', 'numList', { loadFb: [2, 4, 8] }],
  ['slangInjectMax', 'injectMax', 'intOr', { loadFb: 8, saveFb: 8 }],
  ['slangLearnerPreset', 'learnerPreset', 'textOr', { loadFb: 'qq-chat' }],
  ['slangWorkspaceTitle', 'workspaceTitle', 'textOr', { loadFb: 'QQ 黑话学习' }],
  ['slangAutoResearch', 'autoResearch', 'bool']
];
//   bool    默认开的开关：load `v !== false`    save `el.checked`
//   intOr   整数：load `v ?? loadFb`            save `Number(v) || saveFb`（原实现就不夹范围、不取整）
//   numList 数字数组 ↔ 逗号分隔文本：load 数组，或把字符串拆开（旧实现在字符串上会抛异常 → 整个面板加载中断）
//   textOr  文本：load `v || loadFb`            save `el.value.trim()`
const L_KINDS = {
  load: {
    bool: (v) => v !== false,
    intOr: (v, o) => (v === undefined ? o.loadFb : v),
    numList: (v, o) => (Array.isArray(v) ? v : v == null ? o.loadFb : String(v).split(/[,，\s]+/).map(Number).filter(Boolean)).join(', '),
    textOr: (v, o) => v || o.loadFb
  },
  save: {
    bool: (el) => el.checked,
    intOr: (el, o) => Number(el.value) || o.saveFb,
    numList: (el) => el.value.split(/[,，\s]+/).map(Number).filter(Boolean),
    textOr: (el) => el.value.trim()
  }
};

function loadSlangConfig() {
  api('/api/slang').then(r => {
    const c = r.config || {};
    for (const [id, path, kind, opt] of L_FIELDS) {
      const el = document.getElementById(id);
      const val = L_KINDS.load[kind](c[path], opt || {});
      if (kind === 'bool') el.checked = val;
      else el.value = val;
    }
  }).catch(() => {});
}
async function saveSlangConfig() {
  const body = {};
  for (const [id, path, kind, opt] of L_FIELDS) body[path] = L_KINDS.save[kind](document.getElementById(id), opt || {});
  const r = await api('/api/slang/config', 'POST', body);
  const msg = document.getElementById('slangConfigMsg');
  msg.textContent = r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadSlangConfig();
}
document.getElementById('slangConfigSave').addEventListener('click', saveSlangConfig);
function loadSecurity() {
  api('/api/security').then(r => {
    document.getElementById('secInterceptNotify').checked = r.security?.interceptNotify !== false;
  }).catch(() => {});
}
document.getElementById('secSave').addEventListener('click', async () => {
  const r = await api('/api/security', 'POST', { interceptNotify: document.getElementById('secInterceptNotify').checked });
  const msg = document.getElementById('secMsg');
  msg.textContent = r.ok ? '✅ 已保存' : ('❌ ' + (r.error || '失败'));
  msg.className = r.ok ? 'meta ok' : 'meta err';
  if (r.ok) loadSecurity();
});

async function changeConsoleToken(generate) {
  const input = document.getElementById('consoleTokenInput');
  const msg = document.getElementById('consoleTokenMsg');
  const token = generate ? '' : input.value.trim();
  if (!generate && token && token.length < 16) {
    msg.textContent = '❌ 令牌至少需要 16 位';
    msg.className = 'meta err';
    return;
  }
  const r = await api('/api/console/token', 'POST', { token });
  if (!r.ok) {
    msg.textContent = '❌ ' + (r.error || '修改失败');
    msg.className = 'meta err';
    return;
  }
  // 保存到 localStorage，当前页面继续使用新令牌
  localStorage.setItem('consoleToken', r.token);
  input.value = r.token;
  msg.textContent = r.generated ? ('✅ 已生成随机令牌：' + r.token) : '✅ 已保存新令牌';
  msg.className = 'meta ok';
}
document.getElementById('consoleTokenSave').addEventListener('click', () => changeConsoleToken(false));
document.getElementById('consoleTokenRandom').addEventListener('click', () => changeConsoleToken(true));

// ── A1.0 影子组装（只读）─────────────────────────────────────────────────
// 看"如果按新方案组装，这一回合她会看到什么"。用来核对"材料里有没有漏东西"，不改变她的输入。
async function loadContextShadow() {
  const box = document.getElementById('ctxShadowOutput');
  const msg = document.getElementById('ctxShadowMsg');
  // 点击立刻给反馈：即使读失败、或者影子还没留档，也必须看得出"点了有反应"
  msg.textContent = '读取中…';
  box.textContent = '（读取中…）';
  try {
    const r = await api('/api/socialV2/context-shadow?limit=3');
    const entries = r.entries || [];
    if (!entries.length) {
      box.textContent = '（还没有留档：等她跑一个回合，或看看 config.json 里 assembler.shadow 是不是被关了）';
      msg.textContent = '';
      return;
    }
    box.innerHTML = entries.map((e) => {
      const blocks = Object.entries(e.byBlock || {}).map(([k, v]) => `${k} ${v}`).join(' · ');
      const when = new Date(e.at).toLocaleTimeString();
      return `<div style="margin-bottom:8px"><div class="meta">${when}｜${esc(e.key)}｜约 ${e.estTokens} token｜前缀 ${e.prefixHash}${e.wakeReason ? '｜唤醒：' + esc(e.wakeReason) : ''}</div>`
        + `<div class="meta">${esc(blocks)}</div>`
        + `<details><summary class="meta">展开材料全文</summary><pre style="white-space:pre-wrap;max-height:320px;overflow:auto">${esc(e.text)}</pre></details></div>`;
    }).join('');
    msg.textContent = `共 ${entries.length} 份（最多留 20 份）`;
  } catch (error) {
    box.textContent = '读取失败：' + (error?.message ?? error);
  }
}
document.getElementById('ctxShadowLoad').addEventListener('click', loadContextShadow);

// ── 人物与关系（只读）─────────────────────────────────────────────────────
// 她心里给每个人定的档位 + 小标签 + 最近影响关系的那句话。
// 数据源就是 state/memory/people.json —— 和材料里 relationLines 渲染的是同一份，不另建副本。
// 只读面板：这里没有任何写入路径（改档位归她自己，用 qq_memory_append 的 extra.relation/extra.tag）。
const RELATION_COLOR = { '家人': '#e91e63', '好朋友': '#3f8cff', '熟人': '#666', '认识但不太熟': '#888', '路人': '#999', '讨厌': '#d33' };
function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderPeople(data) {
  const box = document.getElementById('peopleList');
  if (!data || !data.ok) { box.innerHTML = '<span class="meta">加载失败</span>'; return; }
  const list = Array.isArray(data.people) ? data.people : [];
  if (!list.length) { box.innerHTML = '<span class="meta">（还没有任何人物记录）</span>'; return; }
  const rows = list.map((p) => {
    const names = Object.values(p.names || {}).filter(Boolean);
    const label = names[0] || p.qq;
    const aliases = names.slice(1);
    const rel = p.relation
      ? `<b style="color:${RELATION_COLOR[p.relation] || '#333'}">${esc(p.relation)}</b>`
      : '<span class="meta">（未定档）</span>';
    const tag = p.tag ? esc(p.tag) : '<span class="meta">—</span>';
    const tagWhen = p.tagAt ? `<div class="meta">${fmtWhen(p.tagAt)}</div>` : '';
    const note = p.relationNote
      ? `${esc(p.relationNote)}${p.relationNoteAt ? ` <span class="meta">${fmtWhen(p.relationNoteAt)}</span>` : ''}`
      : '<span class="meta">—</span>';
    return `<tr><td>${esc(label)}<div class="meta">${esc(p.qq)}</div></td><td>${rel}</td><td>${tag}${tagWhen}</td><td>${note}</td><td>${aliases.length ? esc(aliases.join('、')) : '<span class="meta">—</span>'}</td></tr>`;
  }).join('');
  box.innerHTML = '<table><thead><tr><th>名字</th><th>关系</th><th>小标签</th><th>最近影响关系的话</th><th>别名（别的群/私聊）</th></tr></thead><tbody>'
    + rows + '</tbody></table>'
    + `<div class="meta" style="margin-top:6px">共 ${list.length} 人。档位由近到远排列；关系跟 QQ 走，换群不换档。</div>`;
}
async function loadPeople() {
  const box = document.getElementById('peopleList');
  const msg = document.getElementById('peopleMsg');
  msg.textContent = '读取中…';
  try {
    const r = await api('/api/socialV2/people');
    renderPeople(r);
    msg.textContent = `已加载（${r.count ?? 0} 人）`;
  } catch (error) {
    box.innerHTML = '<span class="meta">读取失败</span>';
    msg.textContent = '❌ ' + (error?.message ?? error);
  }
}
// 说说卡片（只读）：显示今天还能不能发、上一条是什么、账本里最近几条。
// 额度是"发不出去"的硬界限，所以把判据原文（r.error）也直接摆在面板上，别让人猜。
const MOOD_RIGHT_LABEL = { 1: '所有人可见', 4: '好友可见', 16: '部分好友可见', 64: '仅自己可见', 128: '部分好友不可见' };
function renderMood(data) {
  const box = document.getElementById('moodStatus');
  if (!data || !data.ok) { box.innerHTML = '<span class="meta">加载失败</span>'; return; }
  if (data.enabled === false) { box.innerHTML = '<span class="meta">说说功能已关闭（socialV2.qzone.enabled = false）</span>'; return; }
  const verdict = data.allowed
    ? `<b style="color:#2a8a3e">现在可以发</b>`
    : `<b style="color:#d33">现在不能发</b><span class="meta">：${esc(data.error || data.reason || '')}</span>`;
  const head = `<div>今天已发 <b>${data.todayCount ?? 0}</b> / ${data.dailyCap ?? '?'} 条`
    + `　两次至少隔 ${Math.round((Number(data.minGapMs) || 0) / 60000)} 分钟`
    + `　默认权限 ${esc(data.ugcRightLabel || MOOD_RIGHT_LABEL[data.ugcRight] || data.ugcRight || '?')}`
    + `　正文上限 ${data.maxChars ?? '?'} 字</div>`
    + `<div style="margin-top:6px">${verdict}</div>`;
  const posts = Array.isArray(data.posts) ? data.posts : [];
  if (!posts.length) {
    box.innerHTML = head + '<div class="meta" style="margin-top:6px">账本还是空的（她还没发过说说）</div>';
    return;
  }
  const rows = posts.slice().reverse().map((p) => `<tr><td>${fmtWhen(p.at)}</td><td>${esc(p.text)}</td>`
    + `<td>${p.image?.name ? esc(p.image.name) + (p.image.by === 'her' ? '<div class="meta">她自己存的</div>' : '<div class="meta">管理员放的</div>') : '<span class="meta">—</span>'}</td>`
    + `<td>${esc(MOOD_RIGHT_LABEL[p.ugcRight] || p.ugcRight || '')}</td>`
    + `<td class="meta">${p.tid ? esc(p.tid) : '（没拿到 tid）'}</td></tr>`).join('');
  box.innerHTML = head + '<table style="margin-top:8px"><thead><tr><th>时间</th><th>正文</th><th>配图</th><th>权限</th><th>tid</th></tr></thead><tbody>'
    + rows + '</tbody></table>'
    + `<div class="meta" style="margin-top:6px">账本共 ${posts.length} 条（本地只留最近一批）。配图只记"用了哪张图"；图上传到空间相册后<strong>删说说不会把图删掉</strong>。</div>`;
}
async function loadMood() {
  const box = document.getElementById('moodStatus');
  const msg = document.getElementById('moodMsg');
  msg.textContent = '读取中…';
  try {
    const r = await api('/api/socialV2/mood-status');
    renderMood(r);
    msg.textContent = r.allowed ? '现在可以发' : '现在发不了（有额度/间隔限制）';
  } catch (error) {
    box.innerHTML = '<span class="meta">读取失败</span>';
    msg.textContent = '❌ ' + (error?.message ?? error);
  }
}
refresh(); refreshRoles(); refreshWhitelist(); refreshSessions(); refreshPending(); refreshPresets(); loadV2Config(); refreshV2Activity(); loadV2ToolLog(); loadV2SessionOptions(); refreshSlang(); loadSlangConfig(); loadSecurity(); loadContextShadow(); loadPeople(); loadMood();
setInterval(() => { refresh(); refreshSessions(); refreshPending(); refreshSlang(); }, 3000);

// 按钮绑定放在最后一行：控制台 UI 守卫（scripts/check-console-ui.mjs）会把"末尾的初始化段"
// 整段切掉再跑页面（见它 pageScript() 的正则）。放这儿，只读面板的元素就不会混进
// "配置面板金标准"的快照里 —— 这个面板跟配置无关，不该进那份金标准。
document.getElementById('peopleLoad').addEventListener('click', loadPeople);
document.getElementById('moodLoad').addEventListener('click', loadMood);
