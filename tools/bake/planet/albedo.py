"""Albedo layer of a simple body: 256 x 256 opaque WebP tiles of sRGB base colour, levels 0..maxLevel.

Finest level A: every texel is the source's area-filtered value at the texel's footprint (source.Raster),
turned into linear colour (transfer function, the tint of a mono map or the chroma of a colour map, one
calibration gain), or, for a body with no map, the procedural albedo: the configured mean colour brightened
by the freshness of the crater population (procedural.ts). Coarser levels: 2 x 2 means of the four child
tiles in LINEAR colour (a box pyramid, no re-sampling of the source and no re-decoding of lossy tiles),
computed depth-first per subtree so nothing global is ever held in memory.

Calibration: one gain so that the area-weighted mean luminance of the map (or of a calibration disc) is the
configured albedo (`calibration.meanAlbedo`, normally the body's geometric albedo, as the Moon's bake did:
its mean linear albedo 0.13 against a geometric albedo of 0.12).
"""
from __future__ import annotations

import hashlib
import io
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
_GAIN: dict = {}


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
        return lin
    if colour is not None:
        c = _to_linear_colour(body, colour)
        y = np.maximum(c @ LUMA, 1e-6)
        return lin[..., None] * (c / y[..., None])
    return lin[..., None] * _tint(body)


def _to_linear_colour(body: config.Body, v: np.ndarray) -> np.ndarray:
    r = _raster(body, body.albedo["colourSource"])
    return srgb_decode(np.clip(v * _dn_scale(r), 0.0, 1.0))


def gain(body: config.Body) -> float:
    """Calibration gain (computed once per process from the coarse mips, deterministic)."""
    if body.id in _GAIN:
        return _GAIN[body.id]
    al = body.albedo
    cal = al["calibration"]
    if al["procedural"] is not None:
        g = 1.0
    else:
        r = _raster(body, al["source"])
        rc = _raster(body, al["colourSource"]) if al["colourSource"] else None
        if rc is not None:
            # chroma has unit luminance: the luminance source alone sets the mean
            def lum_fn(a):
                return _to_linear(body, al["source"], a)
            mean = float(r.coarse_mean(lum_fn, cal["region"]))
        else:
            def lum_fn(a):
                lin = _to_linear(body, al["source"], a)
                return lin @ LUMA if lin.ndim == 3 else lin
            mean = float(r.coarse_mean(lum_fn, cal["region"]))
        if not mean > 0:
            raise ValueError(f"{body.id}: albedo source mean is {mean}")
        g = cal["meanAlbedo"] / mean
    _GAIN[body.id] = g
    return g


def procedural_colour(body: config.Body) -> np.ndarray:
    pr = body.albedo["procedural"]
    c = np.asarray(pr["color"], dtype=np.float64)
    return c * (body.albedo["calibration"]["meanAlbedo"] / float(c @ LUMA))


def finest_linear(body: config.Body, face: int, x: int, y: int) -> np.ndarray:
    """Linear RGB (256, 256, 3) of one finest-level tile."""
    A = int(body.albedo["maxLevel"])
    al = body.albedo
    if al["procedural"] is not None:
        p = rt.work_dir(body.id) / "proc" / "a" / f"{face}_{x}_{y}.f32"
        fresh = np.fromfile(p, dtype="<f4").reshape(256, 256).astype(np.float64)
        rgb = procedural_colour(body)[None, None, :] * (1.0 + al["procedural"]["freshBrightening"] * fresh)[..., None]
        return np.clip(rgb, 0.0, 1.0)
    d = cube.image_tile_dirs(face, A, x, y)
    fp = footprint_m(d, A, body.radius, cells=cube.IMAGE_TILE_SIZE)
    v = _raster(body, al["source"]).sample(d, fp)
    col = None
    if al["colourSource"]:
        rc = _raster(body, al["colourSource"])
        # chroma at the colour map's own resolution at least (no ringing from upsampling chroma)
        col = rc.sample(d, np.maximum(fp, rc.pyramid.px_deg0 * np.pi / 180.0 * body.radius))
    return np.clip(linear_colour(body, v, col) * gain(body), 0.0, 1.0)


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
    g = gain(body)
    rt.log(f"{body.id}: albedo calibration gain {g:.5f}")
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
    return {"tiles": n, "bytes": nb, "seconds": time.time() - t0, "gain": g}


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
            "sources": sources, "calibration": {"meanAlbedo": body.albedo["calibration"]["meanAlbedo"],
                                                "gain": round(stats["gain"], 6)}}


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
