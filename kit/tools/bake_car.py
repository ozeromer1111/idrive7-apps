#!/usr/bin/env python3
"""Bake a top-down car photo into a glyph atlas the renderer draws like text (Pillow required).

python3 kit/tools/bake_car.py photo.jpg [--rotate DEG] [--length 372 420]
The renderer draws only one-colour glyphs (pixel images need the upstream dialect and lose the
kit's tabs), so the photo becomes three layers drawn at the same spot:
  U+E010  the silhouette (drawn black)
  U+E011  its brightness (drawn white over it: a greyscale photo)
  U+E012  its red parts (tail lights, drawn red)
The background must be near-white; it is cut away from the edges in, on a 4x upscale whose edge is
smoothed and then scaled down, so the outline is anti-aliased instead of stair-stepped. Each
--length is a baked size (the car's height in px); bake the sizes the app draws, so it is never
rescaled when drawn. --rotate turns the photo so the front points up.
kit/runtime/carimage.js draws it. Output: kit/runtime/fonts/car.json.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import zlib

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent.parent
UP = 4


def matte(im, thr):
    """The car's alpha at im's size: background flood-filled from the edges, the middle piece kept, edge smoothed."""
    w, h = im.size
    r, g, b = im.split()
    low = ImageChops.darker(ImageChops.darker(r, g), b)
    fill = low.point(lambda v: 255 if v >= thr else 0)
    step = max(1, min(w, h) // 200)
    for x in range(0, w, step):
        for s in ((x, 0), (x, h - 1)):
            if fill.getpixel(s) == 255:
                ImageDraw.floodfill(fill, s, 128)
    for y in range(0, h, step):
        for s in ((0, y), (w - 1, y)):
            if fill.getpixel(s) == 255:
                ImageDraw.floodfill(fill, s, 128)
    fg = fill.point(lambda v: 0 if v == 128 else 255)
    k = 2 * UP + 1                                    # open then close: specks and nicks of the JPEG away
    fg = fg.filter(ImageFilter.MinFilter(k)).filter(ImageFilter.MaxFilter(k))
    fg = fg.filter(ImageFilter.MaxFilter(k)).filter(ImageFilter.MinFilter(k))
    ImageDraw.floodfill(fg, (w // 2, h // 2), 77)     # only the piece under the middle (drops watermarks)
    car = fg.point(lambda v: 255 if v == 77 else 0)
    # a smooth outline: blur, then a steep ramp around the middle (shrinks the edge by the JPEG halo)
    car = car.filter(ImageFilter.GaussianBlur(UP * 1.2))
    return car.point(lambda v: max(0, min(255, (v - 150) * 3)))


def layers(rgba):
    w, h = rgba.size
    sil, lum, red = (Image.new('L', (w, h), 0) for _ in range(3))
    sp, lp, rp, src = sil.load(), lum.load(), red.load(), rgba.load()
    for y in range(h):
        for x in range(w):
            r, g, b, al = src[x, y]
            if not al:
                continue
            redness = max(0.0, min(1.0, (r - max(g, b) - 25) / 70))
            sp[x, y] = al
            lp[x, y] = round(al * (r * 299 + g * 587 + b * 114) / 255000 * (1 - redness))
            rp[x, y] = round(al * redness)
    return sil, lum, red


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('photo')
    ap.add_argument('--rotate', type=float, default=0)
    ap.add_argument('--length', type=int, nargs='+', default=[372], help='baked car heights in px')
    ap.add_argument('--threshold', type=int, default=250)
    a = ap.parse_args()
    src = Image.open(a.photo).convert('RGB')
    big = src.resize((src.width * UP, src.height * UP), Image.LANCZOS)
    rgba = big.convert('RGBA')
    rgba.putalpha(matte(big, a.threshold))
    if a.rotate:
        rgba = rgba.rotate(a.rotate, resample=Image.BICUBIC, expand=True)
    rgba = rgba.crop(rgba.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox())
    sizes = []
    for length in sorted(set(a.length)):
        wq = round(rgba.width * length / rgba.height)
        small = rgba.resize((wq, length), Image.LANCZOS, reducing_gap=3.0)
        w, h = small.size
        atlas = Image.new('L', (w, h * 3 + 2), 0)
        glyphs = {}
        for i, m in enumerate(layers(small)):
            atlas.paste(m, (0, i * (h + 1)))
            glyphs[0xE010 + i] = [0, i * (h + 1), w, h, 0, -h, w]
        sizes.append({'size': h, 'ascent': h, 'descent': 0, 'atlasW': w, 'atlasH': atlas.height,
                      'alpha': base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode(), 'glyphs': glyphs})
        print('car image:', w, 'x', h)
    key = hashlib.sha256(json.dumps(sizes, separators=(',', ':')).encode()).hexdigest()[:16]
    out = ROOT / 'kit/runtime/fonts/car.json'
    out.write_text(json.dumps({'family': 'car', 'source': Path(a.photo).name, 'cacheKey': key, 'sizes': sizes},
                              separators=(',', ':')) + '\n', encoding='utf-8')
    print('->', out, out.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
