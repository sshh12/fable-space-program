"""The bright bodies at their true albedo: global map and a close view of bright terrain, for LOOKING at the
calibration (mean = albedo, highlights through the knee).

  python -I tools/bake/planet/looks.py <id>:<lat>:<lon>:<capDeg> [...]   ->  out/bake/planet/looks.png

Per body one row: the low-res global albedo (as stored: sRGB, no exposure) and an unshaded orthographic close
view of the finest albedo level around the given point, also at exposure 1, with the level-0 mean and the
manifest's calibration (gain, knee start).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from planet import config, rt  # noqa: E402
from planet.sheets import Colour  # noqa: E402
from planet.verify import level0_mean_luminance  # noqa: E402
from planet.views import N, cap_view  # noqa: E402


def main() -> None:
    rows = []
    for arg in sys.argv[1:]:
        bid, lat, lon, cap = arg.split(":")
        body = config.load(bid)
        m = json.loads((rt.TILES_ROOT / bid / "manifest.json").read_text(encoding="utf-8"))
        cal = m["layers"]["albedo"]["calibration"]
        lowres = Image.open(rt.TILES_ROOT / bid / "globals" / "albedo-lowres.png").convert("RGB").resize((800, 400))
        close = Image.fromarray(cap_view(Colour(bid), float(lat), float(lon), float(cap), int(body.albedo["maxLevel"]), 1.0))
        mean, where = level0_mean_luminance(body)
        knee = cal.get("knee") or {}
        label = (f"{body.raw['name']}: level-0 mean {mean:.3f} over {where} (target {cal['meanAlbedo']}), gain "
                 f"{cal['gain']}, knee from {knee.get('start')}; close view {lat} N {lon} E, cap {cap} deg, finest level")
        rows.append((label, lowres, close))
    W = 800 + N + 30
    H = sum(410 + 30 for _ in rows) + 10
    canvas = Image.new("RGB", (W, H), (20, 20, 24))
    d = ImageDraw.Draw(canvas)
    y = 10
    for label, lowres, close in rows:
        d.text((10, y), label, fill=(255, 255, 0))
        canvas.paste(lowres, (10, y + 20))
        canvas.paste(close, (820, y + 20))
        y += 440
    out = rt.OUT / "looks.png"
    canvas.save(out, optimize=True)
    print(out)


if __name__ == "__main__":
    main()
