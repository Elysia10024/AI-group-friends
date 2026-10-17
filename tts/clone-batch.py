"""批量克隆：模型只加载一次，跑多组「参考音 × 语速」组合（省掉每组 13 秒的加载）。

    python clone-batch.py jobs.json

jobs.json:
[
  {"ref": "...wav", "ref_text": "...", "text": "要说的话", "speed": 0.9, "out": "...wav",
   "cfg_strength": 2.0, "nfe_step": 32, "label": "refB@0.9"}
]
输出每行一个 JSON（ok/label/out/seconds/ms）。
"""
from __future__ import annotations

import json
import os
import sys
import time
import wave
from pathlib import Path

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
HERE = Path(__file__).resolve().parent


def patch_torchaudio_load() -> None:
    """同 clone.py：torchaudio 2.11 的 torchcodec 在这台机器上加载不起来，换 soundfile。"""
    try:
        import soundfile as sf
        import torch
        import torchaudio

        def _load(path, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
            data, sr = sf.read(str(path), dtype='float32', always_2d=True)
            return torch.from_numpy(data.T.copy()), sr

        torchaudio.load = _load
    except Exception as error:  # noqa: BLE001
        print(f'[warn] torchaudio.load 替换失败：{error}', file=sys.stderr)


def trim_silence(x, sr: int, thresh_ratio: float = 0.08, margin_ms: int = 25):
    """剪掉首尾静音。生成单个语气词（如"吧"）时模型会前后各垫一大段空白，
    1.4 秒里有 1 秒是静音 —— 轻声本来就该短，不剪就会显得拖。"""
    import numpy as np
    if len(x) == 0:
        return x
    win = max(1, int(sr * 0.01))
    rms = np.array([float(np.sqrt(np.mean(x[i:i + win] ** 2))) if len(x[i:i + win]) else 0.0
                    for i in range(0, len(x), win)])
    peak = float(rms.max()) or 1.0
    idx = np.where(rms > peak * thresh_ratio)[0]
    if len(idx) == 0:
        return x
    margin = int(sr * margin_ms / 1000)
    start = max(0, int(idx[0]) * win - margin)
    end = min(len(x), (int(idx[-1]) + 1) * win + margin)
    return x[start:end]


def cap_seconds(x, sr: int, max_seconds: float):
    """超过上限就从两端往中间剪（保住最响的核心）。"""
    import numpy as np
    limit = int(sr * max_seconds)
    if len(x) <= limit:
        return x
    win = max(1, int(sr * 0.01))
    rms = np.array([float(np.sqrt(np.mean(x[i:i + win] ** 2))) if len(x[i:i + win]) else 0.0
                    for i in range(0, len(x), win)])
    center = int(np.argmax(rms)) * win
    start = max(0, min(center - limit // 2, len(x) - limit))
    return x[start:start + limit]


def last_voiced_index(x, sr: int, thresh_ratio: float = 0.06) -> int:
    """最后一个"有声音"的采样点（尾巴上的静音垫不算）。"""
    import numpy as np
    if len(x) == 0:
        return 0
    win = max(1, int(sr * 0.01))
    rms = np.array([float(np.sqrt(np.mean(x[i:i + win] ** 2))) if len(x[i:i + win]) else 0.0
                    for i in range(0, len(x), win)])
    peak = float(rms.max()) or 1.0
    idx = np.where(rms > peak * thresh_ratio)[0]
    return min(len(x), (int(idx[-1]) + 1) * win) if len(idx) else len(x)


def glide_rise(x, sr: int, semitones: float, ms: int):
    """结尾做**渐变**上扬：音高从 0 平滑升到 semitones，时长不变。

    为什么不用"整段硬移调"（第十轮那种）：fixed pitch_shift 会在最后一个字上突然换音色，
    听起来像被掐了一下 —— 用户当时的评价就是"都不好"。渐变重采样读源音频（前慢后快），
    音高连续爬升，接近真人问句的调型。
    """
    import numpy as np
    if semitones == 0 or len(x) == 0:
        return x
    end = last_voiced_index(x, sr)
    n = min(end, int(sr * ms / 1000))
    if n < int(sr * 0.08):
        return x
    head, tail, pad = x[:end - n], x[end - n:end], x[end:]
    u = np.linspace(0.0, 1.0, len(tail), endpoint=False)
    factor = 2.0 ** (float(semitones) * u / 12.0)      # 瞬时音高倍率
    cum = np.cumsum(factor)
    cum = cum / cum[-1]                                # 归一化 → 总时长不变
    src = cum * (len(tail) - 1)
    warped = np.interp(src, np.arange(len(tail)), tail).astype(np.float32)
    fade = min(int(sr * 0.010), len(warped) // 4, len(head))
    if fade > 0:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        warped = warped.copy()
        warped[:fade] *= ramp
        head = head.copy()
        head[-fade:] *= (1.0 - ramp)
        merged = head.copy()
        merged[-fade:] += warped[:fade]
        return np.concatenate([merged, warped[fade:], pad])
    return np.concatenate([head, warped, pad])


def shape_tail(x, sr: int, *, rise_semitones: float = 0.0, rise_ms: int = 220,
               particle_ms: int = 0, particle_gain: float = 1.0, particle_shrink: float = 1.0,
               keep_silence: bool = False):
    """只修饰**结尾那一小段**，其余一字不动。

    keep_silence=True 时保留原来的句尾静音垫（用户 2026-10-05 要求：只改"吧"字，
    不要把垫的空白也剪掉，好单独听语气词的效果）。
    """
    import librosa
    import numpy as np

    x = np.asarray(x, dtype=np.float32)
    end = last_voiced_index(x, sr)
    body, pad = x[:end], x[end:]          # pad = 模型垫的句尾静音

    if rise_semitones:
        n = min(len(body), int(sr * rise_ms / 1000))
        if n > int(sr * 0.05):
            head, tail = body[:-n], body[-n:]
            tail = librosa.effects.pitch_shift(tail, sr=sr, n_steps=float(rise_semitones))
            fade = min(int(sr * 0.012), len(tail) // 4, len(head))
            if fade > 0:
                ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
                tail = tail.astype(np.float32).copy()
                tail[:fade] *= ramp
                head = head.copy()
                head[-fade:] *= (1.0 - ramp)
                merged = head.copy()
                merged[-fade:] += tail[:fade]
                body = np.concatenate([merged, tail[fade:]])
            else:
                body = np.concatenate([head, tail])

    if particle_ms and (particle_gain != 1.0 or particle_shrink != 1.0):
        n = min(len(body), int(sr * particle_ms / 1000))
        if n > int(sr * 0.05):
            head, tail = body[:-n], body[-n:].copy()
            if particle_shrink != 1.0:
                tail = librosa.effects.time_stretch(tail, rate=1.0 / float(particle_shrink))
            tail = tail * float(particle_gain)
            body = np.concatenate([head, tail])

    return np.concatenate([body, pad]) if keep_silence else body


def save_wav(path: Path, samples, sr: int) -> None:
    import numpy as np
    data = np.clip(np.asarray(samples, dtype='float32'), -1.0, 1.0)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((data * 32767.0).astype('<i2').tobytes())


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:  # noqa: BLE001
        pass
    jobs = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    patch_torchaudio_load()
    from f5_tts.api import F5TTS

    t0 = time.time()
    f5 = F5TTS(
        ckpt_file=str(HERE / 'models' / 'f5' / 'model_1250000.safetensors'),
        vocab_file=str(HERE / 'models' / 'f5' / 'vocab.txt'),
        vocoder_local_path=str(HERE / 'models' / 'vocos'),
    )
    load_ms = int((time.time() - t0) * 1000)
    print(json.dumps({'ok': True, 'stage': 'model_loaded', 'load_ms': load_ms}, ensure_ascii=False), flush=True)

    for job in jobs:
        t1 = time.time()
        try:
            import numpy as np

            segs = job.get('segments')
            if segs:
                # 分句生成 + 用精确静音拼接：标点交给模型不靠谱（……它会乱停），
                # 而"哪里停、停多久"是打磨语音时最要命的一项，所以这里自己控制。
                pieces = []
                durations = []
                for seg in segs:
                    wav, sr, _ = f5.infer(
                        # 每句可以换参考音：问句用"本身就是问句"的片段当参考，
                        # 上扬的语调才会跟着过来（F5 是零样本克隆，语调主要从参考音学）。
                        ref_file=seg.get('ref', job['ref']),
                        ref_text=seg.get('ref_text', job['ref_text']),
                        gen_text=seg['text'],
                        speed=float(seg.get('speed', job.get('speed', 1.0))),
                        cfg_strength=float(seg.get('cfg_strength', job.get('cfg_strength', 2.0))),
                        nfe_step=int(seg.get('nfe_step', job.get('nfe_step', 32))),
                        show_info=lambda *a, **k: None,
                    )
                    audio = np.asarray(wav, dtype=np.float32)
                    if seg.get('trim'):
                        audio = trim_silence(audio, sr)
                    if seg.get('max_seconds'):
                        audio = cap_seconds(audio, sr, float(seg['max_seconds']))
                    gain = float(seg.get('gain', 1.0))
                    if gain != 1.0:
                        audio = audio * gain      # 轻声：句尾语气词压低音量
                    pieces.append(audio)
                    durations.append(round(len(audio) / sr, 2))
                    gap = float(seg.get('gap_after', 0.0))
                    if gap > 0:
                        pieces.append(np.zeros(int(sr * gap), dtype=np.float32))
                wav = np.concatenate(pieces)
                save_wav(Path(job['out']), wav, sr)
                extra = {'segments': [s['text'] for s in segs], 'segment_seconds': durations}
            else:
                wav, sr, _ = f5.infer(
                    ref_file=job['ref'], ref_text=job['ref_text'], gen_text=job['text'],
                    speed=float(job.get('speed', 1.0)),
                    cfg_strength=float(job.get('cfg_strength', 2.0)),
                    nfe_step=int(job.get('nfe_step', 32)),
                    file_wave=job['out'], show_info=lambda *a, **k: None,
                )
                tail_spec = job.get('tail') or {}
                if tail_spec:
                    if tail_spec.get('glide_semitones'):
                        wav = glide_rise(wav, sr, float(tail_spec['glide_semitones']),
                                         int(tail_spec.get('glide_ms', 400)))
                    wav = shape_tail(
                        wav, sr,
                        rise_semitones=float(tail_spec.get('rise_semitones', 0.0)),
                        rise_ms=int(tail_spec.get('rise_ms', 220)),
                        particle_ms=int(tail_spec.get('particle_ms', 0)),
                        particle_gain=float(tail_spec.get('particle_gain', 1.0)),
                        particle_shrink=float(tail_spec.get('particle_shrink', 1.0)),
                        keep_silence=bool(tail_spec.get('keep_silence', False)),
                    )
                save_wav(Path(job['out']), wav, sr)
                extra = {'tail': tail_spec or None, 'seconds_out': round(len(wav) / sr, 2)}
            print(json.dumps({'ok': True, 'label': job.get('label', ''), 'out': job['out'],
                              'seconds': round(len(wav) / sr, 2), 'ms': int((time.time() - t1) * 1000),
                              **extra}, ensure_ascii=False), flush=True)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({'ok': False, 'label': job.get('label', ''), 'reason': f'{type(error).__name__}: {error}'},
                             ensure_ascii=False), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
