"""Close views of the baked albedo where bakes go wrong: the +-180 and 0 meridians and both poles.

  python -I tools/bake/planet/views.py <id> [...] | --all [--cap DEG] [--level L]
      ->  out/bake/planet/views/<id>.png

Unshaded albedo (no relief, no lighting) in four orthographic views, each a spherical cap of --cap degrees
radius (default 25) seen from above its centre: 0 N 180 E (the wrap meridian, where a source's first or last
column ends up), 0 N 0 E, the north pole and the south pole (each pole view has 0 E at the bottom). Exposure
puts the body's mean albedo at middle grey; a seam, a fill disc or a pinwheel shows at a glance. The finest
albedo level is used unless --level is given. (Replaces the scratch previews of the first bake.)
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from common import cube  # noqa: E402
from moon.sampling import srgb_decode, srgb_encode  # noqa: E402
from planet import config, rt  # noqa: E402
from planet.sheets import Colour  # noqa: E402

N = 400
CENTRES = (("0 N 180 E (wrap meridian)", 0.0, 180.0), ("0 N 0 E", 0.0, 0.0), ("north pole", 90.0, 0.0), ("south pole", -90.0, 0.0))


def cap_view(col: Colour, lat0: float, lon0: float, cap_deg: float, level: int, exposure: float) -> np.ndarray:
    """Orthographic view of the cap of radius cap_deg around (lat0, lon0), north (or 0 E for a pole) up."""
    c = cube.lat_lon_to_dir(math.radians(lat0), math.radians(lon0))
    up = np.array([0.0, 0.0, 1.0]) if abs(lat0) < 89.0 else -np.sign(lat0) * cube.lat_lon_to_dir(0.0, math.radians(lon0 + 180.0))
    e = np.cross(up, c)
    e /= np.linalg.norm(e)
    n = np.cross(c, e)
    s = math.sin(math.radians(cap_deg))
    k = ((np.arange(N) + 0.5) / N * 2 - 1) * s
    px, py = np.meshgrid(k, -k, indexing="xy")
    inside = px * px + py * py < s * s
    pz = np.sqrt(np.clip(1 - px * px - py * py, 0, 1))
    d = pz[..., None] * c + px[..., None] * e + py[..., None] * n
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    rgb = np.zeros((N, N, 3))
    rgb[inside] = col.sample(d[inside], level)
    img = np.clip(rgb * exposure, 0, 1)
    img[~inside] = 0.0
    return (srgb_encode(img) * 255 + 0.5).astype(np.uint8)


def views(bid: str, cap_deg: float, level: int | None) -> Path:
    body = config.load(bid)
    col = Colour(bid)
    L = int(body.albedo["maxLevel"]) if level is None else level
    lowres = np.asarray(Image.open(rt.TILES_ROOT / bid / "globals" / "albedo-lowres.png").convert("RGB"))
    mean_lin = float((srgb_decode(lowres / 255.0) @ np.array([0.2126, 0.7152, 0.0722])).mean())
    exposure = 0.18 / max(mean_lin, 1e-3)
    canvas = Image.new("RGB", (4 * (N + 10) + 10, N + 50), (20, 20, 24))
    dr = ImageDraw.Draw(canvas)
    dr.text((10, 4), f"{body.raw['name']}: unshaded albedo, level {L}, caps of {cap_deg:g} deg, exposure x{exposure:.1f}", fill=(255, 255, 0))
    for i, (name, la, lo) in enumerate(CENTRES):
        x0 = 10 + i * (N + 10)
        canvas.paste(Image.fromarray(cap_view(col, la, lo, cap_deg, L, exposure)), (x0, 40))
        dr.text((x0, 24), name, fill=(255, 255, 0))
    out = rt.OUT / "views" / f"{bid}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, optimize=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--cap", type=float, default=25.0)
    ap.add_argument("--level", type=int)
    a = ap.parse_args()
    for bid in (config.all_ids("solid") if a.all else a.ids):
        if not (rt.TILES_ROOT / bid / "manifest.json").is_file():
            print(f"{bid}: not baked")
            continue
        print(views(bid, a.cap, a.level))


if __name__ == "__main__":
    main()
