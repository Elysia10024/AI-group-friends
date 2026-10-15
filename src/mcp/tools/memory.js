// 记忆：追加 / 查询 / 删除 / 清空
//
// 从 src/mcp-snowluma-safe.js 里按族搬出来的 4 个工具注册；**正文逐字未改**
// （包括缩进 —— 块里可能有模板串，重新缩进会改内容）。
// 注册顺序与本文件在原文里的顺序一致。
import { z } from 'zod';

export function registerMemoryTools(server, { agentApi }) {
server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象（**必须**带 target=群友名字，顶层或 extra.target 都认）；**小标签**：memberImpression 时用 extra.tag 给这个人写一句**极简概括**（如"素质很低，爱说脏话""爱发图，手快"），**只留最新一条**——你对他的看法变了就重新写一句，旧的自动被顶掉；标签只写"他是什么样的人"，具体事件和时间留给印象（content）；**改关系**：memberImpression 时用 extra.relation 填档位（讨厌/路人/认识但不太熟/熟人/好朋友/家人）就能改这个人在你心里的位置——**可升可降，你的判断就是权威**，content 顺手写清是什么事（"他骂我「你怎么不去死」"），那就是以后你回答"为什么讨厌他"时要用的东西；两条硬边界：主人永远是家人、不降档，家人档只能由主人指定（别人最高好朋友）；**mood=你现在的心情**（content 填基调：平静/开心/得意/有点闷/烦躁/期待/心虚/难过，extra.because 填一句来由，extra.intensity 填 1~3）。心情是**全局**的：在一个群受的影响，到别的群还带着；但**跟别人提起时不要说是哪个群**（别人不一定知道还有别的群），只说"别处的事"；没有来由的心情就留空 because（照实说"说不上为什么"）。**只记事实**（他是谁/发生过什么/你的感受），不要写"下次该怎么办"这类规矩。给印象加一个槽位前缀（如「【作息】他早七上课」「【雷点】不爱被提胖」）——**同一槽位的新内容会覆盖旧的**，所以同一件事不会记两遍；没有槽位就按新条目追加。**句子里先写名字、别用"他/她"开头**（指代不清会让她把两个人记混——真实事故：她把"群友乙"和另一个人名片里的"来来"当成同一个人）。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
    // ⚠️ 2026-10-13 修：这个 extra 里**少了一半的键**（relation/tag/tone/because/intensity），
    // 而说明里一直在教她用 `extra.relation` 改关系、`extra.tag` 写小标签 —— zod 对未声明的键是
    // **静默丢掉**（不是报错），所以那些字段在到达桥接之前就没了：
    // 实测她**试过 8 次写 tag，一次都没落库**（人物表里唯一的标签还是我手工写的），
    // 而"改关系"更是一次都没成功过（她连试都没试，因为压根不会生效——试了也白试）。
    // 这类"说明里承诺了、schema 里没有"的坑由 scripts/check-tool-schema.mjs 盯着，别再漏。
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'mood']).describe('记忆类别（mood=记你现在的心情，全局生效）'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象（mood 时填基调：平静/开心/得意/有点闷/烦躁/期待/心虚/难过）'),
    // 顶层 target 是"宽容参数"：实测她 111 次里 7 次顺手写成顶层（schema 没有 → 被拒 → 白跑一步）。
    // 两种写法都认：顶层 target 会在下面被折进 extra.target。
    target: z.string().optional().describe('memberImpression 时的群友名字/昵称（等价于 extra.target，两种写法都认）'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      // 改关系 / 写小标签：这两个是"她自己的判断落地"的唯一入口（说明里写得很细，schema 里必须真有）
      relation: z.enum(['讨厌', '路人', '认识但不太熟', '熟人', '好朋友', '家人']).optional()
        .describe('改这个人在她心里的档位（可升可降，她自己说了算；主人恒为家人、家人只能给主人）'),
      tag: z.string().optional().describe('给这个人写一句极简小标签（只留最新一条，越短越好）'),
      // 心情（category=mood 时用）
      tone: z.string().optional().describe('心情基调（mood 时可用它替代 content）'),
      because: z.string().optional().describe('心情的来由，一句（没有来由就留空）'),
      intensity: z.number().optional().describe('心情强度 1~3'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        // target 是 schema 里的顶层参数，桥接侧读的是 extra.target —— 必须折进去，
      // 否则 memberImpression 每次都会被拒（"需要 extra.target"，实测白跑 7 次）。
      body: JSON.stringify({ key, category, content, extra: { ...(extra || {}), ...(target ? { target } : {}) } }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。**被问到"我上次/在别的群说过什么"时**，加 scope="all"（可再带 query 关键词）去查别的会话——返回里会标明是在哪个群/私聊说的，回答时要说清是在哪儿说的；私聊的内容查不到，别人也看不到你的私聊。返回里的 `timedTraits` 是**带时间的印象**（firstAt=最早提到、lastAt=最近提到、hits=提过几次）——被问"这是什么时候的事/他什么时候说过"就照它答，别答"记不清"；可以再带 person（只看某人）和 since（如 "7d" / "2026-10-01"）收窄。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'mood']).optional().describe('可选：只看某一类记忆；mood=你现在的心情（全局，跨群生效）'),
    scope: z.enum(['this', 'all']).optional().describe('默认 this=本会话；all=连别的会话一起查（回答时标明是哪个群）'),
    query: z.string().optional().describe('scope=all 时的关键词，例如"粥""发图"；不填就列别的会话最近在聊什么'),
    person: z.string().optional().describe('只看某位群友的印象（名字片段即可，如"UserQ"）'),
    since: z.string().optional().describe('只看这段时间之后的条目：7d / 12h / 2026-10-01（不填=不限）'),
    limit: z.number().optional().describe('最多返回几条带时间的印象，默认 20，上限 100')
  },
  async ({ key, token, category, scope, query, person, since, limit }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      if (scope) q.set('scope', scope);
      if (query) q.set('query', query);
      if (person) q.set('person', person);
      if (since) q.set('since', since);
      if (limit != null) q.set('limit', String(limit));
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);
}
