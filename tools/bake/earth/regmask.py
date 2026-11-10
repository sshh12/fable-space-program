"""Regional `watermask` levels: the coastline of the regional height (USGS 3DEP via Terrarium) with ESA
WorldCover 2021 water for inland water and dry ground below sea level, then the 64-texel coverage feather.

Base mask per tile (fine to coarse):
  - finest level, and coarser tiles not wholly covered by the next finer level: 4 x 4 sub-sample fraction of
    the stored height tile of the same key below sea level (watermask.height_fraction), corrected with
    WorldCover exactly like the global layer corrects with MODIS (lakes, dry depressions; 2 texels from the
    other source's water/sea);
  - other coarser tiles: 2 x 2 means of the finer base masks.
Stored tiles (coarse to fine): base, feathered into the stored parent over the outer 64 texels.
"""
from __future__ import annotations

import io

import numpy as np
from scipy import ndimage

from common import cube
from earth import manifest, paths, region as regmod, regional, tiles
from earth.regsrc import land_bbox
from earth.util import run_units
from earth.watermask import CORRECT_TEXELS, SUB, height_fraction, to_u8
from earth.worldcover import WATER, WorldCoverGrid

BASE_DIR = paths.WORK / "regmask-base"


_WC: dict = {}


def worldcover(region: dict) -> WorldCoverGrid:
    k = region["id"]
    if k not in _WC:
        _WC[k] = WorldCoverGrid(*land_bbox(region))
    return _WC[k]


def wc_fraction(wc: WorldCoverGrid, face: int, level: int, x: int, y: int, pad: int, sub: int):
    """WorldCover water fraction on sub x sub sub-samples per texel over a grid padded by `pad` texels;
    also whether WorldCover has data there (class != 0)."""
    n = 256 + 2 * pad
    k = (np.arange(n * sub) + 0.5) / (256 * sub) - pad / 256.0
    uu, vv = np.meshgrid(k, k)
    d = cube.tile_uv_to_dir(face, level, x, y, uu, vv).reshape(-1, 3)
    lat, lon = tiles.dirs_latlon(d)
    c = wc.nearest(lat, lon).reshape(n, sub, n, sub)
    return (c == WATER).mean(axis=(1, 3)), (c != 0).mean(axis=(1, 3))


def own_mask(region: dict, face: int, level: int, x: int, y: int) -> np.ndarray:
    """Base mask of one tile from its own height tile + WorldCover corrections."""
    from earth import hpyramid
    pad = 8
    h = tiles.read_height(face, level, x, y)
    f_h = height_fraction(h)
    wc = worldcover(region)
    f_w, has = wc_fraction(wc, face, level, x, y, pad, 2)
    # padded height sign at texel centres (stored tiles of this level, global source outside coverage)
    kp = (np.arange(-pad, 256 + pad) + 0.5) / 256
    up, vp = np.meshgrid(kp, kp)
    dp = cube.tile_uv_to_dir(face, level, x, y, up, vp).reshape(-1, 3)
    cache = hpyramid.TileCache(level, tiles.read_height)
    hp = hpyramid.bilinear_from_tiles(dp, cache, fallback=lambda p: _fallback_height(p)).reshape(up.shape)
    sea = hp < 0.0
    sea[pad:-pad, pad:-pad] = f_h >= 0.5
    ww = (f_w >= 0.5) & (has > 0.5)
    d_ww = ndimage.distance_transform_edt(~ww)[pad:-pad, pad:-pad] if ww.any() else np.full((256, 256), np.inf)
    d_sea = ndimage.distance_transform_edt(~sea)[pad:-pad, pad:-pad] if sea.any() else np.full((256, 256), np.inf)
    fw = f_w[pad:-pad, pad:-pad]
    hs = has[pad:-pad, pad:-pad] > 0.5
    mask = f_h.copy()
    dry = hs & (f_h > 0.0) & (fw < 0.5) & (d_ww > CORRECT_TEXELS)
    mask[dry] = fw[dry]
    lake = hs & (fw >= 0.5) & (f_h < 0.5) & (d_sea > CORRECT_TEXELS)
    mask[lake] = np.maximum(f_h[lake], fw[lake])
    return mask


_FALLBACK = {}


def _fallback_height(p: np.ndarray) -> np.ndarray:
    """Global level-7 surface for stencil points outside the regional coverage."""
    from earth import hpyramid
    c = _FALLBACK.get("c")
    if c is None:
        c = _FALLBACK["c"] = hpyramid.TileCache(7, tiles.read_height)
    return hpyramid.bilinear_from_tiles(p, c)


def base_path(region_id: str, face: int, level: int, x: int, y: int):
    return BASE_DIR / region_id / f"{face}-{level}-{x}-{y}.npz"


def load_base(region_id, face, level, x, y) -> np.ndarray:
    return np.load(base_path(region_id, face, level, x, y))["m"].astype(np.float64) / 255.0


def _base_unit(u: tuple) -> int:
    region_id, level, tl = u
    reg = regmod.load(region_id)
    finer = regmod.coverage_rects(reg, level + 1) if str(level + 1) in reg["levels"] else []

    def inside(f, xx, yy):
        return any(r["face"] == f and r["x0"] <= xx <= r["x1"] and r["y0"] <= yy <= r["y1"] for r in finer)

    for face, x, y in tl:
        ch = tiles.children(face, level, x, y)
        if finer and all(inside(f, cx, cy) for f, _, cx, cy in ch):
            m = tiles.box2(tiles.assemble_children([load_base(region_id, f, level + 1, cx, cy) for f, _, cx, cy in ch]))
        else:
            m = own_mask(reg, face, level, x, y)
        p = base_path(region_id, face, level, x, y)
        p.parent.mkdir(parents=True, exist_ok=True)
        buf = io.BytesIO()
        np.savez_compressed(buf, m=to_u8(m))
        p.write_bytes(buf.getvalue())
    return len(tl)


def _write_unit(u: tuple) -> int:
    region_id, level, tl = u
    reg = regmod.load(region_id)
    rects = regmod.coverage_rects(reg, level)
    n = 0
    for face, x, y in tl:
        m = load_base(region_id, face, level, x, y) * 255.0
        d = regional.boundary_distance(rects, face, level, x, y)
        if d.min() < regional.FEATHER_TEXELS:
            w = regional.feather_weight(d)
            par = regional.parent_upsample("watermask", face, level, x, y,
                                           lambda f_, l_, x_, y_: tiles.read_u8("watermask", f_, l_, x_, y_)[..., None].astype(np.float64))[..., 0]
            m = w * m + (1.0 - w) * par
        n += tiles.write_u8("watermask", face, level, x, y, np.clip(np.floor(m + 0.5), 0, 255).astype(np.uint8))
    return n


def bake(region_id: str) -> None:
    reg = regmod.load(region_id)
    for layer, scope in (("watermask", "global"), ("height", region_id)):
        if not manifest.is_marked(layer, scope):
            raise RuntimeError(f"regional watermask needs the {layer} layer ({scope}) baked first")
    worldcover(reg)
    cfg = {"v": 2, "region": reg, "correct": CORRECT_TEXELS, "sub": SUB}
    lv = regmod.levels(reg)
    for level in reversed(lv):
        tl = regional.level_tiles(reg, level)
        units = [(region_id, level, tuple(tl[i:i + 64])) for i in range(0, len(tl), 64)]
        run_units(f"watermask-base-{region_id}-l{level}", _base_unit, units,
                  key=lambda u: f"{u[2][0][1]}-{u[2][0][2]}-{len(u[2])}", config=cfg)
    for level in lv:
        tl = regional.level_tiles(reg, level)
        units = [(region_id, level, tuple(tl[i:i + 64])) for i in range(0, len(tl), 64)]
        run_units(f"watermask-{region_id}-l{level}", _write_unit, units,
                  key=lambda u: f"{u[2][0][1]}-{u[2][0][2]}-{len(u[2])}", config=cfg)
    manifest.mark("watermask", region_id)
