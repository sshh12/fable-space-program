"""Acceptance checks of the earth tile set (work package bake-earth).

    python -I tools/bake/earth/verify.py [--quick]
    python -I tools/bake/earth/verify.py --region <id> [--quick]

Prints one line per check (PASS / FAIL with the measured numbers) and writes out/bake/earth/verify.json.
Exit code 0 only when every check passes. --quick decodes a 1-in-16 sample of the tiles instead of all.
--region checks one region only (work package site-bake), staged or live: its tiles, the prospective manifest,
its pads (data/staged/sites), sourceCoverage, seams, coverage edges, coastline, pits, needles, the near-shore sea
floor, relief shading near the site and the TypeScript decode; writes out/bake/earth/verify-<id>.json. Without
--region, staged regions (stage.py) are not checked: they are not in the live tile set yet.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
VENV = REPO / "data" / "cache" / "earth" / "venv"
VENV_PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

if __name__ == "__main__" and Path(sys.prefix).resolve() != VENV.resolve():
    if not VENV_PY.is_file():
        sys.exit(subprocess.call([sys.executable, "-I", str(HERE / "bake.py"), "status"]) or
                 subprocess.call([str(VENV_PY), "-I", str(Path(__file__).resolve()), *sys.argv[1:]]))
    sys.exit(subprocess.call([str(VENV_PY), "-I", str(Path(__file__).resolve()), *sys.argv[1:]]))

sys.path.insert(0, str(HERE.parent))

import io  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import time  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage  # noqa: E402

from common import cube, frt1, layout  # noqa: E402
from earth import paths, region as regmod, tiles  # noqa: E402
from earth.hpyramid import TileCache, bilinear_from_tiles, locate  # noqa: E402
from earth.util import pool, read_json, set_below_normal, write_json  # noqa: E402

RESULTS: list[dict] = []
LUMA = np.array([0.2126, 0.7152, 0.0722])


def check(name: str, ok: bool, detail: str, data=None) -> bool:
    RESULTS.append({"check": name, "pass": bool(ok), "detail": detail, "data": data})
    print(f"{'PASS' if ok else 'FAIL'}  {name}: {detail}", flush=True)
    return ok


INFO: list[dict] = []


def info(name: str, detail: str) -> None:
    """A measurement reported for the record that is not an acceptance gate."""
    INFO.append({"measurement": name, "detail": detail})
    print(f"INFO  {name}: {detail}", flush=True)


# ---------------------------------------------------------------------------------------------- helpers
def all_tiles(m: dict, layer: str) -> list[tuple[int, int, int, int]]:
    L = m["layers"][layer]
    out = [(f, lv, x, y) for lv in range(L["globalMaxLevel"] + 1) for f in range(6)
           for x in range(2 ** lv) for y in range(2 ** lv)]
    for lv, rects in L.get("coverage", {}).items():
        for r in rects:
            out += [(r["face"], int(lv), x, y) for x in range(r["x0"], r["x1"] + 1) for y in range(r["y0"], r["y1"] + 1)]
    return out


def webp_has_alpha(data: bytes) -> bool:
    """True if a WebP file carries alpha (VP8X alpha flag, ALPH chunk, or lossless with alpha)."""
    if data[:4] != b"RIFF" or data[8:12] != b"WEBP":
        raise ValueError("not a WebP file")
    pos = 12
    while pos + 8 <= len(data):
        tag = data[pos:pos + 4]
        size = int.from_bytes(data[pos + 4:pos + 8], "little")
        if tag == b"VP8X" and data[pos + 8] & 0x10:
            return True
        if tag == b"ALPH":
            return True
        if tag == b"VP8L" and (data[pos + 8 + 4] >> 4) & 1:    # alpha_is_used bit of the lossless header
            return True
        pos += 8 + size + (size & 1)
    return False


def _decode_chunk(args) -> dict:
    layer, ext, keys = args
    bad, alpha, n = [], 0, 0
    for f, lv, x, y in keys:
        p = tiles.tile_file(layer, f, lv, x, y)          # the live path, or the stage of a staged region
        try:
            b = p.read_bytes()
            if ext == "webp":
                if webp_has_alpha(b):
                    alpha += 1
                im = Image.open(io.BytesIO(b))
                im.load()
                if im.mode != "RGB" or im.size != (256, 256):
                    bad.append(f"{f}/{lv}/{x}/{y}: {im.mode} {im.size}")
            else:
                t = frt1.from_file_bytes(b)
                if layer == "height":
                    if (t["width"], t["height"], t["border"]) != (259, 259, 1) or not np.isfinite(t["heights"]).all():
                        bad.append(f"{f}/{lv}/{x}/{y}: bad height tile")
                elif (t["width"], t["height"], t["channels"]) != (256, 256, 1):
                    bad.append(f"{f}/{lv}/{x}/{y}: bad u8 tile")
            n += 1
        except Exception as e:  # report every undecodable tile
            bad.append(f"{f}/{lv}/{x}/{y}: {e}")
    return {"bad": bad, "alpha": alpha, "n": n}


def height_at(cache_by_level: dict, level: int, lat, lon) -> np.ndarray:
    """Catmull-Rom of the vertex grid of the level's tiles (the height authority's interpolant)."""
    d = cube.lat_lon_to_dir(np.radians(np.ravel(lat)), np.radians(np.ravel(lon)))
    face, x, y, u, v = locate(d, level)
    out = np.empty(face.size)
    c = cache_by_level.setdefault(level, TileCache(level, tiles.read_height))
    for i in range(face.size):
        h = c.get(int(face[i]), int(x[i]), int(y[i]))
        gi, gj = 1.0 + u[i] * 256.0, 1.0 + v[i] * 256.0
        i0, j0 = int(math.floor(gi)), int(math.floor(gj))
        i0 = min(max(i0, 1), 256)
        j0 = min(max(j0, 1), 256)
        fx, fy = gi - i0, gj - j0

        def w(t):
            t2, t3 = t * t, t * t * t
            return ((-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2)
        wx, wy = w(fx), w(fy)
        acc = 0.0
        for jj in range(4):
            row = 0.0
            for ii in range(4):
                row += wx[ii] * h[min(max(j0 - 1 + jj, 0), 258), min(max(i0 - 1 + ii, 0), 258)]
            acc += wy[jj] * row
        out[i] = acc
    return out


def max_near(level: int, lat: float, lon: float, radius_m: float, cache: dict, step_m: float = 10.0) -> float:
    from earth.site import destination
    k = np.arange(-radius_m, radius_m + 1, step_m)
    E, N = np.meshgrid(k, k)
    m = np.hypot(E, N) <= radius_m
    la, lo = destination(lat, lon, E[m], N[m])
    # vertex values of the tiles touched are what matters for the maximum; sample densely (bilinear grid)
    d = cube.lat_lon_to_dir(np.radians(la), np.radians(lo))
    c = cache.setdefault(level, TileCache(level, tiles.read_height))
    return float(bilinear_from_tiles(d, c).max())


# ---------------------------------------------------------------------------------------------- checks
def check_files(m: dict, quick: bool) -> None:
    t0 = time.time()
    n = layout.verify_files_exist(m)
    check("files", True, f"all {n} tiles promised by the manifest exist ({time.time() - t0:.0f} s)")
    jobs = []
    for layer, L in m["layers"].items():
        keys = all_tiles(m, layer)
        if quick:
            keys = keys[::16]
        for i in range(0, len(keys), 4000):
            jobs.append((layer, L["ext"], keys[i:i + 4000]))
    bad, alpha, total = [], 0, 0
    with pool() as ex:
        for r in ex.map(_decode_chunk, jobs):
            bad += r["bad"]
            alpha += r["alpha"]
            total += r["n"]
    check("decode", not bad, f"{total} tiles decoded{' (1 in 16 sample)' if quick else ''}, {len(bad)} failures"
          + (f": {bad[:5]}" if bad else ""))
    check("no alpha in image tiles", alpha == 0, f"{alpha} albedo/night WebP tiles carry alpha")
    for g, meta in m["globals"].items():
        p = paths.TILES / meta["path"]
        im = Image.open(p)
        ok = im.size == (meta["width"], meta["height"]) and len(im.getbands()) == len(meta["channels"])
        check(f"global {g}", ok, f"{meta['path']} {im.size} bands {im.getbands()} (manifest {meta['channels']})")


def check_pyramid(m: dict) -> None:
    layout.validate_manifest(json.loads(json.dumps(m)))
    missing = 0
    n = 0
    for name, L in m["layers"].items():
        for lv, rects in L.get("coverage", {}).items():
            for r in rects:
                for x in range(r["x0"], r["x1"] + 1):
                    for y in range(r["y0"], r["y1"] + 1):
                        n += 1
                        if not layout.layer_has_tile(L, r["face"], int(lv) - 1, x >> 1, y >> 1):
                            missing += 1
    check("pyramid completeness", missing == 0, f"{n} regional tiles, {missing} without a parent; manifest validates")


def check_source_coverage(m: dict, regions: list[str] | None = None) -> None:
    """`layers.height.sourceCoverage` (docs/requests/terrain-core-1.md, -4.md) lists, per regional level, exactly
    the tiles that touch the area where the regional source has weight and hold land, all inside the coverage; at a
    level whose parent's vertices are already finer than the land source (heights.source_finer_than_parent) none."""
    from earth.heights import source_finer_than_parent, source_land_tiles
    L = m["layers"]["height"]
    sc = L.get("sourceCoverage", {})
    for r_id in (regmod.list_regions() if regions is None else regions):
        reg = regmod.load(r_id)
        own = {lv: {(r["face"], x, y) for r in regmod.coverage_rects(reg, lv)
                    for x in range(r["x0"], r["x1"] + 1) for y in range(r["y0"], r["y1"] + 1)} for lv in regmod.levels(reg)}
        rows = []
        ok = True
        for lv in regmod.levels(reg):
            listed = {(r["face"], x, y) for r in sc.get(str(lv), [])
                      for x in range(r["x0"], r["x1"] + 1) for y in range(r["y0"], r["y1"] + 1)} & own[lv]
            want = set(source_land_tiles(reg, lv)) if source_finer_than_parent(reg, lv) else set()
            inside = all(layout.layer_has_tile(L, f, lv, x, y) for f, x, y in listed)
            ok &= listed == want and inside
            rows.append(f"level {lv}: {len(listed)} tiles in {len(sc.get(str(lv), []))} rects (expected {len(want)}, "
                        f"{len(listed ^ want)} differ, inside coverage {inside})")
        check(f"height sourceCoverage {r_id}", ok, "; ".join(rows))


def check_heights(m: dict) -> None:
    cache: dict = {}
    ev = max_near(7, 27.9881, 86.9250, 8000.0, cache, 50.0)
    check("Everest level 7", ev > 8300, f"max {ev:.1f} m within 8 km (need > 8300)")
    cd = _min_near(7, 11.35, 142.20, 30000.0, cache)
    check("Challenger Deep level 7", cd < -10400, f"min {cd:.1f} m within 30 km (need < -10400)")
    regs = [regmod.load(r) for r in regmod.list_regions()]
    finest = max([7] + [regmod.levels(r)[-1] for r in regs])
    mk = max_near(finest, 19.8207, -155.4681, 1500.0, cache)
    check(f"Mauna Kea level {finest}", abs(mk - 4207) <= 40, f"summit {mk:.1f} m (4207 +/- 40)")
    ml = max_near(finest, 19.4794, -155.6028, 3000.0, cache)
    check(f"Mauna Loa level {finest}", abs(ml - 4169) <= 40, f"summit {ml:.1f} m (4169 +/- 40)")
    for r in regs:
        p = paths.SITES_DIR / f"{r['site']}.location.json"
        if p.is_file():
            loc = read_json(p)
            h = float(height_at(cache, finest, loc["latDeg"], loc["lonDeg"])[0])
            check(f"pad {r['site']}", abs(h - loc["padElevation"]) <= 2.0,
                  f"level-{finest} height {h:.2f} m at the location file's coordinates vs padElevation {loc['padElevation']} m")
    check_staged_pads([r["id"] for r in regs], cache)


def staged_pads(region_id: str) -> list[dict]:
    """Pad files of data/staged/sites resolved on this region (padresolve.py)."""
    d = paths.REPO / "data" / "staged" / "sites"
    out = []
    for p in sorted(d.glob("*.pads.json")) if d.is_dir() else []:
        doc = read_json(p)
        if doc.get("region") == region_id:
            out.append(doc)
    return out


def reference_point(reg: dict) -> dict:
    """The site's reference point on a region: the site's location file when it exists, else the reference pad of
    a pads file resolved on the region, else the region's centre."""
    p = paths.SITES_DIR / f"{reg['site']}.location.json"
    if p.is_file():
        return read_json(p)
    for doc in staged_pads(reg["id"]):
        ref = next(q for q in doc["pads"] if q["id"] == doc["referencePad"])
        return {"latDeg": ref["latDeg"], "lonDeg": ref["lonDeg"], "padElevation": ref["padElevation"]}
    c = reg["shape"]["centre"]
    return {"latDeg": c["latDeg"], "lonDeg": c["lonDeg"], "padElevation": "terrain"}


def check_staged_pads(regions: list[str], cache: dict) -> None:
    """Every resolved pad (data/staged/sites/<site>.pads.json): the finest-level height at its coordinates (the
    authority's bicubic) within 2 m of its padElevation, and its recorded evaluation passes the rule."""
    for r_id in regions:
        reg = regmod.load(r_id)
        lv = regmod.levels(reg)[-1]
        for doc in staged_pads(r_id):
            worst, bad = 0.0, []
            for p in doc["pads"]:
                h = float(height_at(cache, lv, p["latDeg"], p["lonDeg"])[0])
                worst = max(worst, abs(h - p["padElevation"]))
                if abs(h - p["padElevation"]) > 2.0 or (not p["fixed"] and not p["report"]["passes"]):
                    bad.append(p["id"])
            check(f"pads {doc['site']} on {r_id}", not bad,
                  f"{len(doc['pads'])} pads: level-{lv} height vs padElevation within {worst:.2f} m (need 2), every "
                  f"resolved pad passes the rule" + (f"; failing: {bad}" if bad else ""))


def _min_near(level, lat, lon, radius_m, cache):
    from earth.site import destination
    k = np.arange(-radius_m, radius_m + 1, 100.0)
    E, N = np.meshgrid(k, k)
    msk = np.hypot(E, N) <= radius_m
    la, lo = destination(lat, lon, E[msk], N[msk])
    d = cube.lat_lon_to_dir(np.radians(la), np.radians(lo))
    c = cache.setdefault(level, TileCache(level, tiles.read_height))
    return float(bilinear_from_tiles(d, c).min())


def _edge_values(f, lv, x, y, side):
    """Vertex values and directions along one edge (side: 0 u=0, 1 u=1, 2 v=0, 3 v=1), border excluded."""
    t = frt1.from_file_bytes(tiles.tile_file("height", f, lv, x, y).read_bytes())
    h = t["heights"]
    k = np.arange(257) / 256.0
    if side == 0:
        vals, u, v = h[1:258, 1], np.zeros(257), k
    elif side == 1:
        vals, u, v = h[1:258, 257], np.ones(257), k
    elif side == 2:
        vals, u, v = h[1, 1:258], k, np.zeros(257)
    else:
        vals, u, v = h[257, 1:258], k, np.ones(257)
    return vals, cube.tile_uv_to_dir(f, lv, x, y, u, v), t["scale"]


def _vertex_value(f, lv, d):
    """Value of the vertex at direction d on face f (projected with face f's own basis)."""
    n, U, V = cube.FACE_N[f], cube.FACE_U[f], cube.FACE_V[f]
    dn = d @ n
    s, t = (d @ U) / dn, (d @ V) / dn
    N = 2 ** lv
    gs = (s + 1.0) / 2.0 * N * 256.0
    gt = (t + 1.0) / 2.0 * N * 256.0
    ix, iy = np.rint(gs).astype(int), np.rint(gt).astype(int)
    if np.max(np.abs(gs - ix)) > 1e-6 or np.max(np.abs(gt - iy)) > 1e-6:
        raise ValueError("edge directions are not vertices of the neighbouring face")
    out = np.empty(d.shape[0])
    scales = set()
    for k in range(d.shape[0]):
        tx, ty = min(ix[k] // 256, N - 1), min(iy[k] // 256, N - 1)
        t_ = frt1.from_file_bytes(tiles.tile_file("height", f, lv, tx, ty).read_bytes())
        out[k] = t_["heights"][iy[k] - ty * 256 + 1, ix[k] - tx * 256 + 1]
        scales.add(t_["scale"])
    return out, scales


def check_seams_height(m: dict) -> None:
    rng = np.random.default_rng(5)
    compared = mismatched = skipped = 0
    # (a) every cube edge at levels 0-3: walk the tiles along each face edge, compare with the other face
    for lv in range(4):
        N = 2 ** lv
        for f in range(6):
            for side in range(4):
                for k in range(N):
                    x, y = {0: (0, k), 1: (N - 1, k), 2: (k, 0), 3: (k, N - 1)}[side]
                    vals, d, sc = _edge_values(f, lv, x, y, side)
                    # the face across this edge: nudge the edge midpoint outward along the face plane
                    g, _, _ = cube.dir_to_face_st(d[128] + (d[128] - cube.FACE_N[f] * (d[128] @ cube.FACE_N[f])) * 1e-6)
                    other = int(g)
                    if other == f:
                        continue
                    ov, oscales = _vertex_value(other, lv, d)
                    compared += 1
                    if oscales != {sc}:
                        skipped += 1
                        continue
                    if not np.array_equal(ov.astype(np.float32), vals.astype(np.float32)):
                        mismatched += 1
    check("height seams across cube edges, levels 0-3", mismatched == 0 and compared > 0,
          f"{compared} tile edges on cube edges compared, {mismatched} differ, {skipped} skipped (scale differs)")
    # (b) random same-face neighbours at every level, including regional levels
    compared = mismatched = skipped = 0
    for name, L in [("height", m["layers"]["height"])]:
        cand = []
        for lv in range(L["globalMaxLevel"] + 1):
            for _ in range(60):
                N = 2 ** lv
                if N < 2:
                    break
                f = int(rng.integers(6))
                x, y = int(rng.integers(N - 1)), int(rng.integers(N - 1))
                cand.append((f, lv, x, y))
        for lv, rects in L.get("coverage", {}).items():
            for r in rects:
                for _ in range(80):
                    if r["x1"] > r["x0"] and r["y1"] > r["y0"]:
                        cand.append((r["face"], int(lv), int(rng.integers(r["x0"], r["x1"])), int(rng.integers(r["y0"], r["y1"]))))
        for f, lv, x, y in cand:
            for (dx, dy, sa, sb) in ((1, 0, 1, 0), (0, 1, 3, 2)):
                a, _, sa_ = _edge_values(f, lv, x, y, sa)
                b, _, sb_ = _edge_values(f, lv, x + dx, y + dy, sb)
                compared += 1
                if sa_ != sb_:
                    skipped += 1
                elif not np.array_equal(a, b):
                    mismatched += 1
    check("height seams between neighbouring tiles", mismatched == 0,
          f"{compared} shared edges compared (global and regional levels), {mismatched} differ, {skipped} skipped (scale differs)")


def check_roundtrip() -> None:
    ref = read_json(paths.REFS / "height-etopo.json")
    lat, lon = np.array(ref["lat"]), np.array(ref["lon"])
    # (a) mapping round trip
    d = cube.lat_lon_to_dir(np.radians(lat), np.radians(lon))
    face, x, y, u, v = locate(d, 7)
    back = np.stack([cube.tile_uv_to_dir(int(face[i]), 7, int(x[i]), int(y[i]), u[i], v[i]) for i in range(lat.size)])
    err_m = np.linalg.norm(back - d, axis=1) * paths.RADIUS        # chord length (arccos is too coarse here)
    texel_m = ref["texelDeg"] * 111_195.0
    # (b) baked level-7 heights vs the source raster, as equivalent displacement in source texels
    cache: dict = {}
    baked = height_at(cache, 7, lat, lon)
    diff = baked - np.array(ref["value"])
    g = np.hypot(np.array(ref["gradEast"]), np.array(ref["gradNorth"]))
    sel = g > 20.0
    disp = np.abs(diff[sel]) / g[sel]
    rms = float(np.sqrt(np.mean(disp ** 2)))
    ge, gn = np.array(ref["gradEast"])[sel], np.array(ref["gradNorth"])[sel]
    A = np.stack([ge, gn], axis=1)
    shift = np.linalg.lstsq(A, diff[sel], rcond=None)[0]
    check("cube mapping round trip", float(err_m.max()) < 1e-3,
          f"1000 lat/lon -> tile (u, v) -> lat/lon, max error {err_m.max():.2e} m")
    check("registration vs source raster", rms < 0.5,
          f"{int(sel.sum())} points with relief: RMS equivalent displacement {rms:.3f} source texels "
          f"(fitted mean shift east {shift[0]:+.3f}, north {shift[1]:+.3f} texels; {texel_m:.0f} m texels); "
          f"RMS height difference over all {lat.size} points {np.sqrt(np.mean(diff ** 2)):.2f} m")


def _read_rgb(f, lv, x, y):
    return tiles.read_webp("albedo", f, lv, x, y).astype(np.float64)


def check_albedo_seams(m: dict) -> None:
    """Mean |difference| of the texel pairs that straddle a tile border vs interior texel pairs, per level group.

    For seamless tiles both have the same expectation, so the measured means differ only by sampling noise of
    either sign. The gate is therefore: the border mean exceeds the mean of the interior pairs right next to
    the same borders (same rows, columns 254|255 and 0|1: same content) by no more than two standard errors
    of that paired difference. A seam (compression or registration) shows up as a border excess of many
    standard errors (independently compressed lossy WebP q90 tiles: +0.45 levels, about 60 % of the interior
    mean). The plain mean over all interior pairs of the tiles is reported alongside."""
    rng = np.random.default_rng(9)
    L = m["layers"]["albedo"]
    groups = {"global level 7": [(int(rng.integers(6)), 7, int(rng.integers(127)), int(rng.integers(127)))
                                 for _ in range(1000)]}
    for lv, rects in sorted(L.get("coverage", {}).items(), key=lambda kv: int(kv[0])):
        keys = []
        for r in rects:
            keys += [(r["face"], int(lv), int(rng.integers(r["x0"], r["x1"])), int(rng.integers(r["y0"], r["y1"])))
                     for _ in range(150)]
        groups[f"regional level {lv}"] = keys
    for name, keys in groups.items():
        border, adjacent, interior = [], [], []
        for f, lv, x, y in keys:
            a = _read_rgb(f, lv, x, y)
            b = _read_rgb(f, lv, x + 1, y)
            c = _read_rgb(f, lv, x, y + 1)
            for p, q in ((a, b), (np.swapaxes(a, 0, 1), np.swapaxes(c, 0, 1))):     # east and north neighbour
                border.append(np.abs(p[:, 255] - q[:, 0]).mean())
                adjacent.append(0.5 * (np.abs(p[:, 254] - p[:, 255]).mean() + np.abs(q[:, 0] - q[:, 1]).mean()))
                interior.append(np.abs(p[:, 1:] - p[:, :-1]).mean())
        border, adjacent = np.array(border), np.array(adjacent)
        d = border - adjacent
        se = float(d.std(ddof=1) / math.sqrt(d.size))
        check(f"albedo seams, {name}", float(d.mean()) <= 2.0 * se,
              f"{d.size} tile borders: mean |difference| across the border {border.mean():.3f}, interior pairs next "
              f"to it {adjacent.mean():.3f} (excess {d.mean():+.4f}, 2 s.e. {2 * se:.4f}), all interior pairs "
              f"{np.mean(interior):.3f} (sRGB levels)")


def check_coverage_edges(m: dict, regions: list[str] | None = None) -> None:
    from earth import regional
    from earth.sample import bicubic
    for r_id in (regmod.list_regions() if regions is None else regions):
        reg = regmod.load(r_id)
        cache: dict = {}
        worst_h = 0.0
        details = []
        for lv in regmod.levels(reg):
            rects = regmod.coverage_rects(reg, lv)
            diffs_h, diffs_a, diffs_w = [], [], []
            maxa = maxw = 0.0
            for rc in rects:
                f = rc["face"]
                ring = [(x, rc["y0"], 2) for x in range(rc["x0"], rc["x1"] + 1)] + \
                       [(x, rc["y1"], 3) for x in range(rc["x0"], rc["x1"] + 1)] + \
                       [(rc["x0"], y, 0) for y in range(rc["y0"], rc["y1"] + 1)] + \
                       [(rc["x1"], y, 1) for y in range(rc["y0"], rc["y1"] + 1)]
                for x, y, side in ring:                     # every tile of the outer ring
                    vals, d, _ = _edge_values(f, lv, x, y, side)
                    la, lo = tiles.dirs_latlon(d)
                    par = height_at(cache, lv - 1, la, lo)
                    diffs_h.append(vals - par)
                    for layer, reader, store, mx in (("albedo", _read_rgb, diffs_a, "a"), ("watermask", None, diffs_w, "w")):
                        if layer == "albedo":
                            t = _read_rgb(f, lv, x, y)
                            up = regional.parent_upsample("albedo", f, lv, x, y, _read_rgb)
                        else:
                            t = tiles.read_u8("watermask", f, lv, x, y)[..., None].astype(np.float64)
                            up = regional.parent_upsample("watermask", f, lv, x, y,
                                                          lambda a, b, c, e: tiles.read_u8("watermask", a, b, c, e)[..., None].astype(np.float64))
                        row = {0: (slice(None), 0), 1: (slice(None), 255), 2: (0, slice(None)), 3: (255, slice(None))}[side]
                        dd = np.abs(t[row] - up[row])
                        store.append(dd)
                        if layer == "albedo":
                            maxa = max(maxa, float(dd.max()))
                        else:
                            maxw = max(maxw, float(dd.max()))
            dh = np.concatenate(diffs_h)
            rms = float(np.sqrt(np.mean(dh ** 2)))
            ma = float(np.mean(np.concatenate([a.ravel() for a in diffs_a])))
            mw = float(np.mean(np.concatenate([a.ravel() for a in diffs_w])))
            worst_h = max(worst_h, rms)
            ok = rms < 3.0 and maxa <= 2.0 and maxw <= 2.0
            details.append(ok)
            check(f"coverage edge {r_id} level {lv}", ok,
                  f"height vs bicubic parent RMS {rms:.2f} m (< 3); outermost texel row vs bilinear parent: albedo "
                  f"max {maxa:.0f} (mean {ma:.2f}) /255, watermask max {maxw:.0f} (mean {mw:.2f}) /255 (every texel "
                  f"within 2)")


def check_water_fraction() -> None:
    lv = 5
    num = den = 0.0
    k = (np.arange(256) + 0.5) / 256
    for f in range(6):
        for x in range(32):
            for y in range(32):
                s = -1 + 2 * (x + k) / 32
                t = -1 + 2 * (y + k) / 32
                S, T = np.meshgrid(s, t)
                w = (1 + S * S + T * T) ** -1.5          # gnomonic area element
                mk = tiles.read_u8("watermask", f, lv, x, y) / 255.0
                num += float((w * mk).sum())
                den += float(w.sum())
    frac = num / den
    check("water area fraction", 0.70 <= frac <= 0.72, f"{frac * 100:.2f} % of the sphere at level 5 (need 70-72 %)")


def coast_points(level: int, n_pts: int, rng, pick, max_tries: int = 40000) -> list:
    """Height zero crossings between horizontally adjacent vertices of stored height tiles at one level:
    (face, x, y, j, uu) with j the vertex row and uu the crossing in vertex (= texel edge) units. pick() draws
    a tile key (face, x, y) or None."""
    pts = []
    tries = 0
    while len(pts) < n_pts and tries < max_tries:
        tries += 1
        k = pick()
        if k is None:
            continue
        f, x, y = k
        h = tiles.read_height(f, level, x, y)[1:258, 1:258]
        sc = np.nonzero(((h[:, :-1] > 0) & (h[:, 1:] < 0)) | ((h[:, :-1] < 0) & (h[:, 1:] > 0)))
        if sc[0].size == 0:
            continue
        i = int(rng.integers(sc[0].size))
        j, c = int(sc[0][i]), int(sc[1][i])
        a, b = float(h[j, c]), float(h[j, c + 1])
        # a coast, not a pit, pinnacle or channel narrower than a texel (below the mask's 1/16 texel quantum)
        nb_a = h[max(j - 1, 0):j + 2, max(c - 1, 0):c + 2]
        nb_b = h[max(j - 1, 0):j + 2, c:c + 3]
        if (np.sign(nb_a) == np.sign(a)).sum() < 3 or (np.sign(nb_b) == np.sign(b)).sum() < 3:
            continue
        pts.append((f, x, y, j, c + a / (a - b)))
    return pts


def coast_window(m: np.ndarray, j: int, uu: float):
    """The mask texels within one texel of a crossing, and 'ok' if the anti-aliased shoreline (texels neither
    all land nor all water, or a land/water change) passes there, else 'land' / 'water' (uniform window)."""
    r = min(max(j, 0), 255)
    c0 = int(math.floor(uu - 0.5))
    rs = slice(max(r - 1, 0), min(r + 1, 255) + 1)
    cs = slice(max(c0 - 1, 0), min(c0 + 2, 255) + 1)
    win = m[rs, cs]
    if (win.min() < 250.0 and win.max() > 5.0) or ((win >= 128).any() and (win < 128).any()):
        return "ok", rs, cs
    return ("water" if win.min() >= 250.0 else "land"), rs, cs


# open-sea fjords and inlets that MODIS 250 m maps as land (review of 2026-11-10): the mask must follow the sea
FJORD_PROBES = [(65.669, -39.623), (67.657, -65.977), (67.705, -33.159)]


def check_coastline() -> None:
    """Global level 7: on 1000 sampled height zero crossings the mask's shoreline lies within one texel, except
    where the bake deliberately departs from the height sign, which needs independent evidence:
      - the mask is LAND on both sides: only if the below-sea-level texel there is NOT connected to the ocean
        (watermask.py: an enclosed basin, or shallow ground MODIS maps as land with no deep ground next to it;
        the class map the bake writes for every tile);
      - the mask is WATER on both sides: water above sea level, i.e. inland water (MODIS lakes).
    Every other disagreement is a failure (an ocean-connected fjord drawn as land, for example)."""
    from earth import watermask as wmod
    rng = np.random.default_rng(3)
    pts = coast_points(7, 1000, rng, lambda: (int(rng.integers(6)), int(rng.integers(128)), int(rng.integers(128))))
    tally = {"ok": 0, "lake": 0, "basin": 0, "shallow": 0, "bad": 0}
    bad = []
    for f, x, y, j, uu in pts:
        kind, rs, cs = coast_window(tiles.read_u8("watermask", f, 7, x, y).astype(np.float64), j, uu)
        if kind == "ok":
            tally["ok"] += 1
        elif kind == "water":
            tally["lake"] += 1
        else:
            cls = wmod.inland_class(f, x, y)[rs, cs]
            if (cls == 1).any():
                tally["basin"] += 1
            elif (cls == 2).any():
                tally["shallow"] += 1
            else:
                tally["bad"] += 1
                la, lo = tiles.dirs_latlon(cube.tile_uv_to_dir(f, 7, x, y, np.array([uu / 256]), np.array([(j + 0.5) / 256])))
                bad.append(f"{float(la[0]):.3f} {float(lo[0]):.3f}")
    probes, fj_ok = [], True
    for la, lo in FJORD_PROBES:
        f, x, y, u, v = cube.dir_to_tile(cube.lat_lon_to_dir(math.radians(la), math.radians(lo)), 7)
        h = tiles.read_height(f, 7, x, y).astype(np.float64)
        hc = 0.25 * (h[1:257, 1:257] + h[1:257, 2:258] + h[2:258, 1:257] + h[2:258, 2:258])
        m = tiles.read_u8("watermask", f, 7, x, y)
        r, c = min(int(v * 256), 255), min(int(u * 256), 255)
        sl = (slice(max(r - 1, 0), r + 2), slice(max(c - 1, 0), c + 2))
        sea = hc[sl] < 0
        wet = int((m[sl][sea] >= 128).sum())
        fj_ok &= wet == int(sea.sum())
        probes.append(f"{la:.3f} {lo:.3f}: mask water on {wet} of the {int(sea.sum())} texels below sea level "
                      f"(deepest {hc[sl].min():.0f} m)")
    n = len(pts)
    check("coastline agreement", tally["bad"] == 0 and n >= 1000 and fj_ok,
          f"of {n} sampled level-7 height zero crossings, {tally['ok']} have the mask's 50 % contour within one "
          f"texel ({tally['ok'] / max(1, n) * 100:.1f} %); deliberate departures with independent evidence: "
          f"{tally['basin']} in enclosed basins below sea level not connected to the ocean, {tally['shallow']} on "
          f"shallow below-sea-level ground MODIS maps as land with no deep ground next to it (polders, ETOPO coast "
          f"offsets), {tally['lake']} at inland water above sea level; {tally['bad']} other disagreements"
          + (f" ({', '.join(bad[:8])})" if bad else "") + f". Open-sea fjords MODIS misses: {'; '.join(probes)}",
          tally)


def check_regional_coastline(regions: list[str] | None = None) -> None:
    """Regional levels: the mask's shoreline lies within one texel of the regional height's zero crossing,
    except at inland water above sea level and where the global level-7 mask also calls the below-sea-level
    ground dry; crossings in the 64-texel coverage feather are skipped (blended into the parent there)."""
    from earth import regional
    for r_id in (regmod.list_regions() if regions is None else regions):
        reg = regmod.load(r_id)
        for lv in regmod.levels(reg):
            rects = regmod.coverage_rects(reg, lv)
            rng = np.random.default_rng(100 + lv)
            finest = lv == regmod.levels(reg)[-1]

            def pick():
                rc = rects[int(rng.integers(len(rects)))]
                return rc["face"], int(rng.integers(rc["x0"], rc["x1"] + 1)), int(rng.integers(rc["y0"], rc["y1"] + 1))
            pts = coast_points(lv, 1000 if finest else 300, rng, pick, 60000)
            tally = {"ok": 0, "lake": 0, "dry": 0, "feather": 0, "bad": 0}
            bad = []
            for f, x, y, j, uu in pts:
                r, c0 = min(max(j, 0), 255), min(max(int(uu), 0), 255)
                if regional.boundary_distance(rects, f, lv, x, y)[r, c0] < regional.FEATHER_TEXELS:
                    tally["feather"] += 1
                    continue
                kind, rs, cs = coast_window(tiles.read_u8("watermask", f, lv, x, y).astype(np.float64), j, uu)
                if kind == "ok":
                    tally["ok"] += 1
                elif kind == "water":
                    tally["lake"] += 1
                else:
                    g7 = regional.parent_upsample("watermask", f, lv, x, y,
                                                  lambda a, b, c, e: tiles.read_u8("watermask", a, b, c, e)[..., None]
                                                  .astype(np.float64), ancestor=paths.GLOBAL_MAX_LEVEL)[..., 0]
                    if (g7[rs, cs] < 127.5).all():
                        tally["dry"] += 1
                    else:
                        tally["bad"] += 1
                        la, lo = tiles.dirs_latlon(cube.tile_uv_to_dir(f, lv, x, y, np.array([uu / 256]),
                                                                       np.array([(j + 0.5) / 256])))
                        bad.append(f"{float(la[0]):.4f} {float(lo[0]):.4f}")
            n = tally["ok"] + tally["lake"] + tally["dry"] + tally["bad"]
            check(f"regional coastline {r_id} level {lv}", tally["bad"] == 0 and n >= (500 if finest else 150),
                  f"of {n} sampled height zero crossings (outside the coverage feather; {tally['feather']} more inside "
                  f"it skipped), {tally['ok']} have the mask's 50 % contour within one texel; {tally['lake']} at inland "
                  f"water above sea level, {tally['dry']} on ground the global mask also keeps dry; {tally['bad']} "
                  f"other disagreements" + (f" ({', '.join(bad[:8])})" if bad else ""), tally)


def check_regional_needles(regions: list[str] | None = None) -> None:
    """No needle in the regional heights (docs/requests/terrain-render-2.md: corrupt survey samples on the
    shore stood up to 1,135 m above ground a few metres high): on the finest level of every region, no land
    vertex stands more than heights.SPIKE_EXCESS_M above the 75th percentile of its 9 x 9 neighbourhood,
    judged on 3 x 3 tile mosaics so that vertices at tile edges see their true neighbours. The coarser
    regional levels are averages of the finest one; their largest excess is reported."""
    from earth import heights
    for r_id in (regmod.list_regions() if regions is None else regions):
        reg = regmod.load(r_id)
        lv = regmod.levels(reg)
        finest = lv[-1]
        have = set(regmod.rect_tiles(regmod.coverage_rects(reg, finest)))
        cands = []
        tl = sorted(have)
        for i in range(0, len(tl), 64):
            cands.extend(heights._despike_scan_unit((r_id, finest, tuple(tl[i:i + 64]))))
        needles = 0
        worst = 0.0
        m = heights.M_MARGIN
        for f, x, y in cands:
            mos = np.full((769, 769), np.nan)
            for i in range(3):
                for j in range(3):
                    if (f, x - 1 + i, y - 1 + j) in have:
                        mos[j * 256:j * 256 + 257, i * 256:i * 256 + 257] = tiles.read_height(f, finest, x - 1 + i, y - 1 + j)[1:258, 1:258]
            sub = mos[256 - m:513 + m, 256 - m:513 + m]
            mask = heights.spike_mask(sub)[m:m + 257, m:m + 257]
            needles += int(mask.sum())
            filled = np.where(np.isnan(sub), -1e9, sub)
            excess = (filled - heights._p75(filled))[m:m + 257, m:m + 257]
            land = sub[m:m + 257, m:m + 257] > 0.0
            if land.any():
                worst = max(worst, float(excess[land].max()))
        check(f"height needles {r_id}", needles == 0,
              f"{needles} land vertices of level {finest} stand more than {heights.SPIKE_EXCESS_M:g} m above the 75th "
              f"percentile of their 9 x 9 neighbourhood ({len(tl)} tiles, {len(cands)} looked at closely; largest "
              f"excess {worst:.1f} m)", {"needles": needles, "candidates": len(cands), "largestExcessM": worst})


def check_regional_pits(regions: list[str] | None = None) -> None:
    """No closed depression in the regional heights that the source DEM does not have: on every regional
    tile, the 4-connected areas at or below 0.5 m that lie within its 3 x 3 tile neighbourhood, hold no sea floor
    (nothing below -2 m) and are ringed by ground more than 10 m high (median of the 3-vertex ring) are pits
    (inland water baked as sea, for example). Also: no regional vertex is stored as exactly 0 m (the sign of
    every vertex decides water for physics)."""
    for r_id in (regmod.list_regions() if regions is None else regions):
        reg = regmod.load(r_id)
        pits, zeros, tiles_n, big = [], 0, 0, 0
        for lv in regmod.levels(reg):
            rects = regmod.coverage_rects(reg, lv)
            cache: dict = {}

            def get(f, x, y):
                k = (f, x, y)
                if k not in cache:
                    h = tiles.read_height(f, lv, x, y)
                    cache[k] = None if h is None else h[1:257, 1:257].astype(np.float64)
                return cache[k]
            for rc in rects:
                f = rc["face"]
                for x in range(rc["x0"], rc["x1"] + 1):
                    for y in range(rc["y0"], rc["y1"] + 1):
                        tiles_n += 1
                        h0 = get(f, x, y)
                        zeros += int((h0 == 0.0).sum())
                        if not (h0 <= 0.5).any() or (h0 < -2.0).all():
                            continue
                        mos = np.full((768, 768), np.nan)
                        for i in range(3):
                            for j in range(3):
                                t = get(f, x - 1 + i, y - 1 + j) if 0 <= x - 1 + i < 2 ** lv and 0 <= y - 1 + j < 2 ** lv else None
                                if t is not None:
                                    mos[j * 256:(j + 1) * 256, i * 256:(i + 1) * 256] = t
                        low = np.nan_to_num(mos, nan=1e9) <= 0.5
                        lab, n = ndimage.label(low)      # 4-connected (diagonal = bilinear saddle)
                        edge = np.zeros_like(low)
                        edge[0, :] = edge[-1, :] = edge[:, 0] = edge[:, -1] = True
                        edge |= ndimage.binary_dilation(np.isnan(mos))
                        touching = set(np.unique(lab[edge & low]))
                        for L in np.unique(lab[256:512, 256:512]):
                            if L == 0:
                                continue
                            if L in touching:
                                big += 1
                                continue
                            comp = lab == L
                            if mos[comp].min() < -2.0:
                                continue
                            ring = ndimage.binary_dilation(comp, iterations=3) & ~comp & ~np.isnan(mos)
                            rim = float(np.median(mos[ring]))
                            if rim > 10.0:
                                jj, ii = np.nonzero(comp)
                                d = cube.tile_uv_to_dir(f, lv, x - 1, y - 1, np.array([ii.mean() / 256]), np.array([jj.mean() / 256]))
                                la, lo = tiles.dirs_latlon(d.reshape(-1, 3))
                                pits.append((rim, lv, float(la[0]), float(lo[0]), float(mos[comp].min()), int(comp.sum())))
                        if len(cache) > 3000:
                            for k in list(cache)[:1500]:
                                del cache[k]
        pits = sorted(set(pits), reverse=True)
        check(f"no inland pits in regional heights {r_id}", not pits and zeros == 0,
              f"{tiles_n} tiles of levels {regmod.levels(reg)[0]}-{regmod.levels(reg)[-1]}: {len(pits)} closed areas at "
              f"or below 0.5 m without sea floor under a rim more than 10 m high"
              + (": " + "; ".join(f"level {p[1]} {p[2]:.4f} {p[3]:.4f} rim {p[0]:.0f} m bottom {p[4]:.2f} m"
                                  for p in pits[:6]) if pits else "")
              + (f" (vertices per area: {[p[5] for p in pits]})" if pits else "")
              + f"; {zeros} vertices stored as exactly 0 m ({big} low areas reach beyond the 3 x 3 neighbourhood: sea)")


def near_shore_profile(regions: list[str] | None = None) -> None:
    """INFO: depth of the level-12 sea floor by distance from the shore, 8 x 8 km around each pad."""
    from earth.site import destination
    for r_id in (regmod.list_regions() if regions is None else regions):
        reg = regmod.load(r_id)
        lv = regmod.levels(reg)[-1]
        loc = reference_point(reg)
        k = np.arange(-4000.0, 4000.0, 10.0)
        E, N = np.meshgrid(k, k)
        la, lo = destination(loc["latDeg"], loc["lonDeg"], E.ravel(), N.ravel())
        d = cube.lat_lon_to_dir(np.radians(la), np.radians(lo))
        h = bilinear_from_tiles(d, TileCache(lv, tiles.read_height)).reshape(E.shape)
        sea = h < 0.0
        dist = ndimage.distance_transform_edt(sea) * 10.0
        parts = []
        for d0, d1 in ((0, 50), (50, 100), (100, 200), (200, 300), (300, 400), (400, 600), (600, 800), (800, 1000),
                       (1000, 1500)):
            s = sea & (dist > d0) & (dist <= d1)
            if s.any():
                parts.append(f"{d0}-{d1} m {np.median(h[s]):.1f}")
        shallow = sea & (h > -5.0)
        info(f"near-shore sea floor {r_id} level {lv}",
             f"median depth by distance from the shore (8 x 8 km around the pad, 10 m grid): {', '.join(parts)}; sea "
             f"shallower than 5 m reaches {np.percentile(dist[shallow], 95):.0f} m from the shore (95th percentile), "
             f"{dist[shallow].max():.0f} m at most; shallowest sea sample {h[sea].max():.3f} m")


ARID_RANGES = [("Tibesti", 21.0, 17.8), ("Hoggar", 23.3, 5.6), ("Sinai", 28.6, 33.9), ("Hajar", 23.1, 57.4),
               ("Kunlun", 36.0, 85.0), ("Panamint", 36.2, -117.1), ("Atacama Andes", -23.5, -68.0),
               ("Namib escarpment", -23.5, 15.8)]
# The source's own shading differs between ranges of the same latitude band and brightness by up to ~8 % (east
# over west: Tibesti 1.126, Hajar 1.050, both at 21-23 N; the composite mixes view geometries), so a per-band
# de-shading leaves about +/-4-5 % on single ranges; uncorrected or inverted shading is 10-30 %.
ARID_TOLERANCE = 0.06


def check_arid_aspect() -> None:
    """No relief shading in the global imagery (level 7): over hyper-arid bare ranges, where vegetation does
    not follow aspect, the mean albedo of east- vs west-facing and north- vs south-facing texels steeper than
    10 deg (3 x 3 level-7 tiles around each range; land, Y < 0.4) agree within ARID_TOLERANCE. Relief shading of the
    10:30 sun makes east-facing slopes brighter everywhere and equator-facing slopes brighter; an over-strong
    de-shading inverts both."""
    from earth.albedo import tile_normals
    rows, worst = [], 0.0
    for name, la, lo in ARID_RANGES:
        f, x0, y0, _, _ = cube.dir_to_tile(cube.lat_lon_to_dir(math.radians(la), math.radians(lo)), 7)
        Ys, NEs, NNs = [], [], []
        for x in range(x0 - 1, x0 + 2):
            for y in range(y0 - 1, y0 + 2):
                Y = tiles.srgb_to_linear(tiles.read_webp("albedo", f, 7, x, y)) @ LUMA
                ne, nn, _ = tile_normals(tiles.read_height(f, 7, x, y), f, 7, x, y)
                ok = (tiles.read_u8("watermask", f, 7, x, y) < 128) & (Y < 0.4)
                Ys.append(Y[ok])
                NEs.append(ne[ok])
                NNs.append(nn[ok])
        Y, ne, nn = np.concatenate(Ys), np.concatenate(NEs), np.concatenate(NNs)
        slope = np.degrees(np.arcsin(np.clip(np.hypot(ne, nn), 0, 1)))
        asp = (np.degrees(np.arctan2(ne, nn)) + 360) % 360
        st = slope > 10
        E, W = st & (asp > 45) & (asp < 135), st & (asp > 225) & (asp < 315)
        Nf, S = st & ((asp > 315) | (asp < 45)), st & (asp > 135) & (asp < 225)
        ew, ns = float(Y[E].mean() / Y[W].mean()), float(Y[Nf].mean() / Y[S].mean())
        worst = max(worst, abs(ew - 1), abs(ns - 1))
        rows.append(f"{name} E/W {ew:.3f} N/S {ns:.3f} ({int(E.sum())}/{int(W.sum())}/{int(Nf.sum())}/{int(S.sum())})")
    check("no relief shading in the global imagery", worst <= ARID_TOLERANCE,
          f"level 7, slopes > 10 deg, mean albedo ratios (need 1 +/- {ARID_TOLERANCE:.2f}; texels E/W/N/S): {'; '.join(rows)}; worst deviation {worst:.3f}")


def mauna_kea_east_west(lv: int, local_sigma_m: float = 300.0):
    """East- (45-135 deg) and west-facing (225-315 deg) texels steeper than 5 deg, above 3300 m (above the
    vegetation) and within 8 km of the Mauna Kea summit at one level: (east, west) linear luminance, and the
    same divided by the mean luminance of a local_sigma_m neighbourhood (both slopes of each cone or ridge
    against their common surroundings: illumination only, the summit's large-scale geology cancels)."""
    from scipy import ndimage as ndi
    from earth.albedo import tile_normals
    from earth.site import gc_distance_m
    f0, x0, y0, _, _ = cube.dir_to_tile(cube.lat_lon_to_dir(np.radians(19.8207), np.radians(-155.4681)), lv)
    span = max(1, int(math.ceil(8000.0 / (2460.0 * 2 ** (12 - lv)))))
    n = 2 * span + 1
    mos = {k: np.zeros((n * 256, n * 256)) for k in ("lum", "ne", "nn", "hc", "dist")}
    have = np.zeros((n * 256, n * 256), bool)
    for i, x in enumerate(range(x0 - span, x0 + span + 1)):
        for j, y in enumerate(range(y0 - span, y0 + span + 1)):
            if not tiles.exists("albedo", f0, lv, x, y):
                continue
            ne, nn, hc = tile_normals(tiles.read_height(f0, lv, x, y), f0, lv, x, y)
            la, lo = tiles.dirs_latlon(cube.image_tile_dirs(f0, lv, x, y))
            sl = (slice(j * 256, (j + 1) * 256), slice(i * 256, (i + 1) * 256))
            mos["lum"][sl] = tiles.srgb_to_linear(tiles.read_webp("albedo", f0, lv, x, y)) @ LUMA
            mos["ne"][sl], mos["nn"][sl], mos["hc"][sl] = ne, nn, hc
            mos["dist"][sl] = gc_distance_m(19.8207, -155.4681, la, lo).reshape(256, 256)
            have[sl] = True
    from earth.regional import texel_metres
    sig = local_sigma_m / texel_metres(f0, lv, x0, y0)
    wsum = ndi.gaussian_filter(have.astype(float), sig)
    local = ndi.gaussian_filter(np.where(have, mos["lum"], 0.0), sig) / np.maximum(wsum, 1e-9)
    rel = mos["lum"] / np.maximum(local, 1e-9)
    slope = np.degrees(np.arcsin(np.clip(np.hypot(mos["ne"], mos["nn"]), 0, 1)))
    aspect = (np.degrees(np.arctan2(mos["ne"], mos["nn"])) + 360) % 360
    sel = have & (mos["dist"] < 8000) & (mos["hc"] > 3300) & (slope > 5)
    e = sel & (aspect > 45) & (aspect < 135)
    w = sel & (aspect > 225) & (aspect < 315)
    return mos["lum"][e], mos["lum"][w], rel[e], rel[w]


def check_deshade() -> None:
    """No baked hillshade on Mauna Kea (east- vs west-facing slopes above 3300 m, within 8 km of the summit).

    Gate: the PAIRED ratio, each east- or west-facing texel divided by the mean of its own 300 m surroundings,
    so that both slopes of the same cone or ridge are compared under the same surface material. Shading by a
    morning sun brightens east-facing slopes against their surroundings and darkens west-facing ones, so it
    shows up 1:1 in this ratio; surface material at scales above 300 m cancels.
    Reported with it, not gated: the plain ratio of the two flank means (the brief's wording). It is about 0.94
    in the regional Sentinel-2 imagery, i.e. the east flank's summit cinders are darker material; a morning-sun
    shading residue would have the opposite sign, and no physically fitted de-shading (|alpha| < 0.06 on this
    composite) can or should move it. At level 7 (300 m texels, 200-300 texels per flank) both numbers are
    reported only: the paired ratio is insensitive at that resolution, and the global imagery is gated by
    check_arid_aspect instead. Hand-off section "Verification" has the full analysis."""
    regs = [regmod.load(r) for r in regmod.list_regions()]
    gates = sorted({regmod.levels(r)[-1] for r in regs} | {10} if regs else {7})
    for lv in sorted(set(gates) | {7}):
        e, w, re_, rw = mauna_kea_east_west(lv)
        if e.size < 10 or w.size < 10:
            check(f"no baked hillshade level {lv}", False, f"too few samples ({e.size} east, {w.size} west)")
            continue
        ratio = float(e.mean() / w.mean())
        local = float(re_.mean() / rw.mean())
        detail = (f"Mauna Kea above 3300 m, slopes > 5 deg ({e.size} east-, {w.size} west-facing texels): each slope "
                  f"against its 300 m surroundings, east/west ratio {local:.3f} (need 1 +/- 0.03); plain flank means "
                  f"{e.mean():.4f} / {w.mean():.4f} = {ratio:.3f} (surface material, reported only)")
        if lv in gates:
            check(f"no baked hillshade level {lv}", abs(local - 1) <= 0.03, detail)
        else:
            info(f"hillshade measure level {lv} (global imagery, 300 m texels)", detail)


def check_night() -> None:
    best = None
    for name, la, lo in (("Germany", 50.5, 9.5), ("US Midwest", 41.5, -89.0), ("northern India", 27.0, 80.0)):
        f, x, y, _, _ = cube.dir_to_tile(cube.lat_lon_to_dir(np.radians(la), np.radians(lo)), 7)
        a = tiles.read_webp("night", f, 7, x, y).astype(np.float64)
        lum = a @ LUMA
        lab, n = ndimage.label(lum > 40)
        sizes = ndimage.sum(np.ones_like(lum), lab, range(1, n + 1)) if n else np.array([])
        towns = int((sizes >= 2).sum())
        lit = float((lum > 40).mean())
        best = best or (name, towns, lit, (f, x, y))
        if towns > best[1]:
            best = (name, towns, lit, (f, x, y))
    check("night lights resolve towns", best[1] >= 20,
          f"level-7 tile {best[3]} over {best[0]}: {best[1]} separate lit blobs (sRGB > 40), {best[2] * 100:.1f} % lit")


def check_typescript(regions: list[str] | None = None) -> None:
    """Python decode of 3 height, 1 watermask and 1 landcover tile -> reference JSON; the TypeScript codec
    (src/core/geo/tileCodec.ts, run with npx tsx) must decode the same files to identical values."""
    import hashlib
    regs = [regmod.load(r) for r in (regmod.list_regions() if regions is None else regions)]
    keys = [("height", 2, 7, 60, 98), ("height", 0, 0, 0, 0)]
    if regs:
        c = regs[0]["shape"]["centre"]
        lv = regmod.levels(regs[0])[-1]
        f, x, y, _, _ = cube.dir_to_tile(cube.lat_lon_to_dir(math.radians(c["latDeg"]), math.radians(c["lonDeg"])), lv)
        keys += [("height", f, lv, x, y), ("watermask", f, lv, x, y), ("landcover", f, lv, x, y)]
    else:
        keys += [("height", 1, 7, 93, 89), ("watermask", 1, 7, 93, 89), ("landcover", 1, 7, 93, 89)]
    rng = np.random.default_rng(1)
    out = []
    for layer, f, lv, x, y in keys:
        p = tiles.tile_file(layer, f, lv, x, y)
        t = frt1.from_file_bytes(p.read_bytes())
        if t["kind"] == "height":
            arr = np.ascontiguousarray(t["heights"].astype("<f4"))
            entry = {"kind": "height", "width": t["width"], "height": t["height"], "scale": float(t["scale"]),
                     "offset": float(t["offset"])}
        else:
            arr = np.ascontiguousarray(t["data"].reshape(-1))
            entry = {"kind": "u8", "width": t["width"], "height": t["height"]}
        flat = arr.reshape(-1)
        idx = rng.integers(0, flat.size, 8)
        entry.update({"path": Path(os.path.relpath(p, paths.TILES.parent)).as_posix(), "sha256": hashlib.sha256(flat.tobytes()).hexdigest(),
                      "samples": [{"index": int(i), "value": float(flat[i])} for i in idx]})
        out.append(entry)
    write_json(paths.OUT / "ts-spot-ref.json", {"tiles": out})
    npx = "npx.cmd" if os.name == "nt" else "npx"
    r = subprocess.run([npx, "tsx", str(HERE / "ts_spot_check.ts")], cwd=str(REPO), capture_output=True, text=True)
    lines = (r.stdout or "").strip().splitlines()
    check("TypeScript decode spot check", r.returncode == 0 and bool(lines),
          (lines[-1] if lines else (r.stderr or "no output")[-300:]), lines)


def check_size() -> None:
    from earth.util import dir_size
    b, n = dir_size(paths.TILES)
    check("total baked size", True, f"{b / 1e9:.2f} GB in {n} files under data/tiles/earth")


# ---------------------------------------------------------------------------------------------- one region
def check_region_files(m: dict, reg: dict, quick: bool) -> None:
    """Every tile the (prospective) manifest promises in the region's coverage exists and decodes."""
    t0 = time.time()
    jobs, missing, n = [], [], 0
    for layer in reg["layers"]:
        ext = m["layers"][layer]["ext"]
        keys = [(f, lv, x, y) for lv in regmod.levels(reg) for f, x, y in regmod.rect_tiles(regmod.coverage_rects(reg, lv))]
        for k in keys:
            n += 1
            if not tiles.tile_file(layer, *k).is_file():
                missing.append(f"{layer}/{k}")
        keys = keys[::16] if quick else keys
        for i in range(0, len(keys), 2000):
            jobs.append((layer, ext, keys[i:i + 2000]))
    check(f"files {reg['id']}", not missing, f"{n} tiles of the region's coverage (layers {', '.join(reg['layers'])}), "
          f"{len(missing)} missing ({time.time() - t0:.0f} s)" + (f": {missing[:5]}" if missing else ""))
    bad, alpha, total = [], 0, 0
    with pool() as ex:
        for r in ex.map(_decode_chunk, jobs):
            bad += r["bad"]
            alpha += r["alpha"]
            total += r["n"]
    check(f"decode {reg['id']}", not bad, f"{total} tiles decoded{' (1 in 16 sample)' if quick else ''}, {len(bad)} failures"
          + (f": {bad[:5]}" if bad else ""))
    check(f"no alpha in image tiles {reg['id']}", alpha == 0, f"{alpha} albedo WebP tiles carry alpha")


def check_region_seams(reg: dict) -> None:
    """Shared height edges of random neighbouring tiles of the region, every regional level: bit-identical."""
    rng = np.random.default_rng(7)
    compared = mismatched = skipped = 0
    for lv in regmod.levels(reg):
        for r in regmod.coverage_rects(reg, lv):
            for _ in range(150):
                f, x, y = r["face"], int(rng.integers(r["x0"], r["x1"])), int(rng.integers(r["y0"], r["y1"]))
                for (dx, dy, sa, sb) in ((1, 0, 1, 0), (0, 1, 3, 2)):
                    a, _, sa_ = _edge_values(f, lv, x, y, sa)
                    b, _, sb_ = _edge_values(f, lv, x + dx, y + dy, sb)
                    compared += 1
                    if sa_ != sb_:
                        skipped += 1
                    elif not np.array_equal(a, b):
                        mismatched += 1
    check(f"height seams between neighbouring tiles {reg['id']}", mismatched == 0 and compared > skipped,
          f"{compared} shared edges compared, {mismatched} differ, {skipped} skipped (scale differs)")


def check_region_albedo_seams(reg: dict) -> None:
    """check_albedo_seams on the region's own levels and coverage (the same paired gate)."""
    rng = np.random.default_rng(11)
    for lv in regmod.levels(reg):
        keys = []
        for r in regmod.coverage_rects(reg, lv):
            keys += [(r["face"], lv, int(rng.integers(r["x0"], r["x1"])), int(rng.integers(r["y0"], r["y1"])))
                     for _ in range(150)]
        border, adjacent, interior = [], [], []
        for f, lv_, x, y in keys:
            a = _read_rgb(f, lv_, x, y)
            b = _read_rgb(f, lv_, x + 1, y)
            c = _read_rgb(f, lv_, x, y + 1)
            for p, q in ((a, b), (np.swapaxes(a, 0, 1), np.swapaxes(c, 0, 1))):
                border.append(np.abs(p[:, 255] - q[:, 0]).mean())
                adjacent.append(0.5 * (np.abs(p[:, 254] - p[:, 255]).mean() + np.abs(q[:, 0] - q[:, 1]).mean()))
                interior.append(np.abs(p[:, 1:] - p[:, :-1]).mean())
        border, adjacent = np.array(border), np.array(adjacent)
        d = border - adjacent
        se = float(d.std(ddof=1) / math.sqrt(d.size))
        check(f"albedo seams {reg['id']} level {lv}", float(d.mean()) <= 2.0 * se,
              f"{d.size} tile borders: mean |difference| across the border {border.mean():.3f}, interior pairs next "
              f"to it {adjacent.mean():.3f} (excess {d.mean():+.4f}, 2 s.e. {2 * se:.4f}), all interior pairs "
              f"{np.mean(interior):.3f} (sRGB levels)")


def aspect_ratios(lv: int, lat: float, lon: float, radius_m: float, min_h: float, local_sigma_m: float = 300.0) -> dict:
    """The paired relief-shading measure of check_deshade about any point: texels steeper than 5 deg above min_h
    within radius_m, each divided by the mean luminance of its own local_sigma_m surroundings; mean ratio of
    east- over west-facing and of north- over south-facing texels, with the counts."""
    from scipy import ndimage as ndi
    from earth.albedo import tile_normals
    from earth.regional import texel_metres
    from earth.site import gc_distance_m
    f0, x0, y0, _, _ = cube.dir_to_tile(cube.lat_lon_to_dir(np.radians(lat), np.radians(lon)), lv)
    tm = texel_metres(f0, lv, x0, y0)
    span = max(1, int(math.ceil(radius_m / (256 * tm))))
    n = 2 * span + 1
    mos = {k: np.zeros((n * 256, n * 256)) for k in ("lum", "ne", "nn", "hc", "dist")}
    have = np.zeros((n * 256, n * 256), bool)
    for i, x in enumerate(range(x0 - span, x0 + span + 1)):
        for j, y in enumerate(range(y0 - span, y0 + span + 1)):
            if not tiles.exists("albedo", f0, lv, x, y):
                continue
            ne, nn, hc = tile_normals(tiles.read_height(f0, lv, x, y), f0, lv, x, y)
            la, lo = tiles.dirs_latlon(cube.image_tile_dirs(f0, lv, x, y))
            sl = (slice(j * 256, (j + 1) * 256), slice(i * 256, (i + 1) * 256))
            mos["lum"][sl] = tiles.srgb_to_linear(tiles.read_webp("albedo", f0, lv, x, y)) @ LUMA
            mos["ne"][sl], mos["nn"][sl], mos["hc"][sl] = ne, nn, hc
            mos["dist"][sl] = gc_distance_m(lat, lon, la, lo).reshape(256, 256)
            have[sl] = True
    sig = local_sigma_m / tm
    wsum = ndi.gaussian_filter(have.astype(float), sig)
    local = ndi.gaussian_filter(np.where(have, mos["lum"], 0.0), sig) / np.maximum(wsum, 1e-9)
    rel = mos["lum"] / np.maximum(local, 1e-9)
    slope = np.degrees(np.arcsin(np.clip(np.hypot(mos["ne"], mos["nn"]), 0, 1)))
    aspect = (np.degrees(np.arctan2(mos["ne"], mos["nn"])) + 360) % 360
    sel = have & (mos["dist"] < radius_m) & (mos["hc"] > min_h) & (slope > 5)
    e, w = sel & (aspect > 45) & (aspect < 135), sel & (aspect > 225) & (aspect < 315)
    nf, s = sel & ((aspect > 315) | (aspect < 45)), sel & (aspect > 135) & (aspect < 225)
    ratio = lambda a, b: float(rel[a].mean() / rel[b].mean()) if a.any() and b.any() else float("nan")   # noqa: E731
    return {"ew": ratio(e, w), "ns": ratio(nf, s), "n": [int(e.sum()), int(w.sum()), int(nf.sum()), int(s.sum())]}


def check_region_deshade(reg: dict) -> None:
    """No baked relief shading in the regional imagery near the site: the paired east/west and north/south
    ratios (aspect_ratios) within 10 km of the site's reference point, at level 10 and the finest level, within
    1 +/- 0.03 where both sides have at least 1000 texels (reported only otherwise)."""
    ref = reference_point(reg)
    for lv in sorted({10, regmod.levels(reg)[-1]}):
        r = aspect_ratios(lv, ref["latDeg"], ref["lonDeg"], 10000.0, 1.0)
        detail = (f"slopes > 5 deg within 10 km of the site (texels E/W/N/S {r['n']}): each against its 300 m "
                  f"surroundings, east/west {r['ew']:.3f}, north/south {r['ns']:.3f} (need 1 +/- 0.03)")
        if min(r["n"]) >= 1000:
            check(f"no baked hillshade {reg['id']} level {lv}", abs(r["ew"] - 1) <= 0.03 and abs(r["ns"] - 1) <= 0.03, detail)
        else:
            info(f"hillshade measure {reg['id']} level {lv} (too few steep texels to gate)", detail)


def main_region(region_id: str, quick: bool) -> int:
    """Acceptance checks of one region, staged (against the prospective manifest: the live one with the region
    added, stage.prospective_manifest) or live."""
    from earth import stage
    from earth.util import dir_size
    reg = regmod.load(region_id)
    hidden = stage.state(region_id) in stage.HIDDEN_STATES
    m = stage.prospective_manifest(region_id) if hidden else layout.read_manifest(paths.TILESET)
    if not hidden and not all(r in m["layers"]["height"].get("coverage", {}).get(str(lv), [])
                              for lv in regmod.levels(reg) for r in regmod.coverage_rects(reg, lv)):
        print(f"{region_id} is neither staged nor in the live manifest", flush=True)
        return 1
    t0 = time.time()
    info("region", f"{region_id}: {'STAGED: checked against the prospective manifest (the live one with the region added)' if hidden else 'live'}")
    check_region_files(m, reg, quick)
    check_pyramid(m)
    check_staged_pads([region_id], {})
    check_source_coverage(m, [region_id])
    check_region_seams(reg)
    check_region_albedo_seams(reg)
    check_coverage_edges(m, [region_id])
    check_regional_coastline([region_id])
    check_regional_pits([region_id])
    check_regional_needles([region_id])
    near_shore_profile([region_id])
    check_region_deshade(reg)
    check_typescript([region_id])
    b, n = dir_size(stage.tiles_root(region_id)) if hidden else (None, None)
    info("size", f"{region_id}: " + (f"{b / 1e9:.2f} GB in {n} files staged" if hidden else "swapped into data/tiles/earth"))
    failed = [r for r in RESULTS if not r["pass"]]
    write_json(paths.OUT / f"verify-{region_id}.json", {"results": RESULTS, "info": INFO, "seconds": time.time() - t0,
                                                        "quick": quick, "staged": hidden})
    print(f"{len(RESULTS) - len(failed)} of {len(RESULTS)} checks passed in {time.time() - t0:.0f} s")
    return 1 if failed else 0


def main(argv: list[str]) -> int:
    set_below_normal()
    quick = "--quick" in argv
    if "--region" in argv:
        return main_region(argv[argv.index("--region") + 1], quick)
    m = layout.read_manifest(paths.TILESET)
    t0 = time.time()
    check_files(m, quick)
    check_pyramid(m)
    check_heights(m)
    check_source_coverage(m)
    check_seams_height(m)
    check_roundtrip()
    check_albedo_seams(m)
    check_coverage_edges(m)
    check_water_fraction()
    check_coastline()
    check_regional_coastline()
    check_regional_pits()
    check_regional_needles()
    near_shore_profile()
    check_deshade()
    check_arid_aspect()
    check_night()
    check_typescript()
    check_size()
    failed = [r for r in RESULTS if not r["pass"]]
    write_json(paths.OUT / "verify.json", {"results": RESULTS, "info": INFO, "seconds": time.time() - t0, "quick": quick})
    print(f"{len(RESULTS) - len(failed)} of {len(RESULTS)} checks passed in {time.time() - t0:.0f} s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
