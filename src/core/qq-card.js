// QQ 卡片消息（json 段）→ 可读文本：尽量抠出标题和链接，让 AI 能看到 BV/短链。
//
// OneBot 的 json 段形状不统一：`data` 可能是 JSON 字符串，也可能直接是对象；
// B 站分享常见 `meta.news.jumpUrl`（structmsg）或 `meta.detail_1.qqdocurl`（小程序）。
// 所以这里不写死字段：递归找 URL 和 title/desc，优先 B 站链接。
export function cardToText(data) {
  let card = data;
  if (typeof data?.data === 'string') {
    try { card = JSON.parse(data.data); } catch { card = data; }
  } else if (data?.data && typeof data.data === 'object') {
    card = data.data;
  }

  const urls = [];
  const texts = [];
  const walk = (v, depth) => {
    if (v == null || depth > 8) return;
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^https?:\/\//i.test(s)) urls.push(s.replace(/&amp;/g, '&'));
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'title' || k === 'desc' || k === 'summary') && typeof x === 'string' && x.trim()) {
          texts.push(x.trim());
        }
        walk(x, depth + 1);
      }
    }
  };
  walk(card, 0);

  const bili = urls.find((u) => /bilibili\.com|b23\.tv|bili2233\.cn/i.test(u)) ?? '';
  const url = bili || urls[0] || '';
  const title = texts[0] || '';
  if (!url && !title) return '[卡片消息]';
  return `[卡片消息${title ? ` ${title.slice(0, 60)}` : ''}${url ? ` ${url}` : ''}]`;
}
