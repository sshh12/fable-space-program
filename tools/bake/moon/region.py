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
Source-coverage rectangles (the height layer's `sourceCoverage`, requested in docs/requests/terrain-core-1.md):
tiles touching the area where band k's source data actually lies (the disc; the source's valid footprint
without marginM), without coverageMarginTiles - where a level holds data finer than its parent.

A source may carry `seamCorrection` (correct_column_seam): a stereo-model seam running along the columns of a
DTM is tracked as one path and replaced by a smooth ramp before anything else reads the source; and
`trackStripeCorrection` (correct_track_stripes): columns that carry altimeter-track noise (SLDEM2015 pixels
pulled to LOLA shots along the polar ground tracks) lose their narrow across-track residual where detected.
"""
from __future__ import annotations

import argparse
import hashlib
import json
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
    sdef = region["sources"][sid]
    data = g.mips[0]
    if sdef.get("seamCorrection"):
        data, _ = correct_column_seam(data, sdef["seamCorrection"])
    if sdef.get("trackStripeCorrection"):
        data, _ = correct_track_stripes(data, sdef["trackStripeCorrection"])
    if data is not g.mips[0]:
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


STEP_WINDOW = 7  # columns over which a seam step is summed (the step spreads over ~5 columns)


def seam_block_profiles(a: np.ndarray, sc: dict) -> dict:
    """Per block of sc['blockRows'] rows: dev(c) = median over the block's rows of h[c + 1] - h[c], minus its
    41-column running median (the regional slope), i.e. the systematic column-to-column offset; step(c) =
    sum of dev over STEP_WINDOW columns centred on c; noise = robust spread of step over the search band."""
    c0, c1 = sc["searchColumns"]
    br = int(sc["blockRows"])
    rows, devs = [], []
    for r0 in range(0, a.shape[0], br):
        blk = np.diff(a[r0:r0 + br].astype(np.float64), axis=1)
        if np.isfinite(blk[:, c0:c1]).sum(axis=0).min() < 0.5 * blk.shape[0]:
            continue  # the band is not fully covered by data in this block (strip ends)
        with np.errstate(all="ignore"):
            med = np.nan_to_num(np.nanmedian(blk, axis=0))
        rows.append(r0 + blk.shape[0] / 2.0)
        devs.append(med - ndimage.median_filter(med, 41))
    dev = np.array(devs)
    step = ndimage.uniform_filter1d(dev, STEP_WINDOW, axis=1) * STEP_WINDOW
    band = step[:, c0:c1]
    noise = 1.4826 * np.median(np.abs(band - np.median(band, axis=1, keepdims=True)), axis=1)
    return {"rows": np.array(rows), "dev": dev, "step": step, "noise": np.maximum(noise, 1e-6)}


def track_seam(prof: dict, sc: dict) -> tuple[np.ndarray, int]:
    """The seam as one continuous path of columns (one per block) and its step sign.

    Dynamic programming over the blocks: a block scores sign * step(c) / noise where positive, a change of
    column between consecutive blocks costs sc['jumpCostPerPx'] per column (at most sc['maxJumpPx']). Both
    signs are tracked and the sign with the higher total wins, so the path follows the one consistent seam
    instead of the strongest unrelated excess of each block."""
    c0, c1 = sc["searchColumns"]
    lam, mj = float(sc["jumpCostPerPx"]), int(sc["maxJumpPx"])
    cols = np.arange(c0, c1)
    dc = np.abs(cols[:, None] - cols[None, :])
    trans = np.where(dc <= mj, -lam * dc, -np.inf)  # [to, from]
    best = None
    for sgn in (1, -1):
        score = np.maximum(0.0, sgn * prof["step"][:, c0:c1]) / prof["noise"][:, None]
        v = score[0].copy()
        back = np.zeros(score.shape, dtype=np.int64)
        for b in range(1, len(score)):
            m = v[None, :] + trans
            back[b] = np.argmax(m, axis=1)
            v = score[b] + m[np.arange(len(cols)), back[b]]
        k = int(np.argmax(v))
        if best is None or v[k] > best[0]:
            path = np.zeros(len(score), dtype=np.int64)
            path[-1] = k
            for b in range(len(score) - 1, 0, -1):
                path[b - 1] = back[b][path[b]]
            best = (float(v[k]), cols[path], sgn)
    return best[1], best[2]


def correct_column_seam(a: np.ndarray, sc: dict) -> tuple[np.ndarray, dict]:
    """Replace a stereo-seam step along a near-column line by a smooth ramp of +-rampPx columns.

    The seam is tracked as one path (track_seam). A block is corrected only where its step at the path is
    significant (z = sign * step / noise): weight max(smoothstep of z over minZ..fullZ, smoothstep of the mean
    z over significanceBlocks blocks along the path over minPathZ..fullPathZ). The block's profile is dev over
    +-halfWidthPx columns around the path, averaged with its neighbours (Gaussian of profileSmoothBlocks
    blocks, weighted by significance) in the path's frame; its cumulative sum E is the offset the seam adds,
    and the correction subtracts E and adds back the same total step as a smootherstep over +-rampPx, so the
    long-wavelength shape is kept and only the sharp seam goes. Each block's correction sits at its own path
    column; rows between block centres blend the two neighbouring corrections linearly. Last, an across-track
    notch (Gaussian of notchSigmaPx columns, full within notchHalfWidthPx of the path, faded out over 3 more
    columns, scaled by the block weight) removes the thin ridge/groove pairs a block profile cannot follow
    where the seam wanders by a column or two. Away from the path and in blocks without a significant step
    nothing changes."""
    prof = seam_block_profiles(a, sc)
    path, sgn = track_seam(prof, sc)
    hw, ramp_px = int(sc["halfWidthPx"]), float(sc["rampPx"])
    nb = len(path)
    z = np.array([sgn * prof["step"][b, path[b]] / prof["noise"][b] for b in range(nb)])
    # significance: the block's own step (minZ..fullZ) or, with a lower bar, the mean z over
    # significanceBlocks blocks along the path (a seam persists for many blocks; a chance excess does not)
    zs = ndimage.uniform_filter1d(z, int(sc["significanceBlocks"]), mode="nearest")

    def gate(v, lo, hi):
        q = np.clip((v - lo) / (hi - lo), 0.0, 1.0)
        return q * q * (3 - 2 * q)

    g = np.maximum(gate(z, sc["minZ"], sc["fullZ"]), gate(zs, sc["minPathZ"], sc["fullPathZ"]))
    shapes = np.array([prof["dev"][b, path[b] - hw:path[b] + hw + 1] for b in range(nb)])
    ks = float(sc["profileSmoothBlocks"])
    kk = np.arange(-int(math.ceil(3 * ks)), int(math.ceil(3 * ks)) + 1)
    kern = np.exp(-0.5 * (kk / ks) ** 2)
    num = np.zeros_like(shapes)
    den = np.zeros(nb)
    for o, kw in zip(kk, kern):
        src = np.clip(np.arange(nb) + o, 0, nb - 1)
        valid = (np.arange(nb) + o >= 0) & (np.arange(nb) + o < nb)
        wgt = np.where(valid, kw * g[src], 0.0)
        num += wgt[:, None] * shapes[src]
        den += wgt
    shapes = np.where(den[:, None] > 1e-9, num / np.maximum(den, 1e-9)[:, None], 0.0)
    # correction profile of each block on x = column - path column, x in [-L, L]
    L = int(math.ceil(ramp_px)) + 1
    x = np.arange(-L, L + 1, dtype=np.float64)
    e = np.zeros((nb, len(x)))
    cum = np.cumsum(shapes, axis=1)                    # offset of column path + j + 1, j = -hw..hw
    i0 = L - hw + 1
    e[:, i0:i0 + cum.shape[1]] = cum
    e[:, i0 + cum.shape[1]:] = cum[:, -1:]
    step_total = cum[:, -1]
    ramp = smootherstep((x - 0.5 + ramp_px) / (2.0 * ramp_px))
    corr_b = g[:, None] * (e - step_total[:, None] * ramp[None, :])
    # across-track notch along the path: a narrow Gaussian across columns, faded in over notchHalfWidthPx + 3
    # columns, removes what the block profiles cannot follow (the seam wanders by a column or two within a
    # block and leaves thin ridge/groove pairs)
    nh, ns = float(sc["notchHalfWidthPx"]), float(sc["notchSigmaPx"])
    taper = 1.0 - smootherstep((np.abs(x) - nh) / 3.0)
    rows = prof["rows"]
    out = a.astype(np.float64)
    notch_w = np.zeros(a.shape, dtype=np.float32)
    r_all = np.arange(a.shape[0], dtype=np.float64)
    j = np.clip(np.searchsorted(rows, r_all) - 1, 0, nb - 2)
    t = np.clip((r_all - rows[j]) / (rows[j + 1] - rows[j]), 0.0, 1.0)
    for side, wt in ((0, 1.0 - t), (1, t)):
        blk = j + side
        for b in np.unique(blk):
            sel = np.nonzero((blk == b) & (wt > 0))[0]
            if g[b] <= 0.0 or len(sel) == 0:
                continue
            c_lo = path[b] - L
            cs = slice(max(0, c_lo), min(a.shape[1], path[b] + L + 1))
            xs = slice(cs.start - c_lo, cs.stop - c_lo)
            out[sel, cs] -= wt[sel, None] * corr_b[b, xs][None, :]
            notch_w[sel, cs] += (wt[sel, None] * g[b] * taper[xs][None, :]).astype(np.float32)
    rr = np.nonzero(notch_w.max(axis=1) > 0)[0]
    if len(rr):
        cs = slice(max(0, int(path.min()) - L - 8), min(a.shape[1], int(path.max()) + L + 9))  # notch_w = 0 outside
        sub = out[rr, cs]
        fin = np.isfinite(sub)
        num = ndimage.gaussian_filter1d(np.where(fin, sub, 0.0), ns, axis=1, mode="nearest")
        den = ndimage.gaussian_filter1d(fin.astype(np.float64), ns, axis=1, mode="nearest")
        smooth = np.where(den > 0.5, num / np.maximum(den, 1e-9), sub)
        nw = np.minimum(notch_w[rr, cs], 1.0).astype(np.float64)
        out[rr, cs] = np.where(fin, sub + nw * (smooth - sub), sub)
    out = out.astype(np.float32)
    after = seam_block_profiles(out, sc)
    st_before = np.array([prof["step"][b, path[b]] for b in range(nb)])
    st_after = np.array([after["step"][b, path[b]] for b in range(nb)])
    sig = g > 0
    max_change = 0.0
    for q in range(0, a.shape[0], 1024):
        c = np.abs(out[q:q + 1024].astype(np.float64) - a[q:q + 1024])
        if np.isfinite(c).any():
            max_change = max(max_change, float(np.nanmax(c)))
    rep = {"blocks": nb, "sign": int(sgn), "correctedBlocks": int(sig.sum()), "fullyCorrectedBlocks": int((g >= 1).sum()),
           "pathColumns": [int(path.min()), int(path.max())],
           "pathColumnsCorrected": [int(path[sig].min()), int(path[sig].max())] if sig.any() else [],
           "maxStepBeforeM": float(np.abs(st_before[sig]).max()) if sig.any() else 0.0,
           "maxStepAfterM": float(np.abs(st_after[sig]).max()) if sig.any() else 0.0,
           "rmsStepBeforeM": float(np.sqrt(np.mean(st_before[sig] ** 2))) if sig.any() else 0.0,
           "rmsStepAfterM": float(np.sqrt(np.mean(st_after[sig] ** 2))) if sig.any() else 0.0,
           "medianStepNoiseM": float(np.median(prof["noise"])),
           "maxAbsChangeM": max_change,
           "blockTable": [{"row": float(rows[b]), "col": int(path[b]), "stepBeforeM": round(float(st_before[b]), 3),
                           "stepAfterM": round(float(st_after[b]), 3), "z": round(float(z[b]), 2),
                           "zAlongPath": round(float(zs[b]), 2), "weight": round(float(g[b]), 2)}
                          for b in range(nb)]}
    return out, rep


def _abs_d2(x: np.ndarray, axis: int) -> np.ndarray:
    """|second difference| along `axis` (rows = 0, columns = 1), zero on the first and last line."""
    out = np.zeros_like(x)
    if axis == 1:
        out[:, 1:-1] = np.abs(x[:, :-2] - 2.0 * x[:, 1:-1] + x[:, 2:])
    else:
        out[1:-1, :] = np.abs(x[:-2, :] - 2.0 * x[1:-1, :] + x[2:, :])
    return out


ROUGHNESS_NEIGHBOURS = 15  # lines in the reference of line_roughness_ratio (the stripe metric; fixed, not tuned)


def line_roughness_ratio(x: np.ndarray, axis: int, neighbours: int = ROUGHNESS_NEIGHBOURS) -> np.ndarray:
    """Per interior column (axis=1) or row (axis=0): mean |second difference across it| over the whole grid,
    divided by the running median of that over `neighbours` lines. An altimeter track along a column stands
    out (> 1.3); isotropic terrain stays near 1. The first and last line have no second difference and are
    left out."""
    m = _abs_d2(x, axis).mean(axis=0 if axis == 1 else 1)[1:-1]
    return m / np.maximum(ndimage.median_filter(m, neighbours, mode="nearest"), 1e-9)


def correct_track_stripes(a: np.ndarray, sc: dict) -> tuple[np.ndarray, dict]:
    """Remove altimeter-track stripes running along the columns of a DTM grid.

    SLDEM2015 pulls the Kaguya TC DTM to LOLA shots, and LRO's polar ground tracks run along the columns of an
    equirectangular grid: a track column then carries the shot-to-shot differences between LOLA and the TC
    DTM, i.e. noise that changes from pixel to pixel along the column, which a hillshade under a low sun draws
    as straight N-S lines. Detection (per pixel): the across-track roughness |d2x| (Gaussian along the column
    over detectAlongPx rows) must exceed both the running median of the neighbouring columns (neighbourCols)
    and the column's own along-track roughness |d2y| relative to its neighbours: score = min(excess,
    anisotropy). A crater raises d2x and d2y alike and does not stay in one column; wrinkle ridges curve. The
    weight is a smoothstep of the score over scoreLo..scoreHi, widened by one column on each side (a track
    pixel raises d2x of its neighbours). Correction: the weighted pixels lose their narrow across-track residual
    r = h - median over acrossMedianPx columns, clamped to +-maxStripeM, so the column takes the height of its
    neighbours while everything wider than ~2 px (craters, ridges, slopes) is kept. No along-track filtering:
    the error changes from shot to shot. Non-finite pixels stay as they are."""
    fin = np.isfinite(a)
    x = a.astype(np.float64)
    if not fin.all():
        _, idx = ndimage.distance_transform_edt(~fin, return_indices=True)
        x = x[tuple(idx)]
    along, nb = float(sc["detectAlongPx"]), int(sc["neighbourCols"])
    gx = ndimage.gaussian_filter1d(_abs_d2(x, 1), along, axis=0, mode="nearest")
    gy = ndimage.gaussian_filter1d(_abs_d2(x, 0), along, axis=0, mode="nearest")
    excess = gx / np.maximum(ndimage.median_filter(gx, size=(1, nb), mode="nearest"), 1e-9)
    an = gx / np.maximum(gy, 1e-9)
    aniso = an / np.maximum(ndimage.median_filter(an, size=(1, nb), mode="nearest"), 1e-9)
    q = np.clip((np.minimum(excess, aniso) - sc["scoreLo"]) / (sc["scoreHi"] - sc["scoreLo"]), 0.0, 1.0)
    w = ndimage.maximum_filter1d(q * q * (3.0 - 2.0 * q), 3, axis=1)
    w[~fin] = 0.0
    m = float(sc["maxStripeM"])
    resid = np.clip(x - ndimage.median_filter(x, size=(1, int(sc["acrossMedianPx"])), mode="nearest"), -m, m)
    y = x - w * resid
    out = np.where(fin, y, a).astype(np.float32)
    chg = (y - x)[fin]
    before_c, after_c = line_roughness_ratio(x, 1), line_roughness_ratio(y, 1)
    rep = {"weightedFraction": float(np.mean(w[fin] > 0)), "fullWeightFraction": float(np.mean(w[fin] >= 1.0)),
           "changeRmsM": float(np.sqrt(np.mean(chg ** 2))), "changeP99M": float(np.percentile(np.abs(chg), 99)),
           "maxChangeM": float(np.abs(chg).max()),
           "columnRatioMaxBefore": float(before_c.max()), "columnRatioMaxAfter": float(after_c.max()),
           "columnsAbove1p3Before": int((before_c > 1.3).sum()), "columnsAbove1p3After": int((after_c > 1.3).sum()),
           "rowRatioMaxControl": float(line_roughness_ratio(x, 0).max()),
           "rmsD2xBefore": float(np.sqrt(np.mean(_abs_d2(x, 1) ** 2))), "rmsD2xAfter": float(np.sqrt(np.mean(_abs_d2(y, 1) ** 2))),
           "rmsD2yBefore": float(np.sqrt(np.mean(_abs_d2(x, 0) ** 2))), "rmsD2yAfter": float(np.sqrt(np.mean(_abs_d2(y, 0) ** 2)))}
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
    bias_wide = bias
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
    # bias_wide (the biasSmoothingM field alone) is kept for the verifier, which reports where the edge-local
    # field changes the heights
    np.savez(work_dir(model.region["id"]) / f"bias-{b.id}.npz", bias=bias.astype(np.float32), mip=m,
             bias_wide=bias_wide.astype(np.float32))
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


def band_tiles(model: RegionModel, k: int, level: int, source_only: bool = False) -> set:
    """Tiles touching band k's area (source_only: only where its source data lies, i.e. without marginM)."""
    b = model.bands[k]
    c = model.region["centre"]
    if b.area["kind"] == "disc":
        t = cube.tiles_covering_disc(math.radians(c["latDeg"]), math.radians(c["lonDeg"]), b.area["radiusM"],
                                     rt.MOON_RADIUS, level)
        return set(t)
    pts = footprint_points(b.grid, 0.0 if source_only else b.area["marginM"])

    f, x, y, _, _ = dirs_to_tiles(pts, level)
    return set(zip(f.tolist(), x.tolist(), y.tolist()))


def region_coverage(model: RegionModel) -> tuple[dict[int, list[dict]], dict[int, list[dict]]]:
    """(coverage rectangles, source-coverage rectangles) per level; see the module docstring."""
    margin = int(model.region["coverageMarginTiles"])
    levels = sorted({L for b in model.bands for L in b.levels})
    if levels[0] != model.gmax + 1 or levels != list(range(levels[0], levels[-1] + 1)):
        raise ValueError(f"region levels {levels} must run contiguously from {model.gmax + 1}")
    tiles: dict[int, set] = {}
    source: dict[int, list[dict]] = {}
    for b in model.bands:
        for L in b.levels:
            tiles[L] = dilate_tiles(band_tiles(model, b.k, L), L, margin)
            source[L] = cube.rects_from_tiles(sorted(band_tiles(model, b.k, L, source_only=True)))
    rects: dict[int, list[dict]] = {}
    for L in reversed(levels):
        rects[L] = cube.rects_from_tiles(sorted(tiles[L]))
        if L - 1 in tiles:
            for r in rects[L]:
                for x in range(r["x0"], r["x1"] + 1):
                    for y in range(r["y0"], r["y1"] + 1):
                        tiles[L - 1].add((r["face"], x >> 1, y >> 1))
    for L in levels:
        inside = set(rect_tiles(rects[L]))
        if not set(rect_tiles(source[L])) <= inside:
            raise ValueError(f"level {L}: source coverage is not inside the coverage")
    return {L: rects[L] for L in levels}, {L: source[L] for L in levels}


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
    rt.write_tile(layout.tile_file(m.region["tileset"], "height", face, level, x, y, "hgt"), data)
    return task, len(data), float(h.min()), float(h.max()), hashlib.sha256(data).hexdigest()


# -- manifest ----------------------------------------------------------------------------------------------
def update_manifest(region: dict, rects: dict[int, list[dict]], source_rects: dict[int, list[dict]],
                    scales: dict[int, float], credits: list[str], tiles_sha: str) -> None:
    """Merge the region's rectangles (and those of every other registered region) into the height layer.

    `sourceCoverage` is the field docs/requests/terrain-core-1.md asks for (same shape as `coverage`).
    `build` hashes the content of every registered region's tiles: layout.write_manifest hashes only the
    manifest body, so without it a re-bake that changes tiles but no rectangle would keep the contentHash the
    tile URLs are cache-busted with (TileManifest.contentHash: "changes whenever tiles are re-baked")."""
    reg = rt.read_json(REGISTRY) if REGISTRY.is_file() else {}
    reg[region["id"]] = {"rects": {str(L): r for L, r in rects.items()}, "sourceRects": {str(L): r for L, r in source_rects.items()},
                         "scales": {str(L): s for L, s in scales.items()}, "credits": credits, "tilesSha256": tiles_sha}
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
    source_cov: dict[str, list] = {}
    level_scale: dict[int, float] = {}
    sources = [s for s in layer["sources"]]
    for rid, e in reg.items():
        if "sourceRects" not in e or "tilesSha256" not in e:
            raise ValueError(f"region {rid} in {REGISTRY} predates source coverage / tile hashes: re-run region.py {rid}")
        for L, rs in e["rects"].items():
            coverage.setdefault(L, []).extend(rs)
        for L, rs in e["sourceRects"].items():
            source_cov.setdefault(L, []).extend(rs)
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
    layer["sourceCoverage"] = {L: source_cov[L] for L in sorted(source_cov, key=int)}
    layer["heightScales"] = hs
    layer["sources"] = sources
    layer["build"] = hashlib.sha256(json.dumps({rid: e["tilesSha256"] for rid, e in sorted(reg.items())}).encode("utf-8")).hexdigest()[:16]
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
        data = acquire_raw_source(region, sid).mips[0]
        if sdef.get("seamCorrection"):
            data, report[f"seam-{sid}"] = correct_column_seam(data, sdef["seamCorrection"])
            rt.log(f"source {sid}: seam correction {report[f'seam-{sid}']}")
        if sdef.get("trackStripeCorrection"):
            _, report[f"stripes-{sid}"] = correct_track_stripes(data, sdef["trackStripeCorrection"])
            rt.log(f"source {sid}: track-stripe correction {report[f'stripes-{sid}']}")
    for b in model.bands:
        compute_bias(model, b.k, report)
    rects, source_rects = region_coverage(model)
    tasks = [(region["id"], f, L, x, y) for L in sorted(rects) for (f, x, y) in rect_tiles(rects[L])]
    report["tilesPerLevel"] = {str(L): len(rect_tiles(r)) for L, r in rects.items()}
    report["coverage"] = {str(L): r for L, r in rects.items()}
    report["sourceCoverage"] = {str(L): r for L, r in source_rects.items()}
    rt.log(f"region {region['id']}: {len(tasks)} tiles {report['tilesPerLevel']}")
    total = 0
    digests: dict = {}
    with rt.pool() as p:
        for i, (task, n, lo, hi, dg) in enumerate(p.imap_unordered(bake_tile, tasks, chunksize=2)):
            total += n
            digests[task] = dg
            if (i + 1) % 200 == 0 or i + 1 == len(tasks):
                rt.log(f"  {i + 1}/{len(tasks)} tiles, {total / 1e6:.1f} MB")
    tiles_sha = hashlib.sha256("".join(f"{t}:{digests[t]};" for t in tasks).encode("utf-8")).hexdigest()
    report["tilesSha256"] = tiles_sha
    scales = {L: model.bands[model.band_of_level(L)].scale for L in rects}
    credits = [region["sources"][b.source_id]["credit"] for b in model.bands]
    update_manifest(region, rects, source_rects, scales, credits, tiles_sha)
    report["bytes"] = total
    report["seconds"] = time.time() - t0
    rt.write_json(work_dir(region["id"]) / "report.json", report)
    rt.log(f"region {region['id']} done: {len(tasks)} tiles, {total / 1e6:.1f} MB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
