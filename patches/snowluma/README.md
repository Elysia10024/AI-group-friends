# SnowLuma 补丁

这两个补丁**直接改写 SnowLuma 的 `index.mjs`**（一个 7.2 MB 的第三方 bundle）。
它们不是可选的：**没有它们，红包功能就没了。**

## 为什么必须打

SnowLuma 没有 `elem` tag 24 的解码器，QQ 红包元素会被**整块丢掉**，
桥只能看到 QQ 的兜底文案 `[QQ红包]请使用新版手机QQ查收红包。`。后果：

| 能力 | 有补丁 | 没补丁 |
|---|---|---|
| 红包上的**留言** | 解得出（默认「恭喜发财」不给反应，自定义留言要接一句） | **完全丢失** |
| 区分**真假红包** | 靠 `redbag` 段，可靠 | 只能靠文本特征，**真红包会被当成手打的假红包去嘲讽** |
| 抓红包原始数据 | `RAWHEX` 日志行 | 无 |

最后一条是**最难自己发现的回归**：消息照样收得到，她照样说话，
只是红包被误判、留言看不见 —— 群里看不出异常。

## 两个补丁分别做什么

### `rawhex-capture.mjs`

给 820 个生成的 protobuf 解码器补丁：把**未知字段**（≥150 字节）的原始字节
挂到 `rawHex` 上，并在 `logUnknownWireFields` 里打一行 `wire element RAWHEX`。

- 锚点：`totalByteLength: _unknownByteLength`
- 为什么需要：红包元素是 tag 24 的未知字段（390 字节），SnowLuma 不认它，
  只能从原始字节里自己解。**`redbag-decode.py` 依赖补丁提供的 `rawHex`。**

### `redbag-decode.py`

- 在 `ELEMENT_CODECS` 里注册 `redbag` 段（映射成 `{type:"redbag", data:{greeting, subtitle, url, bill_no, auth_key, red_type}}`）
- 新增 `decodeRedPacketElement` / `decodeRedbagsOnce`：从 `rawHex` 解出红包体
  （路径：`payload[1]` → `mid`；`mid[3]` → `info`；`info[3]`=留言、`info[14]`=链接；`mid[9]`=bill_no、`mid[10]`=auth_key）
- 有红包时丢掉 QQ 的兜底文案（`hasRedbag` 抑制文本段）

## 自检（升级后必跑）

```bash
node patches/snowluma/check.mjs
```

补丁缺失时它会**大声报错并退出 1**，列出缺了哪项、以及怎么重打：

```
╔══════════════════════════════════════════════════════════════╗
║  ❌ SnowLuma 补丁缺失 —— 红包功能已失效，需要重新打补丁      ║
╚══════════════════════════════════════════════════════════════╝
```

`check.mjs` 里记了打补丁时的版本（`PATCHED_VERSION`）。
版本变了但补丁还在时只告警；版本变了且补丁没了就退出 1。

## 升级 SnowLuma 后的重打流程

1. `node patches/snowluma/check.mjs` —— 确认补丁确实丢了
2. **先备份**：`Copy-Item <项目根>\SnowLuma\index.mjs <项目根>\SnowLuma\index.mjs.bak-<日期>`
3. 按顺序打（**顺序不能反**，`redbag-decode.py` 依赖 `rawhex-capture.mjs` 的 `rawHex`）：
   ```bash
   node patches/snowluma/rawhex-capture.mjs
   python patches/snowluma/redbag-decode.py
   ```
4. `node --check <项目根>\SnowLuma\index.mjs` —— 语法必须过
5. 重启 SnowLuma（见下）
6. `node patches/snowluma/check.mjs` —— 应全绿
7. 更新 `check.mjs` 里的 `PATCHED_VERSION`

两个脚本都是**幂等**的：已打过会检测到标志串并退出，不会重复插桩。

## 重启 SnowLuma

SnowLuma 以 `"<项目根>\SnowLuma\node.exe" ./index.mjs` 运行（工作目录 `<项目根>\SnowLuma`）。
重启方式与注意事项见 `docs/重构方案.md`（要等它把日志写完再停，避免写坏状态）。

## 为什么不干脆改上游

SnowLuma 是第三方 bundle，改它是**唯一**能拿到红包原始字节的办法
（native DLL 里没有红包相关代码，QQ 自己的 asar 是整体加密的）。
代价就是**每次升级都要重打**，所以配了自检。

## 已知的遗留

`redbag-decode.py` 是项目里最后一个 Python 脚本。它打印中文时会乱码
（Python 的 stdout 在 Windows 上是 GBK，而 harness 按 UTF-8 解码），
但只影响日志可读性、不影响功能。抽空可以改写成 Node（见 `docs/重构方案.md` R0.5）。

## 许可与归属

SnowLuma 是**第三方项目**（许可条款见其发布页）；本目录下的补丁是**本项目原创**，仅用于本地部署时修补第三方程序，**不随本仓库分发 SnowLuma 本体**。完整第三方清单见仓库根目录 `THIRD_PARTY.md`。