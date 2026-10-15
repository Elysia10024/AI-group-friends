#!/usr/bin/env python3
"""把图片缩到"视觉友好"的尺寸，再喂给模型看。

为什么要它：QQ 群里发的原图动辄 7~10MB，直接喂会撞上图片大小上限 —— 她看到的就是
"（图片获取失败）"，等于没看到。缩一下（长边 1568、JPEG 质量 85）通常只剩几百 KB，
画质对"看懂这张图是什么梗"完全够。

用法：
    python shrink-image.py <输入路径> <输出路径> [长边=1568] [质量=85]

约定（给调用方看）：
    · 成功：stdout 打印 `OK <输出字节数>`，退出码 0
    · 失败：stderr 打印原因，退出码非 0（调用方应回退到原图或如实报错）
    · 带透明通道的图会先铺白底再转 JPEG（不铺的话透明区会变黑）
"""
import sys
import os


def main() -> int:
    if len(sys.argv) < 3:
        print('用法: shrink-image.py <in> <out> [maxEdge] [quality]', file=sys.stderr)
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    max_edge = int(sys.argv[3]) if len(sys.argv) > 3 else 1568
    quality = int(sys.argv[4]) if len(sys.argv) > 4 else 85

    try:
        from PIL import Image
    except Exception as exc:  # noqa: BLE001
        print(f'没有 Pillow：{exc}', file=sys.stderr)
        return 3

    try:
        with Image.open(src) as im:
            im.load()
            # 动图只取第一帧：模型看一帧就够，整段动画没必要
            if getattr(im, 'is_animated', False):
                im.seek(0)
            if im.mode in ('RGBA', 'LA', 'P'):
                im = im.convert('RGBA')
                bg = Image.new('RGB', im.size, (255, 255, 255))
                bg.paste(im, mask=im.split()[-1])
                im = bg
            elif im.mode != 'RGB':
                im = im.convert('RGB')
            w, h = im.size
            scale = min(1.0, max_edge / max(w, h)) if max(w, h) else 1.0
            if scale < 1.0:
                im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
            im.save(dst, 'JPEG', quality=quality, optimize=True)
    except Exception as exc:  # noqa: BLE001
        print(f'缩放失败：{exc}', file=sys.stderr)
        return 4

    print(f'OK {os.path.getsize(dst)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
