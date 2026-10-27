// 看群友分享的 B 站视频（桥接侧只读工具）。
// 配额和分享者判定都由桥接做（见 src/domains/bili-look.js），这里只转发。
import { z } from 'zod';

export function registerBiliTools(server, { agentApi }) {
  server.tool(
    'qq_bili_look',
    '看群里有人分享过的 B 站视频：返回标题、简介、按热度前 5 条评论，并抽帧看画面（只看 5 分钟以内，每 2 秒一张，最多 150 张）。**每个群友每天只能让你看一次**：同一个人当天第二次分享会被直接拒绝；被拒就照实说明，不要绕。看完会自动把内容记进「看过的视频」笔记；**如果视频里有要记住的规则/注意事项/知识点，看完立刻用 qq_memory_append 记下来**——不记下一轮就忘了。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      url: z.string().describe('B 站视频链接或 BV 号（必须是群里/私聊里有人发过的）'),
      token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）'),
      withFrames: z.boolean().optional().describe('是否抽帧看画面，默认 true；false 只回文字（不看画面）')
    },
    async ({ key, url, token, withFrames }) => {
      try {
        const data = await agentApi('/api/socialV2/bili-look', {
          method: 'POST',
          body: JSON.stringify({ key, url, withFrames }),
          headers: { 'x-agent-token': token },
          timeoutMs: 240000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        return {
          content: [
            { type: 'text', text: data?.text ?? JSON.stringify(data) },
            ...images.map((img) => ({ type: 'image', data: String(img.data), mimeType: String(img.mimeType || 'image/jpeg') }))
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `看视频失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_bili_scroll',
    '空闲时间自己刷 B 站：挑一个 5 分钟以内的热门短视频看（标题/简介/热度前 5 评论 + 每 2 秒一张截图）。只在空闲时段可用，每小时最多一次，每天有上限。看完会自动把这条视频的标题/简介/热评选进你的「看过的视频」笔记（以后能想起来）；想留自己的想法用 qq_memory_append 另记。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（**必填**，漏传会被拒；见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/socialV2/bili-scroll', {
          method: 'POST',
          body: JSON.stringify({ key }),
          headers: { 'x-agent-token': token },
          timeoutMs: 240000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        return {
          content: [
            { type: 'text', text: data?.text ?? JSON.stringify(data) },
            ...images.map((img) => ({ type: 'image', data: String(img.data), mimeType: String(img.mimeType || 'image/jpeg') }))
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `自己刷视频失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}
