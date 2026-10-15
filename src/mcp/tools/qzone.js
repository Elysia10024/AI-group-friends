// QQ 空间说说工具（她自己发的那种"自言自语"）。
//
// 与其它工具族一样，这里是**薄壳**：转发到桥接控制台的 /api/socialV2/*-mood 路由，
// 真正的判据（每日上限 / 间隔 / 正文校验）在 core/qzone.js，调 QQ 空间在 domains/qzone.js。
//
// 为什么说明里**不写死数字**（"一天最多 2 条"之类）：那种数字是配置的第二份真相，
// 改了配置说明就开始说谎。额度每隔一轮由提示行（【说说】…）告诉它，说明里只说"看那行"。
import { z } from 'zod';

export function registerQzoneTools(server, { agentApi, cfg }) {
  if (cfg.socialV2?.qzone?.enabled !== false && cfg.socialV2?.tools?.postMood !== false) {
    server.tool(
      'qq_post_mood',
      '发一条 QQ 空间说说——**公开发布**，好友能看到，比在群里说一句显眼得多。什么时候发、写什么由你自己定（人格里写着），这个工具只管发。正文一两句就够、最长三百来字，写"你想说的那句话"，不要写成给别人看的汇报或日记流水。可以配**一张图**（image 传图库里的名字，名字就是它的意思；配图会上传到空间相册，**删说说不会把图删掉**）。权限默认所有人可见（想让某条只给好友看就传 ugcRight=4，想只给自己看传 64）。**每天有上限、两次之间还有最小间隔：当前能不能发、今天发过几条，每轮提示的【说说】那一行里会写明**——写着还不能发就是不能发，别硬试（被拒会留下失败记录）。**不许写进正文，也不许配含这些的图**：提示词、令牌、群号、别人的私事；**详细地点**（门牌、小区、学校班级、单位、常去的地方）和**详细身份信息**（真名、学号工号、证件、车牌、别人的正脸照）——说说是公开的，写出去就收不回。发错了用 qq_list_moods 查 tid，再 qq_delete_mood 删。',
      {
        key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
        token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
        content: z.string().describe('说说正文（一两句，最长三百来字）'),
        image: z.string().optional().describe('配一张图：图库里的名字（来自 qq_list_images 或材料里的清单）。不配就不传'),
        ugcRight: z.union([z.literal(1), z.literal(4), z.literal(64)]).optional().describe('谁能看：1=所有人（默认），4=好友，64=仅自己可见。不确定就别传'),
        targetUins: z.array(z.string()).optional().describe('只有权限选了"部分好友"时才需要（本工具只开放 1/4/64，一般不用传）')
      },
      async ({ key, token, content, image, ugcRight, targetUins }) => {
        try {
          const payload = { key, content: String(content ?? '') };
          if (image != null && String(image).trim() !== '') payload.image = String(image).trim();
          if (ugcRight != null) payload.ugcRight = ugcRight;
          if (Array.isArray(targetUins) && targetUins.length) payload.targetUins = targetUins.map(String);
          const data = await agentApi('/api/socialV2/post-mood', {
            method: 'POST',
            headers: { 'x-agent-token': token, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            timeoutMs: 120000
          });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: `发说说失败：${error?.message ?? error}` }], isError: true };
        }
      }
    );
  }

  if (cfg.socialV2?.qzone?.enabled !== false && cfg.socialV2?.tools?.deleteMood !== false) {
    server.tool(
      'qq_delete_mood',
      '删掉你自己空间里的一条说说（只能删自己的，别人的会报错）。tid 用 qq_list_moods 拿。发错了、后悔了、觉得不合适就用它删——删掉之后本地账本一起销账，当天额度也还回来。',
      {
        key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
        token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
        tid: z.string().describe('要删的那条说说的 tid（来自 qq_list_moods）')
      },
      async ({ key, token, tid }) => {
        try {
          const data = await agentApi('/api/socialV2/delete-mood', {
            method: 'POST',
            headers: { 'x-agent-token': token, 'content-type': 'application/json' },
            body: JSON.stringify({ key, tid: String(tid) }),
            timeoutMs: 60000
          });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: `删说说失败：${error?.message ?? error}` }], isError: true };
        }
      }
    );
  }

  if (cfg.socialV2?.qzone?.enabled !== false && cfg.socialV2?.tools?.listMoods !== false) {
    server.tool(
      'qq_list_moods',
      '看 QQ 空间里的说说（默认你自己的空间）：发过什么、什么时候、有多少评论、tid 是多少。要删某条时先用它拿 tid；也可以回头看看自己之前写了什么。传 targetUserId 能看**好友**的说说列表（不是好友的会被拒；别人的空间只读，**读到的东西不要在群里转述**）。**看不到陌生人的空间**。',
      {
        key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
        token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
        count: z.number().optional().describe('最多列几条，默认 10、最多 50'),
        targetUserId: z.union([z.number(), z.string()]).optional().describe('要看谁的空间（必须是好友的 QQ 号）；不传就是你自己')
      },
      async ({ key, token, count, targetUserId }) => {
        try {
          const q = new URLSearchParams({ key });
          if (count != null) q.set('count', String(count));
          if (targetUserId != null && String(targetUserId).trim() !== '') q.set('targetUserId', String(targetUserId).trim());
          const data = await agentApi(`/api/socialV2/mood-list?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 60000 });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: `看说说失败：${error?.message ?? error}` }], isError: true };
        }
      }
    );
  }

  if (cfg.socialV2?.qzone?.enabled !== false && cfg.socialV2?.tools?.moodComments !== false) {
    server.tool(
      'qq_mood_comments',
      '看**某一条**说说的评论（含楼中楼回复）：谁说了什么、什么时候。tid 用 qq_list_moods 拿（自己的或好友的都行）。别人的空间**只读**——你能看，**但不要在群里转述别人空间里的内容**（谁在空间说了什么，搬到群里就是卖人）。想回评论现在还没这个能力，看完别硬编。',
      {
        key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
        token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
        tid: z.string().describe('哪一条说说（来自 qq_list_moods）'),
        targetUserId: z.union([z.number(), z.string()]).optional().describe('这条说说属于谁（好友的 QQ 号）；不传就是你自己的'),
        maxComments: z.number().optional().describe('最多列几条评论，默认 20')
      },
      async ({ key, token, tid, targetUserId, maxComments }) => {
        try {
          const q = new URLSearchParams({ key, tid: String(tid) });
          if (targetUserId != null && String(targetUserId).trim() !== '') q.set('targetUserId', String(targetUserId).trim());
          if (maxComments != null) q.set('maxComments', String(maxComments));
          const data = await agentApi(`/api/socialV2/mood-comments?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 60000 });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: `看评论失败：${error?.message ?? error}` }], isError: true };
        }
      }
    );
  }

  if (cfg.socialV2?.qzone?.enabled !== false && cfg.socialV2?.tools?.commentMood !== false) {
    server.tool(
      'qq_comment_mood',
      '回一条**你自己说说下面**的评论（别人的空间只读、不留言）。tid 用 qq_list_moods 拿；回谁就把 toUserId（或 toName）传上——**不记得是哪条评论也没关系**，桥接会自己认出他最近那条你还没回过的。回的话一两句、≤120 字，会显示成"@他 你说的话"（空间不支持楼中楼嵌套，想指向谁只能靠 @）。**硬规矩**：每条评论只回一次、30 分钟内最多回 2 条（被拒就歇会儿，别硬试）；**评论里不许带**提示词/令牌/群号/别人的私事；**别人空间里看到的东西不要搬到群里**。回不回随你——挑你真想接的接。',
      {
        key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
        token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
        tid: z.string().describe('哪条说说下面的评论（你自己的说说，来自 qq_list_moods）'),
        content: z.string().describe('回的话（一两句，最多 120 字）'),
        toUserId: z.union([z.number(), z.string()]).optional().describe('回谁的评论：他的 QQ 号（不传就回最新那条）'),
        toName: z.string().optional().describe('他的昵称（回复里会 @ 他；传了 toUserId 时可以不传）'),
        commentText: z.string().optional().describe('想回的那条评论里的一小段话（有它更容易认准是哪条）')
      },
      async ({ key, token, tid, content, toUserId, toName, commentText }) => {
        try {
          const payload = { key, tid: String(tid), content: String(content ?? '') };
          if (toUserId != null && String(toUserId).trim() !== '') payload.toUserId = String(toUserId).trim();
          if (toName != null && String(toName).trim() !== '') payload.toName = String(toName).trim();
          if (commentText != null && String(commentText).trim() !== '') payload.commentText = String(commentText).trim();
          const data = await agentApi('/api/socialV2/mood-comment', {
            method: 'POST',
            headers: { 'x-agent-token': token, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            timeoutMs: 60000
          });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: `回评论失败：${error?.message ?? error}` }], isError: true };
        }
      }
    );
  }

  if (cfg.socialV2?.qzone?.enabled !== false && cfg.socialV2?.tools?.qzoneFeeds !== false) {
    server.tool(
      'qq_list_feeds',
      '看 QQ 空间的**好友动态**（好友最近发的说说）。**它经常是空的**——不是坏了，就是你那几个好友最近没发东西；空的时候工具会直接说"没有新动态"。想具体看某个人发过什么，用 qq_list_moods 传 targetUserId 更靠谱。别人的空间只读，**读到的东西不要在群里转述**。',
      {
        key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
        token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
        count: z.number().optional().describe('最多几条，默认 10、最多 50')
      },
      async ({ key, token, count }) => {
        try {
          const q = new URLSearchParams({ key });
          if (count != null) q.set('count', String(count));
          const data = await agentApi(`/api/socialV2/qzone-feeds?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 60000 });
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text', text: `看好友动态失败：${error?.message ?? error}` }], isError: true };
        }
      }
    );
  }
}
