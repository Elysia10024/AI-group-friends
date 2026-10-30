// 「她的活动」公共日志 · IO（state/whale-activity.json，所有会话共用一个文件）。
import fs from 'node:fs';
import path from 'node:path';
import { makeEntry, appendEntry } from '../core/whale-activity.js';

export function createWhaleActivityModule(ctx) {
  const { stateDir, readJsonSafe, atomicWriteJson } = ctx;
  const file = path.join(stateDir, 'whale-activity.json');
  const empty = { version: 1, entries: [] };

  function load() {
    try {
      const data = readJsonSafe(file, empty);
      return Array.isArray(data?.entries) ? data.entries : [];
    } catch {
      return [];
    }
  }

  /** 记一条活动（不抛：日志失败不能影响主流程）。 */
  function record(input) {
    try {
      const entries = appendEntry(load(), makeEntry(input));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      atomicWriteJson(file, { version: 1, entries });
      return true;
    } catch {
      return false;
    }
  }

  /** 最近 N 条（全局，不分会话）。 */
  function recent(limit = 5) {
    return load().slice(-Math.max(1, Math.min(50, Number(limit) || 5)));
  }

  return { record, recent };
}
