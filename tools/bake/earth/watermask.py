"""`watermask` layer: frt1-u8 256 x 256, classes { land: 0, water: 255 }, anti-aliased shorelines.

Global level 7, per texel:
  f_h  = fraction of 4 x 4 sub-samples of the texel where the bilinear height surface of the baked level-7
         height tile is below sea level (the elevation sign, exactly the surface the height authority uses);
  f_m  = fraction of 4 x 4 sub-samples that the independent MODIS MOD44W 250 m water mask calls water.
  default                          mask = f_h
  land below sea level             mask = f_m   where f_h > 0, f_m < 0.5 and MODIS water is more than
                                                CORRECT_TEXELS away (Qattara, Death Valley, polders ...)
  inland water above sea level     mask = max(f_h, f_m)  where f_m >= 0.5, f_h < 0.5 and the sea (f_h >= 0.5)
                                                is more than CORRECT_TEXELS away (lakes, wide rivers)
Coastlines therefore follow the height sign (what physics calls water); the independent source only adds
inland water and removes dry depressions. Levels 6..0 are 2 x 2 means of the level below.
Regional levels: regmask.py.
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

from common import cube
from earth import hpyramid, manifest, paths, tiles
from earth.util import log, run_units

CORRECT_TEXELS = 2
PAD = 8
SUB = 4
L3_DIR = paths.WORK / "watermask-l3"
SOURCES_GLOBAL = ["Sign of the baked height (ETOPO 2022)",
                  "MODIS MOD44W 250 m water mask via NASA GIBS (MODIS_Water_Mask; public domain): inland water and "
                  "dry depressions"]


def subsample_uv(n: int = 256, sub: int = SUB) -> np.ndarray:
    k = (np.arange(n * sub) + 0.5) / (n * sub)
    return k


def height_fraction(h259: np.ndarray, sub: int = SUB) -> np.ndarray:
    """Fraction of sub x sub bilinear sub-samples per texel below 0 (texel (c, r) spans vertices c..c+1)."""
    g = h259[1:258, 1:258].astype(np.float64)            # 257 x 257 vertices
    f = (np.arange(sub) + 0.5) / sub
    acc = np.zeros((256, 256))
    a00, a10, a01, a11 = g[:-1, :-1], g[:-1, 1:], g[1:, :-1], g[1:, 1:]
    for fy in f:
        for fx in f:
            v = (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy
            acc += v < 0.0
    return acc / (sub * sub)


def level7_mask(face: int, x: int, y: int, cache: hpyramid.TileCache, modis) -> np.ndarray:
    h = cache.get(face, x, y)
    f_h = height_fraction(h)
    # MODIS sub-samples
    k = (np.arange(256 * SUB) + 0.5) / (256 * SUB)
    uu, vv = np.meshgrid(k, k)
    d = cube.tile_uv_to_dir(face, 7, x, y, uu, vv).reshape(-1, 3)
    lat, lon = tiles.dirs_latlon(d)
    f_m = modis.water(lat, lon).reshape(256, SUB, 256, SUB).mean(axis=(1, 3))
    # padded texel-centre grid for distances
    kp = (np.arange(-PAD, 256 + PAD) + 0.5) / 256
    up, vp = np.meshgrid(kp, kp)
    dp = cube.tile_uv_to_dir(face, 7, x, y, up, vp).reshape(-1, 3)
    hp = hpyramid.bilinear_from_tiles(dp, cache).reshape(up.shape)
    la, lo = tiles.dirs_latlon(dp)
    mp = modis.water(la, lo).reshape(up.shape).astype(np.float64)
    sea = hp < 0.0
    sea[PAD:-PAD, PAD:-PAD] = f_h >= 0.5
    mw = mp >= 0.5
    mw[PAD:-PAD, PAD:-PAD] = f_m >= 0.5
    d_mw = ndimage.distance_transform_edt(~mw)[PAD:-PAD, PAD:-PAD] if mw.any() else np.full((256, 256), np.inf)
    d_sea = ndimage.distance_transform_edt(~sea)[PAD:-PAD, PAD:-PAD] if sea.any() else np.full((256, 256), np.inf)
    mask = f_h.copy()
    dry = (f_h > 0.0) & (f_m < 0.5) & (d_mw > CORRECT_TEXELS)
    mask[dry] = f_m[dry]
    lake = (f_m >= 0.5) & (f_h < 0.5) & (d_sea > CORRECT_TEXELS)
    mask[lake] = np.maximum(f_h[lake], f_m[lake])
    return mask


def to_u8(m: np.ndarray) -> np.ndarray:
    return np.clip(np.floor(m * 255.0 + 0.5), 0, 255).astype(np.uint8)


def _subtree_unit(u: tuple[int, int, int]) -> int:
    from earth.gibs import WaterMask
    face, x3, y3 = u
    cache = hpyramid.TileCache(7, tiles.read_height)
    modis = WaterMask()
    cur = {}
    n = 0
    for dx in range(16):
        for dy in range(16):
            x, y = x3 * 16 + dx, y3 * 16 + dy
            m = level7_mask(face, x, y, cache, modis)
            n += tiles.write_u8("watermask", face, 7, x, y, to_u8(m))
            cur[(x, y)] = m
            cache.trim(300)
    for level in range(6, 2, -1):
        k = 2 ** (level - 3)
        nxt = {}
        for dx in range(k):
            for dy in range(k):
                x, y = x3 * k + dx, y3 * k + dy
                t = tiles.box2(tiles.assemble_children([cur[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]))
                n += tiles.write_u8("watermask", face, level, x, y, to_u8(t))
                nxt[(x, y)] = t
        cur = nxt
    L3_DIR.mkdir(parents=True, exist_ok=True)
    np.save(L3_DIR / f"{face}-{x3}-{y3}.npy", cur[(x3, y3)].astype(np.float32))
    return n


def _top_levels() -> None:
    for face in range(6):
        cur = {(x, y): np.load(L3_DIR / f"{face}-{x}-{y}.npy").astype(np.float64) for x in range(8) for y in range(8)}
        for level in (2, 1, 0):
            k = 2 ** level
            nxt = {}
            for x in range(k):
                for y in range(k):
                    t = tiles.box2(tiles.assemble_children([cur[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]))
                    tiles.write_u8("watermask", face, level, x, y, to_u8(t))
                    nxt[(x, y)] = t
            cur = nxt


def bake_global() -> None:
    from earth import gibs
    cfg = {"v": 2, "correct": CORRECT_TEXELS, "sub": SUB}
    if manifest.is_marked("watermask", "global") and (paths.STATE / "watermask-global.cfg").is_file() \
            and (paths.STATE / "watermask-global.cfg").read_text(encoding="utf-8") == str(cfg):
        log("watermask: global levels already baked")
        return
    gibs.fetch_all()
    units = [(f, x, y) for f in range(6) for x in range(8) for y in range(8)]
    run_units("watermask-global", _subtree_unit, units, key=lambda u: "%d-%d-%d" % u, config=cfg)
    _top_levels()
    (paths.STATE / "watermask-global.cfg").write_text(str(cfg), encoding="utf-8")
    manifest.mark("watermask", "global")


def bake_region(region_id: str) -> None:
    from earth import regmask
    regmask.bake(region_id)


def layer_manifest(regions: list[dict]) -> dict:
    from earth import region as regmod
    coverage: dict[str, list] = {}
    sources = list(SOURCES_GLOBAL)
    for reg in regions:
        for L in regmod.levels(reg):
            coverage.setdefault(str(L), []).extend(regmod.coverage_rects(reg, L))
        s = "ESA WorldCover 2021 v200 permanent water (CC BY 4.0) and the regional 3DEP height sign"
        if s not in sources:
            sources.append(s)
    return {"encoding": "frt1-u8", "ext": "u8", "globalMaxLevel": paths.GLOBAL_MAX_LEVEL, "coverage": coverage,
            "classes": {"land": 0, "water": 255}, "sources": sources}
