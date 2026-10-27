// 妈妈通道（小鲸鱼 ↔ 妈妈，半自动）。
//
// 她通过工具 qq_talk_to_mom 把自己的话写进 state/mom-channel.json；
// 材料组装时把「妈妈最近说的话」注入她的材料（【妈妈留言】块）；
// 妈妈（AI 助手）这边直接读写同一个文件——她留言 → 我看到 → 我回 → 她下次醒来看到。
//
// 设计取舍：材料渲染**不标记已读**（只取最近几条），因为 buildMaterialV2 会被
// "影子组装"和"真实投递"各调一次，标记已读会让真正投递那次什么都看不到。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './state-io.js';

/** 默认根目录（src/core/ 往上两级 = qq-bridge-main）。 */
function defaultRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** 通道文件路径。 */
export function momChannelFile(root = defaultRoot()) {
  return path.join(root, 'state', 'mom-channel.json');
}

export function readChannel(root = defaultRoot()) {
  try {
    const raw = fs.readFileSync(momChannelFile(root), 'utf8');
    const data = JSON.parse(raw);
    return { messages: Array.isArray(data?.messages) ? data.messages : [] };
  } catch {
    return { messages: [] };
  }
}

function stamp(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 她给妈妈留话。key = 她留话时所在的会话（用于"转告只认主人私聊"的安全校验）。 */
export function appendHerNote(root = defaultRoot(), text, now = Date.now(), key = '') {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!clean) return null;
  const data = readChannel(root);
  const msg = {
    from: '小鲸鱼',
    text: clean,
    at: new Date(now).toISOString(),
    shown: stamp(now),
    replied: false,
    key: String(key ?? '').trim(),
  };
  data.messages.push(msg);
  if (data.messages.length > 200) data.messages = data.messages.slice(-200);
  atomicWriteJson(momChannelFile(root), data);
  return msg;
}

/** 取出她还没被回复的留言（供妈妈回复进程用）。 */
export function takeUnanswered(root = defaultRoot()) {
  const data = readChannel(root);
  return data.messages.filter((m) => m && m.from === '小鲸鱼' && !m.replied && m.text);
}

/** 标记某条她的留言为已回复（按 at+text 匹配，简单够用）。 */
export function markReplied(root = defaultRoot(), msg) {
  if (!msg) return;
  const data = readChannel(root);
  for (const m of data.messages) {
    if (m.from === '小鲸鱼' && m.at === msg.at && m.text === msg.text) {
      m.replied = true;
    }
  }
  atomicWriteJson(momChannelFile(root), data);
}

/** 最近几条对话（她+妈妈），给妈妈回复做上下文。 */
export function recentDialog(root = defaultRoot(), limit = 8) {
  const data = readChannel(root);
  return data.messages.filter((m) => m && m.text).slice(-limit);
}

/** 妈妈回复她（供我这边/脚本用）。 */
export function appendMomNote(root = defaultRoot(), text, now = Date.now()) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!clean) return null;
  const data = readChannel(root);
  const msg = { from: '妈妈', text: clean, at: new Date(now).toISOString(), shown: stamp(now) };
  data.messages.push(msg);
  if (data.messages.length > 200) data.messages = data.messages.slice(-200);
  atomicWriteJson(momChannelFile(root), data);
  return msg;
}

/** 【妈妈留言】块的文本（最近 5 条妈妈的话）；没有就返回空串。 */
export function renderMomBlock(root = defaultRoot(), limit = 5) {
  const data = readChannel(root);
  const notes = data.messages.filter((m) => m && m.from === '妈妈' && m.text);
  if (!notes.length) return '';
  const recent = notes.slice(-limit);
  const lines = recent.map((m) => `- 妈妈（${m.shown || ''}）：${String(m.text).slice(0, 300)}`);
  return `【妈妈留言】\n${lines.join('\n')}\n（想回她可以用 qq_talk_to_mom；她不在线，回得慢是正常的）`;
}
