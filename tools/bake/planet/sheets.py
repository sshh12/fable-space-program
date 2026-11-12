"""Contact sheets of baked simple bodies, rendered on the CPU from the tiles (for LOOKING at the result).

  python -I tools/bake/planet/sheets.py <id> [...] | --all     ->  out/bake/planet/<id>.png

Top row: the equirect albedo (globals/albedo-lowres.png) with every landmark of the config circled and named,
and a hillshade of the height layer (relief exaggerated so that it shows at this scale; the exaggeration is
printed). Bottom row: four orthographic views of the body (sub-observer longitudes 0, 90, 180 and 270 E on
the equator, north up) lit from the upper left, albedo x Lambert on the true (unexaggerated) heights.
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from common import cube, layout  # noqa: E402
from moon.sampling import dirs_to_tiles, srgb_decode, srgb_encode  # noqa: E402
from moon.tiles import TileReader  # noqa: E402
from planet import config, rt  # noqa: E402

VIEW = 360


class Colour:
    def __init__(self, tileset: str):
        self.tileset = tileset
        self.cache: dict = {}

    def sample(self, d: np.ndarray, level: int) -> np.ndarray:
        f, x, y, u, v = dirs_to_tiles(d, level)
        out = np.zeros((len(d), 3))
        key = (f * 4096 + x) * 4096 + y
        for k in np.unique(key):
            sel = key == k
            ff, xx, yy = int(f[sel][0]), int(x[sel][0]), int(y[sel][0])
            t = self.cache.get((ff, level, xx, yy))
            if t is None:
                p = layout.tile_file(self.tileset, "albedo", ff, level, xx, yy, "webp")
                t = srgb_decode(np.asarray(Image.open(p).convert("RGB"), dtype=np.float64) / 255.0)
                self.cache[(ff, level, xx, yy)] = t
            out[sel] = t[np.minimum(255, (v[sel] * 256).astype(int)), np.minimum(255, (u[sel] * 256).astype(int))]
        return out


def ortho(body: config.Body, hr: TileReader, col: Colour, lon0: float, hl: int, al: int, exposure: float) -> np.ndarray:
    n = VIEW
    k = (np.arange(n) + 0.5) / n * 2 - 1
    px, py = np.meshgrid(k, -k, indexing="xy")
    inside = px * px + py * py < 1.0
    pz = np.sqrt(np.clip(1 - px * px - py * py, 0, 1))
    lo = math.radians(lon0)
    f = np.array([math.cos(lo), math.sin(lo), 0.0])
    e = np.array([-math.sin(lo), math.cos(lo), 0.0])
    nn = np.array([0.0, 0.0, 1.0])
    d = pz[..., None] * f + px[..., None] * e + py[..., None] * nn
    d = d / np.linalg.norm(d, axis=-1, keepdims=True)
    R = body.radius
    h = np.zeros((n, n))
    h[inside] = hr.bicubic(d[inside], hl)
    P = d * (R + h)[..., None]
    gx = np.gradient(P, axis=1)
    gy = np.gradient(P, axis=0)
    nrm = np.cross(gx, gy)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=-1, keepdims=True), 1e-12)
    flip = np.sum(nrm * d, axis=-1) < 0
    nrm[flip] *= -1
    sun = -0.55 * e + 0.55 * nn + 0.63 * f
    sun /= np.linalg.norm(sun)
    lam = np.clip(np.sum(nrm * sun, axis=-1), 0, 1)
    rgb = np.zeros((n, n, 3))
    rgb[inside] = col.sample(d[inside], al)
    img = rgb * lam[..., None] * exposure
    img[~inside] = 0.0
    return (srgb_encode(np.clip(img, 0, 1)) * 255 + 0.5).astype(np.uint8)


def hillshade_equirect(body: config.Body, hr: TileReader, hl: int, w: int = 1024, h: int = 512) -> tuple[np.ndarray, float, tuple]:
    lat = np.radians(90 - (np.arange(h) + 0.5) * 180 / h)
    lon = np.radians(-180 + (np.arange(w) + 0.5) * 360 / w)
    LA, LO = np.meshgrid(lat, lon, indexing="ij")
    d = cube.lat_lon_to_dir(LA, LO).reshape(-1, 3)
    hh = hr.bicubic(d, hl).reshape(h, w)
    R = body.radius
    dy = math.pi * R / h
    dx = dy * np.maximum(np.cos(LA), 0.05)
    gy = np.gradient(hh, axis=0) / dy
    gx = np.gradient(hh, axis=1) / dx
    slope = np.hypot(gx, gy)
    ex = 0.35 / max(float(np.percentile(slope, 95)), 1e-6)
    nx, ny, nz = -gx * ex, gy * ex, np.ones_like(hh)
    nl = np.sqrt(nx * nx + ny * ny + nz * nz)
    s = np.array([-0.6, 0.6, 0.53])
    shade = np.clip((nx * s[0] + ny * s[1] + nz * s[2]) / nl, 0, 1)
    lo, hi = float(hh.min()), float(hh.max())
    tint = (hh - lo) / max(hi - lo, 1e-9)
    rgb = np.stack([0.35 + 0.65 * tint, 0.45 + 0.4 * tint, 0.6 - 0.3 * tint], -1) * shade[..., None]
    return (np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8), ex, (lo, hi)


def sheet(bid: str) -> Path:
    body = config.load(bid)
    hr = TileReader(bid, cache_tiles=2048)
    col = Colour(bid)
    F = int(body.height["maxLevel"])
    A = int(body.albedo["maxLevel"])
    hl = min(F, 4)
    al = min(A, 4)
    lowres = np.asarray(Image.open(rt.TILES_ROOT / bid / "globals" / "albedo-lowres.png").convert("RGB"))
    shade, ex, (lo, hi) = hillshade_equirect(body, hr, hl)
    # exposure: the body's mean albedo lit head-on lands at middle grey (as a camera would expose it)
    mean_lin = float((srgb_decode(lowres / 255.0) @ np.array([0.2126, 0.7152, 0.0722])).mean())
    exposure = 0.45 / max(mean_lin, 1e-3)
    views = [ortho(body, hr, col, lon, hl, al, exposure) for lon in (0, 90, 180, 270)]
    W = 1024 * 2 + 30
    H = 512 + VIEW + 70
    canvas = Image.new("RGB", (W, H), (20, 20, 24))
    canvas.paste(Image.fromarray(lowres), (10, 30))
    canvas.paste(Image.fromarray(shade), (1024 + 20, 30))
    dr = ImageDraw.Draw(canvas)
    dr.text((10, 8), f"{body.raw['name']}: albedo (level <= {A}, 1024 x 512 low-res global), column 0 = 180 W, landmarks circled", fill=(255, 255, 0))
    dr.text((1044, 8), f"height hillshade (level {hl}), relief x{ex:.0f}, range {lo:.0f} .. {hi:.0f} m", fill=(255, 255, 0))
    for lm in body.raw["landmarks"]:
        pts = [lm] if "latDeg" in lm else [dict(lm["brighter"], name=lm["name"] + " +"), dict(lm["darker"], name=lm["name"] + " -")]
        for p in pts:
            x = 10 + ((p["lonDegE"] + 180) % 360) / 360 * 1024
            y = 30 + (90 - p["latDeg"]) / 180 * 512
            r = max(4.0, (p.get("radiusKm") or p.get("diameterKm", 40) / 2 or 20) * 1000 / body.radius / math.pi * 512)
            for ox in (0, 1024 + 10):
                dr.ellipse([x + ox - r, y - r, x + ox + r, y + r], outline=(255, 60, 60))
                dr.text((x + ox + r + 2, y - 6), p.get("name", lm["name"]), fill=(255, 120, 120))
    for i, v in enumerate(views):
        x0 = 10 + i * (VIEW + 20)
        canvas.paste(Image.fromarray(v), (x0, 512 + 55))
        dr.text((x0, 512 + 38), f"sub-observer 0 N {(0, 90, 180, 270)[i]} E (exposure x{exposure:.1f})", fill=(255, 255, 0))
    out = rt.OUT / f"{bid}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, optimize=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    ids = [i for i in config.all_ids("solid")] if a.all else a.ids
    for bid in ids:
        if not (rt.TILES_ROOT / bid / "manifest.json").is_file():
            print(f"{bid}: not baked")
            continue
        print(sheet(bid))


if __name__ == "__main__":
    main()
