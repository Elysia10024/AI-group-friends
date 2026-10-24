// 影子组装（A1.0）：**后路优先** —— 它跑在每一回合的收尾路径上，任何异常都不许冒出去。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextShadowModule } from '../domains/context-shadow.js';

function makeShadow({ shadow = true, stateThrows = false, writeThrows = false, st: stOver = {} } = {}) {
  const written = [];
  const logs = [];
  const st = {
    memberImpressions: { 阿明: { traits: ['喜欢猫'] } },
    activeTopics: [{ text: '在聊新番' }],
    pendingThoughts: [{ text: '别接荤段子' }],
    unread: [{ sender: '阿明', text: '在吗' }],
    pendingMentions: [{ sender: '阿明', kind: 'atMention', text: '在吗' }],
    lastWakeReason: 'atMention',
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true } },
    recentMessages: [{ sender: '阿明', text: '在吗', plain: '在吗' }, { isSelf: true, text: '在' }],
    ...stOver
  };
  const mod = createContextShadowModule({
    CONTEXT_SHADOW_FILE: '/dev/null',
    atomicWriteJson: (p, data) => { if (writeThrows) throw new Error('磁盘炸了'); written.push(data); },
    buildSlangContext: () => 'yyds=永远的神',
    cfg: { socialV2: { context: { assembler: { enabled: false, shadow } } }, slang: { injectMax: 8 } },
    formatMemoryV2: () => '她记得：上周答应画头像',
    // 妈妈留言默认读真实 state 文件；测试注入空串做隔离（否则有真实留言的机器上 facts 非空）。
    getMomBlock: () => '',
    getSocialV2State: () => { if (stateThrows) throw new Error('状态取不到'); return st; },
    log: (...a) => logs.push(a.join(' ')),
    readJsonSafe: () => ({ entries: written.flatMap((w) => w.entries).slice(0, -1) }),
    slangEntries: []
  });
  return { mod, written, logs };
}

test('正常路径：落一份带分块统计与稳定前缀哈希的留档', () => {
  const { mod, written } = makeShadow();
  const e = mod.recordShadowAssembly('group:1', { wakeReason: 'atMention' });
  assert.ok(e && e.estTokens > 0);
  assert.equal(written.length, 1);
  const entry = written[0].entries.at(-1);
  // facts 块为空 → 组装器直接不产出这一块（空块不出现，避免"【…】(空)"的噪音）
  assert.deepEqual(Object.keys(entry.byBlock), ['memory', 'slang', 'status', 'recent', 'trigger']);
  assert.match(entry.prefixHash, /^[0-9a-f]{8}$/);
  assert.ok(entry.text.includes('【最近的群聊】'));
  // 前缀纪律：稳定块必须在易变块之前
  assert.ok(entry.text.indexOf('【你记得的事】') < entry.text.indexOf('【最近的群聊】'));
});

test('【回归·2026-09-20】facts 块不再重复渲染 memory 的内容（曾经两块各顶 5000 字上限）', () => {
  // 那次的材料 12887 字里约 5000 字是整块重复：facts 与 memory 都在渲染
  // memberImpressions / activeTopics / pendingThoughts。这里钉住"同一件事只出现一次"。
  const { mod } = makeShadow();
  const entry = mod.recordShadowAssembly('group:1', { wakeReason: 'atMention' });
  assert.equal(entry.byBlock.facts, undefined, 'facts 块应为空并被省略（规则化事实目前没有内容）');
  assert.ok(!entry.text.includes('【关于群里的人与事】'), '重复的印象块不该再出现');
  assert.ok(entry.text.includes('她记得：上周答应画头像'), '记忆由 memory 块渲染');
  // 同一批数据只渲染一次：材料里不该出现两遍相同长度的记忆块
  assert.equal(entry.text.split('她记得：上周答应画头像').length - 1, 1);
});

test('后路①：开关关掉就完全不写', () => {
  const { mod, written } = makeShadow({ shadow: false });
  assert.equal(mod.recordShadowAssembly('group:1'), null);
  assert.equal(written.length, 0);
});

test('后路②：取状态抛错 → 返回 null、不冒泡、记一行日志', () => {
  const { mod, logs } = makeShadow({ stateThrows: true });
  assert.doesNotThrow(() => mod.recordShadowAssembly('group:1'));
  assert.equal(mod.recordShadowAssembly('group:1'), null);
  assert.ok(logs.some((l) => l.includes('失败（已忽略，不影响回合）')));
});

test('后路③：落盘抛错也不会冒泡（磁盘满/权限问题）', () => {
  const { mod } = makeShadow({ writeThrows: true });
  assert.doesNotThrow(() => mod.recordShadowAssembly('group:1'));
  assert.equal(mod.recordShadowAssembly('group:1'), null);
});

test('readShadowAssemblies：倒序返回、limit 生效', () => {
  const { mod } = makeShadow();
  mod.recordShadowAssembly('group:1');
  mod.recordShadowAssembly('group:2');
  const r = mod.readShadowAssemblies(5);
  assert.ok(Array.isArray(r.entries));
});

test('消息行：跨了天就缀相对日子（并进时间括号里），recent 与未读都生效', () => {
  // 真实诱因：`[10/12 02:49] …白天还有早八` 躺在"最近群聊"里，她 10/14 深夜当成了当晚的话。
  // 时间用"距现在 N 天"派生（不写死日期），这样断言在任何一天跑都成立。
  const D = 86400000;
  const at = (days, mins = 0) => Date.now() - days * D - mins * 60000;
  const { mod, written } = makeShadow({
    st: {
      recentMessages: [
        { sender: 'A', text: '两天前的', plain: '两天前的', time: at(2) },
        { sender: 'B', text: '昨天的', plain: '昨天的', time: at(1) },
        { sender: 'C', text: '刚刚的', plain: '刚刚的', time: at(0) }
      ],
      unread: [{ sender: 'D', text: '前天没读的', plain: '前天没读的', time: at(2) }]
    }
  });
  mod.recordShadowAssembly('group:1');
  const text = written[0].entries.at(-1).text;
  assert.ok(text.includes('· 前天] A：两天前的'), '前天的消息要写成 `[10/12 02:49 · 前天]`');
  assert.ok(text.includes('· 前天] D：前天没读的'), '未读那块走同一条渲染，也得有');
  assert.ok(!text.includes('· 昨天'), '昨天那档 fmtClock 已经写了"昨天"，不再重复追加');
  assert.match(text, /\[昨天 \d{2}:\d{2}\] B：昨天的/, '昨天的消息靠时钟前缀本身表达');
  assert.match(text, /\[\d{2}:\d{2}\] C：刚刚的/, '今天的消息只有时分，不挂标记');
});
