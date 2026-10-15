// 本地图库：列表 / 预览 / 发送
//
// 与 sticker 族（QQ 收藏表情）并列的第二套"发图"能力：
//   · 收藏表情在 QQ 云端，加一张要上传到 QQ 收藏；
//   · 本地图库在 E:\ai群友\image，加图 = 丢文件，语义 = library.json 里那句备注。
//
// 每个工具都是薄壳：转发到桥接控制台的 /api/socialV2/image-* 路由，真正的读盘/发送在那侧。
// 门控沿用它所属的"表情包体系"开关（socialV2.sticker.enabled / tools.listStickers / tools.sendSticker），
// 没有为图库单独加配置键 —— 对它来说这就是"发图"这一件事。
import { z } from 'zod';

export function registerImageLibraryTools(server, { agentApi, cfg }) {
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_images',
    '查看本地图库（管理员准备的梗图，名字就是它的意思）。可按 verdict（适合/谨慎/不适合）、tag、query 过滤。发图用 qq_send_image；不确定某张长什么样就先 qq_view_library_image 看一眼。唤醒提示里已经给了一份紧凑清单，这张表是用来按标签细挑的。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
      verdict: z.enum(['适合', '谨慎', '不适合']).optional().describe('按适合度过滤：适合=随便发；谨慎=带水印/易引战，挑场合；不适合=不许发'),
      tag: z.string().optional().describe('按标签过滤，例如 摸鱼 / 需求变更 / 被催 / 自嘲'),
      query: z.string().optional().describe('关键词，匹配名字/描述/标签'),
      count: z.number().optional().describe('最多返回几条，默认 60')
    },
    async ({ key, token, verdict, tag, query, count }) => {
      try {
        const q = new URLSearchParams({ key });
        if (verdict) q.set('verdict', verdict);
        if (tag) q.set('tag', String(tag));
        if (query) q.set('query', String(query));
        if (count != null) q.set('count', String(count));
        const data = await agentApi(`/api/socialV2/image-list?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图库列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_view_library_image',
    '把本地图库里的某张图直接以图像返回给你看（视觉模型可"看懂"）。**平时不用它**——名字对得上就直接发；只有你想不起来某张到底画的是什么、或者怕发错时才看一眼。name 用材料清单或 qq_list_images 里的名字。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
      name: z.string().describe('图片名字，例如 偷懒 / 改回第一版 / 好耶!')
    },
    async ({ key, token, name }) => {
      try {
        const q = new URLSearchParams({ key, name: String(name) });
        const data = await agentApi(`/api/socialV2/image-file?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 60000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `这张图取不到：${data?.error || '未知'}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: `图库里的「${data.image.name}」（${data.image.verdict || ''}${data.image.tags?.length ? '，标签：' + data.image.tags.join('/') : ''}）：${data.image.desc || ''}` },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `取图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_image',
    '从本地图库发一张梗图（名字即语义，例如 偷懒 / 别催 / 改回第一版 / 好耶!）。**一条消息只能是一张图，不能在同一个气泡里附文字**——想说的话先用 qq_send_message / qq_reply 单独发，再单独发图。**什么时候发（这些场合就该发，别犹豫）**：接梗、别人发了图/表情/自拍时回一张、被夸被逗被哄时甩一张、被催被念时顶一张、自嘲时配一张、别人明确要你"来个图"时立刻发。名字对得上就**直接发**（材料里的清单就有名字），不用先看。分寸：**同一张别连着两轮用；连着两轮发过图就停一轮**。唯一的刹车：有人认真说事/难过/吵架收尾时不发；verdict"谨慎"的挑合适场合，"不适合"会被直接拒。需要引用/@ 时传 replyToMessageId / atUserId（群聊）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
      name: z.string().describe('图库里的图片名字（来自 qq_list_images 或唤醒提示的清单）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊可选，私聊不可用）')
    },
    async ({ key, token, name, replyToMessageId, atUserId }) => {
      try {
        const payload = { key, name: String(name) };
        if (replyToMessageId != null && String(replyToMessageId).trim() !== '') payload.replyToMessageId = replyToMessageId;
        if (atUserId != null && String(atUserId).trim() !== '') payload.atUserId = atUserId;
        const data = await agentApi('/api/socialV2/send-image', {
          method: 'POST',
          headers: { 'x-agent-token': token, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_save_image',
    '把群友发的一张图**存进你自己的本地图库**，以后能直接发（名字就是它的意思）。**存之前先看清这张图画的是什么**（不确定就用 qq_get_message_images 把那张图调出来看一眼）——名字是你以后唯一的检索凭据，起错了以后就会发错图。值得留的才存：这张图对得上你在这个群的语境吗？以后还会用得上吗？name 起短一点（2~8 字，例如"猫猫问号""别催我"），tags 给 2~3 个（以后按标签找），desc 一句它画的是什么；默认 verdict="适合"（能随便发），带水印/易引战的填"谨慎"。messageId 用 qq_get_recent_messages / 材料里那条消息的 id —— 必须真的带图，也不能是纯文字消息或你自己发的。同名会被拒，换个名字。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
      messageId: z.union([z.number(), z.string()]).describe('带图那条消息的 id 或 seq'),
      name: z.string().describe('给它起的短名字（名字就是它的意思，2~8 字最好）'),
      tags: z.array(z.string()).optional().describe('2~3 个标签，例如 ["猫","问号","无语"]'),
      desc: z.string().optional().describe('一句它画的是什么（可选）'),
      verdict: z.enum(['适合', '谨慎']).optional().describe('默认"适合"；带水印/易引战的填"谨慎"')
    },
    async ({ key, token, messageId, name, tags, desc, verdict }) => {
      try {
        const data = await agentApi('/api/socialV2/save-image', {
          method: 'POST',
          headers: { 'x-agent-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ key, messageId, name, tags, desc, verdict }),
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `存图失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
}
