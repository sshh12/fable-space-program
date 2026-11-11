"""Colour constraint of the Moon's `albedo` layer and `albedoLowRes` map (request sky-lighting-6).

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/moon/colour.py [--steps fit,apply,build] [--force]

The SVS colour map behind the albedo layer (albedo.py) carries a stretched colour: maria come out bluer than
green ("blue" mare at the landing site: linear 0.060 / 0.063 / 0.070), which no lunar soil is (reflectance
rises from 415 to 750 nm everywhere; mare basalts are "blue" only relative to other maria in ratio images).
This step keeps every texel's LUMINANCE (Rec. 709 weights, linear) and scales its CHROMA (colour / luminance)
about the area-weighted mean chroma of the global map by one factor k, the largest for which the bluest
surface still has red >= green >= blue (a robust bound: the 0.1 percentile over the map's texels); the few
texels still out of order afterwards are clamped to green <= red, blue <= green and rescaled to their
luminance. Run it after `albedo.py` (and `region.py` for the regional levels): it rewrites the albedo tiles of
every level in place and `globals/albedo-lowres.png`, and records itself as `layers.albedo.colour` in the
manifest, so a second run is a no-op (a fresh `albedo.py tiles` drops the record with the layer it rebuilds).

  fit    mean chroma and k from albedo-lowres.png -> data/cache/moon/work/albedo_colour.json
  apply  every albedo tile (global levels 0-7 and the regional coverage) and albedo-lowres.png
  build  layers.albedo.build (hash of every tile, as albedo.py step_build, regional levels included)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from common import layout  # noqa: E402
from moon import rt  # noqa: E402
from moon.sampling import srgb_decode, srgb_encode  # noqa: E402

LUMA = np.array([0.2126, 0.7152, 0.0722])
WEBP_QUALITY = 95
FIT = rt.MOON_WORK / "albedo_colour.json"
LOWRES = rt.TILES_ROOT / rt.TILESET / "globals" / "albedo-lowres.png"


def constrain(lin: np.ndarray, mean_chroma: np.ndarray, k: float) -> np.ndarray:
    """Linear RGB (..., 3) -> the same luminance, chroma scaled by k about mean_chroma, red >= green >= blue."""
    y = lin @ LUMA
    safe = np.maximum(y, 1e-6)[..., None]
    c = mean_chroma + k * (lin / safe - mean_chroma)
    c = np.maximum(c, 0.0)
    c[..., 1] = np.minimum(c[..., 1], c[..., 0])
    c[..., 2] = np.minimum(c[..., 2], c[..., 1])
    c /= np.maximum(c @ LUMA, 1e-6)[..., None]
    return np.where(y[..., None] > 1e-6, c * y[..., None], lin)


def area_weights(h: int, w: int) -> np.ndarray:
    lat = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    return np.repeat(np.cos(np.radians(lat))[:, None], w, axis=1)


def step_fit() -> None:
    lin = srgb_decode(np.asarray(Image.open(LOWRES).convert("RGB"), dtype=np.float64) / 255.0)
    h, w, _ = lin.shape
    y = lin @ LUMA
    ok = y > 0.01
    wt = area_weights(h, w) * ok
    chroma = lin / np.maximum(y, 1e-6)[..., None]
    mean = (chroma * wt[..., None]).reshape(-1, 3).sum(0) / wt.sum()
    mean /= mean @ LUMA
    d = chroma - mean
    # Per texel, the largest k that keeps B <= G and G <= R: m_B + k d_B <= m_G + k d_G, m_G + k d_G <= m_R + k d_R.
    bounds = np.full(y.shape, np.inf)
    gb = d[..., 2] - d[..., 1]
    rg = d[..., 1] - d[..., 0]
    with np.errstate(divide="ignore", invalid="ignore"):
        bounds = np.where(gb > 1e-9, np.minimum(bounds, (mean[1] - mean[2]) / gb), bounds)
        bounds = np.where(rg > 1e-9, np.minimum(bounds, (mean[0] - mean[1]) / rg), bounds)
    k = float(min(1.0, np.percentile(bounds[ok], 0.1)))
    if mean[2] > mean[1] or mean[1] > mean[0]:
        raise RuntimeError(f"the map's mean colour itself is out of order: {mean}")
    after = constrain(lin, mean, k)
    viol = float(((after[..., 2] > after[..., 1] + 1e-9) | (after[..., 1] > after[..., 0] + 1e-9))[ok].mean())

    def near_side_mean(a: np.ndarray) -> list[float]:
        lon = -180.0 + (np.arange(w) + 0.5) * 360.0 / w
        near = (np.abs(lon) <= 90.0)[None, :] & ok
        ww = area_weights(h, w) * near
        return [float(v) for v in (a * ww[..., None]).reshape(-1, 3).sum(0) / ww.sum()]

    res = {"meanChroma": [float(v) for v in mean], "chromaScale": k, "outOfOrderAfter": viol,
           "nearSideMeanBefore": near_side_mean(lin), "nearSideMeanAfter": near_side_mean(after),
           "globalMeanAfter": [float(v) for v in (after * area_weights(h, w)[..., None]).reshape(-1, 3).sum(0) / area_weights(h, w).sum()]}
    rt.write_json(FIT, res)
    rt.log(f"colour fit: mean chroma {np.round(mean, 4).tolist()}, k {k:.3f}, near-side mean after {np.round(res['nearSideMeanAfter'], 4).tolist()}")


def _apply_tile(args) -> int:
    path, mean, k = args
    p = Path(path)
    with Image.open(p) as im:
        src = np.asarray(im.convert("RGB"), dtype=np.float64) / 255.0
    out = constrain(srgb_decode(src), np.asarray(mean), k)
    u8 = (np.clip(srgb_encode(np.clip(out, 0.0, 1.0)), 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(u8, "RGB").save(buf, "WEBP", quality=WEBP_QUALITY, method=4)
    rt.write_tile(p, buf.getvalue())
    return 1


def tile_keys(layer: dict) -> list[tuple[int, int, int, int]]:
    keys = [(f, L, x, y) for L in range(layer["globalMaxLevel"] + 1) for f in range(6) for y in range(2 ** L) for x in range(2 ** L)]
    for L, rects in sorted(layer.get("coverage", {}).items(), key=lambda kv: int(kv[0])):
        if int(L) <= layer["globalMaxLevel"]:
            continue
        for r in rects:
            keys += [(r["face"], int(L), x, y) for y in range(r["y0"], r["y1"] + 1) for x in range(r["x0"], r["x1"] + 1)]
    return keys


def step_apply(force: bool) -> None:
    m = layout.read_manifest(rt.TILESET)
    layer = m["layers"]["albedo"]
    if layer.get("colour") and not force:
        rt.log(f"albedo colour already applied ({layer['colour']}); nothing to do")
        return
    fit = rt.read_json(FIT)
    mean, k = fit["meanChroma"], fit["chromaScale"]
    keys = [kk for kk in tile_keys(layer) if layout.tile_file(rt.TILESET, "albedo", *kk, "webp").is_file()]
    t0 = time.time()
    jobs = [(str(layout.tile_file(rt.TILESET, "albedo", *kk, "webp")), mean, k) for kk in keys]
    done = 0
    with rt.pool() as p:
        for n in p.imap_unordered(_apply_tile, jobs, chunksize=64):
            done += n
            if done % 10000 == 0 or done == len(jobs):
                rt.log(f"albedo colour {done}/{len(jobs)}  {time.time() - t0:.0f} s")
    lin = srgb_decode(np.asarray(Image.open(LOWRES).convert("RGB"), dtype=np.float64) / 255.0)
    u8 = (srgb_encode(np.clip(constrain(lin, np.asarray(mean), k), 0.0, 1.0)) * 255.0 + 0.5).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(u8, "RGB").save(buf, "PNG", optimize=True)
    layout.write_atomic(LOWRES, buf.getvalue())
    m = layout.read_manifest(rt.TILESET)
    layer = m["layers"]["albedo"]
    layer["colour"] = {"meanChroma": [round(v, 6) for v in mean], "chromaScale": round(k, 6), "rule": "luminance kept, chroma x k about the mean, R >= G >= B"}
    layout.merge_layer(rt.TILESET, rt.MOON_RADIUS, "albedo", layer)
    rt.log(f"albedo colour applied to {len(jobs)} tiles and albedo-lowres.png in {time.time() - t0:.0f} s")


def step_build() -> None:
    m = layout.read_manifest(rt.TILESET)
    layer = m["layers"]["albedo"]
    h = hashlib.sha256()
    for f, L, x, y in tile_keys(layer):
        p = layout.tile_file(rt.TILESET, "albedo", f, L, x, y, "webp")
        if not p.is_file():
            continue
        h.update(f"{f}/{L}/{x}/{y}:".encode("ascii"))
        h.update(hashlib.sha256(p.read_bytes()).digest())
    h.update(hashlib.sha256(LOWRES.read_bytes()).digest())
    layer["build"] = h.hexdigest()[:16]
    layout.merge_layer(rt.TILESET, rt.MOON_RADIUS, "albedo", layer)
    rt.log(f"albedo build {layer['build']}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", default="fit,apply,build")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    rt.check_python()
    rt.below_normal_priority()
    rt.MOON_WORK.mkdir(parents=True, exist_ok=True)
    for s in a.steps.split(","):
        t0 = time.time()
        if s == "fit":
            step_fit()
        elif s == "apply":
            step_apply(a.force)
        elif s == "build":
            step_build()
        else:
            raise SystemExit(f"unknown step {s}")
        rt.log(f"step {s} done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
