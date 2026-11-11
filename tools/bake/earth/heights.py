"""`height` layer: global levels 0-7 from ETOPO 2022 15", regional levels from the region's source.

Level 7 samples ETOPO (Catmull-Rom, longitude-prefiltered near the poles) at every vertex direction; levels
6..0 are full-weighting area averages of the stored level below (hpyramid). A region's finest level is the
tent average of its regional source (regsrc) at twice its resolution; its coarser regional levels are area
averages of the stored level below, falling back to the global source outside that level's coverage (where
the regional source already equals the global one). A regional vertex never quantises to exactly 0 m: values
that would round to 0 are stored as +/- one quantum with their own sign (keep_sign), so the sign of every
stored vertex is unambiguous for physics (water = below sea level, ARCHITECTURE row 12) and for the water mask.
Every regional level also has its closed sea-level pockets below the grid's resolution filled (fill_pits).
"""
from __future__ import annotations

import numpy as np

from common import cube
from common import frt1
from earth import etopo, hpyramid, paths, region as regmod, regsrc, sample, tiles
from earth.util import log, run_units, units_done

GLOBAL_SCALE = 0.5
L7_BLOCK = 16
PYR_BLOCK = 8
SOURCES_GLOBAL = ["NOAA NCEI ETOPO 2022 15 arc-second surface elevation (public domain), DOI 10.25921/fd45-gt74"]


# -- global ------------------------------------------------------------------------------------------------
def _l7_unit(u: tuple[int, int, int]) -> int:
    face, bx, by = u
    mm = etopo.open_memmap()
    n = 0
    for x in range(bx * L7_BLOCK, (bx + 1) * L7_BLOCK):
        for y in range(by * L7_BLOCK, (by + 1) * L7_BLOCK):
            d = cube.height_tile_dirs(face, 7, x, y).reshape(-1, 3)
            lat, lon = tiles.dirs_latlon(d)
            cx = (lon + 180.0) * etopo.CELLS_PER_DEG - 0.5
            cy = (90.0 - lat) * etopo.CELLS_PER_DEG - 0.5
            h = sample.bicubic(mm, cx, cy, True, etopo.UNIT).reshape(259, 259)
            n += tiles.write_height(face, 7, x, y, h, GLOBAL_SCALE)
    return n


def _pyr_unit(u: tuple[int, int, int, int]) -> int:
    level, face, bx, by = u
    cache = hpyramid.TileCache(level + 1, tiles.read_height)
    nt = 2 ** level
    n = 0
    for x in range(bx * PYR_BLOCK, min(nt, (bx + 1) * PYR_BLOCK)):
        for y in range(by * PYR_BLOCK, min(nt, (by + 1) * PYR_BLOCK)):
            h = hpyramid.downsample_tile(face, level, x, y, cache)
            n += tiles.write_height(face, level, x, y, h, GLOBAL_SCALE)
            cache.trim()
    return n


GLOBAL_CFG = {"v": 2, "scale": GLOBAL_SCALE, "src": "etopo2022-15s", "prefilter": etopo.LON_PREFILTER_RATIO}


def bake_global() -> None:
    from earth import gibs, manifest, refs
    if manifest.is_marked("height", "global") and \
            manifest.marker("height", "global").read_text(encoding="utf-8") == str(GLOBAL_CFG):
        log("height: global levels already baked")
        return
    units = [(f, bx, by) for f in range(6) for bx in range(128 // L7_BLOCK) for by in range(128 // L7_BLOCK)]
    key = lambda u: "%d-%d-%d" % u   # noqa: E731
    need_source = (not units_done("height-l7", units, key, GLOBAL_CFG) or not (paths.REFS / "height-etopo.json").is_file()
                   or not gibs.LISTING.is_file())
    if need_source:
        if not etopo.memmap_ready():
            etopo.build_memmap()
        refs.height_refs()
        run_units("height-l7", _l7_unit, units, key=key, config=GLOBAL_CFG)
        gibs.fetch_list()
        # everything that needs the 7.5 GB ETOPO memmap is derived now: free the disk before the pyramid
        etopo.delete_memmap()
    for level in range(6, -1, -1):
        nb = max(1, (2 ** level + PYR_BLOCK - 1) // PYR_BLOCK)
        units = [(level, f, bx, by) for f in range(6) for bx in range(nb) for by in range(nb)]
        run_units(f"height-l{level}", _pyr_unit, units, key=lambda u: "%d-%d-%d-%d" % u,
                  config=dict(GLOBAL_CFG, child="full-weighting-v2"))
    manifest.mark("height", "global", str(GLOBAL_CFG))


# -- regional ----------------------------------------------------------------------------------------------
_RH = {}


def _regional_height(region_id: str):
    if region_id not in _RH:
        from earth.regsrc import RegionalHeight
        _RH[region_id] = RegionalHeight(regmod.load(region_id), slack_km=0.0)
    return _RH[region_id]


def keep_sign(h: np.ndarray, preferred_scale: float) -> np.ndarray:
    """h with every value that would quantise to exactly 0 m (at the scale the encoder will choose) replaced by
    one quantum of the same sign; an exact 0 (an average of land and sea in equal parts) becomes +1 quantum
    (a pure function of the value, so shared tile edges stay identical)."""
    out = np.asarray(h, np.float64).copy()
    for _ in range(4):
        q = frt1.choose_height_scale(float(out.min()), float(out.max()), preferred_scale)
        zero = np.floor(out / q + 0.5) == 0.0
        neg, pos = zero & (h < 0.0), zero & (h >= 0.0)
        if not (neg.any() or pos.any()):
            return out
        out[neg] = -q
        out[pos] = q
    raise ValueError("keep_sign: quantisation did not settle")


PIT_MAX_VERTICES = 16      # fill_pits: closed low areas up to this size are below the grid's resolution
PIT_RIM_M = 10.0


def fill_pits(h: np.ndarray) -> tuple[np.ndarray, int]:
    """Fill the closed sea-level pockets of a regional tile that its vertex grid cannot resolve: 4-connected
    areas at or below 0.5 m of at most PIT_MAX_VERTICES vertices, without sea floor (nothing below -2 m), under
    a rim more than PIT_RIM_M high (median of the 3-vertex ring), are raised to the lowest vertex of their
    1-vertex ring (the spill level). They are WorldCover water joined to the sea through gaps narrower than a
    vertex spacing, on the cliffed lava coasts, where the tent average closes the gap. Only areas whose
    vertices all lie in [3, 255] are touched, so neither the shared edges nor the neighbours' border samples
    change (seams stay identical). Returns (h, number of areas filled)."""
    from scipy import ndimage
    low = h <= 0.5
    if not low.any():
        return h, 0
    lab, n = ndimage.label(low)          # 4-connected: a diagonal of two low vertices is a saddle, not a channel
    if n == 0:
        return h, 0
    out = h.copy()
    filled = 0
    sizes = np.bincount(lab.ravel(), minlength=n + 1)
    for L in np.nonzero((sizes > 0) & (sizes <= PIT_MAX_VERTICES))[0]:
        if L == 0:
            continue
        jj, ii = np.nonzero(lab == L)
        if jj.min() < 3 or jj.max() > 255 or ii.min() < 3 or ii.max() > 255:
            continue
        sl = (slice(jj.min() - 3, jj.max() + 4), slice(ii.min() - 3, ii.max() + 4))
        comp = lab[sl] == L
        if h[sl][comp].min() < -2.0:
            continue
        ring3 = ndimage.binary_dilation(comp, iterations=3) & ~comp
        if float(np.median(h[sl][ring3])) <= PIT_RIM_M:
            continue
        ring1 = ndimage.binary_dilation(comp) & ~comp            # its 4-neighbours: all above 0.5 m
        out[sl][comp] = float(h[sl][ring1].min())
        filled += 1
    return out, filled


def _points_latlon(p: np.ndarray):
    lat, lon = cube.dir_to_lat_lon(p)
    return np.degrees(lat), np.degrees(lon)


def _reg_unit(u: tuple) -> int:
    region_id, level, finest, scale, tl = u
    reg = regmod.load(region_id)
    rh = _regional_height(region_id)
    n = 0
    if level == finest:
        def fn(p):
            la, lo = _points_latlon(p)
            return rh.height(la, lo)
        for face, x, y in tl:
            h, _ = fill_pits(hpyramid.tent_of_function(face, level, x, y, fn))
            n += tiles.write_height(face, level, x, y, keep_sign(h, scale), scale)
        return n
    child_rects = regmod.coverage_rects(reg, level + 1)

    def loader(f, L, x, y):
        for r in child_rects:
            if r["face"] == f and r["x0"] <= x <= r["x1"] and r["y0"] <= y <= r["y1"]:
                t = tiles.read_height(f, L, x, y)
                if t is None:
                    raise FileNotFoundError(f"regional height tile {f}/{L}/{x}/{y} missing")
                return t
        return None

    def fallback(p):
        la, lo = _points_latlon(p)
        return rh.global_height(la, lo)

    cache = hpyramid.TileCache(level + 1, loader)
    for face, x, y in tl:
        h = keep_sign(fill_pits(hpyramid.downsample_tile(face, level, x, y, cache, fallback))[0], scale)
        n += tiles.write_height(face, level, x, y, h, scale)
    return n


def _edge_pit_unit(u: tuple) -> int:
    """fill_pits for the pockets fill_pits cannot see inside one tile (vertices within 3 of a tile edge): on
    3 x 3 tile mosaics of the stored level, the same criteria; a filled vertex is written to EVERY tile that
    stores it (shared edges and border rings), so seams stay identical. Runs in one process (it rewrites
    neighbouring tiles)."""
    from scipy import ndimage
    region_id, level, scale = u
    reg = regmod.load(region_id)
    rects = regmod.coverage_rects(reg, level)
    have = set(regmod.rect_tiles(rects))
    cache: dict = {}

    def get(f, x, y):
        k = (f, x, y)
        if k not in cache:
            cache[k] = tiles.read_height(f, level, x, y).astype(np.float64) if k in have else None
        return cache[k]
    changes: dict = {}                       # (face, gy, gx) global vertex -> value
    for f, x, y in sorted(have):
        h = get(f, x, y)[1:258, 1:258]
        zone = np.zeros((257, 257), bool)
        zone[:3, :] = zone[-3:, :] = zone[:, :3] = zone[:, -3:] = True
        if not (zone & (h <= 0.5)).any():
            continue
        mos = np.full((769, 769), np.nan)
        for i in range(3):
            for j in range(3):
                t = get(f, x - 1 + i, y - 1 + j)
                if t is not None:
                    mos[j * 256:j * 256 + 257, i * 256:i * 256 + 257] = t[1:258, 1:258]
        low = np.nan_to_num(mos, nan=1e9) <= 0.5
        lab, n = ndimage.label(low)
        bad = np.zeros_like(low)
        bad[0, :] = bad[-1, :] = bad[:, 0] = bad[:, -1] = True
        bad |= ndimage.binary_dilation(np.isnan(mos))
        skip = set(np.unique(lab[bad & low]))
        cz = np.zeros_like(low)
        cz[256:513, 256:513] = zone
        for L in np.unique(lab[cz & low]):
            if L == 0 or L in skip:
                continue
            comp = lab == L
            if comp.sum() > PIT_MAX_VERTICES or mos[comp].min() < -2.0:
                continue
            ring3 = ndimage.binary_dilation(comp, iterations=3) & ~comp & ~np.isnan(mos)
            if float(np.median(mos[ring3])) <= PIT_RIM_M:
                continue
            ring1 = ndimage.binary_dilation(comp) & ~comp
            v = float(mos[ring1].min())
            for jj, ii in zip(*np.nonzero(comp)):
                changes[(f, (y - 1) * 256 + int(jj), (x - 1) * 256 + int(ii))] = v
        if len(cache) > 2000:
            cache.clear()
    by_tile: dict = {}
    for (f, gy, gx), v in changes.items():
        for ty in range((gy + 1) // 256 - 1, (gy + 1) // 256 + 1):
            for tx in range((gx + 1) // 256 - 1, (gx + 1) // 256 + 1):
                jy, ix = gy - ty * 256 + 1, gx - tx * 256 + 1          # index in the 259 grid
                if (f, tx, ty) in have and 0 <= jy <= 258 and 0 <= ix <= 258:
                    by_tile.setdefault((f, tx, ty), []).append((jy, ix, v))
    for (f, x, y), lst in by_tile.items():
        h = tiles.read_height(f, level, x, y).astype(np.float64)
        for jy, ix, v in lst:
            h[jy, ix] = v
        tiles.write_height(f, level, x, y, h, scale)
    log(f"height {region_id} level {level}: {len(changes)} vertices of tile-edge pockets filled in {len(by_tile)} tiles")
    return len(changes)


def bake_region(region_id: str) -> None:
    reg = regmod.load(region_id)
    lv = regmod.levels(reg)
    finest = lv[-1]

    def key(u):
        return f"{u[4][0][0]}-{u[4][0][1]}-{u[4][0][2]}-{len(u[4])}"

    plan = []
    for level in reversed(lv):
        tl = regmod.rect_tiles(regmod.coverage_rects(reg, level))
        scale = float(reg["levels"][str(level)]["heightScale"])
        chunks = [tl[i:i + 64] for i in range(0, len(tl), 64)]
        units = [(region_id, level, finest, scale, tuple(c)) for c in chunks]
        plan.append((level, len(tl), units, {"v": 5, "region": reg, "level": level, "grid": regsrc.GRID_VERSION,
                                             "rampSmoothM": regsrc.RAMP_SMOOTH_M, "nearSmoothM": regsrc.NEAR_SMOOTH_M,
                                             "softM": regsrc.SOFT_M, "inlandMaxDevM": regsrc.INLAND_MAX_DEV_M, "openPx": regsrc.OPEN_PX, "fillPits": [PIT_MAX_VERTICES, PIT_RIM_M, "every level", 4, "spill4"],
                                             "minLandM": regsrc.MIN_LAND_M, "minSeaM": regsrc.MIN_SEA_M,
                                             "keepSign": True}))
    from earth import manifest

    def pit_unit(level, cfg):
        return [(region_id, level, float(reg["levels"][str(level)]["heightScale"]))]
    if all(units_done(f"height-{region_id}-l{level}", units, key, cfg)
           and units_done(f"height-{region_id}-l{level}-pits", pit_unit(level, cfg), lambda u: "edge", cfg)
           for level, _, units, cfg in plan):
        log(f"height {region_id}: every level already baked")
        manifest.mark("height", region_id)
        return
    # build (and cache) the regional source once in the parent so workers only memory-map it
    _regional_height(region_id).prepare()
    for level, n_tiles, units, cfg in plan:
        log(f"height {region_id} level {level}: {n_tiles} tiles")
        run_units(f"height-{region_id}-l{level}", _reg_unit, units, key=key, config=cfg)
        run_units(f"height-{region_id}-l{level}-pits", _edge_pit_unit, pit_unit(level, cfg), key=lambda u: "edge",
                  config=cfg, workers=1)
    manifest.mark("height", region_id)


def source_land_tiles(region: dict, level: int) -> list[tuple[int, int, int]]:
    """Tiles of a regional level that touch the area where the regional source has weight and hold land (a
    stored interior vertex above sea level: 3DEP; every regional land vertex is at least one quantum above 0)."""
    out = []
    for f, x, y in regmod.source_tiles(region, level):
        h = tiles.read_height(f, level, x, y)
        if h is None:
            raise FileNotFoundError(f"regional height tile {f}/{level}/{x}/{y} missing")
        if (h[1:258, 1:258] > 0.0).any():
            out.append((f, x, y))
    return out


def layer_manifest(regions: list[dict]) -> dict:
    max_level = max([paths.GLOBAL_MAX_LEVEL] + [regmod.levels(r)[-1] for r in regions])
    scales = []
    for L in range(max_level + 1):
        vals = [float(r["levels"][str(L)]["heightScale"]) for r in regions if str(L) in r["levels"]]
        scales.append(min(vals) if (vals and L > paths.GLOBAL_MAX_LEVEL) else GLOBAL_SCALE)
    coverage: dict[str, list] = {}
    source_coverage: dict[str, list] = {}
    sources = list(SOURCES_GLOBAL)
    for reg in regions:
        for L in regmod.levels(reg):
            coverage.setdefault(str(L), []).extend(regmod.coverage_rects(reg, L))
            source_coverage.setdefault(str(L), []).extend(regmod.tile_set_rects(source_land_tiles(reg, L)))
        s = ("AWS Terrain Tiles (Terrarium; USGS 3DEP 10 m in Hawai'i), attribution: "
             "https://github.com/tilezen/joerd/blob/master/docs/attribution.md")
        if s not in sources:
            sources.append(s)
    # sourceCoverage (docs/requests/terrain-core-1.md and -4.md, optional, additive): the rectangles of the
    # tiles where a regional level holds data genuinely finer than its parent: tiles that touch the area where
    # the regional source has non-zero weight AND hold land (3DEP). Sea-only tiles hold the ETOPO 15" sea floor
    # (~900 m shortest wavelength) and stay in `coverage` only.
    return {"encoding": "frt1-height", "ext": "hgt", "globalMaxLevel": paths.GLOBAL_MAX_LEVEL,
            "coverage": coverage, "sourceCoverage": source_coverage, "heightScales": scales, "sources": sources}
