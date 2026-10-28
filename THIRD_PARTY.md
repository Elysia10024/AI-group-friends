# 第三方项目、借鉴与致谢（THIRD_PARTY）

本项目不是凭空出现的：它有上游、有依赖，也有借鉴过设计思路的公开项目。这里把来源列清楚，按各自许可证署名。

## 1. 本项目来源与许可

- **派生自 [qq-bridge](https://github.com/Derpyu520/qq-bridge)**，上游版权归 **Derpyu520 及 qq-bridge / QSH contributors**。
- 本项目（以及公开镜像 [AI-group-friends](https://github.com/Elysia10024/AI-group-friends)）按 **MIT License** 发布，完整文本见 [LICENSE](LICENSE)。
  **保留上游版权声明**；本仓库在上游基础上的修改同样以 MIT 提供。

## 2. 借鉴了设计/思路（未复制代码）

| 项目 | 许可证 | 借鉴内容 | 我们的实现 |
|---|---|---|---|
| [`SAOS-3624/dsh-video-storyboard`](https://github.com/SAOS-3624/dsh-video-storyboard)（v0.4.1） | **MIT** | 视频「分镜图」的设计：场景取样 9–16 格、每格标时间戳、附转录/音频包络，**拼成一张图省 token**；以及按需 zoom 的思路 | `src/core/storyboard.js`、`src/domains/bili-look.js` 中**独立实现**（只用 ffmpeg，未复制其代码）；版权归其作者，MIT 许可 |

> 以上只借鉴**输出格式与设计思路**，代码为独立编写。如果以后要复制任何上游代码，会在文件头保留其版权与 MIT 许可声明。

## 3. 运行时依赖与外部工具

| 名称 | 用途 | 许可 / 说明 |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai)（`@deepseek-ai/dsh`、`dsh-host-apiproxy` 等） | agent 内核与事件/API 客户端 | MIT（依 npm 包声明） |
| SnowLuma | OneBot v11 的 QQ 实现（本仓库只提供补丁与说明，**不随仓库分发其本体**） | 许可条款见其发布页；补丁仅用于本地部署 |
| yt-dlp | B 站视频下载 | Unlicense |
| FFmpeg | 抽帧、拼图、转码 | 以实际二进制附带的许可证为准（常见 GPL/LGPL） |
| B 站公开接口文档（如 `bilibili-API-collect`） | WBI 签名、接口字段参考 | 仅参考公开文档，未复制代码 |
| QQ 空间 CGI 相关公开实现（如 SnowLuma 的 `getBknFromCookie`） | `g_tk`/`p_skey` 逻辑参考 | 仅参考公开实现思路，代码为本项目独立编写 |

## 4. 声明

- 本项目不包含、也不分发上述第三方项目的源码（`patches/snowluma/` 下的**补丁本身是本项目原创**，应用对象是本地安装的第三方程序）。
- 第三方名称、商标与版权归各自所有者；本项目与它们没有隶属关系，也不代表它们背书。
- 若发现遗漏或标注有误，欢迎指出，会尽快更正。
