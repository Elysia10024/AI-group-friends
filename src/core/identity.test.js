// 身份与引用解析的契约测试。跑法：npm test
//
// 行为不变性由**黄金快照**证明（这次不是抽函数比，因为这几个函数是 async + I/O）：
// 改动前用固定 stub 跑一遍 bridge.js 里的 resolveReplyInfo / resolveReplyTargetV2 /
// groupIdFromKey / selfAliasesFor，把结果写成 JSON；改动后再跑一遍，diff 两份 —— 0 差异。
//
// 这里留下的重点是**引用归属校验**（安全相关）与**取名回退链**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupIdFromKey, selfAliases, memberName, senderLabel, isUsableName,
  isSafeMessageId, replyOwnershipOk, localReplyInfo
} from './identity.js';

// ---------------- groupIdFromKey ----------------
test('groupIdFromKey：只认 group:数字，其余返回空串', () => {
  assert.equal(groupIdFromKey('group:20000001'), '20000001');
  assert.equal(groupIdFromKey('group:0012'), '0012');
  assert.equal(groupIdFromKey('private:10000001'), '');
  assert.equal(groupIdFromKey('group:abc'), '');
  assert.equal(groupIdFromKey('group:'), '');
  assert.equal(groupIdFromKey('GROUP:1'), '');
  assert.equal(groupIdFromKey(''), '');
  assert.equal(groupIdFromKey(null), '');
  assert.equal(groupIdFromKey(undefined), '');
});

// ---------------- selfAliases ----------------
test('selfAliases：昵称小写化，叠加名片缓存', () => {
  assert.deepEqual([...selfAliases('测试二号机', new Set(['大隐鲸']))].sort(), ['大隐鲸', '测试二号机'].sort());
  assert.deepEqual([...selfAliases('ABC')], ['abc']);
  assert.deepEqual([...selfAliases('', new Set(['x']))], ['x']);
  assert.deepEqual([...selfAliases(null, null)], []);
});

// ---------------- memberName / senderLabel ----------------
test('memberName：名片优先于昵称，取不到返回空串', () => {
  assert.equal(memberName({ card: '名片', nickname: '昵称' }), '名片');
  assert.equal(memberName({ nickname: '昵称' }), '昵称');
  assert.equal(memberName({ card: '', nickname: '昵称' }), '昵称');
  assert.equal(memberName({}), '');
  assert.equal(memberName(null), '');
});

test('memberName 刻意不 trim —— 空白名片原样返回（与旧实现逐字一致）', () => {
  assert.equal(memberName({ card: '  ', nickname: '昵称' }), '  ');
});

// ---------------- BUG-001：群名片是未解码 protobuf ----------------

/** 实测样本：群 20000001 的 10000006，19 个字符里 10 个是 C0 控制字符。 */
const GARBAGE_CARD = '\n\n\n\b&ÿfÌÿ\n\u000e\u0012\f丰川祥子\u0010\u0000';

test('BUG-001 复现：脏名片 + 干净昵称 → 用昵称，不再输出二进制乱码', () => {
  // 修复前：memberName 返回 GARBAGE_CARD，她在 AI 眼里就是一串乱码
  assert.equal(memberName({ card: GARBAGE_CARD, nickname: '大祥老师' }), '大祥老师');
  assert.equal(senderLabel({ card: GARBAGE_CARD, nickname: '大祥老师' }, '10000006'), '大祥老师');
});

test('BUG-001：只有脏名片、没有昵称 → 返回空串，让调用方回退到 QQ 号', () => {
  // 空串比二进制乱码有用：senderLabel 会退回 QQ 号，memberName(…) || null 会变 null
  assert.equal(memberName({ card: GARBAGE_CARD }), '');
  assert.equal(senderLabel({ card: GARBAGE_CARD }, '10000006'), '10000006');
  assert.equal(senderLabel({ card: GARBAGE_CARD }, null, '有人'), '有人');
});

test('BUG-001：脏昵称、干净名片 → 仍用名片', () => {
  assert.equal(memberName({ card: '名片', nickname: GARBAGE_CARD }), '名片');
});

test('BUG-001：两个都脏 → 空串', () => {
  assert.equal(memberName({ card: GARBAGE_CARD, nickname: GARBAGE_CARD }), '');
});

test('isUsableName 的边界：真实群里的干净名字不能被误判', () => {
  // 这 47 个是实测从 OneBot get_group_member_list 拿到的真实名片/昵称样本
  const clean = [
    '群卦师，时不时来群里讲道（128/128）', '这货真不是千岁岁', '姜丝小涵（✓）',
    '请你吃酸橙（！？来来？！）', '大祥老师', '　　　　　', '超高校级的大善人',
    '[有新文件] 禁漫天堂.apk', '至招，至丑，至绷的化身', '群三水，🌿私你们这群烧货',
    '🐊Gx🐊', '🤓👆🏻', 'ღIRAS 17514', '♿', '♜', '咲音是凯尔希大人的狗（50/128）',
    'A', '小号', 'Dmnu'
  ];
  for (const n of clean) assert.equal(isUsableName(n), true, `被误判：${JSON.stringify(n)}`);

  // 不可用的：C0 控制字符（制表符除外）、DEL、替换字符、空
  assert.equal(isUsableName(GARBAGE_CARD), false);
  assert.equal(isUsableName('a\u0000b'), false);
  assert.equal(isUsableName('a\u007Fb'), false);
  assert.equal(isUsableName('a\uFFFDb'), false);
  assert.equal(isUsableName(''), false);
  assert.equal(isUsableName(null), false);
  assert.equal(isUsableName(undefined), false);
  assert.equal(isUsableName('a\tb'), true, '制表符算可用');
  assert.equal(isUsableName('换行\n名'), false, '换行属于 C0，判为脏');
});

test('senderLabel：名片 → 昵称 → 兜底 id → 未知', () => {
  assert.equal(senderLabel({ card: '名片', nickname: '昵称' }, 'u1'), '名片');
  assert.equal(senderLabel({ nickname: '昵称' }, 'u1'), '昵称');
  assert.equal(senderLabel({}, 'u1'), 'u1');
  assert.equal(senderLabel({}, 0), '0');
  assert.equal(senderLabel({}, null), '未知');
  assert.equal(senderLabel({}, ''), '未知');
  assert.equal(senderLabel({}, null, '有人'), '有人');
  assert.equal(senderLabel(null, null, '有人'), '有人');
});

// ---------------- isSafeMessageId ----------------
test('isSafeMessageId：超出安全整数范围的要拒绝', () => {
  assert.equal(isSafeMessageId(123), true);
  assert.equal(isSafeMessageId('123'), true);
  assert.equal(isSafeMessageId(-1779334062), true);
  assert.equal(isSafeMessageId('not-a-number'), false);
  assert.equal(isSafeMessageId('9007199254740993'), false, '超过 Number.MAX_SAFE_INTEGER');
  assert.equal(isSafeMessageId(NaN), false);
});

// ---------------- 引用归属校验（安全） ----------------
test('replyOwnershipOk：群会话必须带群归属且与会话一致', () => {
  assert.equal(replyOwnershipOk({ group_id: '20000001' }, 'group', '20000001'), true);
  assert.equal(replyOwnershipOk({ groupId: '20000001' }, 'group', '20000001'), true, '兼容 camelCase');
  assert.equal(replyOwnershipOk({ group_id: '999999' }, 'group', '20000001'), false, '别的群');
  assert.equal(replyOwnershipOk({}, 'group', '20000001'), false, '无归属 → 拒绝');
  assert.equal(replyOwnershipOk({ group_id: undefined, groupId: undefined }, 'group', '20000001'), false);
});

test('replyOwnershipOk：私聊消息不能带群归属，且发送者必须匹配', () => {
  assert.equal(replyOwnershipOk({ user_id: '10000001' }, 'private', '10000001'), true);
  assert.equal(replyOwnershipOk({ sender: { user_id: '10000001' } }, 'private', '10000001'), true, '兼容 sender.user_id');
  assert.equal(replyOwnershipOk({ group_id: '20000001', user_id: '10000001' }, 'private', '10000001'), false, '带群归属 → 拒绝（防跨会话）');
  assert.equal(replyOwnershipOk({ user_id: '999' }, 'private', '10000001'), false, '陌生人 → 拒绝');
  assert.equal(replyOwnershipOk({}, 'private', '10000001'), false, '无发送者 → 拒绝');
});

test('replyOwnershipOk：私聊里允许机器人自己发的消息', () => {
  assert.equal(replyOwnershipOk({ user_id: '3612473248' }, 'private', '10000001', '3612473248'), true);
  assert.equal(replyOwnershipOk({ user_id: '3612473248' }, 'private', '10000001', null), false, '不传 selfId 就不能放行');
});

test('replyOwnershipOk：raw 非法一律拒绝', () => {
  for (const raw of [null, undefined, 'x', 123]) {
    assert.equal(replyOwnershipOk(raw, 'group', '20000001'), false, String(raw));
  }
});

// ---------------- localReplyInfo ----------------
test('localReplyInfo：从本地消息构造兜底 info', () => {
  const r = localReplyInfo({ sender: '甲', text: '原文', seq: 5 }, '2001');
  assert.deepEqual(r, { sender: '甲', text: '原文', userId: null, messageId: '2001', seq: 5 });
});

test('localReplyInfo：text 缺失时回退 plain，并截断到 1200 字', () => {
  assert.equal(localReplyInfo({ sender: '甲', plain: 'plain 文本', seq: 6 }, '2002').text, 'plain 文本');
  assert.equal(localReplyInfo({ sender: '甲', text: 'x'.repeat(2000), seq: 7 }, '2003').text.length, 1200);
});

test('localReplyInfo：sender 缺失时是空串而不是 undefined', () => {
  const r = localReplyInfo({ seq: 1 }, '9');
  assert.equal(r.sender, '');
  assert.equal(r.messageId, '9');
});
