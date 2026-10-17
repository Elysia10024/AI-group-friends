"""常驻 TTS worker：模型只加载一次，之后一句 2–3 秒（原先每次起进程白付 2.5 秒加载）。

    python serve.py [--port 3210]

接口（只监听 127.0.0.1）：
    GET  /health           → {"ok":true,"model_loaded":true,"device":"cuda","busy":false,...}
    POST /speak {"text": "..."}  → {"ok":true,"wav":"E:/.../out/xxx.wav","seconds":2.4,"ms":2300,
                                    "seed":123,"seed_fixed":false,"tail":{...},"notes":[...]}

规则全部来自 her-voice.json（参考音 / 语速 / 情绪档 / **种子** / 句尾轻声 / 问句上扬 / 文本规则），
所以调她的嗓音只需要改那个文件 + 重启 worker，不用碰这里的代码。

种子为什么重要（2026-10-06）：F5-TTS 的 infer() 默认每次自抽一个随机种子，同一句话每次都是
新的一版"发挥"——语气、节奏、音色都会漂。`seed` 给了数字就固定那一版（可复现）。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / 'out'
SPEC_PATH = HERE / 'her-voice.json'

# 句尾语气词（一律轻声；含疑问句的「吗/呢」—— 2026-10-06 主人明确要求）
PARTICLES = '吧啊啦呀哦嘛噢咯吗呢呗嘞喽喔'

# 复用 clone-batch.py 里的音频处理（文件名带横线，只能按路径加载）
_spec = importlib.util.spec_from_file_location('clone_batch', str(HERE / 'clone-batch.py'))
cb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cb)

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:  # noqa: BLE001
    pass


def load_spec() -> dict:
    return json.loads(SPEC_PATH.read_text(encoding='utf-8'))


class Engine:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.busy = False
        self.model = None
        self.device = None
        self.load_ms = None
        self.spec = load_spec()

    def load(self) -> None:
        cb.patch_torchaudio_load()
        from f5_tts.api import F5TTS

        t0 = time.time()
        self.model = F5TTS(
            ckpt_file=str(HERE / 'models' / 'f5' / 'model_1250000.safetensors'),
            vocab_file=str(HERE / 'models' / 'f5' / 'vocab.txt'),
            vocoder_local_path=str(HERE / 'models' / 'vocos'),
        )
        import torch
        self.device = 'cuda' if torch.cuda.is_available() else 'cpu'
        self.load_ms = int((time.time() - t0) * 1000)

    def speak(self, text: str) -> dict:
        text = (text or '').strip()
        if not text:
            return {'ok': False, 'reason': '没有文本'}
        notes = text_notes(text, self.spec)
        params = self.spec['params']
        post = self.spec.get('postprocess', {})
        rise = self.spec.get('question_rise', {})

        tail = {}
        stripped = text.rstrip('。！？…')
        is_question = text.endswith(('？', '?'))
        if is_question and rise.get('glide_semitones'):
            tail['glide_semitones'] = float(rise['glide_semitones'])
            tail['glide_ms'] = int(rise.get('glide_ms', 400))
        # 句尾语气词一律轻声（2026-10-06 主人明确要求：啦/吗/嘛/吧 这些都要轻）。以前只处理
        # 陈述句的（吧/啊/啦…），疑问句的「吗/呢」不降音量、只靠问句上扬；现在两种处理叠加：
        # 先做问句上扬，再把最后 particle_ms 的音量压到 particle_gain（时长不动、保留静音垫）。
        if stripped and stripped[-1] in PARTICLES and post.get('particle_gain'):
            tail['particle_ms'] = int(post.get('particle_ms', 260))
            tail['particle_gain'] = float(post.get('particle_gain', 1.0))
            tail['particle_shrink'] = float(post.get('particle_shrink', 1.0))
            tail['keep_silence'] = bool(post.get('keep_silence', True))

        t0 = time.time()
        with self.lock:
            self.busy = True
            try:
                # 种子：her-voice.json 里给了数字就固定那一版（同一句话永远同一段音频）；
                # 没给就交给 F5-TTS 自己抽（每次不同 —— 会漂，见 _seed_note）。
                raw_seed = self.spec.get('seed')
                seed = int(raw_seed) if isinstance(raw_seed, (int, float)) or (isinstance(raw_seed, str) and raw_seed.strip().isdigit()) else None
                wav, sr, _ = self.model.infer(
                    ref_file=self.spec['reference']['file'],
                    ref_text=self.spec['reference']['text'],
                    gen_text=text,
                    speed=float(params.get('speed', 1.0)),
                    cfg_strength=float(params.get('cfg_strength', 2.0)),
                    nfe_step=int(params.get('nfe_step', 32)),
                    seed=seed,
                    show_info=lambda *a, **k: None,
                )
                if tail.get('glide_semitones'):
                    wav = cb.glide_rise(wav, sr, tail['glide_semitones'], tail['glide_ms'])
                if tail.get('particle_ms'):
                    wav = cb.shape_tail(
                        wav, sr,
                        particle_ms=tail['particle_ms'],
                        particle_gain=tail.get('particle_gain', 1.0),
                        particle_shrink=tail.get('particle_shrink', 1.0),
                        keep_silence=tail.get('keep_silence', True),
                    )
                OUT_DIR.mkdir(parents=True, exist_ok=True)
                out = OUT_DIR / f'{time.strftime("%Y%m%d-%H%M%S")}-{uuid.uuid4().hex[:6]}.wav'
                cb.save_wav(out, wav, sr)
                return {'ok': True, 'wav': str(out), 'seconds': round(len(wav) / sr, 2),
                        'sample_rate': int(sr), 'ms': int((time.time() - t0) * 1000),
                        'seed': getattr(self.model, 'seed', None), 'seed_fixed': seed is not None,
                        'tail': tail or None, 'notes': notes}
            except Exception as error:  # noqa: BLE001
                return {'ok': False, 'reason': f'{type(error).__name__}: {error}',
                        'ms': int((time.time() - t0) * 1000)}
            finally:
                self.busy = False


def text_notes(text: str, spec: dict) -> list[str]:
    """按 her-voice.json 里的文本规则体检（只提示，不改文本）。"""
    rules = spec.get('text_rules', {})
    notes: list[str] = []
    s = text.strip()
    if not s:
        return notes
    if rules.get('avoid_leading_third_tone_single'):
        first = s[0]
        second = s[1] if len(s) > 1 else ''
        if first in '好我你也可很总挺就' and (second == '' or second in '，。！？、…'):
            notes.append(f'句首孤立三声字「{first}」会掉音域（实测 ~200Hz vs 她 ~312Hz），建议双音节')
    limit = int(rules.get('max_chars', 20))
    chars = len([c for c in s if c.strip()])
    if chars > limit:
        notes.append(f'{chars} 字偏长（建议 ≤{limit}）')
    if '？' in s[:-1] or '?' in s[:-1]:
        notes.append('中句问句不会被上扬处理（后期够不着）')
    return notes


ENGINE = Engine()


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:  # 静音：日志走我们自己的格式
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith('/health'):
            self._json({'ok': True, 'model_loaded': ENGINE.model is not None,
                        'device': ENGINE.device, 'load_ms': ENGINE.load_ms,
                        'busy': ENGINE.busy, 'spec_file': str(SPEC_PATH)})
        else:
            self._json({'ok': False, 'reason': 'not found'}, 404)

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.startswith('/speak'):
            self._json({'ok': False, 'reason': 'not found'}, 404)
            return
        try:
            length = int(self.headers.get('content-length', 0))
            payload = json.loads(self.rfile.read(length) or b'{}')
        except Exception as error:  # noqa: BLE001
            self._json({'ok': False, 'reason': f'bad request: {error}'}, 400)
            return
        result = ENGINE.speak(str(payload.get('text', '')))
        print(f'[tts] {json.dumps({**result, "text": payload.get("text", "")[:40]}, ensure_ascii=False)}', flush=True)
        self._json(result)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=3210)
    ap.add_argument('--no-preload', action='store_true', help='不预热模型（测试用）')
    args = ap.parse_args()

    if not args.no_preload:
        print('[tts] 预热模型…', flush=True)
        ENGINE.load()
        print(f'[tts] 模型就绪 device={ENGINE.device} load={ENGINE.load_ms}ms', flush=True)
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'[tts] listening on http://127.0.0.1:{args.port}', flush=True)
    server.serve_forever()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
