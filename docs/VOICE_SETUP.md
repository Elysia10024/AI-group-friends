# 让她开口：语音功能搭建指南

> **默认情况下，AI 群友只会打字。** 想让她发语音，需要在你电脑上额外跑一个 TTS（语音合成）服务。
> 这篇是从零开始的完整步骤，大约 30~60 分钟，时间基本都花在下载模型上。

---

## 一、为什么这套东西不在仓库里

| 东西 | 体积/性质 | 为什么不打包 |
|---|---|---|
| F5-TTS 模型 | **1.3 GB**（`models/f5/model_1250000.safetensors`） | Git 仓库不适合放这么大的二进制 |
| 参考音 | 一段真人录音 | 涉及他人**声音权**，不能随便公开 |

所以仓库里只有**代码和配方模板**（`tts/` 目录），模型和参考音要你自己准备。

---

## 二、你需要什么

| 项目 | 要求 | 说明 |
|---|---|---|
| Python | **3.10 ~ 3.12** | <https://www.python.org/downloads/> |
| 显卡 | 推荐 NVIDIA，显存 ≥ 6 GB | 没有也能跑，用 CPU 会慢很多（一句十几秒） |
| 磁盘 | 约 3 GB | 模型 + 依赖 |
| 参考音 | 10~15 秒干净人声 | 见第 4 步 |

---

## 三、安装

### 第 1 步：装 Python

去 <https://www.python.org/downloads/> 下载 **3.10 ~ 3.12**（别用 3.13，部分依赖还没跟上），
安装时**勾选 "Add python.exe to PATH"**。

验证：

```powershell
python --version
```

### 第 2 步：装 F5-TTS

F5-TTS 是开源的，装法以官方仓库为准：<https://github.com/SWivid/F5-TTS>

```powershell
# 先装 PyTorch（有 N 卡就装 CUDA 版，去 pytorch.org 复制对应命令更快）
pip install torch torchaudio

# 再装 F5-TTS
pip install f5-tts

# 音频读写（clone-batch.py 里对 torchaudio 有个兼容补丁，就是靠它）
pip install soundfile numpy
```

### 第 3 步：准备模型

模型需要放在 `tts/models/f5/` 下：

```
tts/
├── models/
│   └── f5/
│       ├── model_1250000.safetensors   ← 主模型（约 1.3 GB）
│       └── vocab.txt                   ← 词表（几 KB）
├── voice-ref/
│   └── ref.wav                         ← 你的参考音
└── her-voice.json                      ← 嗓音配方
```

**从哪下**：F5-TTS 官方模型在 HuggingFace（`SWivid/F5-TTS`）。第一次跑 `serve.py` 时，
如果 `models/f5/` 是空的，f5_tts 会尝试自动下载；网络不好就手动下好放进去。

国内下载慢的话，设一下镜像：

```powershell
$env:HF_ENDPOINT = 'https://hf-mirror.com'
```

---

## 四、准备参考音（决定声音像不像）

这是**最关键的一步**，音色好坏八成看这里。

**录音要求**：

- **长度 10~15 秒**，太长反而不好
- **单人、安静环境**，不能有背景音乐、他人说话
- **语气自然**，像平时说话，不要朗读腔
- 格式 `wav`，采样率 24k 或 44.1k 都行

**然后把她说的每个字打出来**，放进 `her-voice.json` 的 `reference.text`。
**必须逐字一致**——多一个字少一个字，克隆出来的音色都会跑偏。

> ⚠️ **重要**：请用**你自己的声音**，或者取得明确授权的声音。
> 拿别人的视频/直播录音去克隆，涉及侵犯他人声音权益，别这么做。

---

## 五、写嗓音配方

复制模板并改：

```powershell
copy tts\her-voice.example.json tts\her-voice.json
```

然后编辑 `tts/her-voice.json`：

```json
{
  "reference": {
    "file": "voice-ref/ref.wav",
    "text": "参考音里的逐字文本"
  },
  "params": {
    "speed": 0.8,
    "cfg_strength": 3.5,
    "nfe_step": 32
  },
  "seed": 2
}
```

**几个参数是什么意思**：

| 参数 | 作用 | 怎么调 |
|---|---|---|
| `speed` | 语速 | 0.8 偏软，1.0 正常 |
| `cfg_strength` | 情绪强度 | 3.0~4.0，高一点更夸张 |
| `nfe_step` | 精细度 | 32 够用，越高越慢 |
| `seed` | 随机种子 | **必填**。F5-TTS 每次随机抽种子，同一句话每次音色都漂；固定一个数字才能复现 |

调整完**一定要重启 `serve.py`** 才生效。

---

## 六、启动服务

```powershell
cd tts
python serve.py
```

看到类似这样就成了：

```
[tts] model loaded on cuda
[tts] listening on 127.0.0.1:3210
```

验证一下：

```powershell
curl http://127.0.0.1:3210/health
# → {"ok":true,"model_loaded":true,"device":"cuda","busy":false,...}
```

也可以直接测一句：

```powershell
curl -X POST http://127.0.0.1:3210/speak -H "Content-Type: application/json" -d "{\"text\":\"今天也辛苦啦\"}"
```

会在 `tts/out/` 下生成一个 wav。

---

## 七、接到桥接上

打开 `config.json`，确认这一段：

```json
"socialV2": {
  "voiceOut": {
    "workerUrl": "http://127.0.0.1:3210",
    "allowGroups": true,
    "maxChars": 20,
    "minIntervalMs": 180000,
    "dailyCap": 20
  }
}
```

- `workerUrl` 指向你刚启动的服务 ✅
- `dailyCap` / `minIntervalMs` 是防止她刷屏的限流，可以按需调
- 改完 **双击 `restart.bat`**

---

## 八、常见问题

| 现象 | 原因 | 解决 |
|---|---|---|
| `/health` 里 `device` 是 `cpu` | 没装 CUDA 版 PyTorch | 去 pytorch.org 复制对应命令重装 |
| 生成一句要十几秒 | 在用 CPU 跑 | 正常，CPU 就是慢；或者换显卡 |
| 声音完全不像参考音 | `reference.text` 跟音频对不上 | 逐字核对一遍，标点也要对 |
| 同一句话每次音色都不一样 | 没固定 `seed` | 设一个数字，比如 `2` |
| `torchaudio` 加载报错 | 版本兼容问题 | `clone-batch.py` 里已经有 `patch_torchaudio_load()` 补丁，装了 `soundfile` 就会自动生效 |
| 桥接报"语音服务不可用" | `serve.py` 没启动 | 先启动 TTS，再重启桥接 |

---

## 九、不搭会怎样？

**什么都不会坏。** 桥接会检测 `workerUrl/health`，服务不在就自动降级成纯文字回复，
你的 AI 群友只是不会说话而已。
