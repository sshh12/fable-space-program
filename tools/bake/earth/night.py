"""`night` layer: emitted night-light colour, opaque sRGB WebP, global levels 0-7 (no regional levels).

Source: NASA Black Marble 2016 (VIIRS day/night band composite, 15"). The published composite paints a dim,
bluish moonlit Earth under the lights; that background is not emission and is removed:
  1. background model: BM_linear = [BMNG_linear, 1] M (a 4 x 3 matrix fitted by least squares on unlit,
     blue-dominated pixels of all quadrants) is subtracted;
  2. whatever blue-dominated residue remains (snow and ice the August BMNG lacks) is removed along a bluish
     tint t = (0.5, 0.55, 1.0): a = max(0, (B - k R) / (1 - k t_R)), k = 0.9, so emission keeps B <= k R;
  3. a soft floor of EPS (linear) removes JPEG noise.
The result is cached per quadrant as lossless PNG; tiles are then baked like albedo (level 7 sampled from
the per-face crop, coarser levels 2 x 2 means in linear light, i.e. conserving emitted power).
"""
from __future__ import annotations

import numpy as np
from PIL import Image

from common import cube
from earth import equirect, manifest, paths, sample, tiles
from earth.util import log, read_json, run_units, write_json

MONTH = 8
TINT = np.array([0.5, 0.55, 1.0])
KAPPA = 0.9
EPS = 0.0015
FIT_FILE = paths.WORK / "night-background-fit.json"
QUAD_DIR = paths.WORK / "night-quads"
L3_DIR = paths.WORK / "night-l3"
SOURCES = ["NASA Earth Observatory Black Marble 2016 (Suomi NPP VIIRS day/night band; public domain), "
           "moonlit background removed"]


def fit_background() -> np.ndarray:
    if FIT_FILE.is_file():
        return np.array(read_json(FIT_FILE)["M"])
    xs, ys = [], []
    rng = np.random.default_rng(7)
    for q in equirect.QUADS:
        bm = np.asarray(Image.open(equirect.quad_path("blackmarble", q)).convert("RGB"))[::3, ::3]
        bg = np.asarray(Image.open(equirect.quad_path("bmng", q, MONTH)).convert("RGB"))[::3, ::3]
        unlit = bm[..., 2].astype(np.int16) > bm[..., 0].astype(np.int16) + 8
        idx = np.flatnonzero(unlit)
        if idx.size == 0:
            continue
        idx = rng.choice(idx, min(idx.size, 300_000), replace=False)
        xs.append(tiles.srgb_to_linear(bg.reshape(-1, 3)[idx]))
        ys.append(tiles.srgb_to_linear(bm.reshape(-1, 3)[idx]))
        log(f"night fit: {q} {idx.size} unlit samples")
    X = np.concatenate(xs)
    X1 = np.concatenate([X, np.ones((X.shape[0], 1))], axis=1)
    Y = np.concatenate(ys)
    M, *_ = np.linalg.lstsq(X1, Y, rcond=None)
    res = Y - X1 @ M
    write_json(FIT_FILE, {"M": M.tolist(), "residualStd": res.std(axis=0).tolist(), "samples": int(X.shape[0])})
    log(f"night fit: residual std {res.std(axis=0).round(5)}")
    return M


def emission(bm_srgb: np.ndarray, bg_srgb: np.ndarray, M: np.ndarray) -> np.ndarray:
    """Linear emission for (n, 3) uint8 Black Marble / BMNG pixels."""
    x = tiles.srgb_to_linear(bm_srgb)
    b = tiles.srgb_to_linear(bg_srgb)
    e = x - (b @ M[:3] + M[3])
    a = np.maximum(0.0, (e[:, 2] - KAPPA * e[:, 0]) / (1.0 - KAPPA * TINT[0]))
    e = e - a[:, None] * TINT
    return np.maximum(e - EPS, 0.0)


def build_quadrants() -> None:
    M = fit_background()
    QUAD_DIR.mkdir(parents=True, exist_ok=True)
    for q in equirect.QUADS:
        out = equirect.quad_path("nightemission", q)
        if out.is_file():
            continue
        log(f"night: emission for {q}")
        bm = np.asarray(Image.open(equirect.quad_path("blackmarble", q)).convert("RGB"))
        bg = np.asarray(Image.open(equirect.quad_path("bmng", q, MONTH)).convert("RGB"))
        res = np.empty_like(bm)
        for r0 in range(0, 21600, 600):
            e = emission(bm[r0:r0 + 600].reshape(-1, 3), bg[r0:r0 + 600].reshape(-1, 3), M)
            res[r0:r0 + 600] = tiles.linear_to_srgb8(e).reshape(-1, 21600, 3)
        tmp = out.with_name(out.stem + ".partial.png")
        Image.fromarray(res, "RGB").save(tmp, optimize=False, compress_level=6)
        tmp.replace(out)
        del bm, bg, res


def _subtree_unit(u: tuple[int, int, int]) -> int:
    face, x3, y3 = u
    crop = equirect.open_face_crop("nightemission", face, MONTH)
    lin = {}
    n = 0
    for dx in range(16):
        for dy in range(16):
            x, y = x3 * 16 + dx, y3 * 16 + dy
            d = cube.image_tile_dirs(face, 7, x, y).reshape(-1, 3)
            lat, lon = tiles.dirs_latlon(d)
            cx, cy = crop.px(lat, lon)
            t = tiles.srgb_to_linear(sample.bicubic_rgb_clamped(crop.data, cx, cy, crop.wrap).reshape(256, 256, 3))
            n += tiles.write_webp("night", face, 7, x, y, tiles.linear_to_srgb8(t))
            lin[(x, y)] = t
    for level in range(6, 2, -1):
        k = 2 ** (level - 3)
        nxt = {}
        for dx in range(k):
            for dy in range(k):
                x, y = x3 * k + dx, y3 * k + dy
                t = tiles.box2(tiles.assemble_children([lin[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]))
                n += tiles.write_webp("night", face, level, x, y, tiles.linear_to_srgb8(t))
                nxt[(x, y)] = t
        lin = nxt
    L3_DIR.mkdir(parents=True, exist_ok=True)
    np.save(L3_DIR / f"{face}-{x3}-{y3}.npy", lin[(x3, y3)].astype(np.float32))
    return n


def _top_levels() -> None:
    for face in range(6):
        lin = {(x, y): np.load(L3_DIR / f"{face}-{x}-{y}.npy").astype(np.float64) for x in range(8) for y in range(8)}
        for level in (2, 1, 0):
            k = 2 ** level
            nxt = {}
            for x in range(k):
                for y in range(k):
                    t = tiles.box2(tiles.assemble_children([lin[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]))
                    tiles.write_webp("night", face, level, x, y, tiles.linear_to_srgb8(t))
                    nxt[(x, y)] = t
            lin = nxt


def bake_global() -> None:
    cfg = {"v": 2, "kappa": KAPPA, "eps": EPS, "quality": tiles.WEBP_QUALITY}
    if manifest.is_marked("night", "global") and (paths.STATE / "night-global.cfg").is_file() \
            and (paths.STATE / "night-global.cfg").read_text(encoding="utf-8") == str(cfg):
        log("night: already baked")
        return
    build_quadrants()
    for face in range(6):
        equirect.build_face_crop("nightemission", face, MONTH)
        units = [(face, x, y) for x in range(8) for y in range(8)]
        run_units(f"night-f{face}", _subtree_unit, units, key=lambda u: "%d-%d-%d" % u, config=cfg)
        equirect.delete_face_crop("nightemission", face, MONTH)
    _top_levels()
    (paths.STATE / "night-global.cfg").write_text(str(cfg), encoding="utf-8")
    manifest.mark("night", "global")


def layer_manifest() -> dict:
    return {"encoding": "webp", "ext": "webp", "globalMaxLevel": paths.GLOBAL_MAX_LEVEL, "coverage": {},
            "sources": list(SOURCES)}
