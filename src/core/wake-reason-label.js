// 把唤醒原因翻译成她读得懂的一句话 —— 抽出来的理由（真实事故 2026-09-30）：
//
//   她把自己"订阅"回来了（订阅 = 那人说任何话都叫醒她）。材料里：
//     · 【你现在的状态】只写「触发条件：atMention/nameMention/poke」——**没写她订阅了谁**；
//     · 【这次找你的原因】直接甩内部代号「唤醒原因：speaker:讨厌偏头痛」。
//   于是她被叫醒时，看到群里正飘着「@AF」，就以为有人在 @ 她，
//   连着说"空@我一下就想跑？""再@我可要收费了""@都@上了还挂个笑脸"——群里当场"出幻觉了"。
//
// 结论：**唤醒 ≠ 被 @**，而材料必须把这句话说清楚。所以这里对每种原因都给一句人话，
// 并且凡是"不是冲她来的"，都显式写上「（不是 @ 你）」。

const NOT_CALLING = '（不是 @ 你）';

/**
 * @param {string} reason 唤醒原因（内部代号，如 speaker:讨厌偏头痛 / followUp / keyword:DS）
 * @returns {string} 给她看的一句话
 */
export function wakeReasonLabel(reason) {
  const r = String(reason ?? '').trim();
  if (!r) return '';
  if (r.startsWith('speaker:')) {
    const who = r.slice('speaker:'.length).trim() || '某个人';
    return `你订阅的「${who}」说话了${NOT_CALLING}——只是你设了"他一说话就叫醒你"，先看清是不是在跟你说话`;
  }
  if (r.startsWith('keyword:')) {
    const kw = r.slice('keyword:'.length).trim();
    return `有人提到了「${kw}」这个关键词，于是把你叫醒了${NOT_CALLING}`;
  }
  const TABLE = {
    bootstrap: '刚接入这个会话（第一次唤醒）',
    timeout: `你设的潜水时间到了，时间到就叫你${NOT_CALLING}`,
    replyCheck: `回复检查：回来看看有没有人接你的话${NOT_CALLING}`,
    proactiveCheck: `群里安静了一阵，回头看一眼${NOT_CALLING}`,
    // 和 proactiveCheck 是**两个方向**：那个是"安静了回来看看"，这个是"正热闹、插得上就说"。
    // 措辞里必须写清"不是 @ 你"，否则她会把这句当成有人点她名（就是本文开头那次幻觉）。
    densityWake: `群里正热闹，你插得上就说一句${NOT_CALLING}`,
    qzoneComment: `你发的**说说**下面有人评论了${NOT_CALLING}——在空间里回，别搬到群里`,
    redPacket: '群里有人发了红包',
    private: '私聊有新消息',
    followUp: `刚才跟你说过话的人又说了一句${NOT_CALLING}——看看要不要接`,
    atMention: '有人 @ 了你，或引用了你的某条消息',
    nameMention: '有人叫了你的名字/昵称',
    poke: '有人拍了一拍**你**',
    anyMessage: `群里又有新消息${NOT_CALLING}`,
    question: `有人像是在问你话${NOT_CALLING}——先确认是不是在跟你说话`,
    probability: `随机抽查把你叫醒了（你自己设的概率唤醒，纯属撞上）${NOT_CALLING}`
  };
  return TABLE[r] ?? r;
}

/** 材料里那一行：`唤醒原因：<人话>`。 */
export function wakeReasonLine(reason) {
  const label = wakeReasonLabel(reason);
  return label ? `唤醒原因：${label}` : '';
}
