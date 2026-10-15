// 管理指令匹配层的单测。
//
// 重点不是"能匹配上"，而是**不误触发** —— 指令会以普通对话形式生效，
// 而普通对话里几乎什么话都有。所以下面专门有一组"不该命中"的用例。
// 每条断言都写清了意图，将来加模式时先看这组反例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchAdminCommand, isSlashCommand, isCommandAddressed, ADMIN_COMMANDS } from './commands.js';

test('斜杠写法全部保留（与改造前行为一致）', () => {
  const slash = {
    '/reset': 'reset', '/new': 'reset',
    '/status': 'status',
    '/role': 'role',
    '/silent': 'silent', '/quiet': 'silent',
    '/active': 'active', '/speak': 'active',
  };
  for (const [text, id] of Object.entries(slash)) {
    assert.equal(matchAdminCommand(text)?.id, id, text);
  }
});

test('自然语言写法：关闭/开启聊天（用户点名要的）', () => {
  for (const t of ['关闭聊天功能', '把聊天功能关掉', '关掉聊天', '停止回复', '停掉发言功能', '别说话了', '不要回复了']) {
    assert.equal(matchAdminCommand(t)?.id, 'silent', t);
  }
  for (const t of ['开启聊天功能', '打开聊天', '恢复回复', '启用发言功能', '可以说话了', '能回复了']) {
    assert.equal(matchAdminCommand(t)?.id, 'active', t);
  }
});

test('自然语言写法：重置 / 状态', () => {
  for (const t of ['重置会话', '重开上下文', '清空对话', '重置一下会话']) {
    assert.equal(matchAdminCommand(t)?.id, 'reset', t);
  }
  for (const t of ['状态', '会话状态', '状态怎么样', '状态如何']) {
    assert.equal(matchAdminCommand(t)?.id, 'status', t);
  }
});

test('带参数的指令：角色名取得到（斜杠与自然语言两种写法）', () => {
  assert.equal(matchAdminCommand('/role 小鲸鱼')?.arg, '小鲸鱼');
  assert.equal(matchAdminCommand('/role')?.arg, '');
  assert.equal(matchAdminCommand('切换角色到 傲娇助手')?.arg, '傲娇助手');
  assert.equal(matchAdminCommand('换个角色 小鲸鱼.速记')?.arg, '小鲸鱼.速记');
  assert.equal(matchAdminCommand('设置角色为 off')?.arg, 'off');
});

test('订阅类指令：斜杠 + 自然语言两种写法，参数原样带出', () => {
  assert.equal(matchAdminCommand('/订阅 20000001 群友辛')?.id, 'subscribe');
  assert.equal(matchAdminCommand('/订阅 20000001 群友辛')?.arg, '20000001 群友辛');
  assert.equal(matchAdminCommand('/subscribe 2815316979')?.id, 'subscribe');
  assert.equal(matchAdminCommand('/subscribe 2815316979')?.arg, '2815316979');
  assert.equal(matchAdminCommand('订阅一下 群友辛')?.id, 'subscribe');
  assert.equal(matchAdminCommand('订阅一下 群友辛')?.arg, '群友辛');
  assert.equal(matchAdminCommand('把群友辛订阅上')?.arg, '群友辛');
  assert.equal(matchAdminCommand('/取消订阅 群友辛')?.id, 'unsubscribe');
  assert.equal(matchAdminCommand('/取消订阅 群友辛')?.arg, '群友辛');
  assert.equal(matchAdminCommand('取消订阅 全部')?.arg, '全部');
  assert.equal(matchAdminCommand('把 群友辛 退订了')?.id, 'unsubscribe');
  assert.equal(matchAdminCommand('/订阅列表')?.id, 'subscribe-list');
  assert.equal(matchAdminCommand('看订阅列表')?.id, 'subscribe-list');
  // 整句锚定：随口提到不该触发
  assert.equal(matchAdminCommand('我订阅了那个频道'), null, '不是整句指令就不认');
  assert.equal(matchAdminCommand('群里谁在订阅她啊'), null);
});

test('群里 @她 下的指令要能匹配（@段渲染成 "@名字" 顶在句首）', () => {
  // 真实事故：这条没匹配上 → 桥没执行静默 → 她只看到"你让我闭麦"，口头答应然后继续说
  assert.equal(matchAdminCommand('@大隐鲸 关闭聊天功能')?.id, 'silent');
  assert.equal(matchAdminCommand('@你 关闭聊天功能')?.id, 'silent', '管理员手打的 @你（不是真 @）');
  assert.equal(matchAdminCommand('@大隐鲸 开启聊天功能')?.id, 'active');
  assert.equal(matchAdminCommand('@大隐鲸 重置会话')?.id, 'reset');
  assert.equal(matchAdminCommand('@大隐鲸 状态')?.id, 'status');
  assert.equal(matchAdminCommand('@大隐鲸 切换角色到 傲娇助手')?.arg, '傲娇助手');
  // 但剔掉 @ 之后仍然要整句锚定 —— 不能退化成子串匹配
  assert.equal(matchAdminCommand('@大隐鲸 关闭聊天功能和开启聊天功能两个指令'), null);
  assert.equal(matchAdminCommand('@小明 你觉得该不该关闭聊天功能'), null, '剔掉 @小明 后剩下的不是整句指令');
  assert.equal(matchAdminCommand('@大隐鲸 我提过关闭聊天功能这件事'), null);
});

test('"算不算对她说"：私聊一律算；群里要真点名或句首 @提及', () => {
  const base = { kind: 'group', plainContent: '关闭聊天功能' };
  assert.equal(isCommandAddressed({ ...base, kind: 'private' }), true, '私聊不必点名');
  assert.equal(isCommandAddressed(base), false, '群里干说一句、又没点名 → 不算');
  assert.equal(isCommandAddressed({ ...base, directAddress: true }), true, '真 @她/叫名字');
  assert.equal(isCommandAddressed({ ...base, quoteTargetIsSelf: true }), true, '引用了她自己');
  // 真实事故：管理员手打「@你 关闭聊天功能」—— "@你" 不是从成员列表选的，isDirectAddress 认不出
  assert.equal(isCommandAddressed({ kind: 'group', plainContent: '@你 关闭聊天功能' }), true);
  assert.equal(isCommandAddressed({ kind: 'group', plainContent: '@大隐鲸 关闭聊天功能' }), true);
  assert.equal(isCommandAddressed({ kind: 'group', plainContent: '  关闭聊天功能  ' }), false);
});

test('真实事故：只是"描述她"的话不能触发（旧版子串匹配踩的）', () => {
  const describing = [
    '小鲸鱼现在只有开启关闭聊天功能两个指令',   // ← 群里真实发生的那句
    '你只有开启和关闭聊天功能两个指令',
    '开启和关闭聊天功能',
    '小鲸鱼有开启聊天功能这个指令吗',
    '她可以关闭聊天功能',
    '我记得关闭聊天功能好像是个指令',
    '关闭聊天功能？',                            // 带问号 = 在问，不是下令
    '群友说关闭聊天功能会让她闭嘴',
  ];
  for (const t of describing) {
    assert.equal(matchAdminCommand(t), null, `不该命中：${t}`);
  }
});

test('口语前缀/后缀仍然可以（整句就是这条指令）', () => {
  for (const t of ['关闭聊天功能', '帮我关闭聊天功能', '麻烦关掉聊天功能吧', '把聊天功能关掉', '现在就停止回复', '别说话了', '关闭聊天功能！']) {
    assert.equal(matchAdminCommand(t)?.id, 'silent', t);
  }
  for (const t of ['开启聊天功能', '帮我打开聊天吧', '恢复回复', '可以说话了', '开启聊天功能。']) {
    assert.equal(matchAdminCommand(t)?.id, 'active', t);
  }
});

test('不该命中：日常聊天里的这些句子一个都不能触发', () => {
  const notCommands = [
    '你在群里随便 @ 我一下',
    '今天群里聊了啥',
    '状态不错啊今天',           // 带其它字 → 不命中（模式是整句锚定）
    '我把聊天记录关了',         // "聊天"和"关了"之间隔了字
    '游戏关了',
    '这局关掉了',
    '你说话真好听',             // 有"说话"但前面不是关闭/开启动词
    '能不能说话温柔点',
    '重置一下密码',             // 宾语不是会话/上下文/对话
    '恢复出厂设置',
    '',
    '   ',
  ];
  for (const t of notCommands) {
    assert.equal(matchAdminCommand(t), null, `不该命中：${t}`);
  }
});

test('斜杠但没命中指令的（/model 之类）要能被识别出来交给 DSH，而不是吞掉', () => {
  assert.equal(matchAdminCommand('/model deepseek-r1'), null);
  assert.equal(isSlashCommand('/model deepseek-r1'), true);
  assert.equal(isSlashCommand('关闭聊天功能'), false);
});

test('优先级：先 "关闭" 后 "开启"，不会互相抢', () => {
  assert.equal(matchAdminCommand('关闭聊天功能')?.id, 'silent');
  assert.equal(matchAdminCommand('开启聊天功能')?.id, 'active');
});

test('表里的每条指令都有 id / desc / 至少一条模式（防止加表时漏字段）', () => {
  for (const c of ADMIN_COMMANDS) {
    assert.ok(c.id && typeof c.id === 'string', 'id');
    assert.ok(c.desc && c.desc.length > 3, `desc: ${c.id}`);
    assert.ok(Array.isArray(c.patterns) && c.patterns.length > 0, `patterns: ${c.id}`);
    for (const re of c.patterns) assert.ok(re instanceof RegExp, `${c.id} 的模式必须是正则`);
  }
});
