"""文字 → 语音（本地，两个引擎）。

引擎：
  kokoro   —— Kokoro-82M（onnx，340 MB，8 个中文音色，CPU 上很快，稳定；音色"播音感"）
  chattts  —— ChatTTS（对话式中文，自带停顿/笑声等口语特征；音色随机，可以把抽到的
              说话人向量存成文件固定下来，这样"她的声音"才是稳定的）

用法：
    python speak.py --list-voices
    python speak.py "喂，在忙吗？" --voice zf_xiaobei --out out.wav [--json]
    python speak.py "……你认真的？" --engine chattts --speaker-file her.spk --out out.wav [--json]

输出（--json）：{"ok":true,"engine":"kokoro","voice":"zf_xiaobei","seconds":1.8,"ms":900,"out":"...","sample_rate":24000}

约定（和 asr/transcribe.py 一致）：一次进程一次合成；任何失败都返回 ok:false + reason，
退出码 0 —— 调用方只看 JSON；stdout 强制 UTF-8（Windows 默认 GBK 会把中文吐坏）。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS = HERE / 'models'
KOKORO_MODEL = MODELS / 'kokoro-v1.0.onnx'
KOKORO_VOICES = MODELS / 'voices-v1.0.bin'

# Kokoro v1.0 的中文音色（zf_=女声, zm_=男声）；实际可用列表以 --list-voices 为准
ZH_VOICES = ['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi',
             'zm_yunjian', 'zm_yunxi', 'zm_yunxia', 'zm_yunyang']


def write_wav(path: Path, samples, sample_rate: int) -> None:
    import numpy as np
    data = np.clip(np.asarray(samples, dtype='float32'), -1.0, 1.0)
    pcm = (data * 32767.0).astype('<i2').tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)


def resolve_voice(voice: str):
    """音色名 → 可传给 kokoro 的东西。支持混音做**微调**：

        zf_xiaobei                      单个音色
        zf_xiaobei*0.7+zf_xiaoni*0.3    两个（或多个）音色按权重平均出来的新音色

    为什么能这么玩：Kokoro 的"音色"就是一个向量（voices/<名字>.pt），加权平均 = 一个
    介于两者之间的新音色，权重是连续的，所以可以一点点试（0.8/0.2 和 0.7/0.3 听感不同）。
    """
    spec = str(voice or '').strip()
    if '+' not in spec and '*' not in spec:
        return spec
    import torch
    from huggingface_hub import hf_hub_download

    parts = [p for p in spec.split('+') if p.strip()]
    total = 0.0
    chunks = []
    weights = []
    for part in parts:
        name, _, weight = part.partition('*')
        name = name.strip()
        w = float(weight) if weight.strip() else 1.0
        if w <= 0:
            continue
        path = hf_hub_download('hexgrad/Kokoro-82M', f'voices/{name}.pt')
        chunks.append(torch.load(path, weights_only=True).float())
        weights.append(w)
        total += w
    if not chunks:
        raise ValueError(f'混音参数看不懂：{spec}')
    mixed = sum(c * (w / total) for c, w in zip(chunks, weights))
    return mixed


def synth_kokoro(text: str, voice: str, speed: float, out: Path) -> dict:
    """用 PyTorch 版 kokoro（KPipeline）。中文走 misaki[zh] 的 G2P，比 espeak 准。

    模型放 HF 上（hexgrad/Kokoro-82M，约 330 MB + 每个音色 0.5 MB）。这台机器直连
    huggingface.co 很慢/不稳，所以默认走 hf-mirror 镜像（可用 HF_ENDPOINT 覆盖）。
    """
    import os
    os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
    import numpy as np
    from kokoro import KPipeline

    pipeline = KPipeline(lang_code='z')          # z = 中文
    voice_arg = resolve_voice(voice)
    chunks = []
    for result in pipeline(text, voice=voice_arg, speed=speed):
        audio = getattr(result, 'audio', None)
        if audio is not None:
            chunks.append(np.asarray(audio, dtype='float32'))
    if not chunks:
        raise RuntimeError('kokoro 没有产出音频')
    samples = np.concatenate(chunks)
    sample_rate = 24000
    write_wav(out, samples, sample_rate)
    return {'engine': 'kokoro', 'voice': voice, 'sample_rate': sample_rate,
            'seconds': round(len(samples) / sample_rate, 2)}


def synth_chattts(text: str, speaker_file: Path | None, out: Path, temperature: float) -> dict:
    """用 ChatTTS（对话式中文）。模型在 HF 的 2Noise/ChatTTS，同样走镜像。"""
    import os
    os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
    import ChatTTS
    import torch
    chat = ChatTTS.Chat()
    # source='huggingface'：默认的 'local' 会去 GitHub releases 下模型，这台机器连不上
    # （release-assets.githubusercontent.com 读超时）；HF 走 hf-mirror 镜像没问题。
    if not chat.load(source='huggingface', compile=False):
        raise RuntimeError('ChatTTS 模型加载失败（首次运行会从 HF 镜像下载约 1.5 GB）')
    if speaker_file and speaker_file.exists():
        spk = torch.load(str(speaker_file), weights_only=False)
        voice_label = f'fixed:{speaker_file.name}'
    else:
        spk = chat.sample_random_speaker()
        voice_label = 'random'
        if speaker_file:  # 第一次就跑出来一个稳定音色，存下来给以后用
            speaker_file.parent.mkdir(parents=True, exist_ok=True)
            torch.save(spk, str(speaker_file))
            voice_label = f'new:{speaker_file.name}'
    params = ChatTTS.Chat.InferCodeParams(spk_emb=spk, temperature=temperature)
    wavs = chat.infer([text], params_infer_code=params, use_decoder=True)
    samples = wavs[0]
    sample_rate = 24000
    write_wav(out, samples, sample_rate)
    return {'engine': 'chattts', 'voice': voice_label, 'sample_rate': sample_rate,
            'seconds': round(len(samples) / sample_rate, 2)}


def list_voices() -> dict:
    out = {'kokoro': {'zh': [], 'error': None}, 'chattts': {'note': '音色随机；用 --speaker-file 固定'}}
    try:
        from kokoro_onnx import Kokoro
        k = Kokoro(str(KOKORO_MODEL), str(KOKORO_VOICES))
        all_voices = sorted(k.get_voices())
        out['kokoro']['zh'] = [v for v in all_voices if v.startswith(('zf_', 'zm_'))]
        out['kokoro']['total'] = len(all_voices)
    except Exception as error:  # noqa: BLE001
        out['kokoro']['error'] = f'{type(error).__name__}: {error}'
    return out


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:  # noqa: BLE001
        pass

    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('text', nargs='?', default='')
    ap.add_argument('--engine', default='kokoro', choices=['kokoro', 'chattts'])
    ap.add_argument('--voice', default='zf_xiaobei')
    ap.add_argument('--speed', type=float, default=1.0)
    ap.add_argument('--temperature', type=float, default=0.3)
    ap.add_argument('--speaker-file', default=str(MODELS / 'chattts-speaker.spk'))
    ap.add_argument('--out', default=str(HERE / 'out.wav'))
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--list-voices', action='store_true')
    args = ap.parse_args()

    if args.list_voices:
        print(json.dumps(list_voices(), ensure_ascii=False, indent=1))
        return 0

    t0 = time.time()
    out = Path(args.out)
    try:
        if not args.text.strip():
            raise ValueError('没有文本')
        if args.engine == 'kokoro':
            info = synth_kokoro(args.text.strip(), args.voice, args.speed, out)
        else:
            info = synth_chattts(args.text.strip(), Path(args.speaker_file), out, args.temperature)
        result = {'ok': True, 'text': args.text.strip(), 'out': str(out),
                  'ms': int((time.time() - t0) * 1000), **info}
    except Exception as error:  # noqa: BLE001
        result = {'ok': False, 'reason': f'{type(error).__name__}: {error}',
                  'ms': int((time.time() - t0) * 1000)}

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(result['out'] if result.get('ok') else f"[失败] {result.get('reason')}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
