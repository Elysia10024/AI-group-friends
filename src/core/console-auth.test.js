// core/console-auth.js 的单测（第 20 轮）：控制台安全边界。
// 每条都对应一条真实攻击面：没令牌、错令牌、静态资源例外、跨站写、非 JSON 写。
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConsoleAuth, PUBLIC_ASSETS } from './console-auth.js';

const base = { consoleToken: 'SECRET', port: 3100, headers: {} };

test('配了令牌：GET /api/x 不带令牌 → 401 json', () => {
  const r = checkConsoleAuth({ ...base, method: 'GET', pathname: '/api/x', suppliedToken: null });
  assert.deepEqual(r, { action: 'json', status: 401, error: '未授权：请提供控制台访问令牌' });
});

test('配了令牌：GET / 不带令牌 → 401 HTML（给浏览器弹窗输令牌）', () => {
  const r = checkConsoleAuth({ ...base, method: 'GET', pathname: '/', suppliedToken: null });
  assert.equal(r.action, 'html401');
});

test('令牌错 → 401；令牌对 → 放行', () => {
  assert.equal(checkConsoleAuth({ ...base, method: 'GET', pathname: '/api/x', suppliedToken: 'WRONG' }).status, 401);
  assert.deepEqual(checkConsoleAuth({ ...base, method: 'GET', pathname: '/api/x', suppliedToken: 'SECRET' }), { action: 'allow' });
});

test('静态资源例外：/console.css 与 /console.js 不带令牌也放行（且仅 GET）', () => {
  for (const p of PUBLIC_ASSETS) {
    assert.deepEqual(checkConsoleAuth({ ...base, method: 'GET', pathname: p, suppliedToken: null }), { action: 'allow' });
    assert.equal(checkConsoleAuth({ ...base, method: 'POST', pathname: p, suppliedToken: null }).status, 401);
  }
});

test('没配令牌：跳过令牌校验，但 CSRF 仍然生效', () => {
  const noToken = { ...base, consoleToken: '', suppliedToken: null };
  assert.deepEqual(checkConsoleAuth({ ...noToken, method: 'GET', pathname: '/api/x' }), { action: 'allow' });
  const post = checkConsoleAuth({ ...noToken, method: 'POST', pathname: '/api/restart', headers: { 'content-type': 'text/plain' } });
  assert.deepEqual(post, { action: 'json', status: 415, error: '请求必须是 application/json' });
});

test('CSRF：写操作必须 application/json（带 charset 也认）', () => {
  const ok = checkConsoleAuth({ ...base, method: 'POST', pathname: '/api/restart', suppliedToken: 'SECRET', headers: { 'content-type': 'application/json; charset=utf-8' } });
  assert.deepEqual(ok, { action: 'allow' });
  const bad = checkConsoleAuth({ ...base, method: 'POST', pathname: '/api/restart', suppliedToken: 'SECRET', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(bad.status, 415);
});

test('CSRF：Origin 不是本机 → 403；本机两个 host 都放行', () => {
  const evil = checkConsoleAuth({ ...base, method: 'POST', pathname: '/api/workspace/reset', suppliedToken: 'SECRET', headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' } });
  assert.deepEqual(evil, { action: 'json', status: 403, error: '跨站请求被拒绝' });
  for (const origin of ['http://127.0.0.1:3100', 'http://localhost:3100']) {
    const r = checkConsoleAuth({ ...base, method: 'POST', pathname: '/api/workspace/reset', suppliedToken: 'SECRET', headers: { 'content-type': 'application/json', origin } });
    assert.deepEqual(r, { action: 'allow' });
  }
});

test('CSRF：Origin 非法 URL → 按取不到 host 处理，拒绝', () => {
  const r = checkConsoleAuth({ ...base, method: 'POST', pathname: '/api/restart', suppliedToken: 'SECRET', headers: { 'content-type': 'application/json', origin: 'not a url' } });
  assert.equal(r.status, 403);
});

test('GET 不校验 CSRF（只读）', () => {
  const r = checkConsoleAuth({ ...base, method: 'GET', pathname: '/api/status', suppliedToken: 'SECRET', headers: { origin: 'https://evil.example.com' } });
  assert.deepEqual(r, { action: 'allow' });
});
