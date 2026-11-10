"""`height` layer: global levels 0-7 from ETOPO 2022 15", regional levels from the region's source.

Level 7 samples ETOPO (Catmull-Rom, longitude-prefiltered near the poles) at every vertex direction; levels
6..0 are full-weighting area averages of the stored level below (hpyramid). A region's finest level is the
tent average of its regional source (regsrc) at twice its resolution; its coarser regional levels are area
averages of the stored level below, falling back to the global source outside that level's coverage (where
the regional source already equals the global one).
"""
from __future__ import annotations

import numpy as np

from common import cube
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
            n += tiles.write_height(face, level, x, y, hpyramid.tent_of_function(face, level, x, y, fn), scale)
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
        h = hpyramid.downsample_tile(face, level, x, y, cache, fallback)
        n += tiles.write_height(face, level, x, y, h, scale)
    return n


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
        plan.append((level, len(tl), units, {"v": 4, "region": reg, "level": level,
                                             "rampSmoothM": regsrc.RAMP_SMOOTH_M}))
    from earth import manifest
    if all(units_done(f"height-{region_id}-l{level}", units, key, cfg) for level, _, units, cfg in plan):
        log(f"height {region_id}: every level already baked")
        manifest.mark("height", region_id)
        return
    # build (and cache) the regional source once in the parent so workers only memory-map it
    _regional_height(region_id).prepare()
    for level, n_tiles, units, cfg in plan:
        log(f"height {region_id} level {level}: {n_tiles} tiles")
        run_units(f"height-{region_id}-l{level}", _reg_unit, units, key=key, config=cfg)
    manifest.mark("height", region_id)


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
            source_coverage.setdefault(str(L), []).extend(regmod.source_rects(reg, L))
        s = ("AWS Terrain Tiles (Terrarium; USGS 3DEP 10 m in Hawai'i), attribution: "
             "https://github.com/tilezen/joerd/blob/master/docs/attribution.md")
        if s not in sources:
            sources.append(s)
    # sourceCoverage (docs/requests/terrain-core-1.md, optional, additive): the rectangles of tiles that touch
    # each region's area of interest, where the regional source has full weight. Outside them, in the feather
    # and margin ring of the coverage, the regional levels hold data that converges on the parent's.
    return {"encoding": "frt1-height", "ext": "hgt", "globalMaxLevel": paths.GLOBAL_MAX_LEVEL,
            "coverage": coverage, "sourceCoverage": source_coverage, "heightScales": scales, "sources": sources}
