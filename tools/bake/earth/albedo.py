"""`albedo` layer: opaque sRGB WebP, 256 x 256, cell-registered.

Global levels 0-7: NASA Blue Marble Next Generation, August 2004 base map (no relief shading added by the
producer), topographically de-shaded (deshade.py) with ETOPO normals on the same 15" grid. Level 7 samples
the per-face crop (clamped Catmull-Rom, longitude-prefiltered near the poles); levels 6..0 are 2 x 2 means in
linear light. Regional levels: Sentinel-2 cloudless (regalbedo.py).
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image

from common import cube
from earth import deshade, equirect, etopo, manifest, paths, sample, tiles
from earth.util import log, read_json, run_units, write_json

MONTH = 8
BANDS = 36                      # 5 deg latitude bands for the de-shading fit
FIT_FILE = paths.WORK / f"deshade-bmng-{MONTH:02d}.json"
L3_DIR = paths.WORK / "albedo-l3"
SOURCES_GLOBAL = ["NASA Earth Observatory Blue Marble Next Generation, August 2004 (public domain; Reto Stockli, NASA GSFC)"]
LUMA = np.array([0.2126, 0.7152, 0.0722])


# -- de-shading fit ----------------------------------------------------------------------------------------
def fit_deshading() -> np.ndarray:
    if FIT_FILE.is_file():
        return np.array(read_json(FIT_FILE)["alphaBeta"])
    mm = etopo.open_memmap()
    acc = deshade.Accumulator(BANDS)
    for q in equirect.QUADS:
        qr0, qc0 = equirect.quad_origin(q)
        log(f"deshade fit: {q}")
        img = np.asarray(Image.open(equirect.quad_path("bmng", q, MONTH)).convert("RGB"))
        # half resolution (2 x 2 means) keeps memory and time small
        y = tiles.srgb_to_linear(img.reshape(10800, 2, 10800, 2, 3).mean(axis=(1, 3))) @ LUMA
        del img
        h = np.asarray(mm[qr0:qr0 + 21600, qc0:qc0 + 21600], dtype=np.float32).reshape(10800, 2, 10800, 2).mean(axis=(1, 3)) * etopo.UNIT
        lat_rows = 90.0 - (qr0 + 2.0 * np.arange(10800) + 1.0) / equirect.PX_PER_DEG
        ne, nn, nu = deshade.normals_equirect(h, lat_rows, 2.0 / equirect.PX_PER_DEG, paths.RADIUS)
        land = (h > 5.0) & (y > 0.003)
        lr = deshade.local_log_ratio(y, land, sigma_px=32.0)
        slope_ok = land & (nu < math.cos(math.radians(2.0))) & (y < 0.6)
        band = np.clip(((90.0 - lat_rows) // 5).astype(int), 0, BANDS - 1)
        for b in np.unique(band):
            rows = band == b
            m = slope_ok[rows]
            if m.sum() == 0:
                continue
            acc.add(int(b), ne[rows][m], nn[rows][m], lr[rows][m])
        del y, h, ne, nn, nu, land, lr
    ab = acc.solve()
    write_json(FIT_FILE, {"bands": "5 deg from north", "alphaBeta": ab.tolist(), "samples": acc.n.tolist()})
    log("deshade fit: " + ", ".join(f"{90 - 5 * b - 2.5:+.0f}:{ab[b, 0]:+.2f}/{ab[b, 1]:+.2f}" for b in range(BANDS)))
    return ab


def tile_normals(h259: np.ndarray, face: int, level: int, x: int, y: int):
    """East/north normal components and height at the 256 x 256 texel centres of a tile, from the stored
    height tile of the same key (texel (c, r) spans vertices c..c+1, r..r+1 of the interior grid)."""
    g = h259[1:258, 1:258].astype(np.float64)
    hc = 0.25 * (g[:-1, :-1] + g[:-1, 1:] + g[1:, :-1] + g[1:, 1:])
    hu = 0.5 * ((g[:-1, 1:] + g[1:, 1:]) - (g[:-1, :-1] + g[1:, :-1]))     # per texel step in u
    hv = 0.5 * ((g[1:, :-1] + g[1:, 1:]) - (g[:-1, :-1] + g[:-1, 1:]))     # per texel step in v
    V = cube.height_tile_dirs(face, level, x, y)[1:258, 1:258]       # texel corner (vertex) directions
    d = V[:-1, :-1] + V[:-1, 1:] + V[1:, :-1] + V[1:, 1:]
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    du = 0.5 * ((V[:-1, 1:] + V[1:, 1:]) - (V[:-1, :-1] + V[1:, :-1])) * paths.RADIUS   # one texel step in u
    dv = 0.5 * ((V[1:, :-1] + V[1:, 1:]) - (V[:-1, :-1] + V[:-1, 1:])) * paths.RADIUS   # one texel step in v
    east = np.stack([-d[..., 1], d[..., 0], np.zeros_like(d[..., 0])], axis=-1)
    en = np.linalg.norm(east, axis=-1, keepdims=True)
    east = np.where(en > 1e-12, east / np.maximum(en, 1e-12), np.array([0.0, 1.0, 0.0]))
    north = np.cross(d, east)
    # J maps (du, dv) texel steps to (east, north) metres; gradient g = [hu, hv] J^-1
    a, b = np.sum(du * east, -1), np.sum(dv * east, -1)
    c, e = np.sum(du * north, -1), np.sum(dv * north, -1)
    det = a * e - b * c
    ge = (hu * e - hv * c) / det
    gn = (hv * a - hu * b) / det
    nrm = np.sqrt(1.0 + ge * ge + gn * gn)
    return -ge / nrm, -gn / nrm, hc


POLAR_TAPER = (60.0, 70.0)     # the fit is unreliable over ice sheets and the August polar night


def band_coefficients(ab: np.ndarray, lat: np.ndarray):
    band_lat = 90.0 - 5.0 * np.arange(BANDS) - 2.5
    w = np.clip((POLAR_TAPER[1] - np.abs(lat)) / (POLAR_TAPER[1] - POLAR_TAPER[0]), 0.0, 1.0)
    return w * np.interp(-lat, -band_lat, ab[:, 0]), w * np.interp(-lat, -band_lat, ab[:, 1])


def deshade_tile(lin: np.ndarray, face: int, x: int, y: int, ab: np.ndarray, lat: np.ndarray) -> np.ndarray:
    h = tiles.read_height(face, 7, x, y)
    ne, nn, hc = tile_normals(h, face, 7, x, y)
    al, be = band_coefficients(ab, lat.reshape(256, 256))
    f = np.where(hc > 0.0, deshade.factor(ne, nn, al, be), 1.0)     # seafloor slopes cast no shading
    return lin / f[..., None]


# -- level 7 and the subtree -------------------------------------------------------------------------------
def _sample_l7(crop: equirect.FaceCrop, face: int, x: int, y: int, ab: np.ndarray) -> np.ndarray:
    d = cube.image_tile_dirs(face, 7, x, y).reshape(-1, 3)
    lat, lon = tiles.dirs_latlon(d)
    cx, cy = crop.px(lat, lon)
    rgb = sample.bicubic_rgb_clamped(crop.data, cx, cy, crop.wrap)
    return deshade_tile(tiles.srgb_to_linear(rgb.reshape(256, 256, 3)), face, x, y, ab, lat)


def _subtree_unit(u: tuple[int, int, int]) -> int:
    """All level 7..3 tiles under one level-3 tile."""
    face, x3, y3 = u
    crop = equirect.open_face_crop("bmng", face, MONTH)
    ab = fit_deshading()
    lin = {}
    n = 0
    for dx in range(16):
        for dy in range(16):
            x, y = x3 * 16 + dx, y3 * 16 + dy
            t = _sample_l7(crop, face, x, y, ab)
            n += tiles.write_webp("albedo", face, 7, x, y, tiles.linear_to_srgb8(t))
            lin[(x, y)] = t
    for level in range(6, 2, -1):
        k = 2 ** (level - 3)
        nxt = {}
        for dx in range(k):
            for dy in range(k):
                x, y = x3 * k + dx, y3 * k + dy
                ch = [lin[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]
                t = tiles.box2(tiles.assemble_children(ch))
                n += tiles.write_webp("albedo", face, level, x, y, tiles.linear_to_srgb8(t))
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
                    ch = [lin[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]
                    t = tiles.box2(tiles.assemble_children(ch))
                    tiles.write_webp("albedo", face, level, x, y, tiles.linear_to_srgb8(t))
                    nxt[(x, y)] = t
            lin = nxt


def bake_global() -> None:
    cfg = {"v": 3, "month": MONTH, "quality": tiles.WEBP_QUALITY, "deshade": True}
    if manifest.is_marked("albedo", "global") and (paths.STATE / "albedo-global.cfg").is_file() \
            and (paths.STATE / "albedo-global.cfg").read_text(encoding="utf-8") == str(cfg):
        log("albedo: global levels already baked")
        return
    fit_deshading()
    for face in range(6):
        equirect.build_face_crop("bmng", face, MONTH)
        units = [(face, x, y) for x in range(8) for y in range(8)]
        run_units(f"albedo-f{face}", _subtree_unit, units, key=lambda u: "%d-%d-%d" % u, config=cfg)
        equirect.delete_face_crop("bmng", face, MONTH)
    _top_levels()
    (paths.STATE / "albedo-global.cfg").write_text(str(cfg), encoding="utf-8")
    manifest.mark("albedo", "global")


def bake_region(region_id: str) -> None:
    from earth import regalbedo
    regalbedo.bake(region_id)


def layer_manifest(regions: list[dict]) -> dict:
    from earth import region as regmod
    coverage: dict[str, list] = {}
    sources = list(SOURCES_GLOBAL)
    for reg in regions:
        for L in regmod.levels(reg):
            coverage.setdefault(str(L), []).extend(regmod.coverage_rects(reg, L))
        s = reg["sources"]["albedo"]
        txt = (f"Sentinel-2 cloudless {', '.join(str(y) for y in s['years'])} by EOX IT Services GmbH "
               f"(contains modified Copernicus Sentinel data), {s['licence']}; swappable")
        if txt not in sources:
            sources.append(txt)
    return {"encoding": "webp", "ext": "webp", "globalMaxLevel": paths.GLOBAL_MAX_LEVEL, "coverage": coverage,
            "sources": sources}
