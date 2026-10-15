// 「有人在找你」那一行怎么显示 —— 抽出来是因为这里**谎报过目标**（真实事故 2026-09-29）：
//
//   UserA 戳的是「丰川祥子」，而材料里把**所有**拍一拍都渲染成「拍了一拍你」，
//   结果她被唤醒后以为 UserA 在拍她，回手给了管理员一个拍一拍（"还你一下，收好"），
//   群里当场"？"。她事后还很笃定："他戳我半天，还他一拍怎么了"。
//
// 所以规则很简单：**没证据说是拍你，就别写"拍了一拍你"**。

/**
 * @param {{kind?: string, sender?: string, text?: string, pokeTargetIsSelf?: boolean}} entry
 * @returns {string} 例如 `拍了一拍你` / `拍了别人` / `@ 了你` / `叫了你的名字`
 */
export function mentionLabel(entry) {
  const kind = String(entry?.kind ?? '');
  if (kind === 'poke') {
    if (entry?.pokeTargetIsSelf === true) return '拍了一拍你';
    if (entry?.pokeTargetIsSelf === false) return '拍了别人';
    // 老记录没有这个字段：按正文兜底（social-log 写的是「…戳了戳 你」/「…戳了戳 <QQ>」）
    return /戳了戳\s*你/.test(String(entry?.text ?? '')) ? '拍了一拍你' : '拍了别人';
  }
  if (kind === 'atMention') return '@ 了你';
  return '叫了你的名字';
}
