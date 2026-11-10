"""Global Moon height levels 0..globalMaxLevel (FRT1, 259 x 259 vertex-registered) from LOLA 118 m.

Every sample is the LOLA pyramid filtered over the local sample spacing of its level (EquirectPyramid.sample
with footprint_m(dir, level)); both are functions of the direction only, so shared edge samples are
bit-identical between neighbouring tiles of a level, across cube edges included.

Run:  data/cache/moon/venv/Scripts/python.exe -I tools/bake/moon/heights_global.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from common import cube, frt1, layout  # noqa: E402
from moon import lola, rt  # noqa: E402
from moon.sampling import footprint_m  # noqa: E402

GLOBAL_MAX_LEVEL = 6
GLOBAL_SCALE = 0.5
_PYR = None


def _pyr():
    global _PYR
    if _PYR is None:
        _PYR = lola.pyramid()
    return _PYR


def global_height(dirs: np.ndarray, level: int) -> np.ndarray:
    """The global data height function of a level: LOLA filtered over the level's sample spacing (m)."""
    lat, lon = cube.dir_to_lat_lon(dirs)
    fp_deg = np.degrees(footprint_m(dirs, level, rt.MOON_RADIUS) / rt.MOON_RADIUS)
    return _pyr().sample(np.degrees(lat), np.degrees(lon), fp_deg)


def bake_tile(key: tuple[int, int, int, int]) -> tuple[tuple[int, int, int, int], float, float, int]:
    face, level, x, y = key
    d = cube.height_tile_dirs(face, level, x, y)
    h = global_height(d, level)
    raw = frt1.encode_height(h, GLOBAL_SCALE)
    data = frt1.to_file_bytes(raw)
    layout.write_atomic(layout.tile_file(rt.TILESET, "height", face, level, x, y, "hgt"), data)
    return key, float(h.min()), float(h.max()), len(data)


def tile_keys(levels) -> list[tuple[int, int, int, int]]:
    return [(f, L, x, y) for L in levels for f in range(6) for y in range(2 ** L) for x in range(2 ** L)]


def height_layer(existing: dict | None) -> dict:
    """Manifest layer for heights; keeps regional coverage and per-level scales already in the manifest."""
    scales = [GLOBAL_SCALE] * (GLOBAL_MAX_LEVEL + 1)
    coverage: dict = {}
    sources = [lola.CREDIT]
    if existing:
        old = existing.get("heightScales", [])
        scales += old[GLOBAL_MAX_LEVEL + 1:]
        coverage = existing.get("coverage", {})
        sources += [s for s in existing.get("sources", []) if s not in sources]
    return {"encoding": "frt1-height", "ext": "hgt", "globalMaxLevel": GLOBAL_MAX_LEVEL, "coverage": coverage,
            "heightScales": scales, "sources": sources}


def write_manifest_layer() -> None:
    path = rt.TILES_ROOT / rt.TILESET / "manifest.json"
    existing = layout.read_manifest(rt.TILESET)["layers"].get("height") if path.is_file() else None
    layout.merge_layer(rt.TILESET, rt.MOON_RADIUS, "height", height_layer(existing),
                       attribution=["LOLA: NASA/GSFC LRO LOLA Team (Smith et al. 2010)"], resident_height_level=3)


def main() -> None:
    rt.check_python()
    rt.below_normal_priority()
    lola.build_stored_mips()
    t0 = time.time()
    keys = tile_keys(range(GLOBAL_MAX_LEVEL + 1))
    done = 0
    total_bytes = 0
    lo, hi = np.inf, -np.inf
    with rt.pool() as p:
        for key, a, b, n in p.imap_unordered(bake_tile, keys, chunksize=8):
            done += 1
            total_bytes += n
            lo, hi = min(lo, a), max(hi, b)
            if done % 2000 == 0 or done == len(keys):
                rt.log(f"height tiles {done}/{len(keys)}  {total_bytes / 1e9:.2f} GB  range {lo:.1f}..{hi:.1f} m")
    write_manifest_layer()
    rt.write_json(rt.MOON_WORK / "heights_global_stats.json",
                  {"tiles": len(keys), "bytes": total_bytes, "seconds": time.time() - t0, "minM": lo, "maxM": hi})
    rt.log(f"global heights done: {len(keys)} tiles, {total_bytes / 1e9:.2f} GB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
