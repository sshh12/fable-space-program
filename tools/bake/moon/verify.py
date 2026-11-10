"""Acceptance checks of the Moon tile set (bake-moon-sky). Prints a report and exits non-zero on failure.

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/moon/verify.py [--region moon-tranquility]

Writes the full numbers to out/bake/moon/verify.json.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage  # noqa: E402

from common import cube, frt1, layout  # noqa: E402
from moon import craters, fetch, rt  # noqa: E402
from moon.region import RegionModel, load_region  # noqa: E402
from moon.sampling import dirs_to_tiles, srgb_decode  # noqa: E402
from moon.tiles import TileReader  # noqa: E402

# LOLA benchmarks of docs/research/moon-sky-data.md: PDS ldem_64 pixel values (row 0 = 90 N, column 0 = 0 E,
# pixel centres at (c + 0.5) / 64 deg), located by reading the file (see the hand-off).
BENCHMARKS = [
    ("Tranquility", 5717, 1502, -1925.0),
    ("Tycho floor", 8531, 22310, -1295.5),
    ("Apollo 17", 4467, 1969, -2624.5),
    ("Aitken (SPA)", 9152, 12224, -6948.0),
]
LDEM256 = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/"

FAIL: list[str] = []
OUT: dict = {}


def check(ok: bool, msg: str) -> None:
    print(("PASS " if ok else "FAIL ") + msg, flush=True)
    if not ok:
        FAIL.append(msg)


# -- 1. every promised tile exists and decodes -----------------------------------------------------------
def all_keys(layer: dict) -> list[tuple[int, int, int, int]]:
    keys = [(f, L, x, y) for L in range(layer["globalMaxLevel"] + 1) for f in range(6) for y in range(2 ** L) for x in range(2 ** L)]
    for L, rects in layer.get("coverage", {}).items():
        for r in rects:
            keys += [(r["face"], int(L), x, y) for x in range(r["x0"], r["x1"] + 1) for y in range(r["y0"], r["y1"] + 1)]
    return keys


def _check_height(key):
    f, L, x, y = key
    p = layout.tile_file(rt.TILESET, "height", f, L, x, y, "hgt")
    t = frt1.from_file_bytes(p.read_bytes())
    h = t["heights"]
    ok = t["kind"] == "height" and (t["width"], t["height"], t["border"]) == (259, 259, 1) and bool(np.isfinite(h).all())
    ok = ok and math.log2(t["scale"]) % 1 == 0 and abs(float(h.min()) - t["hMin"]) < 1e-3 and abs(float(h.max()) - t["hMax"]) < 1e-3
    edges = {"l": h[:, 1].copy(), "r": h[:, 257].copy(), "b": h[1, :].copy(), "t": h[257, :].copy()}
    return key, ok, t["scale"], p.stat().st_size, edges


def _check_albedo(key):
    f, L, x, y = key
    p = layout.tile_file(rt.TILESET, "albedo", f, L, x, y, "webp")
    b = p.read_bytes()
    chunk = b[12:16]
    alpha_flag = chunk == b"VP8X" and bool(b[20] & 0x10)
    riff_ok = b[:4] == b"RIFF" and b[8:12] == b"WEBP" and chunk in (b"VP8 ", b"VP8L", b"VP8X")
    with Image.open(io.BytesIO(b)) as im:
        im.load()
        mode, size = im.mode, im.size
    # lossy 'VP8 ' cannot carry alpha; VP8X declares it in a flag; a decoder reporting RGB has none
    no_alpha = not alpha_flag and mode == "RGB"
    return key, riff_ok and mode == "RGB" and size == (256, 256), no_alpha, len(b), chunk.decode("ascii")


def check_tiles(manifest: dict) -> dict:
    res = {}
    h = manifest["layers"]["height"]
    keys = all_keys(h)
    layout.validate_manifest(json.loads(json.dumps(manifest)))
    edges: dict = {}
    bad, nbytes, scales = 0, 0, {}
    with rt.pool() as p:
        for key, ok, scale, n, e in p.imap_unordered(_check_height, keys, chunksize=32):
            bad += 0 if ok else 1
            nbytes += n
            edges[key] = (scale, e)
            scales.setdefault(key[1], set()).add(scale)
    check(bad == 0, f"height: all {len(keys)} promised tiles exist and decode (259x259, finite, power-of-two scale, header min/max)")
    res["height"] = {"tiles": len(keys), "bytes": nbytes, "scalesPerLevel": {str(k): sorted(v) for k, v in sorted(scales.items())}}
    for L, sc in scales.items():
        pref = h["heightScales"][L]
        check(min(sc) >= pref, f"height level {L}: tile scales {sorted(sc)} >= preferred {pref}")
    # pyramid completeness: every tile's parent exists
    missing_parent = [k for k in keys if k[1] > 0 and not layout.layer_has_tile(h, k[0], k[1] - 1, k[2] >> 1, k[3] >> 1)]
    check(not missing_parent, f"height pyramid complete (tiles without parent: {len(missing_parent)})")
    a = manifest["layers"]["albedo"]
    akeys = all_keys(a)
    bad, alpha, abytes, chunks = 0, 0, 0, {}
    with rt.pool() as p:
        for key, ok, no_alpha, n, ch in p.imap_unordered(_check_albedo, akeys, chunksize=64):
            bad += 0 if ok else 1
            alpha += 0 if no_alpha else 1
            abytes += n
            chunks[ch] = chunks.get(ch, 0) + 1
    check(bad == 0, f"albedo: all {len(akeys)} promised tiles exist and decode as 256x256 RGB WebP")
    check(alpha == 0, f"albedo: no tile has an alpha channel (chunk types {chunks})")
    res["albedo"] = {"tiles": len(akeys), "bytes": abytes, "chunkTypes": chunks}
    g = manifest["globals"]["albedoLowRes"]
    with Image.open(rt.TILES_ROOT / rt.TILESET / g["path"]) as im:
        check(im.size == (g["width"], g["height"]) == (1024, 512) and im.mode == "RGB", f"albedoLowRes {im.size} {im.mode}")
    res["edges"] = check_shared_edges(edges)
    return res


# -- 2. shared edges ---------------------------------------------------------------------------------------
def check_shared_edges(edges: dict) -> dict:
    """Edge samples of every tile against its +u and +v neighbours (same level, across cube edges too)."""
    k = np.arange(257) / 256.0
    pairs = same = differ_scale = 0
    worst = 0.0
    names = {(1.0, None): "r", (0.0, None): "l", (None, 1.0): "t", (None, 0.0): "b"}
    for key, (scale, e) in edges.items():
        f, L, x, y = key
        for edge, uu, vv in (("r", np.ones(257), k), ("t", k, np.ones(257))):
            mid = cube.tile_uv_to_dir(f, L, x, y, 1.0 + 1e-6 if edge == "r" else 0.5, 1.0 + 1e-6 if edge == "t" else 0.5)
            nf, nx, ny, _, _ = cube.dir_to_tile(mid, L)
            nkey = (nf, L, nx, ny)
            if nkey not in edges:
                continue
            d = cube.tile_uv_to_dir(f, L, x, y, uu, vv)
            # face coordinates on the NEIGHBOUR's face (on a cube edge dir_to_face_st would pick the lower id)
            dn = d @ cube.FACE_N[nf]
            s, t = (d @ cube.FACE_U[nf]) / dn, (d @ cube.FACE_V[nf]) / dn
            n = 2 ** L
            nu = np.round(((s + 1) / 2 * n - nx) * 256) / 256
            nv = np.round(((t + 1) / 2 * n - ny) * 256) / 256
            if np.all(nu == nu[0]) and nu[0] in (0.0, 1.0):
                nedge, idx = names[(nu[0], None)], np.round(nv * 256).astype(int)
            elif np.all(nv == nv[0]) and nv[0] in (0.0, 1.0):
                nedge, idx = names[(None, nv[0])], np.round(nu * 256).astype(int)
            else:
                raise RuntimeError(f"edge of {key} does not map onto an edge of {nkey}")
            a = e[edge][1:258]
            nscale, ne = edges[nkey]
            b = ne[nedge][1:258][idx]
            pairs += 1
            if scale != nscale:
                differ_scale += 1
                worst = max(worst, float(np.abs(a - b).max()) / max(scale, nscale))
                continue
            if np.array_equal(a, b):
                same += 1
    check(same == pairs - differ_scale, f"shared edges: {same}/{pairs - differ_scale} equal-scale neighbour pairs bit-identical "
                                        f"(incl. cube edges); {differ_scale} pairs of different scale within {worst:.2f} counts of the coarser scale")
    return {"pairs": pairs, "identical": same, "differentScale": differ_scale, "differentScaleMaxCountsOfCoarser": worst}


# -- 3. LOLA benchmarks -------------------------------------------------------------------------------------
def benchmarks(reader: TileReader) -> dict:
    out = {}
    for name, row, col, ref in BENCHMARKS:
        lat = 90.0 - (row + 0.5) / 64.0
        lon = (col + 0.5) / 64.0
        d = cube.lat_lon_to_dir(math.radians(lat), math.radians(lon))[None]
        g = (np.arange(8) + 0.5) / 8 - 0.5
        LA, LO = np.meshgrid(lat + g / 64, lon + g / 64, indexing="ij")
        box = cube.lat_lon_to_dir(np.radians(LA), np.radians(LO))
        p6 = float(reader.bicubic(d, 6)[0])
        m6 = float(reader.bicubic(box, 6).mean())
        # same point in PDS ldem_256 (independent 256 ppd product of the same team)
        q = ("00n_90n" if lat >= 0 else "90s_00s") + "_" + ("000_180" if lon < 180 else "180_360")
        r256 = int(((90.0 - lat) if lat >= 0 else -lat) * 256)
        c256 = int((lon % 180.0) * 256)
        v = np.frombuffer(fetch.read_range(LDEM256 + f"ldem_256_{q}.img", (r256 * 46080 + c256) * 2, 2), "<i2")[0] * 0.5
        e = {"latDeg": lat, "lonDeg": lon, "ldem64": ref, "ldem256Pixel": float(v), "level6Point": round(p6, 2),
             "level6MeanOverLdem64Pixel": round(m6, 2), "diffPoint": round(p6 - ref, 2), "diffMean": round(m6 - ref, 2)}
        out[name] = e
        check(abs(m6 - ref) <= 60.0, f"benchmark {name}: level 6 {m6:.1f} m (mean over the ldem_64 pixel; point {p6:.1f}) vs ldem_64 {ref} m, "
                                     f"ldem_256 pixel {v:.1f} m (limit 60 m)")
    lat, lon, ref = 90.0 - 5717.5 / 64.0, 1502.5 / 64.0, -1925.0
    d = cube.lat_lon_to_dir(math.radians(lat), math.radians(lon))[None]
    p12 = float(reader.data_height(d, 12)[0])
    g = (np.arange(32) + 0.5) / 32 - 0.5
    LA, LO = np.meshgrid(lat + g / 64, lon + g / 64, indexing="ij")
    m12 = float(reader.data_height(cube.lat_lon_to_dir(np.radians(LA), np.radians(LO)).reshape(-1, 3), 12).mean())
    out["Tranquility level 12"] = {"point": p12, "meanOverLdem64Pixel": m12}
    check(abs(p12 - ref) <= 5.0, f"Tranquility at level 12: point {p12:.2f} m, mean over the ldem_64 pixel {m12:.2f} m vs {ref} (limit 5 m)")
    return out


# -- 4. regional checks ---------------------------------------------------------------------------------
def coverage_edges(reader: TileReader, per_tile: int = 1500) -> dict:
    """Level-L data (Catmull-Rom of its tiles) against the surface the run time blends it into, the
    coverage-blended parent surface D_(L-1), at random points of the quarter-tile ring (0 < w_L < 1).

    Random (u, v) rather than vertices: a vertex of the ring sits on a parent grid node, where a margin tile
    holds a quantised copy of the parent sample by construction, so vertices alone cannot see a mismatch of
    the interpolated surfaces between nodes."""
    meta = reader.meta
    rng = np.random.default_rng(11)
    out = {}
    for Ls in sorted(meta["coverage"], key=int):
        L = int(Ls)
        pts = []
        for r in meta["coverage"][Ls]:
            for x in range(r["x0"], r["x1"] + 1):
                for y in range(r["y0"], r["y1"] + 1):
                    if r["x0"] < x < r["x1"] and r["y0"] < y < r["y1"]:
                        continue
                    U, V = rng.random(per_tile), rng.random(per_tile)
                    pts.append(cube.tile_uv_to_dir(r["face"], L, x, y, U, V).reshape(-1, 3))
        d = np.concatenate(pts)
        w = reader.coverage_weight(d, L)
        ring = d[(w > 0.0) & (w < 1.0)]
        a = reader.bicubic(ring, L)
        b = reader.data_height(ring, L - 1)
        rms = float(np.sqrt(np.mean((a - b) ** 2)))
        out[Ls] = {"ringSamples": int(len(ring)), "rmsM": rms, "maxAbsM": float(np.abs(a - b).max()),
                   "p99AbsM": float(np.percentile(np.abs(a - b), 99))}
        lim = 3.0 if L == meta["globalMaxLevel"] + 1 else 1.0
        check(rms < lim, f"coverage edge level {L}: level-{L} data vs the blended level-{L - 1} surface at {len(ring)} random ring points: "
                         f"RMS {rms:.3f} m, p99 {out[Ls]['p99AbsM']:.3f} m, max {out[Ls]['maxAbsM']:.3f} m (limit {lim} m RMS)")
    return out


def source_coverage(reader: TileReader, model: RegionModel) -> dict:
    """The height layer's sourceCoverage (docs/requests/terrain-core-1.md): inside coverage, and every
    direction where a band's source has weight > 0 lies in a source rectangle of that band's levels."""
    meta = reader.meta
    sc = meta.get("sourceCoverage")
    check(sc is not None and set(sc) == set(meta["coverage"]), "height layer has sourceCoverage for every regional level")
    if sc is None:
        return {}
    ok_inside = all(any(r["face"] == q["face"] and q["x0"] <= r["x0"] and r["x1"] <= q["x1"] and q["y0"] <= r["y0"] and r["y1"] <= q["y1"]
                        for q in meta["coverage"][L]) for L, rs in sc.items() for r in rs)
    missing = 0
    for b in model.bands:
        g = b.grid
        rr, cc = np.nonzero(g.valid[::8, ::8])
        lat, lon = g.pixel_to_latlon(rr * 8.0, cc * 8.0)
        d = cube.lat_lon_to_dir(np.radians(lat), np.radians(lon))
        for L in b.levels:
            w = model.weight(b.k, d, lat, lon, np.full(len(lat), 1.0))
            f, x, y, _, _ = dirs_to_tiles(d[w > 0], L)
            for key in set(zip(f.tolist(), x.tolist(), y.tolist())):
                if not any(r["face"] == key[0] and r["x0"] <= key[1] <= r["x1"] and r["y0"] <= key[2] <= r["y1"] for r in sc[str(L)]):
                    missing += 1
    tiles = {L: sum((r["x1"] - r["x0"] + 1) * (r["y1"] - r["y0"] + 1) for r in rs) for L, rs in sc.items()}
    check(ok_inside and missing == 0, f"sourceCoverage inside coverage and covering all source data (tiles per level {tiles}; "
                                      f"source tiles outside it: {missing})")
    return {"tilesPerLevel": tiles, "sourceTilesOutside": missing}


def nac_seam(region: dict) -> dict:
    """The stereo-seam correction of the NAC source, re-run on the published DTM (see region.correct_column_seam)."""
    from moon.region import acquire_raw_source, correct_column_seam

    sid = next(s for s, d in region["sources"].items() if d.get("seamCorrection"))
    _, rep = correct_column_seam(acquire_raw_source(region, sid).mips[0], region["sources"][sid]["seamCorrection"])
    tab = rep.pop("blockTable")
    print(f"INFO NAC stereo seam: tracked as one path, columns {rep['pathColumns'][0]}-{rep['pathColumns'][1]}, step sign {rep['sign']:+d}; "
          f"{rep['correctedBlocks']} of {rep['blocks']} blocks of {region['sources'][sid]['seamCorrection']['blockRows']} rows corrected "
          f"({rep['fullyCorrectedBlocks']} fully); step at the path in those blocks RMS {rep['rmsStepBeforeM']:.3f} -> {rep['rmsStepAfterM']:.3f} m, "
          f"max {rep['maxStepBeforeM']:.3f} -> {rep['maxStepAfterM']:.3f} m (block noise {rep['medianStepNoiseM']:.3f} m); "
          f"largest change {rep['maxAbsChangeM']:.3f} m")
    return {**rep, "blockTable": tab}


# Worst column's across-track roughness / its neighbouring columns. Raw SLDEM2015 over the Tranquility disc: 2.65
# (61 columns > 1.3); isotropic terrain (the rows, E-W control): up to 1.31; the corrected source: 1.47 (3
# columns > 1.3), where a track error inside a crater exceeds the 3 m clamp.
STRIPE_RATIO_LIMIT = 1.6


def track_stripes(region: dict, reader: TileReader, model: RegionModel) -> dict:
    """Altimeter-track stripes (region.correct_track_stripes) in the SHIPPED data: the top level of every band
    whose source carries trackStripeCorrection is sampled at the source's own pixel centres over a square inside
    the band's full-weight area, and each column's across-track roughness is compared with its neighbours (the
    rows, i.e. the E-W direction, are the control). The raw source over the same square is shown for reference."""
    from moon.region import acquire_raw_source, line_roughness_ratio

    out = {}
    for b in model.bands:
        sc = region["sources"][b.source_id].get("trackStripeCorrection")
        if not sc:
            continue
        if b.area["kind"] != "disc":
            raise ValueError(f"band {b.id}: track-stripe check expects a disc band")
        L = b.levels[-1]
        c = region["centre"]
        half_m = (b.area["radiusM"] - b.feather) / math.sqrt(2.0) - 500.0
        g = b.grid
        r0, c0 = (float(v[0]) for v in g.latlon_to_pixel(np.array([c["latDeg"]]), np.array([c["lonDeg"]])))
        n = int(half_m / abs(float(g.transform.a)))
        rows, cols = np.arange(int(r0) - n, int(r0) + n + 1), np.arange(int(c0) - n, int(c0) + n + 1)
        R, C = np.meshgrid(rows, cols, indexing="ij")
        lat, lon = g.pixel_to_latlon(R.astype(np.float64), C.astype(np.float64))
        d = cube.lat_lon_to_dir(np.radians(lat), np.radians(lon)).reshape(-1, 3)
        shipped = reader.data_height(d, L).reshape(R.shape)
        raw = acquire_raw_source(region, b.source_id).mips[0][rows[0]:rows[-1] + 1, cols[0]:cols[-1] + 1].astype(np.float64)
        res = {"level": L, "squareHalfM": half_m, "pixels": int(R.size)}
        for name, arr in (("raw", raw), ("shipped", shipped)):
            cr, rr = line_roughness_ratio(arr, 1), line_roughness_ratio(arr, 0)
            res[name] = {"columnRatioMax": float(cr.max()), "columnsAbove1p3": int((cr > 1.3).sum()),
                         "rowRatioMax": float(rr.max()), "rowsAbove1p3": int((rr > 1.3).sum())}
        out[b.source_id] = res
        s, w = res["shipped"], res["raw"]
        check(s["columnRatioMax"] < STRIPE_RATIO_LIMIT,
              f"no altimeter-track stripes in level {L} ({b.source_id}, {R.shape[0]} x {R.shape[1]} source pixel centres inside the "
              f"{b.area['radiusM'] / 1000:.0f} km disc): worst column roughness {s['columnRatioMax']:.2f} x its neighbours, "
              f"{s['columnsAbove1p3']} columns > 1.3 (raw source {w['columnRatioMax']:.2f}, {w['columnsAbove1p3']} columns; "
              f"E-W control: worst row {s['rowRatioMax']:.2f}) (limit {STRIPE_RATIO_LIMIT})")
    return out


def nac_edge_bias(region: dict, model: RegionModel) -> dict:
    """How much the edge-local NAC bias (biasEdgeSmoothingM) changes the heights inside the mission disc."""
    t = region.get("recommendedTarget")
    k = next(b.k for b in model.bands if b.area["kind"] == "sourceFootprint")
    b = model.bands[k]
    z = np.load(rt.MOON_WORK / f"region-{region['id']}" / f"bias-{b.id}.npz")
    if t is None or "bias_wide" not in z.files:
        check(False, "edge-local NAC bias: recommendedTarget and the wide bias field are needed (re-run region.py)")
        return {}
    ts = region["targetSearch"]
    la, lo = math.radians(t["latDeg"]), math.radians(t["lonDeg"])
    c = cube.lat_lon_to_dir(la, lo)
    e = np.array([-math.sin(lo), math.cos(lo), 0.0])
    n = np.cross(c, e)
    k_ = np.arange(-ts["missionRadiusM"], ts["missionRadiusM"] + 1.0, 10.0)
    X, Y = np.meshgrid(k_, k_)
    inside = np.hypot(X, Y) <= ts["missionRadiusM"]
    p = rt.MOON_RADIUS * c + X[inside][:, None] * e + Y[inside][:, None] * n
    d = p / np.linalg.norm(p, axis=-1, keepdims=True)
    lat, lon = (np.degrees(v) for v in cube.dir_to_lat_lon(d))
    row, col = b.grid.latlon_to_pixel(lat, lon)
    f = 2.0 ** int(z["mip"])
    from moon.region import bilinear
    delta = bilinear(z["bias"].astype(np.float64) - z["bias_wide"].astype(np.float64), (row + 0.5) / f - 0.5, (col + 0.5) / f - 0.5)
    w = model.weight(k, d, lat, lon, np.full(len(lat), 2.0))
    dh = np.abs(w * delta)
    r = np.hypot(X[inside], Y[inside])
    edge_d = bilinear(b.dist, row, col)
    out = {"missionRadiusM": ts["missionRadiusM"], "maxAbsM": float(dh.max()), "p95AbsM": float(np.percentile(dh, 95)),
           "fractionAbove0p5M": float(np.mean(dh > 0.5)), "nearestStripEdgeM": float(edge_d.min()),
           "untouchedWithinM": float(r[dh > 0.01].min()) if np.any(dh > 0.01) else float(ts["missionRadiusM"])}
    print(f"INFO edge-local NAC bias inside the {ts['missionRadiusM']:.0f} m mission disc (the disc comes within {out['nearestStripEdgeM']:.0f} m "
          f"of the NAC strip edge): height change max {out['maxAbsM']:.2f} m, p95 {out['p95AbsM']:.2f} m, {100 * out['fractionAbove0p5M']:.1f} % "
          f"of the disc > 0.5 m; below 1 cm within {out['untouchedWithinM']:.0f} m of the target")
    return out


def nac_blend(model: RegionModel) -> dict:
    """Systematic offset between the bias-corrected NAC and the SLDEM-based surface inside the 300 m feather."""
    k = next(b.k for b in model.bands if b.area["kind"] == "sourceFootprint")
    b = model.bands[k]
    g = b.grid
    step = 4
    rr, cc = np.mgrid[0:g.valid.shape[0]:step, 0:g.valid.shape[1]:step]
    dist = b.dist[rr, cc]
    lv = max(b.levels)
    fp = 3.0
    start = g.stencil_reach_m(fp) + b.inset
    band = (dist > start) & (dist < start + b.feather)
    r, c = rr[band].astype(np.float64), cc[band].astype(np.float64)
    lat, lon = g.pixel_to_latlon(r, c)
    d = cube.lat_lon_to_dir(np.radians(lat), np.radians(lon))
    fpv = np.full(len(lat), fp)
    base = model.height(k - 1, d, fpv)
    nac = g.sample(lat, lon, fpv) - model.bias_at(k, lat, lon)
    diff = nac - base
    # local means along the boundary: 500 m segments (by source row block and side of the strip)
    seg = (r // (500.0 / g.ky)).astype(int) * 4 + np.where(c < g.valid.shape[1] / 2, 0, 1) * 2
    means = [float(diff[seg == s].mean()) for s in np.unique(seg) if np.sum(seg == s) > 50]
    worst = float(np.max(np.abs(means)))
    out = {"level": lv, "featherSamples": int(len(diff)), "rmsNacMinusSldemM": float(np.sqrt(np.mean(diff ** 2))),
           "segments500m": len(means), "maxAbsSegmentMeanM": worst}
    check(worst < 1.0, f"NAC/SLDEM blend: largest 500 m-segment mean offset in the 300 m feather {worst:.3f} m "
                       f"(RMS of local relief difference {out['rmsNacMinusSldemM']:.2f} m) (limit 1 m step)")
    return out


def rms_slope(reader: TileReader, model: RegionModel) -> dict:
    k = next(b.k for b in model.bands if b.area["kind"] == "sourceFootprint")
    g = model.bands[k].grid
    rng = np.random.default_rng(7)
    inner = np.argwhere(model.bands[k].dist > 500.0)
    pick = inner[rng.choice(len(inner), 40000, replace=False)].astype(np.float64)
    lat, lon = g.pixel_to_latlon(pick[:, 0], pick[:, 1])
    out = {}
    for bl in (2.0, 4.0, 8.0):
        az = rng.uniform(0, 2 * math.pi, len(lat))
        dlat = np.degrees(bl * np.cos(az) / rt.MOON_RADIUS)
        dlon = np.degrees(bl * np.sin(az) / (rt.MOON_RADIUS * np.cos(np.radians(lat))))
        d0 = cube.lat_lon_to_dir(np.radians(lat), np.radians(lon))
        d1 = cube.lat_lon_to_dir(np.radians(lat + dlat), np.radians(lon + dlon))
        h0, h1 = reader.bicubic(d0, 12), reader.bicubic(d1, 12)
        s = np.arctan(np.abs(h1 - h0) / bl)
        r0, c0 = pick[:, 0], pick[:, 1]
        r1, c1 = g.latlon_to_pixel(lat + dlat, lon + dlon)
        src = g.mips[0].astype(np.float64)
        n0 = ndimage.map_coordinates(src, [r0, c0], order=1)
        n1 = ndimage.map_coordinates(src, [r1, c1], order=1)
        sn = np.arctan(np.abs(n1 - n0) / bl)
        out[f"{bl:g}m"] = {"level12RmsSlopeDeg": float(np.degrees(np.sqrt(np.mean(s ** 2)))),
                           "level12RmsTan": float(np.sqrt(np.mean(np.tan(s) ** 2))),
                           "nacSourceRmsSlopeDeg": float(np.degrees(np.sqrt(np.mean(sn ** 2))))}
    print("INFO RMS slope of level-12 data inside the NAC DTM (40,000 random pairs, random azimuths): "
          + ", ".join(f"{k_}: {v['level12RmsSlopeDeg']:.2f} deg (source NAC {v['nacSourceRmsSlopeDeg']:.2f} deg)" for k_, v in out.items()))
    return out


def target(region: dict, reader: TileReader) -> dict:
    t = region.get("recommendedTarget")
    check(t is not None, "recommendedTarget present in the region file")
    if t is None:
        return {}
    ts = region["targetSearch"]
    c = t["criteria"]
    d = cube.lat_lon_to_dir(math.radians(t["latDeg"]), math.radians(t["lonDeg"]))[None]
    h = float(reader.data_height(d, ts["level"])[0])
    check(abs(h - t["heightM"]) < 0.05, f"target height re-evaluated {h:.2f} m = recorded {t['heightM']} m")
    check(c["planeSlopeDeg"] < ts["maxSlopeDeg"] and c["steepestBaselineSlopeDeg"] < ts["maxSlopeDeg"],
          f"target slope over {ts['slopeBaselineM']} m: plane fit {c['planeSlopeDeg']} deg, steepest {c['steepestBaselineSlopeDeg']} deg (< {ts['maxSlopeDeg']})")
    check(c["nearestCraterDistanceM"] > ts["craterExclusionRadiusM"],
          f"target: nearest crater >= {ts['craterMinDiameterM']} m is {c['nearestCraterDistanceM']} m away (> {ts['craterExclusionRadiusM']} m)")
    check(c["maxHorizonDeg"] < ts["minSunElevationDeg"] - ts["horizonMarginDeg"],
          f"target lit: horizon toward azimuths {ts['sunAzimuthsDeg']} at most {c['maxHorizonDeg']} deg (sun >= {ts['minSunElevationDeg']} deg)")
    # coverage: whole disc of discRadius + inset inside level-12 coverage, weight 1 over discRadius
    la, lo = math.radians(t["latDeg"]), math.radians(t["lonDeg"])
    cdir = cube.lat_lon_to_dir(la, lo)
    e = np.array([-math.sin(lo), math.cos(lo), 0.0])
    n = np.cross(cdir, e)
    rads = np.arange(0.0, ts["discRadiusM"] + ts["discInsetM"] + 1.0, 25.0)
    angs = np.radians(np.arange(0.0, 360.0, 2.0))
    RR, AA = np.meshgrid(rads, angs)
    p = rt.MOON_RADIUS * cdir + (RR * np.sin(AA))[..., None] * e + (RR * np.cos(AA))[..., None] * n
    dd = (p / np.linalg.norm(p, axis=-1, keepdims=True)).reshape(-1, 3)
    f, x, y, _, _ = dirs_to_tiles(dd, ts["level"])
    inside = all(reader.has(int(a), ts["level"], int(b), int(cc)) for a, b, cc in set(zip(f, x, y)))
    wmin = float(reader.coverage_weight(dd[RR.ravel() <= ts["discRadiusM"]], ts["level"]).min())
    check(inside and wmin == 1.0, f"target: disc of {ts['discRadiusM'] + ts['discInsetM']} m inside level-{ts['level']} coverage, "
                                  f"coverage weight over the {ts['discRadiusM']} m disc min {wmin}")
    return {**t, "heightReevaluatedM": h, "coverageInside": inside, "minCoverageWeight": wmin}


# -- 5. albedo de-shading ----------------------------------------------------------------------------------
class AlbedoReader:
    def __init__(self, level: int):
        self.level = level
        self.cache: dict = {}

    def linear(self, dirs: np.ndarray) -> np.ndarray:
        shp = dirs.shape[:-1]
        d = dirs.reshape(-1, 3)
        f, x, y, u, v = dirs_to_tiles(d, self.level)
        out = np.zeros((len(d), 3))
        for key in set(zip(f.tolist(), x.tolist(), y.tolist())):
            sel = (f == key[0]) & (x == key[1]) & (y == key[2])
            if key not in self.cache:
                with Image.open(layout.tile_file(rt.TILESET, "albedo", key[0], self.level, key[1], key[2], "webp")) as im:
                    self.cache[key] = srgb_decode(np.asarray(im.convert("RGB"), dtype=np.float64) / 255.0)
            a = self.cache[key]
            cx = np.clip(u[sel] * 256 - 0.5, 0, 255)
            cy = np.clip(v[sel] * 256 - 0.5, 0, 255)
            x0, y0 = np.minimum(cx.astype(int), 254), np.minimum(cy.astype(int), 254)
            tx, ty = (cx - x0)[:, None], (cy - y0)[:, None]
            out[sel] = ((1 - ty) * ((1 - tx) * a[y0, x0] + tx * a[y0, x0 + 1]) + ty * ((1 - tx) * a[y0 + 1, x0] + tx * a[y0 + 1, x0 + 1]))
        return out.reshape(shp + (3,))


def deshading(reader: TileReader) -> dict:
    wins = rt.read_json(rt.MOON_WORK / "crater_windows.json")
    L7, L5 = AlbedoReader(7), AlbedoReader(5)
    rows = []
    for c in wins:
        step = 200.0
        r7 = craters.wall_ratio(lambda d: L7.linear(d)[..., 0], c, step, reader)
        r5 = craters.wall_ratio(lambda d: L5.linear(d)[..., 0], c, step, reader)
        # raw WAC (illumination baked in) on its crop, for contrast
        W = np.memmap(rt.MOON_WORK / "crater_crops" / f"{c['name']}.W.f32", dtype=np.float32, mode="r",
                      shape=(c["r1"] - c["r0"], c["c1"] - c["c0"]))

        def wac(d, W=W, c=c):
            la, lo = (np.degrees(a) for a in cube.dir_to_lat_lon(d))
            rr = (90.0 - la) / 180.0 * 54582 - 0.5 - c["r0"]
            cc = (np.mod(lo + 180.0, 360.0)) / 360.0 * 109164 - 0.5 - c["c0"]
            return W[np.clip(np.round(rr).astype(int), 0, W.shape[0] - 1), np.clip(np.round(cc).astype(int), 0, W.shape[1] - 1)]

        rw = craters.wall_ratio(wac, c, step, reader)
        rows.append({"name": c["name"], "latDeg": round(c["latDeg"], 3), "lonDeg": round(c["lonDeg"], 3),
                     "rimRadiusKm": round(c["rimRadiusM"] / 1000, 2), "ratioLevel7": round(r7["ratio"], 4),
                     "ratioLevel5SvsOnly": round(r5["ratio"], 4), "ratioRawWac": round(rw["ratio"], 4)})
    ok = [r for r in rows if abs(r["ratioLevel7"] - 1.0) <= 0.05]
    print("INFO crater wall brightness west-facing / east-facing (level 7 final | level 5 SVS only | raw WAC mosaic):")
    for r in rows:
        print(f"     {r['name']:14s} {r['ratioLevel7']:.3f} | {r['ratioLevel5SvsOnly']:.3f} | {r['ratioRawWac']:.3f}")
    lf = np.log([r["ratioLevel7"] for r in rows])
    lw = np.log([r["ratioRawWac"] for r in rows])
    corr = float(np.corrcoef(lf, lw)[0, 1])
    mean_ratio = float(np.exp(lf.mean()))
    print(f"INFO residual wall asymmetry vs the mosaic's baked shading: correlation of log ratios {corr:.3f} "
          f"(residual shading would correlate); geometric-mean ratio over all craters {mean_ratio:.3f} (not an acceptance "
          f"criterion: the brief asks for each of 20 craters within 5 %, see docs/requests/bake-moon-sky-2.md)")
    check(len(ok) >= 20, f"albedo de-shading: {len(ok)} of {len(rows)} craters have a west-/east-facing wall brightness ratio within 5 % at level 7 "
                         f"(median |1 - ratio| {np.median([abs(r['ratioLevel7'] - 1) for r in rows]):.3f}; raw WAC "
                         f"{np.median([abs(r['ratioRawWac'] - 1) for r in rows]):.3f})")
    return {"craters": rows, "within5pct": len(ok), "correlationWithRawShading": corr, "geometricMeanRatio": mean_ratio}


# -- 6. TypeScript decoder ---------------------------------------------------------------------------------
def ts_decode(manifest: dict) -> dict:
    h = manifest["layers"]["height"]
    r12 = h["coverage"][str(max(int(k) for k in h["coverage"]))][0]
    keys = [(0, 0, 0, 0), (4, 6, 17, 40), (r12["face"], int(max(int(k) for k in h["coverage"])), (r12["x0"] + r12["x1"]) // 2,
                                               (r12["y0"] + r12["y1"]) // 2)]
    files = [layout.tile_file(rt.TILESET, "height", k[0], k[1], k[2], k[3], "hgt") for k in keys]
    npx = "npx.cmd" if sys.platform == "win32" else "npx"
    res = subprocess.run([npx, "tsx", "tools/bake/moon/decode-check.node.ts", *map(str, files)], cwd=rt.REPO_ROOT,
                         capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        check(False, f"TypeScript decode failed: {res.stderr[-400:]}")
        return {}
    ts = json.loads(res.stdout.strip().splitlines()[-1])
    out = []
    for k, f, t in zip(keys, files, ts):
        p = frt1.from_file_bytes(f.read_bytes())
        sha = hashlib.sha256(p["heights"].astype("<f4").tobytes()).hexdigest()
        same = sha == t["sha256"] and p["scale"] == t["scale"] and p["offset"] == t["offset"]
        out.append({"tile": "/".join(map(str, k)), "sha256": sha, "identical": same, "scale": p["scale"]})
        check(same, f"TypeScript tileCodec decode of height/{'/'.join(map(str, k))} is bit-identical to the Python decode")
    return {"tiles": out}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="moon-tranquility")
    a = ap.parse_args()
    rt.check_python()
    rt.below_normal_priority()
    t0 = time.time()
    manifest = layout.read_manifest(rt.TILESET)
    reader = TileReader(rt.TILESET, cache_tiles=1024)
    region = load_region(a.region)
    OUT["tiles"] = check_tiles(manifest)
    OUT["benchmarks"] = benchmarks(reader)
    OUT["coverageEdges"] = coverage_edges(reader)
    model = RegionModel(region, reader)
    OUT["sourceCoverage"] = source_coverage(reader, model)
    OUT["nacSeam"] = nac_seam(region)
    OUT["trackStripes"] = track_stripes(region, reader, model)
    OUT["nacBlend"] = nac_blend(model)
    OUT["nacEdgeBias"] = nac_edge_bias(region, model)
    OUT["rmsSlope"] = rms_slope(reader, model)
    OUT["target"] = target(region, reader)
    OUT["deshading"] = deshading(reader)
    OUT["tsDecode"] = ts_decode(manifest)
    sizes = {"height": rt.dir_size(rt.TILES_ROOT / rt.TILESET / "height"), "albedo": rt.dir_size(rt.TILES_ROOT / rt.TILESET / "albedo"),
             "globals": rt.dir_size(rt.TILES_ROOT / rt.TILESET / "globals")}
    sizes["total"] = rt.dir_size(rt.TILES_ROOT / rt.TILESET)
    OUT["sizes"] = sizes
    print("INFO sizes (GB): " + ", ".join(f"{k} {v / 1e9:.3f}" for k, v in sizes.items()))
    print(f"INFO Moon tile set size {sizes['total'] / 1e9:.2f} GB (the brief's estimate was 4-7 GB)")
    OUT["failures"] = FAIL
    OUT["seconds"] = time.time() - t0
    rt.write_json(rt.MOON_OUT / "verify.json", OUT)
    print(f"{'ALL CHECKS PASSED' if not FAIL else str(len(FAIL)) + ' CHECK(S) FAILED'} ({time.time() - t0:.0f} s)")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
