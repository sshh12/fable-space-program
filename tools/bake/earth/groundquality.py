"""Ground-quality material at the pads of a site (work package site-bake; OPEN_QUESTIONS Q8): the height and
albedo detail the BAKED tiles actually hold at pad level, so that planet-render and the lead can judge whether a
region meets the v1 standard (Ka Lae, 10 m 3DEP) there.

    python -I tools/bake/earth/bake.py quality --region earth-madrakah --site madrakah
    python -I tools/bake/earth/bake.py quality --region earth-ka-lae --site ka-lae

Reads data/staged/sites/<site>.pads.json (padresolve.py) and, for the first pad of each class:
  - height detail: structure function of the level-12 collision surface (RMS height difference of points 10, 30,
    100 m apart) within 2 km, RMS second differences at 10 and 30 m and their ratio (the slope removed: about 0.4
    for real relief, about 0.1 for a surface interpolated from 30 m samples), and the RMS of the band finer than
    about 30 m (surface minus its 15 m Gaussian);
  - slope histogram within 2 km of the pad (10 m grid);
  - albedo detail: RMS luminance difference of neighbouring texels (the imagery's own detail) within 1 km;
  - top-down renders of the baked tiles at pad level (600 m across, 1 m pixels), 2 km across and 20 km across:
    imagery | hillshade (relief x3, sun from the north-west, 45 deg) | imagery lit by that sun (relief x1) | land
    cover, the 500 m disc of
    the pad rule in red and the other pads in yellow;
and an overview of every pad of the site. Writes out/bake/earth/site-bake/quality-<site>*.png and quality-<site>.json.
"""
from __future__ import annotations

import json
import math

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

from common import cube
from earth import paths, region as regmod
from earth.contact import LC_PALETTE, Sampler, hillshade
from earth.padresolve import Field, STAGED_SITES
from earth.site import destination, gc_distance_m
from earth.util import log, write_json

OUT = paths.OUT / "site-bake"
SLOPE_BINS = [0, 1, 2, 4, 8, 16, 32, 90]
LUMA = np.array([0.2126, 0.7152, 0.0722])


def _grid(lat: float, lon: float, half_m: float, n: int):
    k = np.linspace(-half_m, half_m, n)
    E, N = np.meshgrid(k, k[::-1])                     # north up
    la, lo = destination(lat, lon, E.ravel(), N.ravel())
    return la, lo, E, N


def height_detail(h_field: Field, lat: float, lon: float) -> dict:
    """Structure function and fine-band RMS of the collision surface within 2 km (10 m grid), slope histogram."""
    n = 401
    la, lo, E, N = _grid(lat, lon, 2000.0, n)
    H = h_field(la, lo).reshape(n, n)
    inside = np.hypot(E, N) <= 2000.0
    land = inside & (H > 0.0)
    out = {}
    for lag in (1, 3, 10):                             # 10, 30, 100 m
        de = (H[:, lag:] - H[:, :-lag])[land[:, lag:] & land[:, :-lag]]
        dn = (H[lag:, :] - H[:-lag, :])[land[lag:, :] & land[:-lag, :]]
        out[f"rmsDiff{lag * 10}m"] = round(float(np.sqrt(np.mean(np.concatenate([de, dn]) ** 2))), 3)
    # second differences remove the slope: real relief keeps about lag^0.8 of its curvature from 30 m to 10 m
    # (ratio ~0.4), a surface interpolated from 30 m samples keeps ~lag^2 (ratio ~0.1)
    for lag in (1, 3):
        ce = (H[:, 2 * lag:] - 2 * H[:, lag:-lag] + H[:, :-2 * lag])[land[:, 2 * lag:] & land[:, :-2 * lag] & land[:, lag:-lag]]
        cn = (H[2 * lag:, :] - 2 * H[lag:-lag, :] + H[:-2 * lag, :])[land[2 * lag:, :] & land[:-2 * lag, :] & land[lag:-lag, :]]
        out[f"rmsCurvature{lag * 10}m"] = round(float(np.sqrt(np.mean(np.concatenate([ce, cn]) ** 2))), 3)
    out["curvatureRatio10to30"] = round(out["rmsCurvature10m"] / max(out["rmsCurvature30m"], 1e-9), 3)
    fine = H - ndimage.gaussian_filter(H, 1.5)         # sigma 15 m
    out["rmsFinerThan30m"] = round(float(np.sqrt(np.mean(fine[land] ** 2))), 3)
    gy, gx = np.gradient(H, 10.0)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))[land]
    hist, _ = np.histogram(slope, bins=SLOPE_BINS)
    out["slopeHistogram"] = {f"{a}-{b}": round(float(c) / max(1, slope.size), 4) for a, b, c in zip(SLOPE_BINS[:-1], SLOPE_BINS[1:], hist)}
    out["slopeMedianDeg"] = round(float(np.median(slope)), 2)
    out["slopeP95Deg"] = round(float(np.percentile(slope, 95)), 2)
    out["landShare"] = round(float(land.sum() / inside.sum()), 3)
    return out


def albedo_detail(lv: int, lat: float, lon: float) -> dict:
    """RMS sRGB luminance difference of neighbouring texels within 1 km (sampled on the texel grid)."""
    s = Sampler("albedo", lv)
    n = 230                                            # ~ texel spacing at level 12
    la, lo, E, N = _grid(lat, lon, 1000.0, n)
    d = cube.lat_lon_to_dir(np.radians(la), np.radians(lo))
    Y = (s(d).reshape(n, n, 3) @ LUMA)
    dif = np.concatenate([(Y[:, 1:] - Y[:, :-1]).ravel(), (Y[1:, :] - Y[:-1, :]).ravel()])
    return {"rmsNeighbourDiffSrgb": round(float(np.sqrt(np.mean(dif ** 2))), 2),
            "meanLumaSrgb": round(float(Y.mean()), 1), "stdLumaSrgb": round(float(Y.std()), 2)}


def panels(lv: int, h_field: Field, lat: float, lon: float, half_m: float, n: int, marks: list) -> np.ndarray:
    la, lo, E, N = _grid(lat, lon, half_m, n)
    d = cube.lat_lon_to_dir(np.radians(la), np.radians(lo))
    px = 2 * half_m / (n - 1)
    alb = Sampler("albedo", lv)(d).reshape(n, n, 3)
    H = h_field(la, lo).reshape(n, n)
    shade = hillshade(H, px)
    hs = np.clip(np.stack([hillshade(H, px, exag=3.0) * 200] * 3, -1), 0, 255)       # relief x3, to show the detail
    lit = np.clip(alb * (shade[..., None] / 0.88), 0, 255)
    lc = LC_PALETTE[np.clip(Field("landcover", lv)(la, lo).reshape(n, n).astype(int), 0, 11)]
    wm = Field("watermask", lv)(la, lo).reshape(n, n) >= 128
    out = []
    for img in (alb, hs, lit, lc):
        im = Image.fromarray(np.asarray(img, np.uint8))
        a = np.asarray(im).copy()
        a[wm ^ np.roll(wm, 1, 0) | wm ^ np.roll(wm, 1, 1)] = (0, 200, 255)
        im = Image.fromarray(a)
        dr = ImageDraw.Draw(im)
        for mla, mlo, rad, col in marks:
            dist = gc_distance_m(lat, lon, mla, mlo)
            if dist > half_m * 1.5 + rad:
                continue
            az = math.atan2(math.sin(math.radians(mlo - lon)) * math.cos(math.radians(mla)),
                            math.cos(math.radians(lat)) * math.sin(math.radians(mla))
                            - math.sin(math.radians(lat)) * math.cos(math.radians(mla)) * math.cos(math.radians(mlo - lon)))
            cx = (n - 1) / 2 + dist * math.sin(az) / px
            cy = (n - 1) / 2 - dist * math.cos(az) / px
            rp = max(rad / px, 3)
            dr.ellipse([cx - rp, cy - rp, cx + rp, cy + rp], outline=col, width=2 if n > 700 else 1)
        out.append(np.asarray(im))
    sep = np.full((n, 6, 3), 255, np.uint8)
    return np.concatenate(sum([[p, sep] for p in out], [])[:-1], axis=1)


def save(img: np.ndarray, name: str, label: str) -> str:
    OUT.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(img)
    dr = ImageDraw.Draw(im)
    dr.rectangle([0, 0, 8 + 6 * len(label), 15], fill=(0, 0, 0))
    dr.text((4, 2), label, fill=(255, 255, 0))
    p = OUT / name
    im.save(p)
    return p.relative_to(paths.REPO).as_posix()


def run(region_id: str, args) -> dict:
    if not args.site:
        raise ValueError("bake.py quality needs --site")
    reg = regmod.load(region_id)
    lv = regmod.levels(reg)[-1]
    doc = json.loads((STAGED_SITES / f"{args.site}.pads.json").read_text(encoding="utf-8"))
    if doc["region"] != region_id:
        raise ValueError(f"{args.site}.pads.json was resolved on {doc['region']}, not {region_id}")
    pads = doc["pads"]
    h = Field("height", lv)
    picks = []
    for cls in ("heavy", "medium", "light"):
        p = next((q for q in pads if q["class"] == cls), None)
        if p is not None:
            picks.append(p)
    marks_all = [(q["latDeg"], q["lonDeg"], 500.0, (255, 230, 0)) for q in pads]
    res = {"site": args.site, "region": region_id, "level": lv,
           "sources": {"height": reg["sources"]["height"].get("credit", "Terrarium (USGS 3DEP 10 m)"),
                       "heightResolutionM": reg["sources"]["height"].get("resolutionM", 10),
                       "albedo": f"Sentinel-2 cloudless z{reg['sources']['albedo']['zoom']} median {reg['sources']['albedo']['years']}",
                       "landcover": "ESA WorldCover 2021 (10 m)"},
           "pads": {}, "pictures": []}
    for p in picks:
        la, lo = p["latDeg"], p["lonDeg"]
        marks = [(la, lo, 500.0, (255, 40, 40))] + [m for m in marks_all if (m[0], m[1]) != (la, lo)]
        entry = {"class": p["class"], "latDeg": la, "lonDeg": lo, "height": height_detail(h, la, lo),
                 "albedo": albedo_detail(lv, la, lo)}
        for tag, half, n in (("pad", 300.0, 601), ("2km", 1000.0, 1001), ("20km", 10000.0, 1601)):
            img = panels(lv, h, la, lo, half, n, marks)
            res["pictures"].append(save(img, f"quality-{args.site}-{p['id']}-{tag}.png",
                                        f"{args.site} {p['id']} ({p['class']}) {2 * half / 1000:g} km across, level {lv}: "
                                        f"imagery | hillshade x3 | lit imagery | land cover; red = 500 m pad-rule disc"))
        res["pads"][p["id"]] = entry
        log(f"quality {args.site} {p['id']}: {entry}")
    cla = float(np.mean([q["latDeg"] for q in pads]))
    clo = float(np.mean([q["lonDeg"] for q in pads]))
    half = max(6000.0, max(gc_distance_m(cla, clo, q["latDeg"], q["lonDeg"]) for q in pads) + 2500.0)
    img = panels(lv, h, cla, clo, half, 1601, marks_all)
    res["pictures"].append(save(img, f"quality-{args.site}-overview.png",
                                f"{args.site}: every pad (yellow: 500 m discs), {2 * half / 1000:.0f} km across, centred on the pads"))
    write_json(OUT / f"quality-{args.site}.json", res)
    return res
