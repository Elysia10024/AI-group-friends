# 图库（她发梗图用的）

这是从原作者图库里筛出来的**公开版本**：`library.json` + 55 张规范化后的图。

## 三样东西

| 路径 | 是什么 |
| --- | --- |
| `library.json` | **唯一真相源**：每张图的名字 / 文件名 / verdict（适合/谨慎/不适合）/ reason / tags / desc |
| `ready/*.jpg` | 规范化后的成品图：JPEG、最长边 ≤1080、质量 85、单张 ≤236 KB，QQ 可直接发送 |
| `normalize-images.py` | 把新图转成 `ready/` 版本的脚本（幂等，不删原图） |

> `library.json` 里的 `file` 字段是**相对 `ready/`** 的，所以发图只认 `ready/` 里的文件。

## 怎么接到桥接上

**方式 1（默认）**：把整个目录复制到桥接项目的**同级**，命名成 `image`：

```
AI-group-friends/      ← 项目目录
image/                 ← 本目录复制过来，改名 image
├── library.json
├── normalize-images.py
└── ready/
    └── *.jpg
```

**方式 2（自定义位置）**：在 `config.json` 里指定：

```json
"imageLibrary": {
  "dir": "D:/我的梗图库"
}
```

改完 `restart.bat`。

## 公开版删掉了哪些

| 删除 | 原因 |
| --- | --- |
| 2 张标为 `不适合` 的 | verdict 判定不宜公开分发 |
| 1 张 `by: her` 的 | 她自己从 QQ 现存的，不是原创 |

## 想加自己的图

1. 把图片丢进 `image/`（可以放 `.png/.jpg/.webp/.avif`，名字随意）
2. 跑脚本生成可发送版本：

   ```powershell
   python normalize-images.py
   ```

   它会把 AVIF/WebP 转成 JPEG、缩到 1080、压到 236 KB 以内，输出到 `ready/`。

3. 在 `library.json` 的 `images` 数组里加一条：

   ```json
   {
     "name": "新图名字",
     "file": "新图名字.jpg",
     "verdict": "适合",
     "tags": ["打招呼", "卖萌"],
     "desc": "一句话描述图里是什么，给她检索用"
   }
   ```

4. 不用重启桥接——图库是**每轮现读**的。

## 关于 `verdict`

| 值 | 含义 |
| --- | --- |
| `适合` | 随便发 |
| `谨慎` | 能发但要挑场合（带引流水印、擦边、容易引战） |
| `不适合` | 不许发 |

她发图前会看这个字段。

## 版权提醒

图库里是收集/二创的梗图。**二次分发前请自己确认版权**，或者用自己有权利的素材替换。
