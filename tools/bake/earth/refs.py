"""Reference samples of the global height source, kept (about 100 kB) so verify.py can check registration after
the raw downloads are deleted.

For 1,000 seeded random points (half uniform on the sphere, half on land with relief): the ETOPO value
(Catmull-Rom on the source grid) and its gradient per source texel (east, north). verify.py samples the baked
level-7 tiles at the same points and converts the differences into an equivalent displacement in source
texels.
"""
from __future__ import annotations

import numpy as np

from earth import etopo, paths, sample
from earth.util import log, write_json

N = 1000


def random_points(seed: int, n: int = N) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    z = rng.uniform(-1.0, 1.0, n)
    lon = rng.uniform(-180.0, 180.0, n)
    return np.degrees(np.arcsin(z)), lon


def _grad(fn, lat, lon, step_deg):
    gx = (fn(lat, lon + 0.5 * step_deg) - fn(lat, lon - 0.5 * step_deg))
    gy = (fn(lat + 0.5 * step_deg, lon) - fn(lat - 0.5 * step_deg, lon))
    return gx, gy


def height_refs() -> None:
    out = paths.REFS / "height-etopo.json"
    if out.is_file():
        return
    mm = etopo.open_memmap()

    def fn(lat, lon):
        cx = (np.asarray(lon) + 180.0) * etopo.CELLS_PER_DEG - 0.5
        cy = (90.0 - np.asarray(lat)) * etopo.CELLS_PER_DEG - 0.5
        return sample.bicubic(mm, np.ascontiguousarray(cx, dtype=np.float64), np.ascontiguousarray(cy, dtype=np.float64),
                              True, etopo.UNIT)

    # half the points uniform, half on land with relief (where registration errors are visible)
    lat, lon = random_points(11, 20 * N)
    v = fn(lat, lon)
    gx, gy = _grad(fn, lat, lon, 1.0 / etopo.CELLS_PER_DEG)
    g = np.hypot(gx, gy)
    uni = np.arange(N // 2)
    rel = np.nonzero((v > 0) & (g > 20.0) & (np.abs(lat) < 70))[0]
    rel = rel[~np.isin(rel, uni)][: N - uni.size]
    sel = np.concatenate([uni, rel])
    write_json(out, {"source": "ETOPO 2022 15s (memmap, polar rows prefiltered)", "texelDeg": 1.0 / etopo.CELLS_PER_DEG,
                     "lat": lat[sel].tolist(), "lon": lon[sel].tolist(), "value": v[sel].tolist(),
                     "gradEast": gx[sel].tolist(), "gradNorth": gy[sel].tolist()})
    log(f"refs: {sel.size} height reference samples")
