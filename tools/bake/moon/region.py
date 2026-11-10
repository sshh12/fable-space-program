"""Generic regional height bake: levels above the global ones, from a region manifest in data/defs/regions.

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/moon/region.py moon-tranquility

A region file lists `bands` (each: levels, preferred height scale, a source, an area and a feather width)
and `sources` (URL, kind, bias smoothing). Adding a landing region is a new JSON file, nothing else.

Height function of band k at a direction d, for a level with sample spacing fp (footprint_m):
    G_-1(d)   = P(d)  = Catmull-Rom of the global top-level tiles (the run-time D_g, i.e. upsampled LOLA)
    G_k(d)    = G_(k-1)(d) + w_k(d) * (S_k(d, fp) - b_k(d) - G_(k-1)(d))
  S_k     source k filtered over fp (ProjectedGrid.sample);
  b_k     bias field: Gaussian (sigma = biasSmoothingM) of S_k - G_(k-1) at a coarse resolution, so the two
          sources agree at long wavelengths and the feather never has to bridge an offset;
  w_k     smootherstep feather: area kind "disc" -> 1 inside radius - featherM, 0 at radius; kind
          "sourceFootprint" -> 0 on the edge of the source's valid data, 1 at featherM inside it; both are also
          multiplied by the source-validity feather.
Levels of band k sample G_k on their 259 x 259 vertex grid. Coverage rectangles: tiles touching the band
area (disc, or source footprint dilated by marginM), dilated by coverageMarginTiles, closed under parents.
"""
from __future__ import annotations

import argparse
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from rasterio.crs import CRS  # noqa: E402
from rasterio.transform import Affine  # noqa: E402
from scipy import ndimage  # noqa: E402

from common import cube, frt1, layout  # noqa: E402
from moon import fetch, rt  # noqa: E402
from moon.gridsource import ProjectedGrid, read_geotiff_file, read_geotiff_window, smootherstep  # noqa: E402
from moon.sampling import dirs_to_tiles, footprint_m  # noqa: E402
from moon.tiles import TileReader  # noqa: E402

REGISTRY = rt.TILES_ROOT / rt.TILESET / "regions.json"


def region_path(region_id: str) -> Path:
    return rt.REGIONS_DIR / f"{region_id}.json"


def load_region(region_id: str) -> dict:
    r = rt.read_json(region_path(region_id))
    if r.get("id") != region_id:
        raise ValueError(f"{region_path(region_id)}: id must be {region_id}")
    return r


def work_dir(region_id: str) -> Path:
    return rt.MOON_WORK / f"region-{region_id}"


# -- sources ----------------------------------------------------------------------------------------------
def _save_grid(path: Path, g: ProjectedGrid) -> None:
    np.savez(path, data=g.mips[0], transform=np.array(tuple(g.transform)[:6]), crs=np.array(g.crs.to_wkt()))


def _load_grid(path: Path, name: str) -> ProjectedGrid:
    z = np.load(path)
    t = z["transform"]
    return ProjectedGrid(name, z["data"], Affine(*t), CRS.from_wkt(str(z["crs"])))


def acquire_source(region: dict, sid: str) -> ProjectedGrid:
    """The source raster covering the region, with the corrections its definition asks for."""
    g = acquire_raw_source(region, sid)
    sc = region["sources"][sid].get("seamCorrection")
    if sc:
        data, _ = correct_column_seam(g.mips[0], sc)
        g = ProjectedGrid(sid, data, g.transform, g.crs)
    return g


def acquire_raw_source(region: dict, sid: str) -> ProjectedGrid:
    """Read (and cache in the region work dir) one source raster covering the region, as published."""
    sdef = region["sources"][sid]
    cache = work_dir(region["id"]) / f"source-{sid}.npz"
    if cache.is_file():
        return _load_grid(cache, sid)
    cache.parent.mkdir(parents=True, exist_ok=True)
    if fetch.content_length(sdef["url"]) != sdef["bytes"]:
        raise RuntimeError(f"source {sid}: size changed upstream ({sdef['url']})")
    if sdef["kind"] == "geotiff-window":
        c = region["centre"]
        dlat = math.degrees(sdef["windowRadiusM"] / rt.MOON_RADIUS)
        dlon = dlat / math.cos(math.radians(c["latDeg"]))
        g = read_geotiff_window(sdef["url"], (c["latDeg"] - dlat, c["latDeg"] + dlat),
                                (c["lonDeg"] - dlon, c["lonDeg"] + dlon), sid)
    elif sdef["kind"] == "geotiff-download":
        dest = rt.MOON_DL / sid / sdef["url"].rsplit("/", 1)[1]
        fetch.download(sdef["url"], dest, connections=2, expect_bytes=sdef["bytes"])
        g = read_geotiff_file(dest, sid)
    else:
        raise ValueError(f"source {sid}: unknown kind {sdef['kind']}")
    _save_grid(cache, g)
    return g


def column_seam_profile(a: np.ndarray, sc: dict) -> list[dict]:
    """Per block of rows: the systematic column-to-column offset profile of a near-column seam.

    dev(c) = median over the block's rows of h[c + 1] - h[c], minus its 41-column running median (the regional
    slope). The seam is the strongest 7-column excess inside sc['searchColumns']; its shape is dev over
    +-halfWidthPx columns around it and its step is the sum of that window."""
    c0, c1 = sc["searchColumns"]
    hw = int(sc["halfWidthPx"])
    out = []
    for r0 in range(0, a.shape[0], int(sc["blockRows"])):
        blk = np.diff(a[r0:r0 + int(sc["blockRows"])].astype(np.float64), axis=1)
        if not np.isfinite(blk[:, c0:c1]).any():
            continue
        with np.errstate(all="ignore"):
            med = np.nanmedian(blk, axis=0)
        med = np.nan_to_num(med)
        dev = med - ndimage.median_filter(med, 41)
        sm = ndimage.uniform_filter1d(dev, 7)
        k = c0 + int(np.argmax(np.abs(sm[c0:c1])))
        out.append({"row": r0 + blk.shape[0] / 2.0, "col": k, "shape": dev[k - hw:k + hw + 1].copy(),
                    "stepM": float(dev[k - hw:k + hw + 1].sum())})
    return out


def correct_column_seam(a: np.ndarray, sc: dict) -> tuple[np.ndarray, dict]:
    """Replace a stereo-seam step along a near-column line by a smooth ramp of +-rampPx columns.

    Per block, the measured offset of column c relative to the left of the seam is E(c) = sum of dev over the
    window up to column c - 1; the correction subtracts E and adds back the same total step s as a
    smootherstep over +-rampPx, so the published long-wavelength shape is kept and only the sharp seam goes.
    Corrections are interpolated linearly in rows between block centres."""
    prof = column_seam_profile(a, sc)
    hw = int(sc["halfWidthPx"])
    w = a.shape[1]
    cols = np.arange(w, dtype=np.float64)
    corr_blocks = []
    for p in prof:
        e = np.zeros(w)
        lo = p["col"] - hw
        cum = np.cumsum(p["shape"])
        e[lo + 1:lo + 1 + len(cum)] = cum
        e[lo + 1 + len(cum):] = cum[-1]
        ramp = smootherstep((cols - (p["col"] + 0.5) + sc["rampPx"]) / (2.0 * sc["rampPx"]))
        corr_blocks.append(e - p["stepM"] * ramp)
    corr_blocks = np.array(corr_blocks)
    rows = np.array([p["row"] for p in prof])
    r = np.arange(a.shape[0], dtype=np.float64)
    j = np.clip(np.searchsorted(rows, r) - 1, 0, len(rows) - 2)
    t = np.clip((r - rows[j]) / (rows[j + 1] - rows[j]), 0.0, 1.0)
    out = np.empty(a.shape, dtype=np.float32)
    for q in range(0, a.shape[0], 1024):  # row chunks keep the float64 work arrays small
        s_ = slice(q, q + 1024)
        corr = (1.0 - t[s_])[:, None] * corr_blocks[j[s_]] + t[s_][:, None] * corr_blocks[j[s_] + 1]
        out[s_] = (a[s_].astype(np.float64) - corr).astype(np.float32)
    after = column_seam_profile(out, sc)
    rep = {"blocks": len(prof), "maxStepBeforeM": float(max(abs(p["stepM"]) for p in prof)),
           "maxStepAfterM": float(max(abs(p["stepM"]) for p in after)),
           "seamColumns": [int(min(p["col"] for p in prof)), int(max(p["col"] for p in prof))]}
    return out, rep


def nan_gaussian(a: np.ndarray, sigma: float) -> np.ndarray:
    m = np.isfinite(a)
    num = ndimage.gaussian_filter(np.where(m, a, 0.0), sigma, mode="nearest")
    den = ndimage.gaussian_filter(m.astype(np.float64), sigma, mode="nearest")
    out = np.where(den > 1e-3, num / np.maximum(den, 1e-12), np.nan)
    if np.any(~np.isfinite(out)):
        _, idx = ndimage.distance_transform_edt(~np.isfinite(out), return_indices=True)
        out = out[tuple(idx)]
    return out


def bilinear(a: np.ndarray, row: np.ndarray, col: np.ndarray) -> np.ndarray:
    h, w = a.shape
    r = np.clip(row, 0.0, h - 1.0)
    c = np.clip(col, 0.0, w - 1.0)
    r0 = np.minimum(np.floor(r).astype(np.int64), h - 2)
    c0 = np.minimum(np.floor(c).astype(np.int64), w - 2)
    fr, fc = r - r0, c - c0
    return ((1 - fr) * ((1 - fc) * a[r0, c0] + fc * a[r0, c0 + 1]) + fr * ((1 - fc) * a[r0 + 1, c0] + fc * a[r0 + 1, c0 + 1]))


class Band:
    def __init__(self, region: dict, k: int, grid: ProjectedGrid):
        b = region["bands"][k]
        self.k = k
        self.id = b["id"]
        self.levels = list(b["levels"])
        self.scale = float(b["heightScale"])
        self.source_id = b["source"]
        self.sdef = region["sources"][self.source_id]
        self.area = b["area"]
        self.feather = float(b["featherM"])
        self.inset = float(b.get("featherInsetM", 0.0))
        self.grid = grid
        self.dist = grid.distance_inside()
        self.bias: np.ndarray | None = None
        self.bias_mip = 0


class RegionModel:
    """The regional height function G_k (see module docstring)."""

    def __init__(self, region: dict, reader: TileReader | None = None, load_bias: bool = True):
        self.region = region
        self.reader = reader or TileReader(region["tileset"])
        self.gmax = self.reader.meta["globalMaxLevel"]
        c = region["centre"]
        self.centre = cube.lat_lon_to_dir(math.radians(c["latDeg"]), math.radians(c["lonDeg"]))
        self.bands = [Band(region, k, acquire_source(region, b["source"])) for k, b in enumerate(region["bands"])]
        if load_bias:
            for b in self.bands:
                z = np.load(work_dir(region["id"]) / f"bias-{b.id}.npz")
                b.bias, b.bias_mip = z["bias"], int(z["mip"])

    def band_of_level(self, level: int) -> int:
        for b in self.bands:
            if level in b.levels:
                return b.k
        raise KeyError(f"level {level} is not in region {self.region['id']}")

    def parent(self, dirs: np.ndarray) -> np.ndarray:
        return self.reader.bicubic(dirs, self.gmax)

    def weight(self, k: int, dirs: np.ndarray, lat: np.ndarray, lon: np.ndarray, fp: np.ndarray) -> np.ndarray:
        """Feather weight of band k. The validity feather starts where the filtered source's stencil (at this
        footprint) no longer reaches any missing pixel, so the source is only ever read where it is complete."""
        b = self.bands[k]
        row, col = b.grid.latlon_to_pixel(lat, lon)
        w = smootherstep((bilinear(b.dist, row, col) - b.grid.stencil_reach_m(fp) - b.inset) / b.feather)
        if b.area["kind"] == "disc":
            r = rt.MOON_RADIUS * np.arctan2(np.linalg.norm(np.cross(dirs, self.centre), axis=-1), dirs @ self.centre)
            w = w * smootherstep((b.area["radiusM"] - r) / b.feather)
        elif b.area["kind"] != "sourceFootprint":
            raise ValueError(f"band {b.id}: unknown area kind {b.area['kind']}")
        return w

    def bias_at(self, k: int, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        b = self.bands[k]
        row, col = b.grid.latlon_to_pixel(lat, lon)
        f = 2.0 ** b.bias_mip
        return bilinear(b.bias, (row + 0.5) / f - 0.5, (col + 0.5) / f - 0.5)

    def height(self, k: int, dirs: np.ndarray, fp: np.ndarray) -> np.ndarray:
        """G_k at unit directions for a sample footprint fp (m)."""
        if k < 0:
            return self.parent(dirs)
        base = self.height(k - 1, dirs, fp)
        lat, lon = (np.degrees(a) for a in cube.dir_to_lat_lon(dirs))
        w = self.weight(k, dirs, lat, lon, fp)
        sel = w > 0
        if np.any(sel):
            s = self.bands[k].grid.sample(lat[sel], lon[sel], fp[sel]) - self.bias_at(k, lat[sel], lon[sel])
            if not np.all(np.isfinite(s)):
                raise ValueError(f"band {self.bands[k].id}: source has no data where its weight is > 0")
            base = base.copy()
            base[sel] += w[sel] * (s - base[sel])
        return base

    def level_height(self, dirs: np.ndarray, level: int) -> np.ndarray:
        return self.height(self.band_of_level(level), dirs, footprint_m(dirs, level, rt.MOON_RADIUS))


# -- bias fields and registration checks -----------------------------------------------------------------
def compute_bias(model: RegionModel, k: int, report: dict) -> None:
    b = model.bands[k]
    g = b.grid
    smooth = float(b.sdef["biasSmoothingM"])
    edge_s = b.sdef.get("biasEdgeSmoothingM")
    k_coarse = max(g.kx, g.ky)
    m = int(np.clip(round(math.log2(min(smooth, edge_s or smooth) / 8.0 / k_coarse)), 0, len(g.mips) - 1))
    a = g.mips[m].astype(np.float64)
    f = 2.0 ** m
    rr, cc = np.mgrid[0:a.shape[0], 0:a.shape[1]].astype(np.float64)
    lat, lon = g.pixel_to_latlon((rr + 0.5) * f - 0.5, (cc + 0.5) * f - 0.5)
    dirs = cube.lat_lon_to_dir(np.radians(lat), np.radians(lon))
    base = model.height(k - 1, dirs, np.full(lat.shape, f * k_coarse))
    delta = a - base
    bias = nan_gaussian(delta, smooth / (f * k_coarse))
    if edge_s:
        # near the source's edge the bias follows the difference more closely (sigma biasEdgeSmoothingM), so
        # the feather never bridges a local offset; from biasEdgeFullM inside the edge the wide bias takes over
        # over biasEdgeWidthM
        near = nan_gaussian(delta, edge_s / (f * k_coarse))
        dist = bilinear(b.dist, (rr + 0.5) * f - 0.5, (cc + 0.5) * f - 0.5)
        w_edge = 1.0 - smootherstep((dist - float(b.sdef["biasEdgeFullM"])) / float(b.sdef["biasEdgeWidthM"]))
        bias = bias + w_edge * (near - bias)
    fin = np.isfinite(delta)
    resid = (delta - bias)[fin]
    report[f"bias-{b.id}"] = {
        "mip": m, "pixelM": f * k_coarse, "smoothingM": smooth,
        "deltaMeanM": float(delta[fin].mean()), "deltaStdM": float(delta[fin].std()),
        "biasMinM": float(bias[fin].min()), "biasMaxM": float(bias[fin].max()),
        "residualRmsM": float(np.sqrt(np.mean(resid ** 2))),
    }
    # registration: correlation of the high-passed source with the high-passed base for integer shifts
    hp_a = a - nan_gaussian(a, 4.0)
    hp_b = base - nan_gaussian(base, 4.0)
    best = None
    scores = {}
    for dy in range(-4, 5):
        for dx in range(-4, 5):
            s1 = hp_a[max(0, dy):hp_a.shape[0] + min(0, dy), max(0, dx):hp_a.shape[1] + min(0, dx)]
            s2 = hp_b[max(0, -dy):hp_b.shape[0] + min(0, -dy), max(0, -dx):hp_b.shape[1] + min(0, -dx)]
            ok = np.isfinite(s1) & np.isfinite(s2)
            if ok.sum() < 50:
                continue
            c = float(np.corrcoef(s1[ok], s2[ok])[0, 1])
            scores[(dy, dx)] = c
            if best is None or c > best[0]:
                best = (c, dy, dx)
    report[f"registration-{b.id}"] = {"bestShiftPx": [best[1], best[2]], "pixelM": f * k_coarse,
                                      "correlationAtBest": best[0], "correlationAtZero": scores.get((0, 0))}
    np.savez(work_dir(model.region["id"]) / f"bias-{b.id}.npz", bias=bias.astype(np.float32), mip=m)
    b.bias, b.bias_mip = bias.astype(np.float32), m
    rt.log(f"band {b.id}: bias {report[f'bias-{b.id}']}, registration {report[f'registration-{b.id}']}")


# -- coverage ----------------------------------------------------------------------------------------------
def dilate_tiles(tiles: set, level: int, margin: int) -> set:
    out = set()
    n = 2 ** level
    for (f, x, y) in tiles:
        for dx in range(-margin, margin + 1):
            for dy in range(-margin, margin + 1):
                if 0 <= x + dx < n and 0 <= y + dy < n:
                    out.add((f, x + dx, y + dy))
                else:
                    p = cube.tile_uv_to_dir(f, level, x, y, 0.5 + dx, 0.5 + dy)
                    nf, nx, ny, _, _ = cube.dir_to_tile(p, level)
                    out.add((nf, nx, ny))
    return out


def footprint_points(g: ProjectedGrid, margin_m: float) -> np.ndarray:
    """Directions of a <= 64 m lattice over the source's valid footprint dilated by margin_m."""
    m = int(max(0, math.floor(math.log2(64.0 / max(g.kx, g.ky)))))
    f = 2 ** m
    h, w = (g.valid.shape[0] // f) * f, (g.valid.shape[1] // f) * f
    anyv = g.valid[:h, :w].reshape(h // f, f, w // f, f).any(axis=(1, 3))
    pad = int(math.ceil(margin_m / (f * min(g.kx, g.ky)))) + 2
    big = np.pad(anyv, pad, constant_values=False)
    d = ndimage.distance_transform_edt(~big, sampling=(f * g.ky, f * g.kx))
    rr, cc = np.nonzero(d <= margin_m)
    lat, lon = g.pixel_to_latlon((rr - pad + 0.5) * f - 0.5, (cc - pad + 0.5) * f - 0.5)
    return cube.lat_lon_to_dir(np.radians(lat), np.radians(lon))


def band_tiles(model: RegionModel, k: int, level: int) -> set:
    b = model.bands[k]
    c = model.region["centre"]
    if b.area["kind"] == "disc":
        t = cube.tiles_covering_disc(math.radians(c["latDeg"]), math.radians(c["lonDeg"]), b.area["radiusM"],
                                     rt.MOON_RADIUS, level)
        return set(t)
    pts = footprint_points(b.grid, b.area["marginM"])

    f, x, y, _, _ = dirs_to_tiles(pts, level)
    return set(zip(f.tolist(), x.tolist(), y.tolist()))


def region_coverage(model: RegionModel) -> dict[int, list[dict]]:
    margin = int(model.region["coverageMarginTiles"])
    levels = sorted({L for b in model.bands for L in b.levels})
    if levels[0] != model.gmax + 1 or levels != list(range(levels[0], levels[-1] + 1)):
        raise ValueError(f"region levels {levels} must run contiguously from {model.gmax + 1}")
    tiles: dict[int, set] = {}
    for b in model.bands:
        for L in b.levels:
            tiles[L] = dilate_tiles(band_tiles(model, b.k, L), L, margin)
    rects: dict[int, list[dict]] = {}
    for L in reversed(levels):
        rects[L] = cube.rects_from_tiles(sorted(tiles[L]))
        if L - 1 in tiles:
            for r in rects[L]:
                for x in range(r["x0"], r["x1"] + 1):
                    for y in range(r["y0"], r["y1"] + 1):
                        tiles[L - 1].add((r["face"], x >> 1, y >> 1))
    return {L: rects[L] for L in levels}


def rect_tiles(rects: list[dict]) -> list[tuple[int, int, int]]:
    return [(r["face"], x, y) for r in rects for x in range(r["x0"], r["x1"] + 1) for y in range(r["y0"], r["y1"] + 1)]


# -- tile baking -----------------------------------------------------------------------------------------
_MODELS: dict = {}


def _model(region_id: str) -> RegionModel:
    if region_id not in _MODELS:
        _MODELS[region_id] = RegionModel(load_region(region_id))
    return _MODELS[region_id]


def bake_tile(task) -> tuple:
    region_id, face, level, x, y = task
    m = _model(region_id)
    d = cube.height_tile_dirs(face, level, x, y)
    h = m.level_height(d, level)
    scale = m.bands[m.band_of_level(level)].scale
    data = frt1.to_file_bytes(frt1.encode_height(h, scale))
    layout.write_atomic(layout.tile_file(m.region["tileset"], "height", face, level, x, y, "hgt"), data)
    return task, len(data), float(h.min()), float(h.max())


# -- manifest ----------------------------------------------------------------------------------------------
def update_manifest(region: dict, rects: dict[int, list[dict]], scales: dict[int, float], credits: list[str]) -> None:
    reg = rt.read_json(REGISTRY) if REGISTRY.is_file() else {}
    reg[region["id"]] = {"rects": {str(L): r for L, r in rects.items()}, "scales": {str(L): s for L, s in scales.items()},
                         "credits": credits}
    # overlapping regions would bake the same tile twice with different content
    claimed: dict = {}
    for rid, e in reg.items():
        for L, rs in e["rects"].items():
            for t in rect_tiles(rs):
                key = (int(L),) + t
                if key in claimed and claimed[key] != rid:
                    raise ValueError(f"regions {claimed[key]} and {rid} both cover tile {key}")
                claimed[key] = rid
    m = layout.read_manifest(region["tileset"])
    layer = m["layers"]["height"]
    gmax = layer["globalMaxLevel"]
    coverage: dict[str, list] = {}
    level_scale: dict[int, float] = {}
    sources = [s for s in layer["sources"]]
    for rid, e in reg.items():
        for L, rs in e["rects"].items():
            coverage.setdefault(L, []).extend(rs)
        for L, s in e["scales"].items():
            if int(L) in level_scale and level_scale[int(L)] != s:
                raise ValueError(f"regions disagree on the height scale of level {L}")
            level_scale[int(L)] = s
        for c in e["credits"]:
            if c not in sources:
                sources.append(c)
    top = max(level_scale) if level_scale else gmax
    hs = list(layer["heightScales"][:gmax + 1])
    for L in range(gmax + 1, top + 1):
        hs.append(level_scale.get(L, hs[-1]))
    layer["coverage"] = {L: coverage[L] for L in sorted(coverage, key=int)}
    layer["heightScales"] = hs
    layer["sources"] = sources
    layout.merge_layer(region["tileset"], rt.MOON_RADIUS, "height", layer, attribution=credits)
    rt.write_json(REGISTRY, reg)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("region")
    a = ap.parse_args()
    rt.check_python()
    rt.below_normal_priority()
    t0 = time.time()
    region = load_region(a.region)
    report: dict = {"region": region["id"]}
    model = RegionModel(region, load_bias=False)
    for sid, sdef in region["sources"].items():
        if sdef.get("seamCorrection"):
            _, report[f"seam-{sid}"] = correct_column_seam(acquire_raw_source(region, sid).mips[0], sdef["seamCorrection"])
            rt.log(f"source {sid}: seam correction {report[f'seam-{sid}']}")
    for b in model.bands:
        compute_bias(model, b.k, report)
    rects = region_coverage(model)
    tasks = [(region["id"], f, L, x, y) for L in sorted(rects) for (f, x, y) in rect_tiles(rects[L])]
    report["tilesPerLevel"] = {str(L): len(rect_tiles(r)) for L, r in rects.items()}
    report["coverage"] = {str(L): r for L, r in rects.items()}
    rt.log(f"region {region['id']}: {len(tasks)} tiles {report['tilesPerLevel']}")
    total = 0
    with rt.pool() as p:
        for i, (task, n, lo, hi) in enumerate(p.imap_unordered(bake_tile, tasks, chunksize=2)):
            total += n
            if (i + 1) % 200 == 0 or i + 1 == len(tasks):
                rt.log(f"  {i + 1}/{len(tasks)} tiles, {total / 1e6:.1f} MB")
    scales = {L: model.bands[model.band_of_level(L)].scale for L in rects}
    credits = [region["sources"][b.source_id]["credit"] for b in model.bands]
    update_manifest(region, rects, scales, credits)
    report["bytes"] = total
    report["seconds"] = time.time() - t0
    rt.write_json(work_dir(region["id"]) / "report.json", report)
    rt.log(f"region {region['id']} done: {len(tasks)} tiles, {total / 1e6:.1f} MB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
