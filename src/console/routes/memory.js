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
import { memoryFilePath } from '../../core/memory-files.js';
import { applyMoodEvent } from '../../core/mood.js';
import { normalizeRelation, relationFromTrait, resolveRelationWrite } from '../../core/relation.js';

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

  /**
   * 破坏性写入前的自动快照（2026-09-21 加）。
   *
   * 起因是一次真实事故：我用 `memory-update` 做连通性测试，随手写了两条"测试一条/测试两条"，
   * 它按设计**整体替换** traits —— 于是群友乙的 20 条日记当场变成测试字符串。
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
      if (category === 'mood') {
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
      appendMemoryV2(st, category, content, extra);
      let relationOut = null;
      // 「关系：X」不进 traits —— 关系跟 QQ 走（全局），写进 state/memory/people.json。
      if (category === 'memberImpression') {
        // 关系档位与「小标签」都按 QQ 落在全局人物表，而且两个都能**单独**写。
        const rel = normalizeRelation(extra.relation) || relationFromTrait(content);
        const tagWanted = String(extra.tag ?? '').replace(/\s+/g, ' ').trim();
        if (rel || tagWanted) {
          const rawTarget = String(extra.target ?? '').trim();
          // target 直接给 QQ 号时，尽量换成他**在本会话的显示名** ——
          // 否则同一个人会被记成两个 key（"UserQ" 和 "10000002"），面板和材料里就成了两个人。
          const target = /^\d{5,12}$/.test(rawTarget)
            ? (String(getPeople?.()?.[rawTarget]?.names?.[key] ?? '').trim() || rawTarget)
            : rawTarget;
          // target 可以是群友名字，也可以**直接给 QQ 号**（名字查不到时留 QQ 号兜底）：
          // 他不在最近消息窗口里时（窗口被刷掉、刚被从忽略名单放出来）只有 QQ 号认得出来。
          const qq = /^\d{5,12}$/.test(rawTarget)
            ? rawTarget
            : String((st.recentMessages ?? []).find((m) => !m.isSelf && String(m.sender ?? '').trim() === target)?.userId ?? '').trim();
          if (!qq) {
            // 印象已经写进去了，这里如实回报"关系/标签没改"（不静默、也不吞掉印象）。
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
              // 于是"关系变差"永远存不下来（真实 bug —— UserQ 骂她那一次暴露）。
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
      }
      sendJson({
        ok: true,
        key,
        category,
        content,
        ...(relationOut ?? {}),
        memory: formatMemoryV2(st)
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
        const im = st.memberImpressions[oldTarget] || {};
        const newTarget = String(cleanNewExtra.target || oldTarget).trim();
        if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return true; }
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
        if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
        st.memberImpressions[newTarget] = im;
      }
      saveSocialV2State();
      sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
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
      if (person) {
        for (const name of Object.keys(raw.memberImpressions)) {
          if (!(name.includes(person) || person.includes(name))) delete raw.memberImpressions[name];
        }
      }
      // 印象的**时间**单独列一份（traits 本身仍是字符串数组：渲染、前端、旧工具一行都不用改）：
      // 每条带 firstAt=最早提到 / lastAt=最近提到 / hits=提过几次。
      const timedTraits = [];
      for (const [name, im] of Object.entries(raw.memberImpressions)) {
        const traits = Array.isArray(im?.traits) ? im.traits : [];
        const meta = Array.isArray(im?.traitMeta) && im.traitMeta.length === traits.length ? im.traitMeta : [];
        for (let i = 0; i < traits.length; i += 1) {
          const lastAt = Number(meta[i]?.lastAt) || 0;
          // 按时间查的时候，没有时间的条目不出场：不给假时间，也不拿 0 当"很久以前"。
          if (sinceMs > 0 && !(lastAt > 0 && lastAt >= sinceMs)) continue;
          timedTraits.push({
            person: name,
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
      const recall = otherConversations.length
        ? recallAcrossConversations({
          conversations: otherConversations,
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
        formatted: formatMemoryV2({ ...st, ...raw }),
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
        delete st.memberImpressions[target];
      }
      saveSocialV2State();
      sendJson({ ok: true, key, category, memory: formatMemoryV2(st) });
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
      sendJson({ ok: true, key, category: category || 'all', memory: formatMemoryV2(st) });
      return true;
    }
    return false;
  }
}
