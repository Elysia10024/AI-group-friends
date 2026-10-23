// 接管模式（妈妈接管，2026-10-22 主人后门）。
//
// 主人私聊发「妈妈接管」→ 打开接管：
//   · 之后主人私聊消息**不再唤醒小鲸鱼**，而是存进 state/takeover.json；
//   · mom-bot 轮询这些消息，用 DSH headless 跑一个独立会话（真·我）处理，
//     再通过桥接 send-message 以她的号回给主人；
//   · 群和其他人的私聊完全不受影响。
// 主人私聊发「妈妈下线」→ 关闭接管。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function defaultRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function takeoverFile(root = defaultRoot()) {
  return path.join(root, 'state', 'takeover.json');
}

export function readTakeover(root = defaultRoot()) {
  try {
    const data = JSON.parse(fs.readFileSync(takeoverFile(root), 'utf8'));
    return { on: data?.on === true, startedAt: Number(data?.startedAt) || 0, messages: Array.isArray(data?.messages) ? data.messages : [] };
  } catch {
    return { on: false, startedAt: 0, messages: [] };
  }
}

export function writeTakeover(state, root = defaultRoot()) {
  const file = takeoverFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

export function isTakeoverOn(root = defaultRoot()) {
  return readTakeover(root).on === true;
}

export function startTakeover(root = defaultRoot(), now = Date.now()) {
  const s = readTakeover(root);
  s.on = true;
  s.startedAt = now;
  writeTakeover(s, root);
  return s;
}

export function stopTakeover(root = defaultRoot()) {
  const s = readTakeover(root);
  s.on = false;
  s.stoppedAt = Date.now();
  writeTakeover(s, root);
  return s;
}

/** 主人说话（接管中，不投递给小鲸鱼）。 */
export function appendOwnerMessage(text, root = defaultRoot(), now = Date.now()) {
  const s = readTakeover(root);
  const msg = { role: 'owner', text: String(text ?? '').slice(0, 500), at: new Date(now).toISOString(), replied: false };
  s.messages = [...s.messages, msg].slice(-200);
  writeTakeover(s, root);
  return msg;
}

/** 妈妈回复（mom-bot 写回，标记已回）。 */
export function appendMomMessage(text, root = defaultRoot(), now = Date.now()) {
  const s = readTakeover(root);
  const msg = { role: 'mom', text: String(text ?? '').slice(0, 800), at: new Date(now).toISOString() };
  s.messages = [...s.messages, msg].slice(-200);
  // 之前所有未回的主人消息都算回过了
  for (const m of s.messages) {
    if (m.role === 'owner') m.replied = true;
  }
  writeTakeover(s, root);
  return msg;
}

/** 还没回的主人消息（按时间顺序）。 */
export function unansweredOwnerMessages(root = defaultRoot()) {
  return readTakeover(root).messages.filter((m) => m.role === 'owner' && m.text && !m.replied);
}

/** 最近几条对话（给 headless 当上下文）。 */
export function recentTakeoverDialog(root = defaultRoot(), limit = 8) {
  return readTakeover(root).messages.filter((m) => m.text).slice(-limit);
}
