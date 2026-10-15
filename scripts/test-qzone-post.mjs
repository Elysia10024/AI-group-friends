// 说说链路的端到端验证（**手工跑，不进 selfcheck**）。
//
//   node scripts/test-qzone-post.mjs        # 需要桥在运行（控制台 3100）
//
// 覆盖：发（纯文字 / 配图）→ 读列表 → 读评论（含楼中楼）→ 好友动态 → 好友边界 → 额度 → 删。
//
// 为什么手工：它会**真的往 QQ 空间发东西**。放进每日体检就等于每天往空间里发一条，
// 既没必要也白白多吃一次风控。语音输出那条能进 selfcheck，是因为合成一条语音只花本机算力。
//
// 安全设计：测试那条一律 **ugcRight=64（仅自己可见）** —— 好友在空间里看不到它，
// 验证完立刻删掉。**但配图例外要知情**：上传的图会留在空间相册里（删说说不会带走图），
// 所以这里只配一张本来就公开的梗图，不碰任何私人图片。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '<项目目录>/qq-bridge-main';
const BASE = 'http://127.0.0.1:3100';
const consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
const ONEBOT_TOKEN = String(cfg.snowluma?.accessToken ?? '');
const sv2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'social-v2.json'), 'utf8').replace(/^\uFEFF/, ''));
const ownerKey = `private:${cfg.ownerQQ}`;
const st = sv2.conversations?.[ownerKey];
if (!st?.agentToken) { console.error(`❌ 拿不到 ${ownerKey} 的 agentToken`); process.exit(1); }
const agentToken = st.agentToken;

let failed = 0;
const ok = (cond, label, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${label}${detail ? `  ${detail}` : ''}`);
};

const call = async (method, p, { body, agent = true } = {}) => {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'x-console-token': consoleToken,
      ...(agent ? { 'x-agent-token': agentToken } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const K = encodeURIComponent(ownerKey);

// 这个脚本会往"回过的评论"账本里写东西（去重 + 窗口限频都靠它）。为了**能反复跑**，
// 开始前把这两本账存下来，finally 里原样放回去（域是按 mtime 读账本的，改完立刻生效）。
const ledgerFile = path.join(ROOT, 'state', 'qzone.json');
const ledgerBefore = (() => {
  try { return JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); } catch { return null; }
})();

// 挑一张"适合"的梗图（配图用；它本来就是公开的表情图，不会被这次测试弄脏）
const libRaw = JSON.parse(fs.readFileSync('<项目目录>/image/library.json', 'utf8').replace(/^\uFEFF/, ''));
const libImages = Array.isArray(libRaw) ? libRaw : (libRaw.images ?? []);
const pick = libImages.find((i) => i.verdict === '适合' && i.by !== 'her') ?? libImages.find((i) => i.verdict === '适合');
if (!pick) { console.error('❌ 图库里没有"适合"的图，配图这一步没法测'); process.exit(1); }

// 读评论用的样本：主人空间里一条真有评论的说说（自己空间现在没有说说可读）
const ownerTid = process.argv[2] ?? '2f237892284d206906ca0700';

console.log(`会话键 ${ownerKey}`);
console.log(`配图用「${pick.name}」｜读评论样本 tid=${ownerTid}（主人空间）\n`);

console.log('=== 1) 发之前：额度 ===');
const before = (await call('GET', '/api/socialV2/mood-status', { agent: false })).json;
console.log(`  enabled=${before?.enabled} 今天 ${before?.todayCount}/${before?.dailyCap} allowed=${before?.allowed} 配图=${before?.imagesEnabled}`);

let tid = null;
// 备用的"测试用说说"：额度挡住（她今天已经发过、还没过最小间隔）时，直接用网关动作造一条
// **仅自己可见**的临时说说当夹具 —— 它不进账本、不影响额度，最后和普通那条一起删掉。
let fixtureTid = null;
const onebot = async (action, params) => fetch(`http://127.0.0.1:3000/${action}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ONEBOT_TOKEN}` },
  body: JSON.stringify(params)
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));

try {
  console.log('\n=== 2) 发一条带图的（仅自己可见）===');
  const posted = await call('POST', '/api/socialV2/post-mood', {
    body: { key: ownerKey, content: `测试：这条只有我自己看得见（${new Date().toLocaleString('zh-CN')}）`, ugcRight: 64, image: pick.name }
  });
  tid = posted.json?.tid ?? null;
  console.log(`  HTTP ${posted.status} ${JSON.stringify(posted.json).slice(0, 220)}`);
  if (posted.status === 400 && !tid) {
    // 额度挡住是**正常行为**（她今天发过、还没到下一次），不是 bug：这里换夹具，别把守卫判红。
    console.log('  （额度挡住了 —— 这正是它该做的。改用夹具说说继续验证后面的链路）');
    const fixture = await onebot('send_qzone_msg', { content: `测试夹具：仅自己可见（${new Date().toLocaleString('zh-CN')}）`, ugc_right: 64 });
    console.log(`  夹具：${JSON.stringify(fixture).slice(0, 160)}`);
    fixtureTid = fixture?.data?.tid ?? null;
    ok(!!fixtureTid, '夹具说说造好了（仅自己可见）', fixtureTid ?? fixture?.wording ?? '');
  } else {
    ok(posted.json?.ok === true, '发成功', posted.json?.error ?? '');
    ok(!!tid, '拿到 tid（删得掉）', tid ?? '');
    ok(posted.json?.image?.name === pick.name, '回执里带配图信息', JSON.stringify(posted.json?.image ?? null));

    console.log('\n=== 3) 读列表：能看到刚发的那条 + 图数 ===');
    const list = await call('GET', `/api/socialV2/mood-list?key=${K}&count=5`);
    const mine = (list.json?.posts ?? []).find((p) => p.tid === tid);
    console.log(`  ${String(list.json?.text ?? '').split('\n')[0]}`);
    ok(!!mine, '列表里有这条', mine ? `图 ${mine.images} 张` : '');
    ok(Number(mine?.images) > 0, '空间侧也认到"带图"');
  }

  console.log('\n=== 4) 读评论（含楼中楼）===');
  const cm = await call('GET', `/api/socialV2/mood-comments?key=${K}&tid=${encodeURIComponent(ownerTid)}&targetUserId=${cfg.ownerQQ}`);
  console.log(`  HTTP ${cm.status}`);
  if (cm.json?.ok) {
    console.log(String(cm.json.text ?? '').split('\n').map((l) => `  ${l}`).join('\n'));
    ok((cm.json.detail?.comments ?? []).length > 0, '读到了评论');
    ok((cm.json.detail?.comments ?? []).some((c) => (c.replies ?? []).length > 0), '读到了楼中楼回复');
  } else {
    ok(false, '读评论', cm.json?.error ?? '');
  }

  console.log('\n=== 5) 好友动态（空是正常的）===');
  const feeds = await call('GET', `/api/socialV2/qzone-feeds?key=${K}&count=10`);
  console.log(`  HTTP ${feeds.status} ${String(feeds.json?.text ?? feeds.json?.error ?? '').slice(0, 160)}`);
  ok(feeds.status === 200 && feeds.json?.ok === true, '接口通（空=好友最近没发）');

  console.log('\n=== 6) 好友边界：读陌生人空间必须被拒 ===');
  const stranger = await call('GET', `/api/socialV2/mood-list?key=${K}&targetUserId=12345678`);
  console.log(`  HTTP ${stranger.status} ${String(stranger.json?.error ?? '').slice(0, 120)}`);
  ok(stranger.json?.ok === false && /不是她的好友/.test(String(stranger.json?.error ?? '')), '陌生人被挡住');

  // ── 回评论（只在临时那条说说上做：全程仅自己可见，删说说时连评论一起没）──────────────
  // 额度挡住时用夹具说说（fixtureTid），所以这里统一用 workTid。
  const workTid = tid ?? fixtureTid;
  console.log('\n=== 7) 回评论（先自己造一条评论，充当"有人评论了"）===');
  // 直接调网关动作造一条：这样"她那边有人评论过"这个前提成立，而且不碰任何真实说说。
  const seed = await onebot('comment_qzone', { tid: workTid, content: '测试用：假装是别人留下的评论' });
  console.log(`  造评论：${JSON.stringify(seed).slice(0, 150)}`);
  ok(seed?.status === 'ok' || seed?.retcode === 0, '评论造好了', seed?.wording ?? seed?.error ?? '');

  const before2 = await call('GET', `/api/socialV2/mood-comments?key=${K}&tid=${encodeURIComponent(workTid)}`);
  ok((before2.json?.detail?.comments ?? []).length >= 1, '读得到那条评论', `共 ${(before2.json?.detail?.comments ?? []).length} 条`);

  // 用 commentText 把目标钉在夹具那条评论上：它其实是**她自己的号**发出去的（没法用别的号评论），
  // 所以按 toUserId 找不到人 —— 按原文找才稳。真实场景里她用 toUserId/toName 认人（对方 uin ≠ 她自己）。
  const reply = await call('POST', '/api/socialV2/mood-comment', {
    body: { key: ownerKey, tid: workTid, content: '收到了，测试回复', commentText: '假装是别人留下的评论' }
  });
  console.log(`  回评论：HTTP ${reply.status} ${JSON.stringify(reply.json).slice(0, 200)}`);
  ok(reply.json?.ok === true, '回成功', reply.json?.error ?? '');
  ok(/@/.test(String(reply.json?.text ?? '')), '回出去的话带上了 @', String(reply.json?.text ?? ''));

  // 重复回**同一条**：同一个 commentText 钉死目标 → 去重必须拦住
  const dup = await call('POST', '/api/socialV2/mood-comment', {
    body: { key: ownerKey, tid: workTid, content: '再回一次（应该被拦）', commentText: '假装是别人留下的评论' }
  });
  console.log(`  重复回：HTTP ${dup.status} ${String(dup.json?.error ?? dup.json?.text ?? '').slice(0, 110)}`);
  ok(dup.json?.ok === false && /回过了|最多/.test(String(dup.json?.error ?? '')), '同一条评论不会被回第二次（去重生效）');

  const after2 = await call('GET', `/api/socialV2/mood-comments?key=${K}&tid=${encodeURIComponent(workTid)}`);
  ok((after2.json?.detail?.comments ?? []).length >= 2, '空间里能看到回复多了一条', `共 ${(after2.json?.detail?.comments ?? []).length} 条`);

  console.log('\n=== 8) "有人评论就叫醒她"：查一次新评论 ===');
  const fresh = await call('GET', `/api/socialV2/mood-new-comments?key=${K}`);
  console.log(`  HTTP ${fresh.status}｜新评论 ${(fresh.json?.comments ?? []).length} 条｜${String(fresh.json?.notice ?? '').slice(0, 90)}`);
  ok(fresh.status === 200 && fresh.json?.ok === true, '"查新评论"接口通');
} finally {
  console.log('\n=== 9) 清理：删掉测试说说（评论跟着一起没）===');
  for (const cleanupTid of [tid, fixtureTid]) {
    if (!cleanupTid) continue;
    const del = await call('POST', '/api/socialV2/delete-mood', { body: { key: ownerKey, tid: cleanupTid } });
    console.log(`  ${cleanupTid} → HTTP ${del.status} ${JSON.stringify(del.json)}`);
    ok(del.json?.ok === true, '删除成功');
  }
  if (!tid && !fixtureTid) console.log('  （没有 tid，跳过 —— 若有残留请手工去空间删）');
  const after = (await call('GET', '/api/socialV2/mood-status', { agent: false })).json;
  console.log(`\n=== 10) 删之后：额度与账本 ===`);
  console.log(`  今天 ${after?.todayCount}/${after?.dailyCap} allowed=${after?.allowed} 账本条数=${after?.posts?.length ?? '?'}`);
  ok(after?.posts?.length === before?.posts?.length, '账本回到原样（额度还回来）');
  // 空间列表也确认一次（避免"删了但空间还在"）
  const relist = await call('GET', '/api/socialV2/mood-list?key=${K}&count=10');
  ok(!(relist.json?.posts ?? []).some((p) => [tid, fixtureTid].includes(p.tid)), '空间里也没有残留');
  // 把"回过的评论 / 看过的评论"两本账恢复原样，脚本才能连着跑（否则第二次会被 30 分钟限频挡住）
  if (ledgerBefore) {
    try {
      const now = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      fs.writeFileSync(ledgerFile, JSON.stringify({
        ...now,
        seenComments: ledgerBefore.seenComments ?? {},
        repliedComments: ledgerBefore.repliedComments ?? []
      }, null, 2) + '\n', 'utf8');
      console.log('  （评论账本已恢复原样 —— 这个脚本可以反复跑）');
    } catch (e) {
      console.log(`  ⚠️ 评论账本没能恢复：${e?.message ?? e}`);
    }
  }
}

console.log(failed ? `\n❌ ${failed} 项没过` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
