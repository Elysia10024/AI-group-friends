// 红包状态（二代会话）域：从 bridge.js 的 main() 里整体搬出来的一个"簇"（3 个互相调用的函数）。
//
// 搬出来的理由：main() 四千行、占 bridge.js 的 85%，想读这一段得跨过整个函数。
//
// 接口是**工厂 + ctx**，不是一个个注入：
//   · 簇内函数互相调用，整体搬才能就地保留这些调用；
//   · 只读且在 main() 里先声明的名字走解构；
//   · **可写的**和**在簇之后才声明的**名字走 `ctx.X` + get/set 访问器 —— 解构会拿到
//     快照（永远看不到 main() 后来的更新），后声明的会 TDZ（函数声明提升、const/let 不提升）。
//
// 正文与搬迁前**逐字相同**，只有上述 0 处裸名字被改写成 `ctx.X`；
// 搬迁时用"逆变换逐字还原原文"证明过这一点。
export function createRedPacketStateModule(ctx) {
  const {
    redPacketPending,
  } = ctx;

  function rememberRedPacketV2(key, info) {
    if (!key || !info) return;
    redPacketPending.set(key, { ...info, at: Date.now() });
  }
  function redPacketStateV2(key) {
    const hit = redPacketPending.get(key);
    if (!hit) return null;
    if (Date.now() - Number(hit.at || 0) > 10 * 60 * 1000) {
      redPacketPending.delete(key);
      return null;
    }
    return hit;
  }
  function clearRedPacketV2(key) {
    redPacketPending.delete(key);
  }


  return { rememberRedPacketV2, redPacketStateV2, clearRedPacketV2 };
}
