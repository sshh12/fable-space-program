"""Regional `watermask` levels: the coastline of the regional height (USGS 3DEP via Terrarium, the sea floor on
the WorldCover coastline of the ocean) plus ESA WorldCover 2021 inland water, then the 64-texel coverage feather.

Base mask per tile (fine to coarse):
  - finest level, and coarser tiles not wholly covered by the next finer level: 4 x 4 sub-sample fraction of
    the stored height tile of the same key below sea level (watermask.height_fraction), corrected with
    WorldCover:
      inland water   WorldCover water that is NOT the ocean (regsrc.RegionalHeight.inland_water: not connected
                     to the open sea), where the height is above sea level: mask = max(f_h, f_inland). Lakes,
                     ponds and reservoirs at any altitude (the regional height keeps their surface).
      dry ground     WorldCover land where the height is below sea level and WorldCover water is more than
                     CORRECT_TEXELS away: mask = f_wc, but only where the global level-7 mask (which decides
                     ocean connectivity, watermask.py) is land too; otherwise the height sign stands.
    Everywhere else the mask IS the height sign, so mask and height share their coastline (inside the area of
    interest the regional height's sign is the WorldCover ocean by construction).
  - other coarser tiles: 2 x 2 means of the finer base masks.
Stored tiles (coarse to fine): base, feathered into the stored parent over the outer 64 texels.
The configuration records the build hashes of the regional height layer and of the global water mask, so the
mask is re-baked whenever either was re-baked.
"""
from __future__ import annotations

import io

import numpy as np
from scipy import ndimage

from common import cube
from earth import manifest, paths, region as regmod, regional, regsrc, tiles, worldcover as wcmod
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


def _rh(region: dict):
    from earth.heights import _regional_height
    return _regional_height(region["id"])


def wc_fractions(region: dict, face: int, level: int, x: int, y: int, pad: int, sub: int):
    """Per texel over a grid padded by `pad` texels, from sub x sub sub-samples: WorldCover water fraction,
    inland-water fraction (water that is not the ocean), and data fraction (class != 0)."""
    n = 256 + 2 * pad
    k = (np.arange(n * sub) + 0.5) / (256 * sub) - pad / 256.0
    uu, vv = np.meshgrid(k, k)
    d = cube.tile_uv_to_dir(face, level, x, y, uu, vv).reshape(-1, 3)
    lat, lon = tiles.dirs_latlon(d)
    c = worldcover(region).nearest(lat, lon)
    water = c == WATER
    inland = np.zeros_like(water)
    if water.any():
        inland[water] = _rh(region).inland_water(lat[water], lon[water])

    def frac(a):
        return a.reshape(n, sub, n, sub).mean(axis=(1, 3))
    return frac(water), frac(inland), frac(c != 0)


def own_mask(region: dict, face: int, level: int, x: int, y: int) -> np.ndarray:
    """Base mask of one tile from its own height tile + WorldCover corrections."""
    pad = 8
    h = tiles.read_height(face, level, x, y)
    f_h = height_fraction(h)
    f_w, f_i, has = wc_fractions(region, face, level, x, y, pad, 2)
    ww = (f_w >= 0.5) & (has > 0.5)
    d_ww = ndimage.distance_transform_edt(~ww)[pad:-pad, pad:-pad] if ww.any() else np.full((256, 256), np.inf)
    inner = (slice(pad, -pad), slice(pad, -pad))
    fw, fi, hs = f_w[inner], f_i[inner], has[inner] > 0.5
    mask = f_h.copy()
    lake = hs & (fi >= 0.5) & (f_h < 0.5)
    mask[lake] = np.maximum(f_h[lake], fi[lake])
    dry = hs & (f_h > 0.0) & (fw < 0.5) & (d_ww > CORRECT_TEXELS)
    if dry.any():
        g7 = regional.parent_upsample("watermask", face, level, x, y,
                                      lambda f_, l_, x_, y_: tiles.read_u8("watermask", f_, l_, x_, y_)[..., None]
                                      .astype(np.float64), ancestor=paths.GLOBAL_MAX_LEVEL)[..., 0]
        dry &= g7 < 127.5
        mask[dry] = fw[dry]
    return mask


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
    cfg = {"v": 3, "region": reg, "correct": CORRECT_TEXELS, "sub": SUB,
           "inputs": {"height": manifest.build_hash("height", region_id),
                      "watermaskGlobal": manifest.build_hash("watermask", "global")},
           "worldcover": wcmod.URL, "coastGrid": regsrc.GRID_VERSION}
    lv = regmod.levels(reg)
    from earth.util import unit_mode, units_done

    def _plan(prefix):
        return [(f"{prefix}-{region_id}-l{level}", [(region_id, level, tuple(tl[i:i + 64])) for tl in
                 [regional.level_tiles(reg, level)] for i in range(0, len(tl), 64)]) for level in lv]
    k = lambda u: f"{u[2][0][1]}-{u[2][0][2]}-{len(u[2])}"   # noqa: E731
    done = all(units_done(n, us, k, cfg) for prefix in ("watermask-base", "watermask") for n, us in _plan(prefix))
    if not done and unit_mode() is None:     # the sources only when a unit will run (lead-4)
        worldcover(reg)
        _rh(reg)                     # builds the coast grid here (if needed), so workers only memory-map it
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
