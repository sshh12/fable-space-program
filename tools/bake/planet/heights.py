"""Height layer of a simple body: frt1-height tiles, global levels 0..maxLevel.

  height(d) = reference(d) - R_mean + DEM(d)            reference: the triaxial ellipsoid of the radii, or the
                                                        sphere a DEM is given against (a DEM's own datum)
            [+ procedural crater relief]               bodies with no map (procedural.ts)

Finest level F: at every vertex the DEM area-filtered over the level's local vertex spacing
(source.Raster.sample: mips + Catmull-Rom + longitude taps, a pure function of the direction, so shared edge
vertices are bit-identical across tiles and cube faces, as in the Moon's global levels), plus the analytic
reference term; bodies without a DEM take the analytic term (and the procedural relief) at the vertices.
Coarser levels: the existing full-weighting pyramid (earth/hpyramid.downsample_tile).
"""
from __future__ import annotations

import time

import numpy as np

from common import cube, frt1, layout
from earth import hpyramid
from moon.sampling import footprint_m
from planet import config, rt, source

PYR_BLOCK = 8
_RASTER: dict = {}


def reference_radius(body: config.Body, d: np.ndarray) -> np.ndarray:
    ref = body.height["reference"]
    if ref == "ellipsoid":
        a, b, c = body.abc
        return 1.0 / np.sqrt((d[..., 0] / a) ** 2 + (d[..., 1] / b) ** 2 + (d[..., 2] / c) ** 2)
    return np.full(d.shape[:-1], float(ref["sphere"]))


def reference_term(body: config.Body, d: np.ndarray) -> np.ndarray:
    """reference surface radius minus the mean radius (m)."""
    return reference_radius(body, d) - body.radius


def _raster(body: config.Body, key: str) -> source.Raster:
    k = (body.id, key)
    if k not in _RASTER:
        _RASTER[k] = source.Raster(body, key)
    return _RASTER[k]


def dem_metres(body: config.Body, pts: np.ndarray, level: int) -> np.ndarray:
    """DEM metres at unit directions (n, 3), area-filtered at the vertex spacing of `level`."""
    dem = body.height["dem"]
    r = _raster(body, dem["source"])
    fp = footprint_m(pts, level, body.radius)
    return r.sample(pts, fp) * dem["scale"] + dem["offset"]


def _proc_relief(body: config.Body, face: int, x: int, y: int) -> np.ndarray:
    p = rt.work_dir(body.id) / "proc" / "h" / f"{face}_{x}_{y}.f32"
    return np.fromfile(p, dtype="<f4").reshape(259, 259).astype(np.float64)


def finest_tile(body: config.Body, face: int, x: int, y: int) -> np.ndarray:
    F = int(body.height["maxLevel"])
    d = cube.height_tile_dirs(face, F, x, y)
    h = reference_term(body, d)
    if body.height["dem"] is not None:
        return h + dem_metres(body, d.reshape(-1, 3), F).reshape(259, 259)
    if body.height["craters"] is not None:
        h = h + _proc_relief(body, face, x, y)
    return h


def _write(body: config.Body, face: int, level: int, x: int, y: int, h: np.ndarray) -> tuple[int, float, float]:
    data = frt1.to_file_bytes(frt1.encode_height(h, float(body.height["preferredScale"])), level=9)
    rt.write_tile(layout.tile_file(body.id, "height", face, level, x, y, "hgt"), data)
    return len(data), float(h.min()), float(h.max())


def _finest_unit(u) -> tuple[int, int, float, float]:
    body_id, face, x0, x1, y0, y1 = u
    body = config.load(body_id)
    F = int(body.height["maxLevel"])
    n = 0
    nb = 0
    lo, hi = np.inf, -np.inf
    for x in range(x0, x1):
        for y in range(y0, y1):
            b, a, z = _write(body, face, F, x, y, finest_tile(body, face, x, y))
            n += 1
            nb += b
            lo, hi = min(lo, a), max(hi, z)
    return n, nb, lo, hi


def _read_height(body_id: str):
    def loader(f: int, L: int, x: int, y: int):
        p = layout.tile_file(body_id, "height", f, L, x, y, "hgt")
        return frt1.from_file_bytes(p.read_bytes())["heights"] if p.is_file() else None
    return loader


def _pyr_unit(u) -> tuple[int, int, float, float]:
    body_id, level, face, x0, x1, y0, y1 = u
    body = config.load(body_id)
    cache = hpyramid.TileCache(level + 1, _read_height(body_id))
    n = 0
    nb = 0
    lo, hi = np.inf, -np.inf
    for x in range(x0, x1):
        for y in range(y0, y1):
            h = hpyramid.downsample_tile(face, level, x, y, cache)
            b, a, z = _write(body, face, level, x, y, h)
            n += 1
            nb += b
            lo, hi = min(lo, a), max(hi, z)
            cache.trim()
    return n, nb, lo, hi


def _units(body_id: str, level: int, finest: bool) -> list[tuple]:
    nt = 2 ** level
    out = []
    for f in range(6):
        for bx in range(0, nt, PYR_BLOCK):
            for by in range(0, nt, PYR_BLOCK):
                r = (f, bx, min(nt, bx + PYR_BLOCK), by, min(nt, by + PYR_BLOCK))
                out.append((body_id,) + r if finest else (body_id, level) + r)
    return out


def bake(body: config.Body) -> dict:
    """Bake every height level (finest first). Returns stats for the manifest."""
    F = int(body.height["maxLevel"])
    t0 = time.time()
    total = {"tiles": 0, "bytes": 0, "min": np.inf, "max": -np.inf}
    with rt.pool() as p:
        for level in range(F, -1, -1):
            units = _units(body.id, level, level == F)
            fn = _finest_unit if level == F else _pyr_unit
            for n, nb, lo, hi in p.imap_unordered(fn, units):
                total["tiles"] += n
                total["bytes"] += nb
                if level == F:
                    total["min"] = min(total["min"], lo)
                    total["max"] = max(total["max"], hi)
            rt.log(f"{body.id}: height level {level} done ({total['tiles']} tiles, {total['bytes'] / 1e6:.1f} MB)")
    total["seconds"] = time.time() - t0
    return total


def layer(body: config.Body, stats: dict, sources: list[str]) -> dict:
    F = int(body.height["maxLevel"])
    return {"encoding": "frt1-height", "ext": "hgt", "globalMaxLevel": F, "coverage": {},
            "heightScales": [float(body.height["preferredScale"])] * (F + 1), "sources": sources,
            "elevation": {"min": round(stats["min"], 2), "max": round(stats["max"], 2),
                          "note": "range of the finest level's samples, m above manifest.radius"}}
