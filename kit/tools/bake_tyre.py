#!/usr/bin/env python3
"""Bake a tyre's tread photo (seen straight on, the tread filling the frame) into a glyph atlas.

python3 kit/tools/bake_tyre.py tread.png [--size 34 84] [--radius 10]
The tread is tiled down to the tyre's length, cut to a rounded rectangle and scaled down from a 4x
working size, then stored as glyphs drawn at the same spot (kit/runtime/carimage.js drawTyre):
  U+E020  the tyre's outline (drawn black)
  U+E021  the tread's brightness, right-hand tyre (drawn white over it)
  U+E022  the same, mirrored, for the left-hand tyres (the outer shoulder outwards)
Bake at the size the app draws, so it is never rescaled. Output: kit/runtime/fonts/tyre.json.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import zlib

from PIL import Image, ImageDraw, ImageOps

ROOT = Path(__file__).resolve().parent.parent.parent
UP = 4


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tread')
    ap.add_argument('--size', type=int, nargs=2, default=[34, 84], metavar=('W', 'H'))
    ap.add_argument('--radius', type=float, default=10)
    ap.add_argument('--lift', type=float, default=0.36, help='brightness gain (rubber stays dark grey on the dark screen)')
    a = ap.parse_args()
    tw, th = a.size
    W, H = tw * UP, th * UP
    src = ImageOps.autocontrast(Image.open(a.tread).convert('L'), cutoff=1)
    tile = src.resize((W, round(src.height * W / src.width)), Image.LANCZOS)
    tex = Image.new('L', (W, H))
    for y in range(0, H, tile.height):
        tex.paste(tile, (0, y))
    tex = tex.point(lambda v: min(255, round(16 + v * a.lift)))
    mask = Image.new('L', (W, H), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, H - 1], radius=a.radius * UP, fill=255)
    right = Image.composite(tex, Image.new('L', (W, H), 0), mask)
    sil = mask.resize((tw, th), Image.LANCZOS)
    lum_r = right.resize((tw, th), Image.LANCZOS)
    lum_l = ImageOps.mirror(lum_r)
    atlas = Image.new('L', (tw, th * 3 + 2), 0)
    glyphs = {}
    for i, m in enumerate((sil, lum_r, lum_l)):
        atlas.paste(m, (0, i * (th + 1)))
        glyphs[0xE020 + i] = [0, i * (th + 1), tw, th, 0, -th, tw]
    size = {'size': th, 'ascent': th, 'descent': 0, 'atlasW': tw, 'atlasH': atlas.height,
            'alpha': base64.b64encode(zlib.compress(atlas.tobytes(), 9)).decode(), 'glyphs': glyphs}
    key = hashlib.sha256(json.dumps(size, separators=(',', ':')).encode()).hexdigest()[:16]
    out = ROOT / 'kit/runtime/fonts/tyre.json'
    out.write_text(json.dumps({'family': 'tyre', 'source': Path(a.tread).name, 'cacheKey': key, 'sizes': [size]},
                              separators=(',', ':')) + '\n', encoding='utf-8')
    print('tyre tread:', tw, 'x', th, '->', out, out.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
