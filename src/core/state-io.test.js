// 状态读写基元的契约测试。跑法：npm test
//
// 行为不变性由一次性差分脚本证明：抽取 bridge.js 里原件的三个函数，
// 与新模块在相同输入下比对（用同一个临时目录跑两遍），全部一致；脚本验证完即删。
//
// 这里留下的重点是**静默毁数据的边界**：写坏 / 读错都要能被测出来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonSafe, atomicWriteJson, atomicWriteText, appendCappedLine } from './state-io.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stateio-test-'));
let seq = 0;
const tmpFile = (name = 'x.json') => path.join(tmpRoot, `case${++seq}`, name);
const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

// ---------------- readJsonSafe ----------------
test('readJsonSafe：正常读取', () => {
  const f = tmpFile('a.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"a":1}', 'utf8');
  assert.deepEqual(readJsonSafe(f, null), { a: 1 });
});

test('readJsonSafe：文件缺失返回 fallback', () => {
  assert.equal(readJsonSafe(tmpFile('missing.json'), 'FB'), 'FB');
  assert.deepEqual(readJsonSafe(tmpFile('missing2.json'), { d: 1 }), { d: 1 });
  assert.equal(readJsonSafe(tmpFile('missing3.json'), null), null);
});

test('readJsonSafe：内容损坏返回 fallback（不抛错）', () => {
  const f = tmpFile('bad.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{ this is not json', 'utf8');
  assert.equal(readJsonSafe(f, 'FB'), 'FB');
});

test('readJsonSafe：空文件返回 fallback', () => {
  const f = tmpFile('empty.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '', 'utf8');
  assert.equal(readJsonSafe(f, 'FB'), 'FB');
});

test('readJsonSafe：剥掉 UTF-8 BOM（Windows 工具常见）', () => {
  const f = tmpFile('bom.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '\uFEFF{"b":2}', 'utf8');
  assert.deepEqual(readJsonSafe(f, null), { b: 2 }, '带 BOM 也必须能读出来');
});

test('readJsonSafe：required=true 时缺失/损坏都抛错（fail-fast）', () => {
  assert.throws(() => readJsonSafe(tmpFile('req-missing.json'), null, true), /配置文件读取\/解析失败/);
  const f = tmpFile('req-bad.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'not json', 'utf8');
  assert.throws(() => readJsonSafe(f, null, true), /配置文件读取\/解析失败/);
});

test('readJsonSafe：目录当文件读也走 fallback 而不是崩', () => {
  const d = tmpFile('adir');
  fs.mkdirSync(d, { recursive: true });
  assert.equal(readJsonSafe(d, 'FB'), 'FB');
});

// ---------------- atomicWriteJson ----------------
test('atomicWriteJson：写入内容 = 2 空格缩进 + 末尾换行', () => {
  const f = tmpFile('w.json');
  atomicWriteJson(f, { a: 1, b: [2, 3] });
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
});

test('atomicWriteJson：自动创建父目录', () => {
  const f = tmpFile(path.join('deep', 'nested', 'w.json'));
  atomicWriteJson(f, { ok: true });
  assert.deepEqual(readJsonSafe(f, null), { ok: true });
});

test('atomicWriteJson：不留临时文件', () => {
  const f = tmpFile('clean.json');
  atomicWriteJson(f, { x: 1 });
  const left = listDir(path.dirname(f)).filter((n) => n.includes('.tmp'));
  assert.deepEqual(left, [], '写完不该有 .tmp 残留');
});

test('atomicWriteJson：覆盖已有文件', () => {
  const f = tmpFile('over.json');
  atomicWriteJson(f, { v: 1 });
  atomicWriteJson(f, { v: 2 });
  assert.deepEqual(readJsonSafe(f, null), { v: 2 });
});

test('atomicWriteJson：权限 0600（Windows 上不强制，但调用不该报错）', () => {
  const f = tmpFile('mode.json');
  atomicWriteJson(f, { s: 'secret' });
  assert.ok(fs.existsSync(f));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  }
});

test('atomicWriteJson：并发写不互相踩（临时名唯一）', async () => {
  const dir = path.dirname(tmpFile('conc.json'));
  const f = path.join(dir, 'conc.json');
  fs.mkdirSync(dir, { recursive: true });
  // 并发写 20 次，每次内容不同
  await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => atomicWriteJson(f, { i }))));
  const got = readJsonSafe(f, null);
  assert.ok(got && Number.isInteger(got.i), '结果必须是某一次完整写入，不能是半个文件');
  assert.deepEqual(listDir(dir).filter((n) => n.includes('.tmp')), [], '不该有 .tmp 残留');
});

test('atomicWriteJson：能写各种 JSON 值', () => {
  for (const v of [null, [], {}, 0, '', false, { n: null }]) {
    const f = tmpFile('val.json');
    atomicWriteJson(f, v);
    assert.deepEqual(readJsonSafe(f, 'FB'), v);
  }
});

// ---------------- atomicWriteText ----------------
test('atomicWriteText：原样写文本，不加换行', () => {
  const f = tmpFile('t.txt');
  atomicWriteText(f, 'hello');
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello');
});

test('atomicWriteText：创建父目录且不留临时文件', () => {
  const f = tmpFile(path.join('tx', 'deep', 't.txt'));
  atomicWriteText(f, 'x');
  assert.equal(fs.readFileSync(f, 'utf8'), 'x');
  assert.deepEqual(listDir(path.dirname(f)).filter((n) => n.includes('.tmp')), []);
});

test('atomicWriteText：能写空串与多字节文本', () => {
  const f = tmpFile('t2.txt');
  atomicWriteText(f, '');
  assert.equal(fs.readFileSync(f, 'utf8'), '');
  atomicWriteText(f, '中文 · emoji 🐟');
  assert.equal(fs.readFileSync(f, 'utf8'), '中文 · emoji 🐟');
});

// ---------------- appendCappedLine ----------------
// 三处日志（活动 500 行 / 桥 2000 行 / 工具调用 2000 行）原本各写一份同样的
// 「追加 → 读回 → split → 超了 slice(-cap).join 重写」。这里把语义钉死。

/** 抽出前的内联写法，逐字复刻，用来做差分。 */
function origAppend(file, line, cap, trailingNewline) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, line);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (lines.length > cap) fs.writeFileSync(file, lines.slice(-cap).join('\n') + (trailingNewline ? '\n' : ''));
}

test('appendCappedLine：文件不存在时会建目录并写入', () => {
  const f = tmpFile('nested/deep/log.txt');
  assert.equal(appendCappedLine(f, 'hello\n', { cap: 10 }), false);
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello\n');
});

test('appendCappedLine：未超上限时只追加、不重写', () => {
  const f = tmpFile('log.txt');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'a\nb\n', 'utf8');
  assert.equal(appendCappedLine(f, 'c\n', { cap: 10 }), false);
  assert.equal(fs.readFileSync(f, 'utf8'), 'a\nb\nc\n');
});

test('appendCappedLine：判定用的是 split 后的元素个数（末尾空串也算一项）', () => {
  // 原实现就是 `lines.length > cap`，而 'a\nb\nc\n'.split('\n') 是 ['a','b','c',''] 共 4 项。
  // 所以 cap=3 时 4 > 3 → 会裁，结果 ['b','c',''].join('\n') = 'b\nc\n'。
  // 把这个"看起来像 off-by-one"的语义显式记下来，免得以后被"顺手修好"。
  const f = tmpFile('log.txt');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'a\nb\n', 'utf8');
  assert.equal(appendCappedLine(f, 'c\n', { cap: 3 }), true);
  assert.equal(fs.readFileSync(f, 'utf8'), 'b\nc\n');
});

test('appendCappedLine：cap 边界与内联原实现逐字节一致', () => {
  for (const cap of [1, 2, 3, 5, 10]) {
    for (const trailing of [false, true]) {
      for (const seedCount of [0, 1, 2, 4, 9]) {
        const a = tmpFile('a.txt');
        const b = tmpFile('b.txt');
        const seed = Array.from({ length: seedCount }, (_, i) => `L${i}\n`).join('');
        fs.mkdirSync(path.dirname(a), { recursive: true });
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.writeFileSync(a, seed, 'utf8');
        fs.writeFileSync(b, seed, 'utf8');
        const got = appendCappedLine(a, 'NEW\n', { cap, trailingNewline: trailing });
        origAppend(b, 'NEW\n', cap, trailing);
        assert.equal(fs.readFileSync(a, 'utf8'), fs.readFileSync(b, 'utf8'),
          `cap=${cap} trailing=${trailing} seed=${seedCount}`);
        assert.equal(typeof got, 'boolean');
      }
    }
  }
});

test('appendCappedLine：trailingNewline 的差异必须保留（工具日志补、另两个不补）', () => {
  const mk = () => {
    const f = tmpFile('log.txt');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'a\nb\n', 'utf8');
    return f;
  };
  const noNl = mk();
  const yesNl = mk();
  appendCappedLine(noNl, 'c\n', { cap: 2 });
  appendCappedLine(yesNl, 'c\n', { cap: 2, trailingNewline: true });
  assert.equal(fs.readFileSync(noNl, 'utf8').endsWith('\n\n'), false);
  assert.equal(fs.readFileSync(yesNl, 'utf8').endsWith('\n\n'), true);
});

// ---------------- 收尾 ----------------
test.after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
});
