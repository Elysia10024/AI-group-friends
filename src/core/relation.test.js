// src/core/relation.js 的测试。跑法：npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { RELATION_TIERS, normalizeRelation, closerRelation, relationFromTrait, relationLines, resolveRelationWrite, relationNoteSuffix } from './relation.js';

test('六档（讨厌在最前），别名能归一', () => {
  assert.deepEqual(RELATION_TIERS, ['讨厌', '路人', '认识但不太熟', '熟人', '好朋友', '家人']);
  assert.equal(normalizeRelation('陌生人'), '路人');
  assert.equal(normalizeRelation('不太熟'), '认识但不太熟');
  assert.equal(normalizeRelation('朋友'), '好朋友');
  assert.equal(normalizeRelation('自己人'), '家人');
  assert.equal(normalizeRelation('烦'), '讨厌');
  assert.equal(normalizeRelation('不喜欢'), '讨厌');
  assert.equal(normalizeRelation('很烦他'), '', '带修饰词认不出就不猜');
  assert.equal(normalizeRelation('很好的网友'), '', '认不出就不猜');
});

test('档位有分歧取更亲近的那个（宁可偏熟，别当陌生人）', () => {
  assert.equal(closerRelation('熟人', '好朋友'), '好朋友');
  assert.equal(closerRelation('家人', '路人'), '家人');
  assert.equal(closerRelation('', '熟人'), '熟人');
  assert.equal(closerRelation('路人', ''), '路人');
});

test('从印象文本里抠关系', () => {
  assert.equal(relationFromTrait('关系：家人'), '家人');
  assert.equal(relationFromTrait('关系: 好朋友'), '好朋友');
  assert.equal(relationFromTrait('他爱问好感度'), '');
});

test('材料里的关系行：只列本会话出现过的人，读全局档位', () => {
  const people = { '10000001': { relation: '家人' }, '3951361727': { relation: '好朋友' }, '999': { relation: '熟人' } };
  const lines = relationLines({ people, speakers: [
    { userId: '10000001', sender: '群友甲，🌿私你们这群烧货' },
    { userId: '3951361727', sender: '群友乙' },
    { userId: '10000001', sender: '群友甲，🌿私你们这群烧货' },
    { userId: '5', sender: '没档位的人' }
  ] });
  assert.equal(lines.length, 2, '去重 + 没有档位的不写');
  assert.match(lines[0], /群友甲.*家人/);
  assert.match(lines[1], /群友乙.*好朋友/);
});

test('同一个 QQ 在任何会话读到的都是同一档（跨群一致）', () => {
  const people = { '10000001': { relation: '家人' } };
  const inGroupA = relationLines({ people, speakers: [{ userId: '10000001', sender: '群友甲，🌿私你们这群烧货' }] });
  const inGroupB = relationLines({ people, speakers: [{ userId: '10000001', sender: '杨森' }] });
  assert.match(inGroupA[0], /家人/);
  assert.match(inGroupB[0], /家人/, '换个群、换个名字，档位不变');
  assert.match(inGroupB[0], /杨森/, '但用**当前群的名字**称呼（别在 B 群喊 A 群的名）');
});

test('写入关系：她的判断是权威，升能升、降能降（旧的"只升不降"已修）', () => {
  // 降档这条以前永远存不下来（closerRelation 永远取更亲近的那个）
  assert.equal(resolveRelationWrite({ qq: '10000002', next: '讨厌' }).tier, '讨厌');
  assert.equal(resolveRelationWrite({ qq: '999', next: '讨厌' }).tier, '讨厌', '从熟人直接降到讨厌也要能存下');
  assert.equal(resolveRelationWrite({ qq: '999', next: '熟人' }).tier, '熟人');
  assert.equal(resolveRelationWrite({ qq: '999', next: '好朋友' }).tier, '好朋友');
});

test('两条硬边界：主人恒为家人；家人档只能由主人指定', () => {
  const owner = '10000001';
  const ownerTry = resolveRelationWrite({ ownerQQ: owner, qq: owner, next: '讨厌' });
  assert.equal(ownerTry.tier, '家人', '主人永不降档');
  assert.match(ownerTry.adjusted, /主人恒为家人/, '被边界改写要回报，别默默改');
  assert.equal(resolveRelationWrite({ ownerQQ: owner, qq: owner, next: '家人' }).adjusted, '', '本来就是家人不算改写');
  const otherTry = resolveRelationWrite({ ownerQQ: owner, qq: '3951361727', next: '家人' });
  assert.equal(otherTry.tier, '好朋友', '其他人最高只能到好朋友');
  assert.match(otherTry.adjusted, /只能由主人指定/);
});

test('认不出的档位 / 缺 QQ 一律不写（fail-closed）', () => {
  assert.equal(resolveRelationWrite({ qq: '1', next: '很好的网友' }).ok, false);
  assert.equal(resolveRelationWrite({ qq: '', next: '熟人' }).ok, false);
  assert.equal(resolveRelationWrite({ qq: '1', next: '' }).ok, false);
});

test('关系行带上"最近影响关系的那句话 + 时间"（她自己看得见，面板也读同一份）', () => {
  const at = new Date(2026, 9, 12, 0, 11).getTime(); // 本地时间 10-12 00:11
  const suffix = relationNoteSuffix({ relationNote: '他骂过我，最近有点烦', relationNoteAt: at });
  assert.match(suffix, /10-12 00:11/);
  assert.match(suffix, /他骂过我/);
  assert.equal(relationNoteSuffix({}), '', '没记过就留空');
  const lines = relationLines({ people: { 1: { relation: '讨厌', relationNote: '骂过我', relationNoteAt: at } }, speakers: [{ userId: '1', sender: 'UserQ' }] });
  assert.match(lines[0], /UserQ：讨厌（10-12 00:11：骂过我）/);
});
