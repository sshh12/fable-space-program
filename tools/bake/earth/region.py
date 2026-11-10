"""Regional bake definitions (data/defs/regions/earth-*.json): area of interest, coverage per level, feather.

Shapes:
  {"kind": "disc",  "centre": {"latDeg", "lonDeg"}}                  levels[L].radiusKm
  {"kind": "strip", "points": [{"latDeg", "lonDeg"}, ...]}            levels[L].radiusKm = half width
The area of interest (AOI) of level L is everything within radiusKm of the centre / polyline. The regional
SOURCE has full weight inside the largest AOI and fades to the global source over `featherKm` beyond it
(smootherstep). Coverage of level L = every tile that touches the AOI of L grown by featherKm plus
`marginTiles` mean tile sizes, as one bounding rectangle per cube face, so the AOI lies more than one tile
inside every coverage rectangle and every coverage boundary lies where the source is already the global one.
"""
from __future__ import annotations

import math
from functools import lru_cache

import numpy as np

from common import cube
from earth import paths
from earth.util import read_json, write_json


def region_file(region_id: str):
    return paths.REGIONS_DIR / f"{region_id}.json"


def list_regions() -> list[str]:
    return sorted(p.stem for p in paths.REGIONS_DIR.glob(f"{paths.TILESET}-*.json"))


@lru_cache(maxsize=None)
def _load_cached(region_id: str, mtime: float) -> dict:
    r = read_json(region_file(region_id))
    if r.get("id") != region_id:
        raise ValueError(f"{region_file(region_id)}: id must be {region_id}")
    if r.get("tileset") != paths.TILESET:
        raise ValueError(f"{region_id}: tileset must be {paths.TILESET}")
    kind = r["shape"]["kind"]
    if kind not in ("disc", "strip"):
        raise ValueError(f"{region_id}: unknown shape {kind}")
    levels = sorted(int(k) for k in r["levels"])
    if levels != list(range(paths.GLOBAL_MAX_LEVEL + 1, levels[-1] + 1)):
        raise ValueError(f"{region_id}: regional levels must be consecutive from {paths.GLOBAL_MAX_LEVEL + 1}")
    return r


def load(region_id: str) -> dict:
    return _load_cached(region_id, region_file(region_id).stat().st_mtime)


def save(region: dict) -> None:
    write_json(region_file(region["id"]), region)


def levels(region: dict) -> list[int]:
    return sorted(int(k) for k in region["levels"])


def radius_km(region: dict, level: int) -> float:
    return float(region["levels"][str(level)]["radiusKm"])


def max_radius_km(region: dict) -> float:
    return max(radius_km(region, L) for L in levels(region))


def shape_points(region: dict) -> np.ndarray:
    """(n, 2) lat/lon degrees of the centre (disc) or polyline vertices (strip)."""
    s = region["shape"]
    if s["kind"] == "disc":
        return np.array([[s["centre"]["latDeg"], s["centre"]["lonDeg"]]], dtype=np.float64)
    return np.array([[p["latDeg"], p["lonDeg"]] for p in s["points"]], dtype=np.float64)


def _unit(lat_deg, lon_deg) -> np.ndarray:
    return cube.lat_lon_to_dir(np.radians(lat_deg), np.radians(lon_deg))


def distance_to_shape_m(region: dict, lat_deg, lon_deg) -> np.ndarray:
    """Great-circle distance (m) from points to the disc centre or to the strip polyline."""
    p = _unit(np.asarray(lat_deg, np.float64), np.asarray(lon_deg, np.float64))
    pts = shape_points(region)
    if region["shape"]["kind"] == "disc":
        c = _unit(pts[0, 0], pts[0, 1])
        return np.arccos(np.clip(p @ c, -1.0, 1.0)) * paths.RADIUS
    best = np.full(p.shape[:-1], np.inf)
    for a_ll, b_ll in zip(pts[:-1], pts[1:]):
        a = _unit(*a_ll)
        b = _unit(*b_ll)
        n = np.cross(a, b)
        n /= np.linalg.norm(n)
        # distance to the great circle, valid when the foot point lies between a and b
        dc = np.abs(np.arcsin(np.clip(p @ n, -1, 1)))
        foot = p - (p @ n)[..., None] * n
        foot /= np.linalg.norm(foot, axis=-1, keepdims=True)
        ab = math.acos(np.clip(a @ b, -1, 1))
        inside = (np.arccos(np.clip(foot @ a, -1, 1)) <= ab) & (np.arccos(np.clip(foot @ b, -1, 1)) <= ab)
        da = np.arccos(np.clip(p @ a, -1, 1))
        db = np.arccos(np.clip(p @ b, -1, 1))
        d = np.where(inside, dc, np.minimum(da, db))
        best = np.minimum(best, d)
    return best * paths.RADIUS


def smootherstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * x * (x * (6.0 * x - 15.0) + 10.0)


def source_weight(region: dict, lat_deg, lon_deg) -> np.ndarray:
    """1 inside the largest AOI, smootherstep to 0 over featherKm beyond it (regional vs global source)."""
    d = distance_to_shape_m(region, lat_deg, lon_deg) - max_radius_km(region) * 1000.0
    return 1.0 - smootherstep(d / (float(region["featherKm"]) * 1000.0))


def coverage_tiles(region: dict, level: int) -> list[tuple[int, int, int]]:
    grow = (radius_km(region, level) + float(region["featherKm"])) * 1000.0 \
        + float(region["marginTiles"]) * cube.mean_tile_size(paths.RADIUS, level)
    pts = shape_points(region)
    out: set[tuple[int, int, int]] = set()
    if region["shape"]["kind"] == "disc":
        samples = pts
    else:
        step = max(grow * 0.5, 1000.0)
        samples_l = []
        for a, b in zip(pts[:-1], pts[1:]):
            ua, ub = _unit(*a), _unit(*b)
            ang = math.acos(np.clip(ua @ ub, -1, 1))
            n = max(1, int(math.ceil(ang * paths.RADIUS / step)))
            for k in range(n + 1):
                f = k / n
                d = (math.sin((1 - f) * ang) * ua + math.sin(f * ang) * ub) / math.sin(ang) if ang > 0 else ua
                lat, lon = cube.dir_to_lat_lon(d)
                samples_l.append((math.degrees(float(lat)), math.degrees(float(lon))))
        samples = np.array(samples_l)
    for lat, lon in samples:
        out.update(cube.tiles_covering_disc(math.radians(lat), math.radians(lon), grow, paths.RADIUS, level))
    return sorted(out)


def coverage_rects(region: dict, level: int) -> list[dict]:
    return cube.rects_from_tiles(coverage_tiles(region, level))


def rect_tiles(rects: list[dict]) -> list[tuple[int, int, int]]:
    return [(r["face"], x, y) for r in rects for x in range(r["x0"], r["x1"] + 1) for y in range(r["y0"], r["y1"] + 1)]


def latlon_bbox_of_tiles(tiles: list[tuple[int, int, int]], level: int, pad_deg: float = 0.0) -> tuple[float, float, float, float]:
    """(lat0, lat1, lon0, lon1) enclosing the given tiles (no antimeridian crossing supported)."""
    lats, lons = [], []
    for f, x, y in tiles:
        d = cube.tile_uv_to_dir(f, level, x, y, np.array([0, 1, 0, 1, 0.5]), np.array([0, 0, 1, 1, 0.5]))
        la, lo = cube.dir_to_lat_lon(d)
        lats.extend(np.degrees(la))
        lons.extend(np.degrees(lo))
    if max(lons) - min(lons) > 180:
        raise ValueError("regions crossing the antimeridian are not supported")
    return min(lats) - pad_deg, max(lats) + pad_deg, min(lons) - pad_deg, max(lons) + pad_deg


def source_bbox(region: dict, slack_km: float = 0.0) -> tuple[float, float, float, float]:
    """Lat/lon box enclosing every regional tile of the region (the coarsest regional level has the
    largest coverage), plus slack."""
    L = levels(region)[0]
    lat0, lat1, lon0, lon1 = latlon_bbox_of_tiles(rect_tiles(coverage_rects(region, L)), L)
    dlat = slack_km / 111.2
    dlon = slack_km / (111.2 * max(0.1, math.cos(math.radians(max(abs(lat0), abs(lat1))))))
    return lat0 - dlat, lat1 + dlat, lon0 - dlon, lon1 + dlon


def set_centre(region: dict, lat_deg: float, lon_deg: float) -> None:
    if region["shape"]["kind"] != "disc":
        raise ValueError("only disc regions have a centre")
    region["shape"]["centre"] = {"latDeg": round(lat_deg, 6), "lonDeg": round(lon_deg, 6)}
    save(region)
    _load_cached.cache_clear()
