"""Acceptance checks of the earth tile set (work package bake-earth).

    python -I tools/bake/earth/verify.py [--quick]

Prints one line per check (PASS / FAIL with the measured numbers) and writes out/bake/earth/verify.json.
Exit code 0 only when every check passes. --quick decodes a 1-in-16 sample of the tiles instead of all.
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
        p = layout.tile_file(paths.TILESET, layer, f, lv, x, y, ext)
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
        loc = read_json(paths.SITES_DIR / f"{r['site']}.location.json")
        h = float(height_at(cache, finest, loc["latDeg"], loc["lonDeg"])[0])
        check(f"pad {r['site']}", abs(h - loc["padElevation"]) <= 2.0,
              f"level-{finest} height {h:.2f} m at the location file's coordinates vs padElevation {loc['padElevation']} m")


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
    rng = np.random.default_rng(9)
    border, interior = [], []
    L = m["layers"]["albedo"]
    keys = [(int(rng.integers(6)), 7, int(rng.integers(127)), int(rng.integers(127))) for _ in range(300)]
    for lv, rects in L.get("coverage", {}).items():
        for r in rects:
            keys += [(r["face"], int(lv), int(rng.integers(r["x0"], r["x1"])), int(rng.integers(r["y0"], r["y1"])))
                     for _ in range(60)]
    for f, lv, x, y in keys:
        a = _read_rgb(f, lv, x, y)
        b = _read_rgb(f, lv, x + 1, y)
        c = _read_rgb(f, lv, x, y + 1)
        border.append(np.abs(a[:, 255] - b[:, 0]).mean())
        border.append(np.abs(a[255, :] - c[0, :]).mean())
        interior.append(np.abs(a[:, 1:] - a[:, :-1]).mean())
        interior.append(np.abs(a[1:, :] - a[:-1, :]).mean())
    b, i = float(np.mean(border)), float(np.mean(interior))
    check("albedo seams", b <= i, f"mean |difference| across {len(border)} tile borders {b:.3f} vs interior texel pairs {i:.3f} (sRGB levels)")


def check_coverage_edges(m: dict) -> None:
    from earth import regional
    from earth.sample import bicubic
    for r_id in regmod.list_regions():
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
                for x, y, side in ring[::max(1, len(ring) // 48)]:
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
            ok = rms < 3.0 and ma <= 2.0 and mw <= 2.0
            details.append(ok)
            check(f"coverage edge {r_id} level {lv}", ok,
                  f"height vs bicubic parent RMS {rms:.2f} m (< 3); outermost texel row vs bilinear parent: albedo mean "
                  f"{ma:.2f} (max {maxa:.0f}) /255, watermask mean {mw:.2f} (max {maxw:.0f}) /255 (<= 2)")


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


def check_coastline() -> None:
    rng = np.random.default_rng(3)
    pts = []
    tries = 0
    while len(pts) < 1000 and tries < 20000:
        tries += 1
        f, x, y = int(rng.integers(6)), int(rng.integers(128)), int(rng.integers(128))
        h = tiles.read_height(f, 7, x, y)[1:258, 1:258]
        sc = np.nonzero((np.sign(h[:, :-1]) != np.sign(h[:, 1:])) & (h[:, :-1] != 0))
        if sc[0].size == 0:
            continue
        i = int(rng.integers(sc[0].size))
        j, c = int(sc[0][i]), int(sc[1][i])
        a, b = float(h[j, c]), float(h[j, c + 1])
        uu = c + a / (a - b)                       # zero crossing in vertex units (= texel edge units)
        pts.append((f, x, y, j, uu))
    ok_n = corr = 0
    for f, x, y, j, uu in pts:
        m = tiles.read_u8("watermask", f, 7, x, y).astype(np.float64)
        r = min(max(j, 0), 255)
        c0 = int(math.floor(uu - 0.5))
        lo, hi = max(c0 - 1, 0), min(c0 + 2, 255)
        win = m[max(r - 1, 0):min(r + 1, 255) + 1, lo:hi + 1]
        if (win >= 128).any() and (win < 128).any():
            ok_n += 1
        else:
            corr += 1
    frac = ok_n / max(1, len(pts))
    check("coastline agreement", frac >= 0.99,
          f"{ok_n} of {len(pts)} sampled level-7 height zero crossings have the mask's 50 % contour within one texel "
          f"({corr} disagree: inland water or dry depressions taken from MODIS)")


def mauna_kea_east_west(lv: int) -> tuple[np.ndarray, np.ndarray]:
    """Linear luminance of east- (45-135 deg) and west-facing (225-315 deg) texels steeper than 5 deg, above
    3300 m (above the vegetation) and within 8 km of the Mauna Kea summit, at one level."""
    from earth.albedo import tile_normals
    from earth.site import gc_distance_m
    E, Wl = [], []
    f0, x0, y0, _, _ = cube.dir_to_tile(cube.lat_lon_to_dir(np.radians(19.8207), np.radians(-155.4681)), lv)
    span = max(1, int(math.ceil(8000.0 / (2460.0 * 2 ** (12 - lv)))))
    for x in range(x0 - span, x0 + span + 1):
        for y in range(y0 - span, y0 + span + 1):
            if not tiles.exists("albedo", f0, lv, x, y):
                continue
            ne, nn, hc = tile_normals(tiles.read_height(f0, lv, x, y), f0, lv, x, y)
            lum = tiles.srgb_to_linear(tiles.read_webp("albedo", f0, lv, x, y)) @ LUMA
            la, lo = tiles.dirs_latlon(cube.image_tile_dirs(f0, lv, x, y))
            dist = gc_distance_m(19.8207, -155.4681, la, lo).reshape(256, 256)
            slope = np.degrees(np.arcsin(np.clip(np.hypot(ne, nn), 0, 1)))
            aspect = (np.degrees(np.arctan2(ne, nn)) + 360) % 360
            sel = (dist < 8000) & (hc > 3300) & (slope > 5)
            E.append(lum[sel & (aspect > 45) & (aspect < 135)])
            Wl.append(lum[sel & (aspect > 225) & (aspect < 315)])
    return np.concatenate(E), np.concatenate(Wl)


def check_deshade() -> None:
    regs = [regmod.load(r) for r in regmod.list_regions()]
    gates = sorted({regmod.levels(r)[-1] for r in regs} | {10} if regs else {7})
    for lv in sorted(set(gates) | {7}):
        e, w = mauna_kea_east_west(lv)
        if e.size < 10 or w.size < 10:
            check(f"no baked hillshade level {lv}", False, f"too few samples ({e.size} east, {w.size} west)")
            continue
        ratio = float(e.mean() / w.mean())
        detail = (f"Mauna Kea above 3300 m: east-facing mean albedo {e.mean():.4f} ({e.size} texels), west-facing "
                  f"{w.mean():.4f} ({w.size}), ratio {ratio:.3f} (1 +/- 0.03)")
        if lv in gates:
            check(f"no baked hillshade level {lv}", abs(ratio - 1) <= 0.03, detail)
        else:
            info(f"hillshade measure level {lv} (global imagery, 300 m texels: geology dominates)", detail)


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


def check_typescript() -> None:
    """Python decode of 3 height, 1 watermask and 1 landcover tile -> reference JSON; the TypeScript codec
    (src/core/geo/tileCodec.ts, run with npx tsx) must decode the same files to identical values."""
    import hashlib
    regs = [regmod.load(r) for r in regmod.list_regions()]
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
        entry.update({"path": p.relative_to(paths.TILES.parent).as_posix(), "sha256": hashlib.sha256(flat.tobytes()).hexdigest(),
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


def main(argv: list[str]) -> int:
    set_below_normal()
    quick = "--quick" in argv
    m = layout.read_manifest(paths.TILESET)
    t0 = time.time()
    check_files(m, quick)
    check_pyramid(m)
    check_heights(m)
    check_seams_height(m)
    check_roundtrip()
    check_albedo_seams(m)
    check_coverage_edges(m)
    check_water_fraction()
    check_coastline()
    check_deshade()
    check_night()
    check_typescript()
    check_size()
    failed = [r for r in RESULTS if not r["pass"]]
    write_json(paths.OUT / "verify.json", {"results": RESULTS, "info": INFO, "seconds": time.time() - t0, "quick": quick})
    print(f"{len(RESULTS) - len(failed)} of {len(RESULTS)} checks passed in {time.time() - t0:.0f} s")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
