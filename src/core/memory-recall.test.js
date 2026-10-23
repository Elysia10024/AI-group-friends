// src/core/memory-recall.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { recallAcrossConversations, convLabel, parseSinceMs } from './memory-recall.js';

const CONVS = [
  { key: 'group:20000001', memory: { activeTopics: [{ text: '三水让我接发图功能那摊' }], memberImpressions: { 群三水: { traits: ['关系：家人', '他爱拿我的配置当谈资'] } } } },
  { key: 'group:20000004', memory: { activeTopics: [{ text: '杨森说下周一起打游戏' }] } },
  { key: 'private:10000001', memory: { activeTopics: [{ text: '他说家里那事别追问' }] } }
];

test('在 B 群问 A 群的事：能查到，并标明是哪个群', () => {
  const lines = recallAcrossConversations({ conversations: CONVS, requesterKey: 'group:20000004', query: '发图' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /群 20000001/);
  assert.match(lines[0], /发图功能/);
});

test('本会话的内容不重复列（材料里已经有了）', () => {
  const lines = recallAcrossConversations({ conversations: CONVS, requesterKey: 'group:20000001', query: '发图' });
  assert.deepEqual(lines, []);
});

test('私聊隔离：群里查不到私聊内容；私聊自己能查到', () => {
  const inGroup = recallAcrossConversations({ conversations: CONVS, requesterKey: 'group:20000001', query: '家里那事' });
  assert.deepEqual(inGroup, [], '群里不该看到私聊');
  const inPrivate = recallAcrossConversations({ conversations: CONVS, requesterKey: 'private:10000001', query: '家里' });
  assert.equal(inPrivate.length, 0, '自己问自己那条也在"本会话"里、不重复列');
  const otherPrivate = recallAcrossConversations({ conversations: CONVS, requesterKey: 'private:10000002', query: '家里那事' });
  assert.deepEqual(otherPrivate, [], '别人的私聊查不到');
});

test('不给关键词时列出各会话的话题（知道"别的群在聊什么"）', () => {
  const lines = recallAcrossConversations({ conversations: CONVS, requesterKey: 'group:20000001', max: 5 });
  assert.ok(lines.length >= 1);
  assert.match(lines.join('\n'), /杨森说下周一起打游戏/);
});

test('最多 max 条、长句截断', () => {
  const many = [{ key: 'group:1', memory: { activeTopics: Array.from({ length: 20 }, (_, i) => ({ text: `话题${i}` + 'x'.repeat(200) })) } }];
  const lines = recallAcrossConversations({ conversations: many, requesterKey: 'group:2', max: 3 });
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.length < 200));
});

test('convLabel：群/私聊都写清楚', () => {
  assert.equal(convLabel('group:20000001'), '群 20000001');
  assert.equal(convLabel('private:10000001'), '私聊 10000001');
});

// ── 时间维度（2026-10-12：时间只存不渲染，被追问时才查）────────────────────
test('parseSinceMs：支持 7d / 12h / 30m / 日期；认不出就不过滤（fail-open）', () => {
  const now = new Date(2026, 9, 12, 12).getTime();
  assert.equal(parseSinceMs('7d', now), now - 7 * 86400000);
  assert.equal(parseSinceMs('12h', now), now - 12 * 3600000);
  assert.equal(parseSinceMs('30m', now), now - 30 * 60000);
  assert.equal(parseSinceMs('3天', now), now - 3 * 86400000);
  assert.equal(parseSinceMs('2026-10-01', now), new Date(2026, 9, 1).getTime());
  assert.equal(parseSinceMs('', now), 0);
  assert.equal(parseSinceMs('昨天', now), 0, '认不出别乱猜，按不过滤处理');
});

test('recallAcrossConversations：带绝对时间、能按人筛、能按时间窗筛', () => {
  const t0 = new Date(2026, 9, 5, 10).getTime();
  const t1 = new Date(2026, 9, 11, 10).getTime();
  const convs = [{
    key: 'group:1',
    memory: {
      memberImpressions: {
        Qruei: { traits: ['他骂过我', '爱说脏话'], traitMeta: [{ firstAt: t0, lastAt: t0, hits: 1 }, { firstAt: t0, lastAt: t1, hits: 3 }] }
      }
    }
  }];
  const all = recallAcrossConversations({ conversations: convs, requesterKey: 'group:2' });
  assert.equal(all.length, 2);
  assert.match(all[0], /\[10-11\]/, '最近提过的排前面，并带绝对时间');
  assert.match(all[1], /\[10-5\]/);
  assert.match(all[0], /对Qruei的/, '标明是对谁的印象');
  assert.equal(recallAcrossConversations({ conversations: convs, requesterKey: 'group:2', person: 'Qruei' }).length, 2);
  assert.equal(recallAcrossConversations({ conversations: convs, requesterKey: 'group:2', person: '别人' }).length, 0);
  const recent = recallAcrossConversations({ conversations: convs, requesterKey: 'group:2', sinceMs: new Date(2026, 9, 10).getTime() });
  assert.equal(recent.length, 1, '只有 10-11 那条落在窗口里');
});

test('按时间筛时，没有时间的条目不出场（不给假时间）', () => {
  const convs = [{ key: 'group:1', memory: { memberImpressions: { A: { traits: ['很久以前的事'] } } } }];
  assert.equal(recallAcrossConversations({ conversations: convs, requesterKey: 'group:2', sinceMs: 1 }).length, 0);
  assert.equal(recallAcrossConversations({ conversations: convs, requesterKey: 'group:2' }).length, 1, '不按时间筛时照常列出来');
});
