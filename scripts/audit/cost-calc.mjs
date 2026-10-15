// 按 DeepSeek 官方单价计算实际花费
// 官方价（每 1M token）：
//   缓存命中输入  off-peak $0.003 / peak $0.006
//   缓存未命中输入 off-peak $0.15  / peak $0.30
//   输出          off-peak $0.6   / peak $1.2
// 高峰时段：UTC 01:00-04:00 与 06:00-10:00（周一至周五）= 北京时间 09:00-12:00 与 14:00-18:00
const P = {
  hit:      { off: 0.003, peak: 0.006 },
  miss:     { off: 0.15,  peak: 0.30 },
  out:      { off: 0.6,   peak: 1.2 },
};
const CNY = 7.1; // 粗略汇率

const cases = [
  { label: '仅 QQ 群会话（session-54bb7e13，28 次调用）', calls: 28, miss: 131509, hit: 797824, out: 5395 },
  { label: '全部会话（含我所有测试，44 次调用）',        calls: 44, miss: 317208, hit: 887424, out: 8739 },
];

for (const c of cases) {
  const cost = (mode) =>
    (c.miss / 1e6) * P.miss[mode] + (c.hit / 1e6) * P.hit[mode] + (c.out / 1e6) * P.out[mode];
  const off = cost('off'), peak = cost('peak');
  console.log(`\n=== ${c.label} ===`);
  console.log(`  未命中输入 ${c.miss.toLocaleString().padStart(9)}  × $${P.miss.off}/$${P.miss.peak}`);
  console.log(`  命中输入   ${c.hit.toLocaleString().padStart(9)}  × $${P.hit.off}/$${P.hit.peak}`);
  console.log(`  输出       ${c.out.toLocaleString().padStart(9)}  × $${P.out.off}/$${P.out.peak}`);
  console.log(`  ---`);
  console.log(`  全走低谷 : $${off.toFixed(4)}  ≈ ¥${(off * CNY).toFixed(3)}`);
  console.log(`  全走高峰 : $${peak.toFixed(4)}  ≈ ¥${(peak * CNY).toFixed(3)}`);
  console.log(`  平均每 1 次调用 : $${(off / c.calls).toFixed(6)} ~ $${(peak / c.calls).toFixed(6)}`);
  console.log(`  平均每 1 万 token : $${(((off + peak) / 2) / ((c.miss + c.hit + c.out) / 1e4)).toFixed(5)}`);
}

// 单次唤醒的典型成本（按 QQ 会话平均）
const c = cases[0];
const perCallMiss = c.miss / c.calls, perCallHit = c.hit / c.calls, perCallOut = c.out / c.calls;
const off1 = (perCallMiss / 1e6) * P.miss.off + (perCallHit / 1e6) * P.hit.off + (perCallOut / 1e6) * P.out.off;
const peak1 = (perCallMiss / 1e6) * P.miss.peak + (perCallHit / 1e6) * P.hit.peak + (perCallOut / 1e6) * P.out.peak;
console.log('\n=== 单次调用平均 ===');
console.log(`  输入 未命中 ${Math.round(perCallMiss)} / 命中 ${Math.round(perCallHit)} / 输出 ${Math.round(perCallOut)}`);
console.log(`  低谷 $${off1.toFixed(6)}  ≈ ¥${(off1 * CNY).toFixed(5)}`);
console.log(`  高峰 $${peak1.toFixed(6)}  ≈ ¥${(peak1 * CNY).toFixed(5)}`);
console.log(`  一个回合(唤醒)通常 1~6 次调用 → 约 ¥${(off1 * CNY * 1).toFixed(4)} ~ ¥${(peak1 * CNY * 6).toFixed(4)}`);
