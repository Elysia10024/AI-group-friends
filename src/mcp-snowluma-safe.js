// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SENSITIVE_RE } from './sensitive.js';
import { createSnowlumaLib } from './mcp/snowluma-lib.js';
import { registerStatusTools } from './mcp/tools/status.js';
import { registerSendTools } from './mcp/tools/send.js';
import { registerReadTools } from './mcp/tools/read.js';
import { registerMemoryTools } from './mcp/tools/memory.js';
import { registerSlangTools } from './mcp/tools/slang.js';
import { registerMediaTools } from './mcp/tools/media.js';
import { registerStickerTools } from './mcp/tools/sticker.js';
import { registerImageLibraryTools } from './mcp/tools/image-library.js';
import { registerQzoneTools } from './mcp/tools/qzone.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const mcpLib = createSnowlumaLib({
  ROOT,
  fs,
  path,
});
const {
  loadConfig,
  getConfig,
  getAccess,
  getOneBotConfig,
  isAllowed,
  escapeCqText,
  unquoteJsonString,
  messageSegments,
  onebot,
  agentApiBase,
  readConsoleToken,
  agentApi,
  authorizeRead,
} = mcpLib;

const cfg = loadConfig();

const server = new McpServer({ name: 'snowluma-safe', version: '0.1.0' });

registerStatusTools(server, { onebot, getAccess, isAllowed, authorizeRead });

registerSendTools(server, { agentApi, unquoteJsonString, cfg });

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
registerReadTools(server, { agentApi, cfg });

registerMemoryTools(server, { agentApi });

registerSlangTools(server, { agentApi });

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
registerMediaTools(server, { agentApi, cfg });

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
registerStickerTools(server, { agentApi, cfg });

// ── 本地图库（管理员在 <项目目录>\image 放的梗图）────────────────────────────
registerImageLibraryTools(server, { agentApi, cfg });

// ── QQ 空间说说（她自己发的"自言自语"）──────────────────────────────────────
registerQzoneTools(server, { agentApi, cfg });

await server.connect(new StdioServerTransport());
