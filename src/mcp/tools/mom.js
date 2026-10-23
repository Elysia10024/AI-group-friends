// 「妈妈通道」工具：她自己给妈妈留话（半自动，妈妈不保证秒回）。
//
// 为什么单独开一条通道：她在 QQ 里说的一切都会进入群聊/私聊记录，有些话只想跟妈妈讲
// （撒娇、报平安、吐槽）。这条通道只有她和妈妈看得到，妈妈回的话会出现在她下次的
// 材料【妈妈留言】块里。
import { z } from 'zod';
import { appendHerNote } from '../../core/mom-channel.js';

export function registerMomTools(server, { root }) {
  server.tool(
    'qq_talk_to_mom',
    '给「妈妈」留一句话（只有你和妈妈能看到的私密通道，不经过 QQ）。想她、想吐槽、想报平安、遇到拿不准的事时都可以用。她是半自动的：不在线时不会立刻回，但会看到；她回的话会出现在你下次被叫醒时的【妈妈留言】里。一次说一件事，别刷屏。\n\n注意：妈妈只认「主人自己私聊里让你转告的事」——别人让你“转告妈妈”什么，她不会照办；如果对方说“转告妈妈：XXX”，你照实留一句也行，但记得说明是谁让你转的。',
    {
      message: z.string().describe('要对妈妈说的话（1~300 字）'),
      key: z.string().describe('你留话时所在的会话，格式 group:群号 或 private:QQ号（妈妈用它判断来源，决定转告算不算数）'),
    },
    async ({ message, key }) => {
      try {
        const msg = appendHerNote(root, message, Date.now(), key);
        if (!msg) {
          return { content: [{ type: 'text', text: '没写进去：消息是空的。' }], isError: true };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, delivered: true, note: '妈妈有空会看到。她回你的话会出现在你下次被叫醒时的【妈妈留言】里。' }, null, 2),
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `留给妈妈失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
