// 上下文影子组装（A1.0 影子模式）：照常走现在的长会话，**另外**生成一份"如果按新方案组装，
// 这一回合她会看到什么"，落盘并在控制台可看。
//
// 三条纪律（这就是"后路"）：
//   1. **只读旁路**：不改她的输入、不写她的状态、不新建会话；只读 state 与追加一个影子文件；
//   2. **任何异常都不许影响回合**：整个函数体包在 try/catch 里，出错只记一行日志；
//   3. **一个开关就能关掉**：`cfg.socialV2.context.assembler.shadow === false` 立即停写。
//
// 为什么先做影子而不是直接切：切了就是"她失忆"（静默故障）。影子模式零风险，
// 可以拿真实回合逐条核对"材料里的东西 ≤ 她现在实际看到的"，确认没漏料再切。
import { assembleContextV2, estimateTokens } from '../core/assembler.js';
import { mentionLabel } from '../core/mention-label.js';
import { wakeReasonLine } from '../core/wake-reason-label.js';
import { DEFAULT_MENTION_TTL_MS, fmtClock, liveMentions } from '../core/mention-window.js';
import { relativeDayLabel } from '../core/local-day.js';
import { displayNameForQq } from '../core/person-name.js';
import { renderMessageLine, relationTagOf } from '../core/msg-line.js';
import { foreignPersonLines } from '../core/person-crossref.js';
import { buildPeopleIndex, crossGroupAliasLines } from '../core/people-index.js';
import { moodLine } from '../core/mood.js';
import { relationLines } from '../core/relation.js';
import { renderMomBlock } from '../core/mom-channel.js';
import { pickCrossEntries, formatCrossBlock, redactText } from '../core/cross-memory.js';
import { formatActivityBlock } from '../core/whale-activity.js';

import { readStateFile, stamp } from '../core/state-schema.js';

export function createContextShadowModule(ctx) {
  const {
    CONTEXT_SHADOW_FILE,
    atomicWriteJson,
    buildSlangContext,
    cfg,
    formatMemoryV2,
    getMemberName,
    getMood,
    // 妈妈留言的渲染默认读真实 state 文件（生产行为不变）；测试注入空串做隔离。
    getMomBlock = renderMomBlock,
    getPeople,
    getOtherConversations,
    getOverlay,
    getExpressionBlock,
    getRoleCore,
    getSocialV2State,
    imageLibraryIndexText,
    isRoleplay,
    log,
    readJsonSafe,
    recentBiliNotes = () => [],
    recentActivity = () => [],
    flags,
  } = ctx;

  const MAX_ENTRIES = 20;    // 影子里最多留最近 20 个回合（够核对，也不会撑大 state 目录）
  const MAX_RECENT = 40;     // 先取最近 40 条原文；再加长由组装器的字符上限兜底

  // 消息行的相对日子：跨天就标（minDays = 1），印象那边是 2 —— 两处共用 core 的 relativeDayLabel，
  // 只是门限不同。为什么消息行要跨天就标：这块叫"最近群聊"，最容易把昨天/前天的话读成"现在"
  // （真实诱因：`[10/12 02:49] …白天还有早八` 躺在"最近群聊"里，她 10/14 深夜当成了当晚的话）。
  // 为什么并进**时间方括号**里而不是句尾：她扫一眼时钟前缀就会看见；放句尾会被当成消息正文的一部分。
  // 时钟本身沿用 fmtClock 的统一口径（今天 `14:03` / 昨天 `昨天 22:10` / 更早 `10/12 02:49`），
  // 只在后面追加 —— 注意"昨天"那一档 fmtClock 已经写了"昨天"，这时不再重复追加（`[昨天 22:10 · 昨天]` 是废话）。
  const MSG_DAY_MIN_DAYS = 1;
  const clockOf = (m, now) => {
    const clock = fmtClock(m?.time, now);
    if (!clock) return '';
    const ago = relativeDayLabel(m?.time, now, undefined, MSG_DAY_MIN_DAYS);
    return ago && !clock.startsWith(ago) ? `${clock} · ${ago}` : clock;
  };

  const fmtRecent = (msgs, now = Date.now()) => (Array.isArray(msgs) ? msgs.slice(-MAX_RECENT) : [])
    .map((m) => renderMessageLine(m, { clock: clockOf(m, now), text: m?.plain ?? m?.text, tag: relationTagOf(getPeople(), m?.userId) })).join('\n');

  const fmtUnread = (st, now = Date.now()) => (Array.isArray(st?.unread) ? st.unread.slice(-10) : [])
    .map((m) => `- ${renderMessageLine(m, { clock: clockOf(m, now), text: m?.plain ?? m?.text, tag: relationTagOf(getPeople(), m?.userId) })}`).join('\n');

  // 「有人在找你」只写**她还没看过**（seq 水位线没过）且**没超 TTL**（默认 2 小时）的。
  // 判据与收尾销账共用 src/core/mention-window.js —— 三处各写一遍必然走偏。
  // 真实事故：材料侧以前完全不判，把 13 小时前、她已经回过的 @ 又投给她 → 她又回了一遍。
  const mentionTtlMs = Number(cfg.socialV2?.context?.mentionTtlMs) || DEFAULT_MENTION_TTL_MS;

  // 跨会话人物补充：本会话消息里出现的人，如果印象记在别的会话，就搬一行过来。
  // 只在真的提到时才补（最多 3 人 × 2 条），不是无脑全塞。
  //
  // 记忆的 key 自 2026-10-15 起是 **QQ 号**（身份锚点），而这里要在**聊天文本里按名字找人**
  // （`foreignPersonLines` 拿名字去 hay 里 includes）—— 所以必须先反查成名字再传进去，
  // 否则 key 是数字、永远匹配不上，整块跨会话补料会**静默失效**（不报错、只是她又不认识人了）。
  const impressionLabel = (impKey, im, convKey, st = null) => displayNameForQq(impKey, {
    key: convKey,
    people: getPeople(),
    st,
    fallback: im?.displayName
  });
  const fmtForeignPersons = (st, convKey) => {
    try {
      const others = (getOtherConversations(convKey) ?? []).map((c) => ({
        key: c?.key,
        memberImpressions: Object.fromEntries(Object.entries(c?.memberImpressions ?? {})
          .map(([k, im]) => [impressionLabel(k, im, c?.key), im]))
      }));
      const hay = [
        ...(Array.isArray(st?.recentMessages) ? st.recentMessages.slice(-MAX_RECENT) : []),
        ...(Array.isArray(st?.unread) ? st.unread : [])
      ].map((m) => `${m?.plain ?? m?.text ?? ''}`).join('\n');
      const out = [];
      // ① 跨群认人（按 QQ）：本会话说话的人如果在别的会话另有名字 → 明确写"是同一个人"。
      //    这条正是"拾圆拾圆/来来"那类事故的解药：身份由 QQ 锚定，不靠名字像不像。
      const index = buildPeopleIndex([{ key: convKey, recentMessages: st?.recentMessages ?? [] }, ...others]);
      const aliasLines = crossGroupAliasLines({ index, convKey, speakers: st?.recentMessages ?? [], max: 3 });
      if (aliasLines.length) out.push(`【同一个人，别的群另有名字】\n${aliasLines.join('\n')}`);
      // ② 本会话提到、印象记在别处的人 → 补一小块印象（避免"XXX 又是谁啊"）。
      if (hay) {
        const lines = foreignPersonLines({
          text: hay,
          // 本会话已有印象的人（也要用名字，`ownNames` 内部按短名比）
          ownNames: Object.entries(st?.memberImpressions ?? {}).map(([k, im]) => impressionLabel(k, im, convKey, st)),
          others
        });
        if (lines.length) out.push(`【别处记过的人】\n${lines.join('\n')}`);
      }
      return out.join('\n\n');
    } catch (error) {
      // 补料失败绝不影响回合 —— 但**必须留痕**（静默失败会让"她突然不认识人"无从排查）。
      log(`[材料] 跨会话人物补料失败（已忽略）：${error?.message ?? error}`);
      return '';
    }
  };
  const fmtMentions = (st) => liveMentions(st?.pendingMentions, {
    fetchedSeq: Number(st?.lastFetchedSeq) || 0,
    now: Date.now(),
    ttlMs: mentionTtlMs
  }).slice(-5).map((m) => `- [${fmtClock(m?.at)}] ${m?.sender || '?'} ${mentionLabel(m)}：「${m?.text ?? ''}」`).join('\n');

  // 时间感（轻度）：她知道"现在几点"和"距上次说话多久"。放在状态块（属于尾部，不污染稳定前缀缓存）。
  const fmtNow = () => {
    const d = new Date();
    const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    const h = d.getHours();
    const part = h < 5 ? '凌晨' : h < 9 ? '清晨' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '夜里' : '深夜';
    return `${d.getMonth() + 1}月${d.getDate()}日 ${wd} ${String(h).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}（${part}）`;
  };
  const fmtGap = (st) => {
    const last = Number(st?.lastIncomingAt) || 0;
    if (!last) return '距上次说话：这是第一次';
    const mins = Math.max(0, Math.round((Date.now() - last) / 60000));
    if (mins < 1) return '距上次说话：刚刚';
    if (mins < 60) return `距上次说话：${mins} 分钟`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `距上次说话：${hours} 小时${mins % 60 ? ` ${mins % 60} 分` : ''}`;
    return `距上次说话：${Math.floor(hours / 24)} 天`;
  };

  const fmtStatus = (st, key = '') => {
    const wc = st?.wakeConfig ?? {};
    const tr = wc.triggers ?? {};
    const on = ['atMention', 'nameMention', 'question', 'poke', 'anyMessage'].filter((k) => tr[k]);
    // 订阅（speakerIds）必须列出来：不写的话，她被"订阅的人说话"叫醒时会以为有人 @ 她
    // （真实事故 2026-09-30：她看到群里飘着 @AF，就认定是在叫她）。
    const subs = Array.isArray(tr.speakerIds) ? tr.speakerIds.filter(Boolean) : [];
    // 群号从 key 拿（状态对象里没有 key 字段 —— 踩过一次，写成 st.key 结果永远是空的）
    const gid = String(key).startsWith('group:') ? String(key).slice(6) : '';
    const subLabel = subs.map((q) => {
      let name = '';
      try { name = getMemberName(gid, q); } catch { name = ''; }
      return name ? `${name}(${q})` : String(q);
    });
    return [
      `现在：${fmtNow()}`,
      fmtGap(st),
      // 心情是全局的（跨群串联）：在别的群受的影响，这里也带着；**不写别的群的名字**。
      moodLine(getMood(), key),
      `唤醒模式：${wc.mode === 'active' ? '活跃' : '潜水'}${wc.infinite ? '（无限期）' : (wc.sleepUntil ? `（睡到 ${wc.sleepUntil}）` : '')}`,
      `触发条件：${on.join('/') || '（无）'}${Number(tr.probability) > 0 ? ` 概率 ${tr.probability}` : ''}`,
      subs.length ? `你订阅了（他们一说话就叫醒你，不代表在 @ 你）：${subLabel.join('、')}` : '',
      `未读 ${Array.isArray(st?.unread) ? st.unread.length : 0} 条`
    ].filter(Boolean).join('\n');
  };

  /** 取当前状态、组装出一份材料（影子与 A1.1 正式投递**共用这一个实现**，避免两条路走偏）。 */
  function buildMaterialV2(key, extra = {}) {
    const st = getSocialV2State(key);
    // 角色扮演期间：记忆、跨会话补料、关系表都不注入 —— 那是小鲸鱼的东西，角色不该继承
    // （2026-10-19 主人要求：扮演的角色看不到小鲸鱼的记忆）。按 key 判断：群里宠物、私聊小鲸鱼。
    const roleplay = isRoleplay(key) === true;
    // 取一次"现在"给 recent / 未读共用：两块的相对日子用同一个基准，免得同一份材料里
    // 一个块说"昨天"、另一个块说"前天"（跨零点那一分钟真会发生）。
    const now = Date.now();
    // facts 块**不再**重复渲染印象/话题/想法（那批内容统一由 memory 块渲染，见下）。
    // 现在它只放"规则化事实"，其中第一件就是**本地图库清单**（她能发哪些图、名字即语义）：
    // 不清单化她就不知道图库里有什么，只能瞎猜名字；57 张只列名字+标签约 900 字，便宜且稳定。
    const facts = [
      // 妈妈留言（2026-10-22）：她给妈妈留的话，妈妈回来的一两句——最显眼的位置。
      // 可注入（ctx.getMomBlock）：测试必须能在不依赖真实 state/mom-channel.json 的情况下跑，
      // 否则「facts 块为空」那两条断言会在有真实留言的机器上变红（2026-10-24 修）。
      roleplay ? '' : getMomBlock(),
      // 会话级"地方设定"（这个群/这个私聊的氛围、熟人、规矩）放最前面：它比图库清单更"当前"。
      getOverlay(key),
      // 本会话提到、但印象记在**别的会话**里的人 → 补一小块（否则私聊里会出现"XXX 又是谁啊"）。
      // 关系（五档）跟 QQ 走：同一个 QQ 在任何群读到的都是同一档，但**用当前群的名字**称呼。
      (() => {
        try {
          if (roleplay) return '';                     // 扮演期间不给她看小鲸鱼的关系表
          const lines = relationLines({ people: getPeople(), speakers: st?.recentMessages ?? [], max: 8 });
          return lines.length ? `【你和他们的关系】\n${lines.join('\n')}` : '';
        } catch { return ''; }
      })(),
      // 同一个人、不同叫法：当前会话出现的人若在其他会话有别的名字，显式说明是同一人（2026-10-30 主人要求）。
      roleplay ? '' : (() => {
        try {
          const people2 = getPeople() ?? {};
          const ids = new Set((Array.isArray(st?.recentMessages) ? st.recentMessages : []).map((m) => String(m?.userId ?? m?.sender?.user_id ?? '')).filter(Boolean));
          const lines = [];
          for (const qq of ids) {
            const names = people2[qq]?.names ?? {};
            const uniq = [...new Set(Object.values(names).map((x) => String(x ?? '').trim()).filter(Boolean))];
            if (uniq.length < 2) continue;
            const curName = String(names[key] ?? '');
            const others = uniq.filter((n) => n !== curName).slice(0, 2);
            if (!others.length) continue;
            lines.push(`- ${curName || uniq[0]}：在别处也叫 ${others.map((n) => `「${n}」`).join('、')}——**同一个人**，别当成两个人`);
            if (lines.length >= 4) break;
          }
          return lines.length ? `【同一个人，不同叫法】\n${lines.join('\n')}` : '';
        } catch { return ''; }
      })(),      roleplay ? '' : fmtForeignPersons(st, key),
      // 表达方式（「场景 → 怎么说」）：只给这个群确认过的，最多 3 条；扮演期间不给。
      roleplay ? '' : getExpressionBlock(key),
      // 她的活动公共日志（最近 5 条）：刷视频/发图/说过的话，跨会话可见，昵称做代号脱敏。
      roleplay ? '' : (() => {
        try {
          const acts = recentActivity(5);
          if (!Array.isArray(acts) || !acts.length) return '';
          const peopleNow2 = getPeople() ?? {};
          const aliases2 = Object.fromEntries(Object.entries(peopleNow2).filter(([, r]) => r?.codeName).map(([q, r]) => [q, String(r.codeName)]));
          return formatActivityBlock(acts.map((a) => ({ ...a, text: redactText(a.text, { people: peopleNow2, aliases: aliases2 }) })), { limit: 5 });
        } catch { return ''; }
      })(),      // 图库清单是小鲸鱼的东西：扮演期间不给她看（宠物连发图工具都没有，2026-10-27 隔离）。
      roleplay ? '' : imageLibraryIndexText(),
      // 她最近看过的视频（自刷 + 群友分享）：2026-10-30 主人发现"问她刷过什么视频，她说没刷过"——
      // 记录在 state/bili-notes.json 但材料里没带，她看不见自己刷过什么。这里补最近 5 条。
      roleplay ? '' : (() => {
        try {
          const notes = recentBiliNotes(5);
          if (!Array.isArray(notes) || !notes.length) return '';
          const lines = notes.map((n) => {
            const d = new Date(Number(n?.at) || 0);
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            const k = String(n?.key || '');
            const where = k.startsWith('group:') ? '群里' : k.startsWith('private:') ? '私聊里' : '';
            const how = n?.source === 'share' ? '别人分享的' : '自己刷到的';
            return `- ${hh}:${mm} ${where}${how}：《${String(n?.title || '').slice(0, 30)}》`;
          });
          return `【你最近看过的视频】（你自己刷到的/别人分享的，聊到视频时可以提）\n${lines.join('\n')}`;
        } catch { return ''; }
      })()
    ].filter(Boolean).join('\n\n');
    const trigger = [
      wakeReasonLine(extra.wakeReason || st.lastWakeReason),
      fmtMentions(st) ? `【有人在找你】\n${fmtMentions(st)}` : '',
      fmtUnread(st, now) ? `【未读原文（前 10 条）】\n${fmtUnread(st, now)}` : ''
    ].filter(Boolean).join('\n\n');
    // 黑话块的排序依据：本轮可见的聊天原文（命中的梗排前面，其余按热度补齐）。
    const slangHaystack = [
      ...(Array.isArray(st?.recentMessages) ? st.recentMessages.slice(-MAX_RECENT) : []),
      ...(Array.isArray(st?.unread) ? st.unread : [])
    ].map((m) => `${m?.plain ?? m?.text ?? ''}`).join('\n');
    return assembleContextV2({
      // 人格核心放最前（稳定块，参与前缀缓存）：她每轮都能看到自己是谁——
      // 以前只有预设里那份"小抄"每轮在，人格卡要她自己去 qq_get_prompt 拉，实测经常整轮不拉。
      role: getRoleCore(key),
      facts,
      memory: roleplay ? '' : [formatMemoryV2(st, key), (() => { try { const cm = cfg.socialV2?.crossMemory ?? {}; if (cm.enabled === false) return ''; const recentText = (Array.isArray(st?.recentMessages) ? st.recentMessages : []).map((m) => String(m?.plain ?? m?.text ?? '')).join(' '); const peopleNow = getPeople() ?? {}; const aliases = Object.fromEntries(Object.entries(peopleNow).filter(([, r]) => r?.codeName).map(([q, r]) => [q, String(r.codeName)])); const others = getOtherConversations(key); const traits = (Array.isArray(others) ? others : []).flatMap((s) => Object.entries(s?.memberImpressions ?? {}).flatMap(([q, im]) => (Array.isArray(im?.traits) ? im.traits : []).map((text, i) => ({ qq: q, text, at: Number(im?.traitMeta?.[i]?.lastAt) || 0 })))); return formatCrossBlock(pickCrossEntries({ currentKey: key, snapshots: others, traits, people: peopleNow, aliases, max: Math.max(1, Math.min(6, Number(cm.max) || 4)), maxChars: Math.max(60, Math.min(600, Number(cm.maxChars) || 240)), recentText })); } catch { return ''; } })()].filter(Boolean).join('\n\n'),
      // 黑话表也是小鲸鱼的：扮演期间不给看（宠物不需要懂"烧货/大隐鲸"这些梗，2026-10-27 隔离）。
      slang: roleplay ? '' : buildSlangContext(flags.slangEntries, cfg.slang?.injectMax ?? 8, slangHaystack),
      status: fmtStatus(st, key),
      recent: fmtRecent(st.recentMessages, now),
      trigger
    });
  }

  /** 生成并落盘一份影子组装；返回条目（失败返回 null，绝不抛）。 */
  function recordShadowAssembly(key, extra = {}) {
    try {
      if (cfg.socialV2?.context?.assembler?.shadow === false) return null;
      if (!key) return null;
      const st = getSocialV2State(key);
      const assembled = buildMaterialV2(key, extra);

      const entry = {
        at: Date.now(),
        key,
        wakeReason: extra.wakeReason || st.lastWakeReason || '',
        prefixHash: assembled.prefixHash,
        chars: assembled.chars,
        estTokens: estimateTokens(assembled.chars),
        byBlock: assembled.stats.byBlock,
        // 正式切换后，把"真正发出去的提示"也留一份 —— 这才是覆盖度核对的**地面真值**
        actualPrompt: extra.actualPrompt ? String(extra.actualPrompt).slice(0, 4000) : '',
        text: assembled.text
      };
      const prev = readStateFile('context-shadow', CONTEXT_SHADOW_FILE, { entries: [] });
      const entries = [...(Array.isArray(prev?.entries) ? prev.entries : []), entry].slice(-MAX_ENTRIES);
      atomicWriteJson(CONTEXT_SHADOW_FILE, stamp('context-shadow', { updatedAt: Date.now(), entries }));
      log(`[影子组装] ${key}：约 ${entry.estTokens} token、前缀 ${entry.prefixHash}（仅观测，未改变她的输入）`);
      return entry;
    } catch (error) {
      // **后路**：影子路径出错绝不影响回合
      log(`[影子组装] 失败（已忽略，不影响回合）：${error?.message ?? error}`);
      return null;
    }
  }

  /** 控制台读最近几份（倒序）。 */
  function readShadowAssemblies(limit = 5) {
    const data = readStateFile('context-shadow', CONTEXT_SHADOW_FILE, { entries: [] });
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    return { updatedAt: data?.updatedAt ?? 0, entries: entries.slice(-Math.max(1, limit)).reverse() };
  }

  return { recordShadowAssembly, readShadowAssemblies, buildMaterialV2 };
}
