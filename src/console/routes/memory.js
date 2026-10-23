// 控制台路由：memory 域（1 段，共 5 条路由）。
//
// 由 scripts/split-console-domains.mjs从 src/console/server.js 切出来。函数正文与原实现逐字相同，
// 只有两处机械改动：
//   1. 路由块里退出请求处理器的 `return;` → `return true;`（告诉分发器"已处理"）；
//   2. 整体缩进从 6 格降到 2 格。
//
// **段与段的调用顺序不能动**：链里有正则兜底路由（/api/slang/:id(/confirm|/reject)?），
// 它依赖自己在链里的位置。server.js 里按原始顺序依次调用这些段函数。
//
// ctx 来自 server.js：
//   Object.assign(Object.create(deps), { req, res, url, sendJson, readBody, gateSendTool })
// 用 Object.create(deps) 而不是展开，是为了让 deps 上的 get/set 访问器继续生效。
import { recallAcrossConversations, parseSinceMs } from '../../core/memory-recall.js';
import { mergeImpressionRecords } from '../../core/memory.js';
import { memoryFilePath } from '../../core/memory-files.js';
import { applyMoodEvent } from '../../core/mood.js';
import { normalizeRelation, relationFromTrait, resolveRelationWrite } from '../../core/relation.js';
import { matchExistingKey, personShortName, resolvePersonQq, displayNameForQq, QQ_KEY_RE } from '../../core/person-name.js';

/**
 * 覆盖 5 条路由，原 L2627–L2767
 */
export async function handleMemory1(ctx) {
  const {
    agentTokenOk,
    appendMemoryV2,
    atomicWriteJson,
    cfg,
    formatMemoryV2,
    fs,
    getMood,
    setMood,
    setPersonTag,
    setPersonRelation,
    getPeople,
    getSocialV2State,
    path,
    readBody,
    readRoleState,
    redactKnownTokensOnly,
    req,
    ROOT,
    saveSocialV2State,
    sendJson,
    url,
    v2SessionAllowed,
    v2ToolEnabled,
  } = ctx;

  /** 拼绝对路径：记忆文件在 state/memory/ 下（每个会话一个）。 */
  const joinRoot = (...p) => p.reduce((a, b) => path.join(a, b), ROOT);

  /** 当前是不是在扮演别人（≠ 小鲸鱼）。扮演期间记忆读写都要特殊处理。 */
  const roleplayName = () => {
    try {
      const rs = typeof readRoleState === 'function' ? readRoleState() : null;
      const r = String(rs?.role ?? '').trim();
      return r && r !== '小鲸鱼' ? r : '';
    } catch { return ''; }
  };

  /**
   * 破坏性写入前的自动快照（2026-09-21 加）。
   *
   * 起因是一次真实事故：我用 `memory-update` 做连通性测试，随手写了两条"测试一条/测试两条"，
   * 它按设计**整体替换** traits —— 于是拾圆拾圆的 20 条日记当场变成测试字符串。
   * 而记忆只存在 state/social-v2.json（gitignore、无版本历史），
   * 最后只能靠"影子组装记录里渲染过的片段"捞回 12 条，剩下 8 条永久丢失。
   *
   * 所以：**update / remove / clear 这三条会丢数据的路由，动手之前先把该会话的记忆落一份快照**。
   * 快照写在 state/backups/ 下，保留最近 40 份；失败不阻断（快照是尽力而为，但它必须尝试）。
   */
  function snapshotMemory(key, op) {
    try {
      const st = getSocialV2State(key);
      const dir = path.join(ROOT, 'state', 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const file = path.join(dir, `memory-${op}-${stamp}-${String(key).replace(/[^a-zA-Z0-9]+/g, '_')}.json`);
      atomicWriteJson(file, {
        at: new Date().toISOString(),
        op,
        key,
        activeTopics: st.activeTopics ?? [],
        pendingThoughts: st.pendingThoughts ?? [],
        memberImpressions: st.memberImpressions ?? {}
      });
      // 只留最近 40 份，别把 state 目录堆爆
      const all = fs.readdirSync(dir).filter((f) => f.startsWith('memory-')).sort();
      for (const old of all.slice(0, Math.max(0, all.length - 40))) fs.unlinkSync(path.join(dir, old));
    } catch (error) {
      // 快照失败也要留下痕迹，但绝不能因此让写入失败（写入方可能正需要它）
      try { ctx.log?.(`记忆快照失败（${op} ${key}）：${error?.message ?? error}`); } catch { /* 日志失败就放弃 */ }
    }
  }

  /**
   * 「她说的这个名字」→ 记忆表里的**实际 key**（QQ 或还没认领的名字）。
   * 这是路由侧唯一的取 key 入口：直接命中 → 走 core 的 resolvePersonQq → 名字/短名兜底。
   * 注意它**不含任何映射逻辑**，只是把 core 那唯一一份解析接上去（两份逻辑必然走偏）。
   */
  function resolveImpressionKey(target, st, key) {
    const imps = st?.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const raw = String(target ?? '').trim();
    if (!raw) return '';
    if (imps[raw]) return raw;                                   // 已经是 key（QQ 或 pendingQq 的名字）
    const qq = resolvePersonQq(raw, { key, people: getPeople?.(), st });
    if (qq && imps[qq]) return qq;
    const byName = matchExistingKey(raw, Object.keys(imps));
    return byName || (qq && !imps[qq] ? qq : '');
  }

  /** 记忆 key → 给她/给面板看的名字（QQ 反查当前名片；pendingQq 的 key 本身就是名字）。 */
  function impressionLabel(impKey, im, key, st) {
    const k = String(impKey ?? '');
    if (!QQ_KEY_RE.test(k)) return k;
    return displayNameForQq(k, { key, people: getPeople?.(), st, fallback: im?.displayName });
  }

    if (await routeMemoryAppend()) return true;
    if (await routeMemoryUpdate()) return true;
    if (routeMemoryGet()) return true;
    if (routePeople()) return true;
    if (await routeMemoryRemove()) return true;
    if (await routeMemoryClear()) return true;

  return false;

  /**
   * 人物表（只读）：控制台「人物与关系」面板用。
   * 数据源就是 state/memory/people.json（关系/标签/名字），**不另建一份**——
   * 它和材料里 `relationLines` 渲染的是同一份，改一处两边都变。
   */
  function routePeople() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/people') {
      const people = (typeof getPeople === 'function' ? getPeople() : null) ?? {};
      const list = Object.entries(people).map(([qq, rec]) => ({
        qq,
        names: rec?.names && typeof rec.names === 'object' ? rec.names : {},
        relation: String(rec?.relation ?? ''),
        relationAt: Number(rec?.relationAt) || 0,
        relationNote: String(rec?.relationNote ?? ''),
        relationNoteAt: Number(rec?.relationNoteAt) || 0,
        tag: String(rec?.tag ?? ''),
        tagAt: Number(rec?.tagAt) || 0
      }));
      // 排序：档位由近到远，同档按最近一次改动倒序（面板里一眼看清谁最近被动过）
      const order = ['家人', '好朋友', '熟人', '认识但不太熟', '路人', '讨厌', ''];
      list.sort((a, b) => {
        const d = order.indexOf(a.relation) - order.indexOf(b.relation);
        if (d !== 0) return d;
        return Math.max(b.relationAt, b.tagAt) - Math.max(a.relationAt, a.tagAt);
      });
      sendJson({ ok: true, count: list.length, people: list });
      return true;
    }
    return false;
  }

  async function routeMemoryAppend() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const content = String(body.content ?? '').trim();
      const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
      if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return true; }
      const MOOD_CATEGORIES = ['mood'];   // 心情：全局一条，跨会话生效
      if (!['activeTopic', 'pendingThought', 'memberImpression', ...MOOD_CATEGORIES].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / mood' }, 400); return true; }
      if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return true; }
      const st = getSocialV2State(key);
      // 角色扮演期间（当前角色 ≠ 小鲸鱼）：记忆一律打 [扮演:角色] 标签，而且不碰真实的
      // 关系 / 标签 / 心情——那些是那个角色说的话，不是小鲸鱼的（2026-10-19 主人要求，防污染）。
      const playingRole = roleplayName();
      if (category === 'mood') {
        if (playingRole) {
          sendJson({ ok: false, roleplay: true, error: `角色扮演期间不改心情（那是「${playingRole}」的，不是小鲸鱼的），这条没写。` });
          return true;
        }
        // 心情是**全局**的：写进 state/memory/mood.json，所有会话共用（这就是"跨群串联"）。
        // sourceKey 记下"来自哪个会话"——只有她自己/控制台看得到，材料里只写"别处的事"。
        const next = applyMoodEvent(getMood(), {
          tone: String(extra.tone || content).trim(),
          intensity: Number(extra.intensity) || 1,
          because: String(extra.because || '').trim(),
          sourceKey: key,
          now: Date.now()
        });
        setMood(next);
        ctx.log?.(`[心情] ${next.tone}（来自 ${key}${next.because ? `：${next.because}` : ''}）`);
        sendJson({ ok: true, key, category, mood: next });
        return true;
      }
      // 顺序很重要：**先写印象正文**，再处理全局的关系/标签 ——
      // 那边万一认不出人，也不能把已经说好的印象吞掉（真实教训：这两个写入曾经互相顶掉）。
      // 扮演期间的正文带 [扮演:角色] 标签：小鲸鱼切回后看到就知道不是自己说的。
      const savedContent = playingRole ? `[扮演:${playingRole}] ${content}` : content;
      appendMemoryV2(st, category, savedContent, extra, { key });
      let relationOut = null;
      // 「关系：X」不进 traits —— 关系跟 QQ 走（全局），写进 state/memory/people.json。
      if (category === 'memberImpression') {
        if (playingRole) {
          // 扮演期间写的印象只落正文，不改小鲸鱼对真人的关系和标签
          relationOut = { roleplay: true, target: String(extra.target ?? '').trim(), note: `角色扮演期间不改真实关系和标签；这条印象已按 [扮演:${playingRole}] 存下` };
        } else {
        // 关系档位与「小标签」都按 QQ 落在全局人物表，而且两个都能**单独**写。
        const rel = normalizeRelation(extra.relation) || relationFromTrait(content);
        const tagWanted = String(extra.tag ?? '').replace(/\s+/g, ' ').trim();
        if (rel || tagWanted) {
          const rawTarget = String(extra.target ?? '').trim();
          // **只走 core 的那一份解析**（2026-10-15 收拢）。以前这里是第二份：只查本会话
          // recentMessages 的 sender、且只服务关系/标签 —— 印象的 key 完全没用它，于是同一个人
          // 的印象按名字各存一份、关系挂在 QQ 上，两边接不上（"讨厌档没生效"的一半原因）。
          const qq = resolvePersonQq(rawTarget, { key, people: getPeople?.(), st });
          // 面板/回报里给她看的名字：QQ → 当前名片；解析不出就原样回名字
          const target = displayNameForQq(qq || rawTarget, { key, people: getPeople?.(), st, fallback: rawTarget });
          if (!qq) {
            // 印象已经写进去了（key 是名字 + pendingQq），这里如实回报"关系/标签没改"（不静默、也不吞掉印象）。
            relationOut = { target, error: `认不出「${target}」是哪一位（他要在本会话里说过话，名字得和消息里显示的一致；也可以直接给 QQ 号）` };
          } else {
            const out = { qq, target };
            if (tagWanted && typeof setPersonTag === 'function') {
              setPersonTag(qq, tagWanted);
              out.tag = String(getPeople?.()?.[qq]?.tag ?? tagWanted);
              ctx.log?.(`[标签] ${target}（QQ ${qq}）→ ${out.tag}`);
            }
            if (rel) {
              // **她的判断是权威**（2026-10-12 主人定）：直接采纳，升能升、降能降。
              // 旧写法 `setPersonRelation(qq, closerRelation(prev, rel))` 永远取更亲近的那个，
              // 于是"关系变差"永远存不下来（真实 bug —— Qruei 骂她那一次暴露）。
              // 只有两条硬边界会改写她的选择，而且改写了必须如实回报：主人恒为家人、家人只能由主人指定。
              const decision = resolveRelationWrite({ ownerQQ: cfg?.ownerQQ, qq, next: rel });
              if (!decision.ok) {
                out.error = decision.reason;
              } else {
                const prev = getPeople?.()?.[qq]?.relation ?? '';
                setPersonRelation(qq, decision.tier, content);
                ctx.log?.(`[关系] ${target}（QQ ${qq}）：${prev || '（空）'} → ${decision.tier}${decision.adjusted ? `（${decision.adjusted}）` : ''}｜理由：${content}`);
                out.relation = { tier: decision.tier, from: prev || undefined, adjusted: decision.adjusted || undefined, why: content };
              }
            }
            relationOut = out;
          }
        }
        }   // end else：非扮演才改全局关系
      }
      sendJson({
        ok: true,
        key,
        category,
        content: savedContent,
        ...(relationOut ?? {}),
        memory: formatMemoryV2(st, key)
      });
      return true;
    }
    return false;
  }


  async function routeMemoryUpdate() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-update') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const oldContent = String(body.oldContent ?? '').trim();
      const target = redactKnownTokensOnly(String(body.target ?? '').trim());
      const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
      const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
      const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
      const cleanNewExtra = {
        ...newExtra,
        pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
        participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
        motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
        target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
      };
      if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
      if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return true; }
      if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return true; }
      snapshotMemory(key, 'update');
      const st = getSocialV2State(key);
      if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
        const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return true; }
        if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
        if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
        if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
      } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
        const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
        if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return true; }
        if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
        if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
        if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
      } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
        const oldTarget = target;
        if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
        // 旧 key：她给的名字/QQ 都认（QQ 走 core 解析，pendingQq 的名字直接命中）
        const oldKey = resolveImpressionKey(oldTarget, st, key) || oldTarget;
        const im = st.memberImpressions[oldKey] || {};
        // 新 key：**改名也要锚在 QQ 上** —— 能算出 QQ 就用 QQ，算不出才退回名字。
        // 这样她把"杨森"改成"群三水"时，不会又开出一个新名字 key。
        const newRaw = String(cleanNewExtra.target || oldTarget).trim();
        if (!newRaw || ['__proto__', 'constructor', 'prototype'].includes(newRaw)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
        const newQq = resolvePersonQq(newRaw, { key, people: getPeople?.(), st });
        const newTarget = newQq
          || matchExistingKey(newRaw, Object.keys(st.memberImpressions))
          || personShortName(newRaw)
          || newRaw;
        if (newContent !== undefined) {
          im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
          delete im.traitMeta;   // traits 换过了，旧时间对不上号（宁可没时间，也别给错位的时间）
        }
        // 也接受**数组**形式的 traits（逐条原样写入，不切分）。
        // 为什么需要：印象正文里大量使用中文逗号（"今天早七上课，课后还有实验，累了来戳我撒娇"），
        // 走上面的 split 会被切成三段 —— 也就是说修一条印象的正文在这条接口上根本表达不出来。
        // 清理近似重复（scripts/dedupe-memory.mjs 的在线版本）必须逐条写入，所以补这个入参。
        const rawTraits = Array.isArray(body.traits) ? body.traits
          : (Array.isArray(newExtra.traits) ? newExtra.traits : null);
        if (rawTraits) {
          im.traits = rawTraits.map((t) => redactKnownTokensOnly(String(t ?? '')).trim())
            .filter(Boolean).map((t) => t.slice(0, 300)).slice(0, 20);
          delete im.traitMeta;   // 同上：整组换过，时间作废
        }
        if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
        // 认领：改名后如果这个人已经有一条 QQ 记忆（或本来就该锚在 QQ 上），
        // 就把它并进来，别在表里留两个 key 指同一个人。
        if (newTarget && newTarget !== oldKey && st.memberImpressions[newTarget]) {
          const merged = mergeImpressionRecords([st.memberImpressions[newTarget], im]);
          im.traits = merged.traits;
          im.traitMeta = merged.traitMeta;
          im.interactionCount = merged.interactionCount;
          im.lastSeenAt = Math.max(Number(im.lastSeenAt) || 0, Number(st.memberImpressions[newTarget].lastSeenAt) || 0);
        }
        if (newTarget !== oldKey) delete st.memberImpressions[oldKey];
        st.memberImpressions[newTarget] = im;
      }
      saveSocialV2State();
      sendJson({ ok: true, key, category, memory: formatMemoryV2(st, key) });
      return true;
    }
    return false;
  }

  function routeMemoryGet() {
    if (req.method === 'GET' && url.pathname === '/api/socialV2/memory') {
      const key = String(url.searchParams.get('key') ?? '').trim();
      const category = String(url.searchParams.get('category') ?? '').trim();
      // 时间维度（2026-10-12 主人定：**平时不渲染时间**，只在被追问时从这里带出来）：
      //   person = 只看某位群友；since = 只看这段时间之后（7d / 12h / 2026-10-01）；limit = 最多几条。
      const person = String(url.searchParams.get('person') ?? '').trim();
      const sinceMs = parseSinceMs(url.searchParams.get('since'));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return true; }
      const st = getSocialV2State(key);
      // 角色扮演期间：别的会话的记忆也不给她查（本会话的记忆在进入扮演时已被清空）。
      if (roleplayName() && String(url.searchParams.get('scope') ?? '') === 'all') {
        sendJson({
          ok: true, key, roleplay: true, formatted: '',
          raw: { activeTopics: [], pendingThoughts: [], memberImpressions: {} },
          recallHint: '角色扮演期间不查其他会话的记忆。'
        });
        return true;
      }
      const raw = {
        activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
        pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
        memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
      };
      if (category === 'activeTopic') {
        raw.pendingThoughts = [];
        raw.memberImpressions = {};
      } else if (category === 'pendingThought') {
        raw.activeTopics = [];
        raw.memberImpressions = {};
      } else if (category === 'memberImpression') {
        raw.activeTopics = [];
        raw.pendingThoughts = [];
      }
      // person：只看某位群友（名字片段匹配即可；raw 也跟着收窄——调用方要的就是"只看他"）
      // 记忆 key 现在是 QQ，所以过滤前先反查成**当前名片**再比（否则按名字永远筛不到人）。
      if (person) {
        for (const impKey of Object.keys(raw.memberImpressions)) {
          const label = impressionLabel(impKey, raw.memberImpressions[impKey], key, st);
          if (!(label.includes(person) || person.includes(label))) delete raw.memberImpressions[impKey];
        }
      }
      // **对外一律用名字**：记忆 key 现在是 QQ（身份锚点），而面板、`qq_memory_query` 的结果
      // 都直接读 raw.memberImpressions 的 key —— 不换就成了满屏 QQ 号（她看到的也变数字）。
      // 这里把 key 换成当前名片，QQ 放进记录的 `qq` 字段（身份不丢，前端一行都不用改）。
      // 同一会话里两个人同名片时加后缀：宁可显示 `群三水(2)`，也不能让一条记忆被顶掉。
      {
        const used = new Set();
        const labelled = {};
        for (const [impKey, im] of Object.entries(raw.memberImpressions)) {
          const base = impressionLabel(impKey, im, key, st);
          let label = base;
          for (let n = 2; used.has(label); n += 1) label = `${base}(${n})`;
          used.add(label);
          labelled[label] = QQ_KEY_RE.test(impKey) ? { ...im, qq: impKey } : im;
        }
        raw.memberImpressions = labelled;
      }
      // 印象的**时间**单独列一份（traits 本身仍是字符串数组：渲染、前端、旧工具一行都不用改）：
      // 每条带 firstAt=最早提到 / lastAt=最近提到 / hits=提过几次。
      const timedTraits = [];
      for (const [impKey, im] of Object.entries(raw.memberImpressions)) {
        const personLabel = impressionLabel(impKey, im, key, st);
        const traits = Array.isArray(im?.traits) ? im.traits : [];
        const meta = Array.isArray(im?.traitMeta) && im.traitMeta.length === traits.length ? im.traitMeta : [];
        for (let i = 0; i < traits.length; i += 1) {
          const lastAt = Number(meta[i]?.lastAt) || 0;
          // 按时间查的时候，没有时间的条目不出场：不给假时间，也不拿 0 当"很久以前"。
          if (sinceMs > 0 && !(lastAt > 0 && lastAt >= sinceMs)) continue;
          timedTraits.push({
            person: personLabel,
            text: String(traits[i] ?? ''),
            firstAt: Number(meta[i]?.firstAt) || 0,
            lastAt,
            hits: Number(meta[i]?.hits) || 0
          });
        }
      }
      timedTraits.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));   // 最近提过的在前
      const timedTraitsOut = timedTraits.slice(0, limit);
      // 跨会话回忆（scope=all）：被问"我上次在别的群说过什么"时，她按需去查**别的会话**。
      // 规则：材料里只注入本会话（不混淆），这里只在被问到时查；结果标明是哪个会话；
      // **私聊来源不外泄**（群里查不到私聊，别人的私聊也查不到）——判据见 core/memory-recall.js。
      let otherConversations = [];
      if (String(url.searchParams.get('scope') ?? '') === 'all') {
        try {
          const all = JSON.parse(ctx.fs.readFileSync(joinRoot('state', 'social-v2.json'), 'utf8'));
          for (const k of Object.keys(all.conversations ?? {})) {
            if (k === key) continue;
            const file = memoryFilePath(joinRoot('state', 'memory'), k);
            if (!file || !ctx.fs.existsSync(file)) continue;
            otherConversations.push({ key: k, memory: JSON.parse(ctx.fs.readFileSync(file, 'utf8')) });
          }
        } catch { otherConversations = []; }
      }
      // 跨会话回忆也按**名字**呈现：把别的会话里以 QQ 为 key 的印象换成那边的当前名片
      // （不换的话她查"在别的群说过什么"会看到一串 QQ 号，`person` 过滤也会全部失效）。
      // 同一会话里两个人同名片时加后缀 —— 宁可显示 `群三水(2)`，也不能让一条记忆被顶掉。
      const labelledConversations = otherConversations.map((conv) => {
        const used = new Set();
        const imps = {};
        for (const [impKey, im] of Object.entries(conv?.memory?.memberImpressions ?? {})) {
          const base = impressionLabel(impKey, im, conv.key, null);
          let label = base;
          for (let n = 2; used.has(label); n += 1) label = `${base}(${n})`;
          used.add(label);
          imps[label] = im;
        }
        return { key: conv.key, memory: { ...conv.memory, memberImpressions: imps } };
      });
      const recall = otherConversations.length
        ? recallAcrossConversations({
          conversations: labelledConversations,
          requesterKey: key,
          query: String(url.searchParams.get('query') ?? ''),
          person,
          sinceMs,
          max: Math.min(8, limit)
        })
        : [];
      sendJson({
        ok: true,
        key,
        category,
        formatted: formatMemoryV2({ ...st, ...raw }, key),
        raw,
        timedTraits: timedTraitsOut.length ? timedTraitsOut : undefined,
        timedTraitsHint: timedTraitsOut.length
          ? '每条印象都带时间：firstAt=最早提到、lastAt=最近提到、hits=提过几次。被问"这是什么时候的事"就照它答，别答"记不清"。'
          : undefined,
        recall: recall.length ? recall : undefined,
        recallHint: recall.length ? '上面这些来自**别的会话**（已在每行标出是哪个群/私聊），回答时要说清是在哪儿说的。' : undefined
      });
      return true;
    }
    return false;
  }

  async function routeMemoryRemove() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-remove') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      const content = String(body.content ?? '').trim();
      const target = String(body.target ?? '').trim();
      if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return true; }
      if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
      if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return true; }
      if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
      if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return true; }
      snapshotMemory(key, 'remove');
      const st = getSocialV2State(key);
      if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
        st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
      } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
        st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
      } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
        // 名字 / QQ 都认：先解析成实际 key（QQ 或 pendingQq 的名字），解析不出才原样删（兼容老行为）
        const impKey = resolveImpressionKey(target, st, key);
        if (impKey) delete st.memberImpressions[impKey];
        else delete st.memberImpressions[target];
      }
      saveSocialV2State();
      sendJson({ ok: true, key, category, memory: formatMemoryV2(st, key) });
      return true;
    }
    return false;
  }

  async function routeMemoryClear() {
    if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-clear') {
      const body = await readBody();
      const key = String(body.key ?? '').trim();
      const category = String(body.category ?? '').trim();
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return true; }
      if (category && !['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return true; }
      if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return true; }
      if (req.headers['x-agent-token'] && !v2ToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return true; }
      snapshotMemory(key, 'clear');
      const st = getSocialV2State(key);
      if (!category || category === 'activeTopic') st.activeTopics = [];
      if (!category || category === 'pendingThought') st.pendingThoughts = [];
      if (!category || category === 'memberImpression') st.memberImpressions = {};
      saveSocialV2State();
      sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st, key) });
      return true;
    }
    return false;
  }
}
