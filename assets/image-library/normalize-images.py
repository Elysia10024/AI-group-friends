#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 E:\\ai群友\\image 下的图规范化成能被 QQ 发送 / 能被模型预览的 JPEG。

为什么要它：用户手工把图片重命名成 .jpg，但其中 48 张其实是 **AVIF**、2 张 WebP、2 张 PNG。
QQ 客户端对 AVIF 支持极差（发出去可能显示不出来），而她自己的看图工具也读不了 AVIF
（实测报 "Unsupported or malformed image data"）—— 那就没法"挑图"。

输出：E:\\ai群友\\image\\ready\\<原名>.jpg（长边 ≤1080、JPEG q85）——**不改原图**。
幂等：输出比输入新就跳过。用法：python normalize-images.py
"""
import os
import sys
from PIL import Image, features

SRC = r'E:\ai群友\image'
DST = os.path.join(SRC, 'ready')
MAX_EDGE = 1080
QUALITY = 85

def main():
    if not features.check('avif'):
        print('⚠️ 这个 Pillow 不支持 AVIF，装一下 pillow-avif-plugin 或升级 Pillow>=11.3', file=sys.stderr)
    os.makedirs(DST, exist_ok=True)
    files = sorted(f for f in os.listdir(SRC) if os.path.isfile(os.path.join(SRC, f)))
    rows = []
    for name in files:
        src = os.path.join(SRC, name)
        base = os.path.splitext(name)[0]
        dst = os.path.join(DST, base + '.jpg')
        if os.path.exists(dst) and os.path.getmtime(dst) >= os.path.getmtime(src):
            rows.append((name, 'skip', os.path.getsize(src) // 1024, os.path.getsize(dst) // 1024, ''))
            continue
        try:
            with Image.open(src) as im:
                fmt, size = im.format, im.size
                im = im.convert('RGBA') if im.mode in ('RGBA', 'LA', 'P') else im.convert('RGB')
                if im.mode == 'RGBA':
                    bg = Image.new('RGB', im.size, (255, 255, 255))
                    bg.paste(im, mask=im.split()[-1])
                    im = bg
                w, h = im.size
                scale = min(1.0, MAX_EDGE / max(w, h))
                if scale < 1.0:
                    im = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
                im.save(dst, 'JPEG', quality=QUALITY, optimize=True)
                rows.append((name, fmt, os.path.getsize(src) // 1024, os.path.getsize(dst) // 1024, f'{size[0]}x{size[1]}'))
        except Exception as e:  # noqa: BLE001
            rows.append((name, 'FAIL', os.path.getsize(src) // 1024, 0, str(e)[:60]))

    converted = [r for r in rows if r[1] not in ('skip', 'FAIL')]
    failed = [r for r in rows if r[1] == 'FAIL']
    print(f'共 {len(rows)} 个文件：新转 {len(converted)}，跳过 {sum(1 for r in rows if r[1] == "skip")}，失败 {len(failed)}')
    for name, fmt, before, after, extra in rows:
        if fmt == 'skip':
            continue
        print(f'  {name[:28]:30s} {fmt:6s} {before:5d}KB -> {after:5d}KB  {extra}')
    print(f'\n输出目录：{DST}')
    return 0 if not failed else 1

if __name__ == '__main__':
    sys.exit(main())
