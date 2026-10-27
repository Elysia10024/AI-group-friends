// core/state-schema.js 的单测（第 1 期；被 src/**/*.test.js 这个 glob 捡到）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStateFile, assertVersion, stamp, STATE_SCHEMA_VERSION } from './state-schema.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-schema-'));
  return path.join(dir, 'state.json');
}

test('文件缺失：返回 fallback，不抛', () => {
  const f = tmpFile();
  assert.equal(readStateFile('social-v2', f, null), null);
  assert.deepEqual(readStateFile('context-shadow', f, { entries: [] }), { entries: [] });
});

test('存在但解析不了：抛错（拒绝按空状态处理）', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"conversations":', 'utf8');
  assert.throws(() => readStateFile('social-v2', f, null), /解析不了/);
});

test('无版本号：按当前版本放行（兼容存量文件）', () => {
  const data = assertVersion('social-v2', { paused: false, conversations: {} });
  assert.deepEqual(data, { paused: false, conversations: {} });
});

test('版本比代码新：抛错（旧进程不许读新结构）', () => {
  const newer = STATE_SCHEMA_VERSION['social-v2'] + 1;
  assert.throws(() => assertVersion('social-v2', { schemaVersion: newer }), /新于本代码/);
});

test('版本比代码旧且没登记迁移：抛错（不静默当空）', () => {
  assert.throws(() => assertVersion('social-v2', { schemaVersion: STATE_SCHEMA_VERSION['social-v2'] - 1 }), /迁移/);
});

test('stamp 补当前版本号；数组原样返回', () => {
  const stamped = stamp('social-v2', { a: 1 });
  assert.equal(stamped.schemaVersion, STATE_SCHEMA_VERSION['social-v2']);
  assert.equal(stamped.a, 1);
  const arr = [1, 2];
  assert.equal(stamp('slang', arr), arr);
});

test('读写回环：stamp 写的能被 readStateFile 读回', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify(stamp('context-shadow', { updatedAt: 1, entries: [] })), 'utf8');
  const back = readStateFile('context-shadow', f, null);
  assert.equal(back.schemaVersion, STATE_SCHEMA_VERSION['context-shadow']);
  assert.deepEqual(back.entries, []);
});

test('带 BOM 的文件也能读（Windows 常见）', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '﻿' + JSON.stringify(stamp('social-v2', { paused: true, conversations: {} })), 'utf8');
  const back = readStateFile('social-v2', f, null);
  assert.equal(back.paused, true);
});
