"""Albedo layer of a simple body: 256 x 256 opaque WebP tiles of sRGB base colour, levels 0..maxLevel.

Finest level A: every texel is the source's area-filtered value at the texel's footprint (source.Raster),
turned into linear colour (transfer function, the tint of a mono map or the chroma of a colour map, one
calibration gain), or, for a body with no map, the procedural albedo: the configured mean colour brightened
by the freshness of the crater population (procedural.ts). Coarser levels: 2 x 2 means of the four child
tiles in LINEAR colour (a box pyramid, no re-sampling of the source and no re-decoding of lossy tiles),
computed depth-first per subtree so nothing global is ever held in memory.

Calibration: one gain and a soft highlight knee (see `calibration`) so that the area-weighted mean luminance
of the finest level (or of a calibration disc) is the configured albedo (`calibration.meanAlbedo`, normally
the body's geometric albedo) with at most 0.4 % of the surface at the 8-bit ceiling; a procedural body's
mean is held at its albedo after the fresh craters' brightening.
"""
from __future__ import annotations

import hashlib
import io
import json
import time

import numpy as np
from PIL import Image

from common import cube, layout
from moon.sampling import footprint_m, srgb_decode, srgb_encode
from planet import config, rt, source

WEBP_QUALITY = 92
LUMA = np.array([0.2126, 0.7152, 0.0722])
SUBTREE_LEVEL = 2
_RASTER: dict = {}



def _raster(body: config.Body, key: str) -> source.Raster:
    k = (body.id, key)
    if k not in _RASTER:
        _RASTER[k] = source.Raster(body, key)
    return _RASTER[k]


def _dn_scale(r: source.Raster) -> float:
    dt = np.dtype(r.meta["georef"]["dtype"])
    if dt == np.uint8:
        return 1.0 / 255.0
    if dt == np.uint16:
        return 1.0 / 65535.0
    if dt == np.int16:
        return 1.0 / 32767.0
    return 1.0


def _to_linear(body: config.Body, key: str, v: np.ndarray) -> np.ndarray:
    r = _raster(body, key)
    x = np.clip(v * _dn_scale(r), 0.0, None)
    return srgb_decode(np.minimum(x, 1.0)) if body.albedo["transfer"] == "srgb" else x


def _tint(body: config.Body) -> np.ndarray:
    t = np.asarray(body.albedo["tint"] or [1.0, 1.0, 1.0], dtype=np.float64)
    return t / float(t @ LUMA)


def linear_colour(body: config.Body, values: np.ndarray, colour: np.ndarray | None) -> np.ndarray:
    """Linear RGB (..., 3) before calibration from the luminance/colour source values (DN) and, when the body
    has one, the colour source's values (DN)."""
    al = body.albedo
    lin = _to_linear(body, al["source"], values)
    if _raster(body, al["source"]).channels == 3:
        if colour is not None:
            raise ValueError(f"{body.id}: a colour source needs a mono luminance source")
        # on a colour map the tint is a white balance (per-channel factors, luminance-normalised)
        return lin * _tint(body) if al["tint"] else lin
    if colour is not None:
        c = _to_linear_colour(body, colour)
        y = np.maximum(c @ LUMA, 1e-6)
        return lin[..., None] * (c / y[..., None])
    return lin[..., None] * _tint(body)


def _to_linear_colour(body: config.Body, v: np.ndarray) -> np.ndarray:
    r = _raster(body, body.albedo["colourSource"])
    return srgb_decode(np.clip(v * _dn_scale(r), 0.0, 1.0))


# ---- calibration: one gain and a soft highlight knee per body -------------------------------------------
#
# The tiles are what the near-field renderer shades with, so their mean must be the body's albedo, and a
# surface cannot reflect more than it receives, so highlights are compressed toward 1.0 instead of clipped:
#
#     y = x                                          for x <= k
#     y = k + (1 - k) t / (1 + t),  t = (x - k) / (1 - k)   for x > k
#
# applied to the brightest channel of g * (the map's linear colour), the other channels scaled with it (hue
# kept). (A local variant, the shoulder on the map's large-scale tone and the detail as a ratio on top, kept
# more detail on bright ground but could hold only a third of the bright moons' albedo within the ceiling:
# bright detail on bright ground has nowhere to go under 1.0.) The knee is continuous with slope 1 at its start k and approaches 1.0 without reaching it (a
# rational shoulder: its slow approach leaves room for a mosaic's bright tail; an exponential shoulder could
# not hold Enceladus' or Tethys' mean without putting a tenth of the surface at the ceiling). The gain
# g makes the area mean luminance equal the configured albedo (over the calibration disc where one is set);
# k is the highest of KNEE_STARTS at which at most CEILING_SHARE of the surface reaches CEILING_LIN (4 DN under
# the 8-bit ceiling of 254 DN, the margin lossy WebP needs): a narrow-ranged bright mosaic keeps its contrast up
# to k and a compressed but readable detail above it.
KNEE_FORM = ("y = x for x <= k; y = k + (1 - k) t / (1 + t) with t = (x - k) / (1 - k) above, on the brightest "
             "channel of gain x the map's linear colour (the other channels scaled with it)")
KNEE_STARTS = tuple(round(0.85 - 0.05 * i, 2) for i in range(15))       # 0.85 .. 0.15
CEILING_DN = 254
CEILING_MARGIN_DN = 4                    # lossy WebP lifts near-white texels by a few DN: calibrate below them
CEILING_LIN = float(srgb_decode(np.array((CEILING_DN - CEILING_MARGIN_DN - 0.5) / 255.0)))
CEILING_SHARE = 0.004                    # of the surface at or above CEILING_LIN; verify allows 0.5 % at 254 DN
CAL_SAMPLES = 200_000
CAL_VERSION = 5
_CAL: dict = {}


def knee(x: np.ndarray, k: float) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    t = (np.maximum(x, k) - k) / (1.0 - k)
    return np.where(x <= k, x, k + (1.0 - k) * t / (1.0 + t))


def apply_knee(rgb: np.ndarray, k: float) -> np.ndarray:
    m = rgb.max(axis=-1)
    return rgb * (knee(m, k) / np.maximum(m, 1e-12))[..., None]


def knee_ceiling_input(k: float) -> float:
    """The input x at which the knee's output reaches the 8-bit ceiling."""
    q = (CEILING_LIN - k) / (1.0 - k)
    return k + (1.0 - k) * q / (1.0 - q)


def _fibonacci(n: int) -> np.ndarray:
    k = np.arange(n) + 0.5
    z = 1.0 - 2.0 * k / n
    th = np.pi * (3.0 - np.sqrt(5.0)) * k
    r = np.sqrt(1.0 - z * z)
    return np.stack([r * np.cos(th), r * np.sin(th), z], axis=-1)


def _cap(lat_deg: float, lon_deg: float, radius_m: float, body_r: float, n: int) -> np.ndarray:
    """Directions spread uniformly by area over a spherical cap."""
    c = cube.lat_lon_to_dir(np.radians(lat_deg), np.radians(lon_deg))
    e1 = np.cross([0.0, 0.0, 1.0], c)
    e1 = e1 / np.linalg.norm(e1) if np.linalg.norm(e1) > 1e-9 else np.array([1.0, 0.0, 0.0])
    e2 = np.cross(c, e1)
    k = np.arange(n) + 0.5
    ang = np.arccos(1.0 - (1.0 - np.cos(radius_m / body_r)) * k / n)
    th = k * np.pi * (3.0 - np.sqrt(5.0))
    d = np.cos(ang)[:, None] * c + np.sin(ang)[:, None] * (np.cos(th)[:, None] * e1 + np.sin(th)[:, None] * e2)
    return d / np.linalg.norm(d, axis=1, keepdims=True)


def pre_gain_linear(body: config.Body, d: np.ndarray, fp: np.ndarray) -> np.ndarray:
    """Linear RGB of a mapped body at directions d before the calibration (and the low-frequency factor)."""
    al = body.albedo
    v = _raster(body, al["source"]).sample(d, fp)
    if not al["colourSource"]:
        return linear_colour(body, v, None)
    rc = _raster(body, al["colourSource"])
    # chroma at the colour map's own resolution at least (no ringing from upsampling chroma)
    fpc = np.maximum(fp, rc.pyramid.px_deg0 * np.pi / 180.0 * body.radius)
    col = rc.sample(d, fpc)
    if al.get("colourMode") == "detail":
        # albedo and colour from the colour map; the mono map's detail as a ratio to itself at the colour
        # map's resolution (for a mono mosaic whose brightness was normalised and lost the albedo pattern)
        m_fine = _to_linear(body, al["source"], v)
        m_low = _to_linear(body, al["source"], _raster(body, al["source"]).sample(d, fpc))
        return _to_linear_colour(body, col) * (m_fine / np.maximum(m_low, 1e-4))[..., None]
    return linear_colour(body, v, col)


def base_linear(body: config.Body, d: np.ndarray, fp: np.ndarray) -> np.ndarray:
    """Linear RGB of a mapped body before the calibration: the map's own colour, times the low-frequency
    factor where one is configured (Iapetus)."""
    lin = pre_gain_linear(body, d, fp)
    if body.albedo.get("lowFrequency"):
        lin = lin * low_frequency_factor(body, d)[..., None]
    return lin


def _samples(body: config.Body, d: np.ndarray) -> tuple:
    """(brightest channel, luminance / brightest channel) of the base colour at directions d, sampled at the
    finest albedo level's footprint."""
    fp = footprint_m(d, int(body.albedo["maxLevel"]), body.radius, cells=cube.IMAGE_TILE_SIZE)
    m = np.empty(len(d))
    r = np.empty(len(d))
    for s0 in range(0, len(d), 20_000):
        rgb = base_linear(body, d[s0:s0 + 20_000], fp[s0:s0 + 20_000])
        mx = rgb.max(axis=-1)
        m[s0:s0 + 20_000] = mx
        r[s0:s0 + 20_000] = (rgb @ LUMA) / np.maximum(mx, 1e-12)
    return m, r


def _solve_gain(m: np.ndarray, r: np.ndarray, k: float, target: float) -> float:
    """Gain whose kneed mean luminance is the target (bisection in log gain; the mean rises with the gain)."""
    lo, hi = -12.0, 12.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if float(np.mean(r * knee(np.exp(mid) * m, k))) < target:
            lo = mid
        else:
            hi = mid
    return float(np.exp(0.5 * (lo + hi)))


def _procedural_mean_fresh(body: config.Body) -> float:
    """Solid-angle-weighted mean freshness of the finest albedo level (the procedural step's fields)."""
    A = int(body.albedo["maxLevel"])
    n = 2 ** A
    k = (np.arange(256) + 0.5) / 256.0
    tot = wsum = 0.0
    for f in range(6):
        for x in range(n):
            for y in range(n):
                fresh = np.fromfile(rt.work_dir(body.id) / "proc" / "a" / f"{f}_{x}_{y}.f32", dtype="<f4").reshape(256, 256)
                u = -1.0 + 2.0 * (x + k) / n
                v = -1.0 + 2.0 * (y + k) / n
                wgt = (1.0 + u[None, :] ** 2 + v[:, None] ** 2) ** -1.5
                tot += float((wgt * fresh).sum())
                wsum += float(wgt.sum())
    return tot / wsum


def _cal_path(body: config.Body):
    return rt.work_dir(body.id) / "albedo-calibration.json"


def _cal_key(body: config.Body) -> str:
    al = body.albedo
    keys = [k for k in (al["source"], al["colourSource"]) if k]
    h = hashlib.sha256(json.dumps({"albedo": al, "radii": body.raw["radii"], "v": CAL_VERSION,
                                   "src": {k: source.source_fingerprint(body, k) for k in keys}},
                                  sort_keys=True).encode("utf-8"))
    return h.hexdigest()[:16]


def calibration(body: config.Body, recompute: bool = False) -> dict:
    """The body's gain and knee start (see the block comment). Computed once by the bake's parent process and
    written to work/albedo-calibration.json, which the tile workers read."""
    if body.id in _CAL and not recompute:
        return _CAL[body.id]
    key = _cal_key(body)
    p = _cal_path(body)
    if not recompute and p.is_file():
        c = rt.read_json(p)
        if c.get("key") == key:
            _CAL[body.id] = c
            return c
    al = body.albedo
    target = float(al["calibration"]["meanAlbedo"])
    if al["procedural"] is not None:
        mf = _procedural_mean_fresh(body)
        c = {"key": key, "gain": 1.0 / (1.0 + al["procedural"]["freshBrightening"] * mf), "kneeStart": None,
             "meanFreshness": mf, "target": target, "achievedSampled": target, "ceilingShareSampled": 0.0}
    else:
        mg, rg = _samples(body, _fibonacci(CAL_SAMPLES))
        reg = al["calibration"]["region"]
        if reg:
            mr, rr = _samples(body, _cap(reg["latDeg"], reg["lonDegE"], reg["radiusKm"] * 1000.0, body.radius, 60_000))
        else:
            mr, rr = mg, rg
        # the highest mean any knee start can hold within the ceiling rule: per start, the largest gain that
        # keeps CEILING_SHARE of the surface under CEILING_LIN, and the mean it gives
        q = float(np.quantile(mg, 1.0 - CEILING_SHARE))
        best = max(((float(np.mean(rr * knee(knee_ceiling_input(k) / q * mr, k))), k) for k in KNEE_STARTS))
        chosen = None
        for k in KNEE_STARTS:
            g = _solve_gain(mr, rr, k, target)
            share = float(np.mean(g * mg >= knee_ceiling_input(k)))
            if share <= CEILING_SHARE:
                chosen = (g, k, share)
                break
        if chosen is None:
            # the target is out of reach of an 8-bit albedo with this map's range: hold the ceiling rule at the
            # highest reachable mean (verify's mean check then fails until the config states a reachable target)
            k = best[1]
            g = knee_ceiling_input(k) / q
            chosen = (g, k, float(np.mean(g * mg >= knee_ceiling_input(k))))
            rt.log(f"{body.id}: albedo target {target} is out of reach within the ceiling rule; the highest "
                   f"reachable mean is {best[0]:.4f} (knee from {k}); baking that")
        g, k, share = chosen
        c = {"key": key, "gain": g, "kneeStart": k, "target": target,
             "achievedSampled": float(np.mean(rr * knee(g * mr, k))), "ceilingShareSampled": share,
             "kneedShareSampled": float(np.mean(g * mg > k)), "region": reg,
             "maxReachableMean": best[0], "maxReachableKnee": best[1]}
    rt.write_json(p, c)
    _CAL[body.id] = c
    return c


def gain(body: config.Body) -> float:
    return calibration(body)["gain"]


_LOWF: dict = {}


def _low_luminance(body: config.Body, d: np.ndarray) -> np.ndarray:
    """Linear luminance of the source (before calibration) area-filtered over the lowFrequency sigma."""
    lf = body.albedo["lowFrequency"]
    r = _raster(body, body.albedo["source"])
    lin = _to_linear(body, body.albedo["source"], r.sample(d, np.full(d.shape[:-1], lf["sigmaKm"] * 1000.0)))
    return lin @ LUMA if lin.ndim == d.ndim and lin.shape[-1] == 3 else lin


def _low_cdf(body: config.Body) -> tuple[np.ndarray, np.ndarray]:
    """Area-weighted distribution of the low-frequency luminance (sorted values, cumulative percent)."""
    if body.id not in _LOWF:
        lat = np.radians(np.arange(-89.0, 90.0, 2.0))
        lon = np.radians(np.arange(-179.0, 180.0, 2.0))
        LA, LO = np.meshgrid(lat, lon, indexing="ij")
        d = cube.lat_lon_to_dir(LA, LO).reshape(-1, 3)
        v = _low_luminance(body, d)
        w = np.cos(LA).ravel()
        o = np.argsort(v)
        _LOWF[body.id] = (v[o], 100.0 * (np.cumsum(w[o]) - 0.5 * w[o]) / w.sum())
    return _LOWF[body.id]


def low_frequency_factor(body: config.Body, d: np.ndarray) -> np.ndarray:
    """Multiplier that replaces the map's low-frequency albedo by the configured one: the percentile rank of a
    texel's low-frequency luminance in the body's own distribution is mapped to an absolute albedo
    (`lowFrequency.percentileToAlbedo`), the detail above `sigmaKm` is kept as a ratio. For mosaics whose
    brightness was equalised region by region (Iapetus: the dark Cassini Regio was stretched to mid-grey)."""
    vals, cdf = _low_cdf(body)
    low = _low_luminance(body, d)
    rank = np.interp(low, vals, cdf)
    knots = np.asarray(body.albedo["lowFrequency"]["percentileToAlbedo"], dtype=np.float64)
    target = np.interp(rank, knots[:, 0], knots[:, 1])
    return target / np.maximum(low, 1e-6)


def procedural_colour(body: config.Body) -> np.ndarray:
    pr = body.albedo["procedural"]
    c = np.asarray(pr["color"], dtype=np.float64)
    return c * (body.albedo["calibration"]["meanAlbedo"] / float(c @ LUMA))


def finest_linear(body: config.Body, face: int, x: int, y: int) -> np.ndarray:
    """Linear RGB (256, 256, 3) of one finest-level tile."""
    A = int(body.albedo["maxLevel"])
    al = body.albedo
    cal = calibration(body)
    if al["procedural"] is not None:
        p = rt.work_dir(body.id) / "proc" / "a" / f"{face}_{x}_{y}.f32"
        fresh = np.fromfile(p, dtype="<f4").reshape(256, 256).astype(np.float64)
        rgb = procedural_colour(body)[None, None, :] * (1.0 + al["procedural"]["freshBrightening"] * fresh)[..., None]
        # the fresh craters brighten; the mean stays the configured albedo
        return np.clip(rgb * cal["gain"], 0.0, 1.0)
    d = cube.image_tile_dirs(face, A, x, y)
    fp = footprint_m(d, A, body.radius, cells=cube.IMAGE_TILE_SIZE)
    return np.clip(apply_knee(base_linear(body, d, fp) * cal["gain"], cal["kneeStart"]), 0.0, 1.0)


def encode(lin: np.ndarray) -> bytes:
    u8 = (srgb_encode(lin) * 255.0 + 0.5).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(u8, "RGB").save(buf, "WEBP", quality=WEBP_QUALITY, method=4)
    return buf.getvalue()


def _write(body: config.Body, face: int, level: int, x: int, y: int, lin: np.ndarray) -> int:
    data = encode(lin)
    rt.write_tile(layout.tile_file(body.id, "albedo", face, level, x, y, "webp"), data)
    return len(data)


def _down(children: list[list[np.ndarray]]) -> np.ndarray:
    """Parent tile from children[cy][cx] (each (256, 256, 3); cx with u, cy with v): 2 x 2 linear means."""
    top = np.concatenate([children[0][0], children[0][1]], axis=1)
    bot = np.concatenate([children[1][0], children[1][1]], axis=1)
    full = np.concatenate([top, bot], axis=0)
    return full.reshape(256, 2, 256, 2, 3).mean(axis=(1, 3))


def _subtree(body: config.Body, face: int, level: int, x: int, y: int, stats: list) -> np.ndarray:
    A = int(body.albedo["maxLevel"])
    if level == A:
        lin = finest_linear(body, face, x, y)
    else:
        ch = [[_subtree(body, face, level + 1, 2 * x + cx, 2 * y + cy, stats) for cx in (0, 1)] for cy in (0, 1)]
        lin = _down(ch)
    stats[0] += 1
    stats[1] += _write(body, face, level, x, y, lin)
    return lin


def _unit(u):
    body_id, face, level, x, y = u
    body = config.load(body_id)
    stats = [0, 0]
    lin = _subtree(body, face, level, x, y, stats)
    return (face, level, x, y), lin.astype(np.float32), stats[0], stats[1]


def bake(body: config.Body) -> dict:
    A = int(body.albedo["maxLevel"])
    U = min(SUBTREE_LEVEL, A)
    t0 = time.time()
    cal = calibration(body, recompute=True)
    g = cal["gain"]
    rt.log(f"{body.id}: albedo calibration gain {g:.5f}, knee from {cal['kneeStart']}, sampled mean "
           f"{cal['achievedSampled']:.4f} (target {cal['target']}), at the ceiling {cal['ceilingShareSampled']:.3%}")
    units = [(body.id, f, U, x, y) for f in range(6) for y in range(2 ** U) for x in range(2 ** U)]
    roots: dict = {}
    n = 0
    nb = 0
    with rt.pool() as p:
        for key, lin, k, b in p.imap_unordered(_unit, units):
            roots[key] = lin.astype(np.float64)
            n += k
            nb += b
    rt.log(f"{body.id}: albedo levels {U}..{A} done ({n} tiles, {nb / 1e6:.1f} MB)")
    level_tiles = roots
    for level in range(U - 1, -1, -1):
        nxt = {}
        for f in range(6):
            for y in range(2 ** level):
                for x in range(2 ** level):
                    ch = [[level_tiles[(f, level + 1, 2 * x + cx, 2 * y + cy)] for cx in (0, 1)] for cy in (0, 1)]
                    lin = _down(ch)
                    nxt[(f, level, x, y)] = lin
                    n += 1
                    nb += _write(body, f, level, x, y, lin)
        level_tiles = nxt
    return {"tiles": n, "bytes": nb, "seconds": time.time() - t0, "gain": g, "kneeStart": cal["kneeStart"],
            "achievedSampled": cal["achievedSampled"], "ceilingShareSampled": cal["ceilingShareSampled"],
            "maxReachableMean": cal.get("maxReachableMean")}


def build_hash(body_id: str, layer_name: str, ext: str, max_level: int) -> str:
    """Hash of every tile's content in key order (the moon/earth `build` field: re-bakes change contentHash)."""
    h = hashlib.sha256()
    for L in range(max_level + 1):
        for f in range(6):
            for y in range(2 ** L):
                for x in range(2 ** L):
                    h.update(f"{f}/{L}/{x}/{y}:".encode("ascii"))
                    h.update(hashlib.sha256(layout.tile_file(body_id, layer_name, f, L, x, y, ext).read_bytes()).digest())
    return h.hexdigest()[:16]


def layer(body: config.Body, stats: dict, sources: list[str]) -> dict:
    return {"encoding": "webp", "ext": "webp", "globalMaxLevel": int(body.albedo["maxLevel"]), "coverage": {},
            "sources": sources, "calibration": {
                "meanAlbedo": body.albedo["calibration"]["meanAlbedo"], "region": body.albedo["calibration"]["region"],
                "gain": round(stats["gain"], 6),
                "knee": None if stats.get("kneeStart") is None else {"start": stats["kneeStart"], "form": KNEE_FORM},
                "achievedMeanSampled": round(stats.get("achievedSampled", 0.0), 5),
                "ceilingShareSampled": round(stats.get("ceilingShareSampled", 0.0), 5),
                "maxReachableMean": stats.get("maxReachableMean"),
                "lowFrequency": body.albedo.get("lowFrequency")}}


def lowres(body: config.Body, w: int = 1024, h: int = 512) -> np.ndarray:
    """1024 x 512 equirect sRGB image (row 0 = north, column 0 = 180 W) from the level-1 albedo tiles."""
    from common import cube as cb
    L = min(1, int(body.albedo["maxLevel"]))
    tiles = {}
    for f in range(6):
        for y in range(2 ** L):
            for x in range(2 ** L):
                p = layout.tile_file(body.id, "albedo", f, L, x, y, "webp")
                tiles[(f, x, y)] = srgb_decode(np.asarray(Image.open(p).convert("RGB"), dtype=np.float64) / 255.0)
    lat = np.radians(90.0 - (np.arange(h) + 0.5) * 180.0 / h)
    lon = np.radians(-180.0 + (np.arange(w) + 0.5) * 360.0 / w)
    LA, LO = np.meshgrid(lat, lon, indexing="ij")
    d = cb.lat_lon_to_dir(LA, LO).reshape(-1, 3)
    face, s, t = cb.dir_to_face_st(d)
    n = 2 ** L
    fx = np.clip((s + 1) / 2 * n, 0, n - 1e-9)
    fy = np.clip((t + 1) / 2 * n, 0, n - 1e-9)
    tx, ty = fx.astype(int), fy.astype(int)
    cx = np.clip((fx - tx) * 256 - 0.5, 0, 255)
    cy = np.clip((fy - ty) * 256 - 0.5, 0, 255)
    out = np.zeros((d.shape[0], 3))
    for (f, x, y), img in tiles.items():
        sel = (face == f) & (tx == x) & (ty == y)
        if not np.any(sel):
            continue
        x0 = np.floor(cx[sel]).astype(int)
        y0 = np.floor(cy[sel]).astype(int)
        x1 = np.minimum(x0 + 1, 255)
        y1 = np.minimum(y0 + 1, 255)
        ax = (cx[sel] - x0)[:, None]
        ay = (cy[sel] - y0)[:, None]
        out[sel] = (img[y0, x0] * (1 - ax) + img[y0, x1] * ax) * (1 - ay) + (img[y1, x0] * (1 - ax) + img[y1, x1] * ax) * ay
    return (srgb_encode(out.reshape(h, w, 3)) * 255 + 0.5).astype(np.uint8)
