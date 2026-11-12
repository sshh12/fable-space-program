"""`height` layer: global levels 0-7 from ETOPO 2022 15", regional levels from the region's source.

Level 7 samples ETOPO (Catmull-Rom, longitude-prefiltered near the poles) at every vertex direction; levels
6..0 are full-weighting area averages of the stored level below (hpyramid). A region's finest level is the
tent average of its regional source (regsrc) at twice its resolution; its coarser regional levels are area
averages of the stored level below, falling back to the global source outside that level's coverage (where
the regional source already equals the global one). A regional vertex never quantises to exactly 0 m: values
that would round to 0 are stored as +/- one quantum with their own sign (keep_sign), so the sign of every
stored vertex is unambiguous for physics (water = below sea level, ARCHITECTURE row 12) and for the water mask.
Every regional level also has its closed sea-level pockets below the grid's resolution filled (fill_pits).
The finest regional level is despiked before the coarser ones are derived from it (despike): the survey
source has isolated corrupt samples on the shore, hundreds of metres above ground that is a few metres high
(docs/requests/terrain-render-2.md).
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


# -- despike -------------------------------------------------------------------------------------------------
SPIKE_WINDOW = 9           # vertices: the neighbourhood a sample is judged against (86 m at level 12)
SPIKE_EXCESS_M = 30.0      # a land vertex this far above the 75th percentile of its window is a needle
SPIKE_SKIRT_M = 5.0        # the same test, tighter, within SPIKE_SKIRT of a removed needle (the tent average
SPIKE_SKIRT = 2            # of the finest level smears a one-pixel source spike over its neighbours)
SPIKE_SCAN_M = 24.0        # candidate tiles: the test on the tile's own grid with a lower threshold
SPIKE_ROUNDS = 8           # the pass repeats until nothing is flagged (removing a needle lowers the percentile
                           # its neighbours are judged against); real clusters need two rounds
SPIKE_CFG = [SPIKE_WINDOW, SPIKE_EXCESS_M, SPIKE_SKIRT_M, SPIKE_SKIRT, "p75", "land-median-v2", SPIKE_ROUNDS]
# Downward needles (region option `sources.height.despikeBelow`): a land vertex more than SPIKE_EXCESS_M BELOW the
# MEDIAN of its window. The Oman Terrarium tiles carry rows of corrupt values along an SRTM tile boundary (19.0 N,
# 56.8-57.0 E: -3,633 m to +440 m under a 110 m plateau), which the bake's tent average turns into a straight trench
# two or three vertices wide; such a trench fills a third of the window, so the median (not the 25th percentile)
# is the ground it cuts. The foot of a straight cliff keeps fewer than half of its window above it and is not
# flagged.
SPIKE_BELOW_CFG = ["p50", SPIKE_EXCESS_M, SPIKE_SKIRT_M]


def _p75(a: np.ndarray) -> np.ndarray:
    """75th percentile of the SPIKE_WINDOW neighbourhood of every sample (edges: nearest)."""
    from scipy import ndimage
    return ndimage.percentile_filter(a, 75, size=SPIKE_WINDOW, mode="nearest")


def _p50(a: np.ndarray) -> np.ndarray:
    from scipy import ndimage
    return ndimage.median_filter(a, size=SPIKE_WINDOW, mode="nearest")


def region_despikes_below(region: dict) -> bool:
    return bool(region["sources"]["height"].get("despikeBelow", False))


def spike_mask(h: np.ndarray, excess_m: float = SPIKE_EXCESS_M, below: bool = False) -> np.ndarray:
    """Land samples standing more than excess_m above the 75th percentile of their neighbourhood. No natural
    surface does at this posting: on a slope, a cliff edge or a ridge crest at least a quarter of the window
    is as high as the sample; a cone would need flanks steeper than 45 degrees all round. NaN = no data
    (never flagged, and a sample whose window touches it is not judged)."""
    from scipy import ndimage
    nan = np.isnan(h)
    filled = np.where(nan, -1e9, h)
    judged = ~ndimage.binary_dilation(nan, iterations=SPIKE_WINDOW // 2) if nan.any() else np.ones(h.shape, bool)
    out = judged & (filled > 0.0) & (filled - _p75(filled) > excess_m)
    if below:
        out |= judged & (filled > 0.0) & (_p50(filled) - filled > excess_m)
    return out


def despike_field(h: np.ndarray, below: bool = False) -> tuple[np.ndarray, np.ndarray]:
    """(h without needles, mask of the samples changed). A needle is replaced by the median of the land
    samples of its window that are not needles themselves (regsrc.MIN_LAND_M when there are none: it stays
    land, so the coastline and the water mask do not move). A second, tighter pass takes the skirt a removed
    needle leaves on the samples next to it. Both repeat until no sample is flagged, so the result is a fixed
    point: despiking it again changes nothing."""
    from scipy import ndimage
    r = SPIKE_WINDOW // 2
    out = h.copy()
    changed = np.zeros(h.shape, bool)

    def replace(mask: np.ndarray) -> None:
        for j, i in zip(*np.nonzero(mask)):
            win = out[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1]
            ok = ~mask[max(0, j - r):j + r + 1, max(0, i - r):i + r + 1] & ~np.isnan(win) & (win > 0.0)
            out[j, i] = float(np.median(win[ok])) if ok.any() else regsrc.MIN_LAND_M
            changed[j, i] = True

    for _ in range(SPIKE_ROUNDS):
        first = spike_mask(out, below=below)
        if not first.any():
            return out, changed
        replace(first)
        near = ndimage.binary_dilation(first, structure=np.ones((3, 3), bool), iterations=SPIKE_SKIRT) & ~first
        skirt = near & spike_mask(out, SPIKE_SKIRT_M, below=below)
        if skirt.any():
            replace(skirt)
    if spike_mask(out, below=below).any():
        raise ValueError("despike: needles remain after the last round")
    return out, changed


def _despike_scan_unit(u: tuple) -> list:
    """Tiles of a chunk that may hold a needle (the test on the tile's own 259 x 259 grid, lower threshold)."""
    region_id, level, tl = u
    below = region_despikes_below(regmod.load(region_id))
    out = []
    for face, x, y in tl:
        h = tiles.read_height(face, level, x, y).astype(np.float64)
        if float(h.max()) <= SPIKE_SCAN_M:
            continue
        if ((h > 0.0) & (h - _p75(h) > SPIKE_SCAN_M)).any() or                 (below and ((h > 0.0) & (_p50(h) - h > SPIKE_SCAN_M)).any()):
            out.append((face, x, y))
    return out


M_MARGIN = 96              # mosaic cells around the centre tile that the decision for its vertices reads
                           # (a round reaches 10 cells; clusters are a few cells wide)


def despike_level(region_id: str, level: int, scale: float, candidates: list) -> dict:
    """Remove the needles of one stored regional level. Works on 3 x 3 tile mosaics of the candidate tiles and
    their neighbours, so a vertex is judged against its true neighbourhood whichever tile stores it, and
    writes a changed vertex to EVERY tile that stores it (shared edges and border rings): seams stay
    identical. Returns {"vertices", "tiles": [(face, x, y)], "worst": [...], "changed": [(face, gy, gx)]} (global
    vertex indices: tile * 256 + vertex); runs in one process."""
    reg = regmod.load(region_id)
    have = set(regmod.rect_tiles(regmod.coverage_rects(reg, level)))
    todo = set()
    for f, x, y in candidates:
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if (f, x + dx, y + dy) in have:
                    todo.add((f, x + dx, y + dy))
    cache: dict = {}

    def get(f, x, y):
        k = (f, x, y)
        if k not in cache:
            cache[k] = tiles.read_height(f, level, x, y).astype(np.float64) if k in have else None
        return cache[k]

    changes: dict = {}                       # (face, gy, gx) global vertex -> (new value, old value)
    lo, hi = 256 - M_MARGIN, 513 + M_MARGIN
    for f, x, y in sorted(todo):
        mos = np.full((769, 769), np.nan)
        for i in range(3):
            for j in range(3):
                t = get(f, x - 1 + i, y - 1 + j)
                if t is not None:
                    mos[j * 256:j * 256 + 257, i * 256:i * 256 + 257] = t[1:258, 1:258]
        sub = mos[lo:hi, lo:hi]
        fixed, changed = despike_field(sub, below=region_despikes_below(reg))
        c = changed[M_MARGIN:M_MARGIN + 257, M_MARGIN:M_MARGIN + 257]
        for jj, ii in zip(*np.nonzero(c)):
            key = (f, y * 256 + int(jj), x * 256 + int(ii))
            changes[key] = (float(fixed[M_MARGIN + jj, M_MARGIN + ii]), float(sub[M_MARGIN + jj, M_MARGIN + ii]))
        if len(cache) > 400:
            cache.clear()
    by_tile: dict = {}
    for (f, gy, gx), (v, _old) in changes.items():
        for ty in range((gy + 1) // 256 - 1, (gy + 1) // 256 + 1):
            for tx in range((gx + 1) // 256 - 1, (gx + 1) // 256 + 1):
                jy, ix = gy - ty * 256 + 1, gx - tx * 256 + 1          # index in the 259 grid
                if (f, tx, ty) in have and 0 <= jy <= 258 and 0 <= ix <= 258:
                    by_tile.setdefault((f, tx, ty), []).append((jy, ix, v))
    for (f, x, y), lst in by_tile.items():
        h = tiles.read_height(f, level, x, y).astype(np.float64)
        for jy, ix, v in lst:
            h[jy, ix] = v
        tiles.write_height(f, level, x, y, keep_sign(h, scale), scale)
    worst = sorted(((old - new, f, gy, gx, old, new) for (f, gy, gx), (new, old) in changes.items()), reverse=True)[:12]
    n = 2 ** level
    rows = []
    for _d, f, gy, gx, old, new in worst:
        s, t = -1.0 + 2.0 * (gx / 256.0) / n, -1.0 + 2.0 * (gy / 256.0) / n
        la, lo_ = _points_latlon(cube.face_st_to_dir(f, np.array([s]), np.array([t])))
        rows.append({"lat": round(float(la[0]), 5), "lon": round(float(lo_[0]), 5), "was": round(old, 1), "now": round(new, 1)})
    log(f"height {region_id} level {level}: {len(changes)} needle vertices removed in {len(by_tile)} tiles"
        + (f"; highest {rows[0]['was']} m -> {rows[0]['now']} m at {rows[0]['lat']}, {rows[0]['lon']}" if rows else ""))
    return {"vertices": len(changes), "tiles": sorted(by_tile), "worst": rows, "changed": sorted(changes)}


def _despike_unit(u: tuple) -> dict:
    region_id, level, scale = u
    import json
    sdir = paths.STATE / f"height-{region_id}-l{level}-despike-scan"
    cands = []
    for p in sorted(sdir.glob("*.cand.json")):
        cands.extend(tuple(t) for t in json.loads(p.read_text(encoding="utf-8")))
    res = despike_level(region_id, level, scale, cands)
    (paths.STATE / f"height-{region_id}-l{level}-despike" / "removed.json").write_text(json.dumps(res, indent=1), encoding="utf-8")
    return res


def _despike_scan(u: tuple) -> int:
    """Scan unit: writes its candidate list next to its state marker (the despike unit reads them)."""
    import json
    region_id, level, tl = u
    cands = _despike_scan_unit(u)
    sdir = paths.STATE / f"height-{region_id}-l{level}-despike-scan"
    sdir.mkdir(parents=True, exist_ok=True)
    (sdir / f"{tl[0][0]}-{tl[0][1]}-{tl[0][2]}-{len(tl)}.cand.json").write_text(json.dumps(cands), encoding="utf-8")
    return len(cands)


def run_despike(region_id: str, level: int, scale: float, cfg: dict) -> dict | None:
    """The despike pass of the finest regional level (scan in the pool, then one process). Returns the result
    of the pass when it ran in this call, None when it was already done for this configuration."""
    tl = regmod.rect_tiles(regmod.coverage_rects(regmod.load(region_id), level))
    chunks = [tuple(tl[i:i + 64]) for i in range(0, len(tl), 64)]
    run_units(f"height-{region_id}-l{level}-despike-scan", _despike_scan, [(region_id, level, c) for c in chunks],
              key=lambda u: f"{u[2][0][0]}-{u[2][0][1]}-{u[2][0][2]}-{len(u[2])}", config=cfg)
    (paths.STATE / f"height-{region_id}-l{level}-despike").mkdir(parents=True, exist_ok=True)
    res = run_units(f"height-{region_id}-l{level}-despike", _despike_unit, [(region_id, level, scale)],
                    key=lambda u: "all", config=cfg, workers=1)
    return res[0] if res else None


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


def _level_cfg(reg: dict, level: int) -> dict:
    """Configuration a regional level is recorded with (its hash is in every unit marker of the level)."""
    return {"v": 5, "region": reg, "level": level, "grid": regsrc.GRID_VERSION,
            "rampSmoothM": regsrc.RAMP_SMOOTH_M, "nearSmoothM": regsrc.NEAR_SMOOTH_M,
            "softM": regsrc.SOFT_M, "inlandMaxDevM": regsrc.INLAND_MAX_DEV_M, "openPx": regsrc.OPEN_PX,
            "fillPits": [PIT_MAX_VERTICES, PIT_RIM_M, "every level", 4, "spill4"],
            "minLandM": regsrc.MIN_LAND_M, "minSeaM": regsrc.MIN_SEA_M,
            "keepSign": True, "despike": SPIKE_CFG,
            **({"despikeBelow": SPIKE_BELOW_CFG} if region_despikes_below(reg) else {})}


def region_is_baked(region_id: str) -> bool:
    """Every unit of every regional level is recorded as done for the present configuration."""
    reg = regmod.load(region_id)
    lv = regmod.levels(reg)
    for level in lv:
        tl = regmod.rect_tiles(regmod.coverage_rects(reg, level))
        scale = float(reg["levels"][str(level)]["heightScale"])
        units = [(region_id, level, lv[-1], scale, tuple(tl[i:i + 64])) for i in range(0, len(tl), 64)]
        cfg = _level_cfg(reg, level)
        if not units_done(f"height-{region_id}-l{level}", units, lambda u: f"{u[4][0][0]}-{u[4][0][1]}-{u[4][0][2]}-{len(u[4])}", cfg):
            return False
        if not units_done(f"height-{region_id}-l{level}-pits", [(region_id, level, scale)], lambda u: "edge", cfg):
            return False
    return units_done(f"height-{region_id}-l{lv[-1]}-despike", [(region_id, lv[-1])], lambda u: "all", _level_cfg(reg, lv[-1]))


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
        plan.append((level, len(tl), units, _level_cfg(reg, level)))
    from earth import manifest

    def pit_unit(level, cfg):
        return [(region_id, level, float(reg["levels"][str(level)]["heightScale"]))]
    if region_is_baked(region_id):
        log(f"height {region_id}: every level already baked")
        manifest.mark("height", region_id)
        return
    # build (and cache) the regional source once in the parent so workers only memory-map it (not when only
    # recording or checking: bake.py accept / --dry-run)
    from earth.util import unit_mode
    if unit_mode() is None:
        _regional_height(region_id).prepare()
    for level, n_tiles, units, cfg in plan:
        log(f"height {region_id} level {level}: {n_tiles} tiles")
        run_units(f"height-{region_id}-l{level}", _reg_unit, units, key=key, config=cfg)
        run_units(f"height-{region_id}-l{level}-pits", _edge_pit_unit, pit_unit(level, cfg), key=lambda u: "edge",
                  config=cfg, workers=1)
        if level == finest:
            # before the coarser levels are averaged from this one
            run_despike(region_id, level, float(reg["levels"][str(level)]["heightScale"]), cfg)
    manifest.mark("height", region_id)


def repair_spikes(region_id: str) -> dict:
    """Despike an EXISTING regional bake without its sources (which `cleanup` has deleted): the pass on the
    stored finest level, then every coarser tile that averages a changed vertex is derived again from the
    stored level below with the code of the normal bake (full weighting, fill_pits, keep_sign, the tile-edge
    pit pass). A coarse vertex averages the 3 x 3 finer vertices around it, so the tiles to derive again are
    known exactly from the changed vertices. Where such a tile reaches outside the finer level's coverage its
    outer vertices would need the global source: they keep their stored values, which is exact as long as
    none of them averages a changed vertex (the pass refuses to continue otherwise). Afterwards the stored
    tiles are what bake_region produces with the present configuration, so the unit records of every level
    are rewritten for it (a later `heights` run finds them done). Layers that record the height build as an
    input (regional water mask, albedo, land cover) become stale in the usual way."""
    from earth import manifest
    from earth.util import config_hash
    reg = regmod.load(region_id)
    lv = regmod.levels(reg)
    finest = lv[-1]

    def cfg_of(level):
        return _level_cfg(reg, level)

    scale_of = lambda level: float(reg["levels"][str(level)]["heightScale"])   # noqa: E731
    res = run_despike(region_id, finest, scale_of(finest), cfg_of(finest))
    if res is None:
        import json
        res = json.loads((paths.STATE / f"height-{region_id}-l{finest}-despike" / "removed.json").read_text(encoding="utf-8"))
    changed = {tuple(v) for v in res["changed"]}          # (face, gy, gx) of the level below the one in work
    report = {"finest": finest, "vertices": res["vertices"], "tiles": {finest: len(res["tiles"])}, "worst": res["worst"]}
    for level in reversed(lv[:-1]):
        have = set(regmod.rect_tiles(regmod.coverage_rects(reg, level)))
        # tile X stores coarse vertices 256 X - 1 .. 256 X + 257, which average finer vertices 512 X - 3 .. 512 X + 515
        todo = set()
        for f, gy, gx in changed:
            for X in range(-((515 - gx) // 512), (gx + 3) // 512 + 1):
                for Y in range(-((515 - gy) // 512), (gy + 3) // 512 + 1):
                    if (f, X, Y) in have:
                        todo.add((f, X, Y))
        todo = sorted(todo)
        child_rects = regmod.coverage_rects(reg, level + 1)

        def loader(f, L, x, y, child_rects=child_rects):
            for r in child_rects:
                if r["face"] == f and r["x0"] <= x <= r["x1"] and r["y0"] <= y <= r["y1"]:
                    return tiles.read_height(f, L, x, y)
            return None

        cache = hpyramid.TileCache(level + 1, loader)
        rewritten = set()
        next_changed = set()
        jj, ii = np.meshgrid(np.arange(259), np.arange(259), indexing="ij")
        for f, x, y in todo:
            before = tiles.read_height(f, level, x, y)
            # outside the finer level's coverage the stencil has no tile: NaN instead of the global source
            h = hpyramid.downsample_tile(f, level, x, y, cache, lambda p: np.full(len(p), np.nan))
            outer = np.isnan(h)
            if outer.any():
                gy, gx = y * 256 + jj[outer] - 1, x * 256 + ii[outer] - 1
                for cy, cx in zip(gy.tolist(), gx.tolist()):
                    if any((f, 2 * cy + dy, 2 * cx + dx) in changed for dy in (-1, 0, 1) for dx in (-1, 0, 1)):
                        raise RuntimeError(f"height {region_id}: tile {f}/{level}/{x}/{y} averages a despiked vertex "
                                           "and the global source: it can only be re-baked from the sources")
                h = np.where(outer, before.astype(np.float64), h)
            h = keep_sign(fill_pits(h)[0], scale_of(level))
            tiles.write_height(f, level, x, y, h, scale_of(level))
            after = tiles.read_height(f, level, x, y)
            diff = before != after
            if diff.any():
                rewritten.add((f, x, y))
                for j, i in zip(*np.nonzero(diff)):
                    next_changed.add((f, y * 256 + int(j) - 1, x * 256 + int(i) - 1))
            cache.trim()
        _edge_pit_unit((region_id, level, scale_of(level)))
        log(f"height {region_id} level {level}: {len(todo)} tiles derived again, {len(rewritten)} changed "
            f"({len(next_changed)} vertices)")
        report["tiles"][level] = len(rewritten)
        changed = next_changed
    # the stored levels now match the present configuration: adopt it in the unit records
    for level in lv:
        cfg = cfg_of(level)
        h = config_hash(cfg)
        for name in (f"height-{region_id}-l{level}", f"height-{region_id}-l{level}-pits"):
            for p in (paths.STATE / name).glob("*.done"):
                p.write_text(h, encoding="utf-8")
    manifest.mark("height", region_id)
    if not region_is_baked(region_id):
        raise RuntimeError(f"height {region_id}: the unit records do not match the present configuration after the repair")
    return report


TERRARIUM_CREDIT = ("AWS Terrain Tiles (Terrarium; USGS 3DEP 10 m in Hawai'i), attribution: "
                    "https://github.com/tilezen/joerd/blob/master/docs/attribution.md")


def vertex_spacing_m(region: dict, level: int) -> float:
    """Vertex spacing (m) of `level` at the region's centre (first shape point)."""
    from earth import regional
    la, lo = regmod.shape_points(region)[0]
    f, x, y, _, _ = cube.dir_to_tile(cube.lat_lon_to_dir(np.radians(la), np.radians(lo)), level)
    return float(regional.texel_metres(int(f), level, int(x), int(y)))


def source_finer_than_parent(region: dict, level: int) -> bool:
    """True when the region's land source (`sources.height.resolutionM`; absent = finer than every level, as
    3DEP 10 m is at Ka Lae) samples more finely than the parent level's vertices at the region."""
    res = region["sources"]["height"].get("resolutionM")
    return res is None or float(res) < vertex_spacing_m(region, level - 1)


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
            if source_finer_than_parent(reg, L):
                source_coverage.setdefault(str(L), []).extend(regmod.tile_set_rects(source_land_tiles(reg, L)))
            else:
                source_coverage.setdefault(str(L), [])
        s = reg["sources"]["height"].get("credit", TERRARIUM_CREDIT)
        if s not in sources:
            sources.append(s)
    # sourceCoverage (docs/requests/terrain-core-1.md and -4.md, optional, additive): the rectangles of the
    # tiles where a regional level holds data genuinely finer than its parent: tiles that touch the area where
    # the regional source has non-zero weight AND hold land (3DEP, SRTM). Sea-only tiles hold the ETOPO 15" sea
    # floor (~900 m shortest wavelength) and stay in `coverage` only, and so does every tile of a level whose
    # parent's vertex spacing is already finer than the land source (ARCHITECTURE 10.2: the parent's procedural
    # detail continues there; a 30 m source adds nothing at a level whose parent samples every 19 m).
    return {"encoding": "frt1-height", "ext": "hgt", "globalMaxLevel": paths.GLOBAL_MAX_LEVEL,
            "coverage": coverage, "sourceCoverage": source_coverage, "heightScales": scales, "sources": sources}
