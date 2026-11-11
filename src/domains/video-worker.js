// 视频分析 worker：用一个独立的 DSH 会话替小鲸鱼"看视频"（不占她的主会话）。
// 2026-11-11 主人要求：内核冻结、不能装插件 → 用现有 DSH API 开一个专用会话。
// 流程：桥抽好分镜图/字幕 → 投给 worker 会话 → 收它的要点 → 写进 bili-learnings。
// 注意：不碰小鲸鱼人设/记忆，worker 只是"替她看"，输出客观要点。
import path from 'node:path';
import { unwrap } from '../dsh-client.js';

export function createVideoWorkerModule(ctx) {
  const { api, cfg, log, stateDir, readJsonSafe, atomicWriteJson } = ctx;
  const stateFile = path.join(stateDir, 'video-worker.json');
  let state = readJsonSafe(stateFile, { version: 1 });
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = { version: 1 };
  let busy = false;

  function save() {
    try { atomicWriteJson(stateFile, state); } catch { /* 状态落盘失败不影响分析 */ }
  }

  async function ensureSession() {
    if (state.sessionId) return String(state.sessionId);
    const dir = path.join(stateDir, 'agents');
    const ws = unwrap(await api.workspace.create({ path: dir }), 'video-worker workspace.create');
    const created = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId }), 'video-worker session.create');
    state.sessionId = created.sessionId;
    state.createdAt = Date.now();
    save();
    log(`[video-worker] 新会话 ${created.sessionId}`);
    return created.sessionId;
  }

  /**
   * 让 worker 看一条视频，返回要点文本（失败抛错）。
   * @param {{bv:string,title:string,images?:Array,text?:string}} input
   */
  async function analyze({ bv, title, images = [], text = '' }) {
    if (busy) throw new Error('video-worker 忙（上一个视频还在分析）');
    busy = true;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 180000);
    try {
      const sessionId = await ensureSession();
      const parts = [{
        type: 'text',
        text: `【视频分析】《${String(title ?? '').slice(0, 80)}》（${bv}）\n${String(text ?? '').slice(0, 1200)}\n\n请只输出三行要点：\n1) 这个视频讲了什么（一句话）\n2) 最值得记住的一个信息\n3) 一句话结论\n不要客套、不要复述标题。`
      }];
      for (const img of Array.isArray(images) ? images.slice(0, 6) : []) {
        const data = String(img?.data ?? '');
        if (!data) continue;
        parts.push({ type: 'image', mediaType: String(img?.mimeType ?? img?.mediaType ?? 'image/jpeg'), data });
      }
      unwrap(await api.sessions.prompt({ sessionId, mode: 'queue', content: parts }), 'video-worker prompt');
      let out = '';
      for await (const envelope of api.events.mux({}, ac.signal)) {
        const frame = envelope?.payload;
        if (frame?.type !== 'session/event' || frame.sessionId !== sessionId) continue;
        const ev = frame.event;
        if (ev?.type === 'assistant/chunk' && ev.data?.chunk?.type === 'text-delta') out += ev.data.chunk.text;
        if (ev?.type === 'turn/end') break;
      }
      return String(out).trim();
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  }

  return { analyze, ensureSession, get state() { return state; } };
}
