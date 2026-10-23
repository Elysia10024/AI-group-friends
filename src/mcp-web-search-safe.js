// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const dnsLookup = dns.promises.lookup;

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// BING_RSS_FIX: 走 Bing 的 RSS 接口，而不是爬 HTML 结果页。
// 原因（实测）：cn.bing.com 的 HTML 页面会对非浏览器请求返回"页面标题正确、
// 但结果块内容被乱填"的投毒页面——查"初音未来 是什么"得到一堆 VCU Health 医疗页，
// 查"原神 芙宁娜"得到 Microsoft 登录页。RSS 接口（format=rss）没有这层反爬，
// 且响应只有 ~4KB（HTML 约 100KB）。
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function bingSearchRss(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'rss');
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const xml = await res.text();
  const results = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const pick = (tag) => {
      const mm = m[1].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!mm) return '';
      return decodeHtml(mm[1].replace(/<!\[CDATA\[|\]\]>/g, ''));
    };
    const title = pick('title');
    const link = pick('link');
    const snippet = pick('description');
    if (title && /^https?:\/\//i.test(link)) results.push({ title, url: link, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

// 兜底：老式 HTML 结果页解析（仅在 RSS 拿不到结果时使用）。
async function bingSearchHtml(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: { 'user-agent': BROWSER_UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await res.text();
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

async function bingSearch(query) {
  try {
    const rss = await bingSearchRss(query);
    if (rss.results.length) return rss;
  } catch { /* 预期回退：RSS 版挂了或无结果就退回下一行的 HTML 解析 */ }
  // RSS 挂了或无结果，退回老解析
  return bingSearchHtml(query);
}

// ---- DeepSeek 官方搜索（2026-10-21）----
// 走 https://api.deepseek.com/v1/tools/search：官方自研搜索，返回摘要/权威度（比爬 Bing 稳）。
// 官方说明：2026-11-01 00:00（北京时间）前免费，之后 $0.75/千次成功请求（失败/空结果不计费）。
// 与旧的 bingSearch 并存：**优先用这个**，它失败再退回 web_search（一次只用一个）。
function deepseekApiKey() {
  const envKey = String(process.env.DEEPSEEK_API_KEY ?? '').trim();
  if (envKey) return envKey;
  try {
    const cred = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8');
    const m = /^\s*DEEPSEEK_API_KEY:\s*['"]?(sk-[A-Za-z0-9_-]+)/m.exec(cred);
    if (m) return m[1];
  } catch { /* 没凭据文件就返回空，工具会报错并让她退回 web_search */ }
  return '';
}

async function deepseekSearch(query, count) {
  const key = deepseekApiKey();
  if (!key) throw new Error('没有 DeepSeek API key（环境变量 DEEPSEEK_API_KEY 或 ~/.dsh/.credentials.yaml 的 refs.DEEPSEEK_API_KEY）');
  const res = await fetch('https://api.deepseek.com/v1/tools/search', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, count, need_content: false }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${text ? ': ' + text.slice(0, 200) : ''}`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return {
    engine: 'deepseek',
    query,
    count: results.length,
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      summary: r.summary,
      authority: r.authority,
      date: r.date,
      site: r.site_name,
    })),
  };
}

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1、::a.b.c.d 等）。
// 只处理标准 IPv4-mapped / IPv4-compatible 形式，避免把 fc00::1、fe80::1 误判成内嵌 IPv4。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  // ::ffff:7f00:1 或 ::7f00:1（IPv4-mapped / compatible）
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 198.18.0.0/15（benchmarking）、192.0.0.0/24（IETF 协议保留）
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    // 组播与保留段
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    // fc00::/7 ULA
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    // fe80::/10 link-local
    if (/^fe[89ab]/.test(h)) return true;
    // fec0::/10 site-local（已废弃）
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 2001:db8::/32 文档地址
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    // 6to4 内嵌 IPv4，例如 2002:c0a8:0101:: -> 192.168.1.1
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    // ff00::/8 组播地址
    if (h.startsWith('ff')) return true;
    return false;
  }

  // 非标准 IP 字面量由 DNS 解析后统一检查。
  return false;
}

// 解析主机名并固定到已校验的 IP，避免 DNS rebinding。
async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

// 从 Node IncomingMessage 读取最多 maxChars 个字符，用 StringDecoder 避免切断 UTF-8。
function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBoundedText(res, maxChars) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      text += decoder.write(chunk);
      if (text.length >= maxChars) {
        text = sliceByCodePoints(text, maxChars);
        try { res.destroy(); } catch { /* 清理类：已经拿够字符，主动断开响应；destroy 失败不影响已有结果 */ }
        finish(resolve, text);
      }
    });
    res.on('end', () => {
      if (!settled) {
        text += decoder.end();
        finish(resolve, sliceByCodePoints(text, maxChars));
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestOnce(url, ip) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000,
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBoundedText(res, 50000)
        .then((body) => resolve({ statusCode, body }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

async function safeFetch(urlString) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const maxChars = 50000;
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: body.length >= maxChars,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

const server = new McpServer({ name: 'web-search-safe', version: '0.1.0' });

server.tool(
  'web_search',
  '（备用搜索）只读搜索网络用语/梗/黑话的含义，返回 Bing 结果（标题/URL/摘要）。**优先用 deepseek_search**；只有它报错/超时/没结果时才用这个。仅用于查词，不执行任何本地操作。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingSearch(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'deepseek_search',
  '联网搜索（DeepSeek 官方搜索）：返回网页标题/URL/摘要/权威度，比 web_search 更准更稳。**优先用这个**；它失败或没结果时，再退回 web_search（一次只用一个，别两个都调）。',
  {
    query: z.string().describe('搜索词（1-128 字）'),
    count: z.number().int().min(1).max(10).optional().describe('返回几条，默认 5'),
  },
  async ({ query, count }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await deepseekSearch(clean, count ?? 5);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `官方搜索失败：${error?.message ?? error}（可以改用 web_search 再试）` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
