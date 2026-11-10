"""Cube-sphere mapping for the bake pipeline: the Python mirror of src/core/geo/cubeSphere.ts.

Lead-owned shared contract code. Both bake pipelines import it; do not copy or re-derive it.
Verified against tools/bake/golden/cube_vectors.json by test_common.py.

Body-fixed frame: +Z spin axis (north), +X prime meridian, right-handed.
  dir = (cos lat cos lon, cos lat sin lon, sin lat), lon east-positive.
Faces: 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z.  dir = normalize(N + s U + t V), s, t in [-1, 1].
Tile (face, level, x, y), tile-local (u, v) in [0, 1]:
  s = -1 + 2 (x + u) / 2^level,  t = -1 + 2 (y + v) / 2^level.
Raster convention for EVERY layer: column index increases with u, ROW index increases with v
(row 0 is the low-t edge; on equatorial faces that is the SOUTH edge, so tiles look upside-down in an
image viewer -- that is intended).
"""
from __future__ import annotations

import numpy as np

FACE_N = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], dtype=np.float64)
FACE_U = np.array([[0, 1, 0], [0, -1, 0], [-1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]], dtype=np.float64)
FACE_V = np.array([[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 1, 0], [0, -1, 0]], dtype=np.float64)

HEIGHT_TILE_CELLS = 256
HEIGHT_TILE_BORDER = 1
HEIGHT_TILE_STORED = 259
IMAGE_TILE_SIZE = 256


def face_st_to_dir(face: int, s, t) -> np.ndarray:
    """Unit directions for face coordinates. s, t: scalars or arrays (broadcast). Returns (..., 3)."""
    s = np.asarray(s, dtype=np.float64)
    t = np.asarray(t, dtype=np.float64)
    c = FACE_N[face] + s[..., None] * FACE_U[face] + t[..., None] * FACE_V[face]
    return c / np.linalg.norm(c, axis=-1, keepdims=True)


def dir_to_face_st(d) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Face index and (s, t) for directions of shape (..., 3). Ties resolve to the lower face id."""
    d = np.asarray(d, dtype=np.float64)
    ax, ay, az = np.abs(d[..., 0]), np.abs(d[..., 1]), np.abs(d[..., 2])
    is_x = (ax >= ay) & (ax >= az)
    is_y = ~is_x & (ay >= az)
    face = np.where(is_x, np.where(d[..., 0] >= 0, 0, 1), np.where(is_y, np.where(d[..., 1] >= 0, 2, 3), np.where(d[..., 2] >= 0, 4, 5)))
    n = FACE_N[face]
    u = FACE_U[face]
    v = FACE_V[face]
    dn = np.sum(d * n, axis=-1)
    return face, np.sum(d * u, axis=-1) / dn, np.sum(d * v, axis=-1) / dn


def tile_uv_to_dir(face: int, level: int, x: int, y: int, u, v) -> np.ndarray:
    n = float(2 ** level)
    u = np.asarray(u, dtype=np.float64)
    v = np.asarray(v, dtype=np.float64)
    return face_st_to_dir(face, -1.0 + 2.0 * (x + u) / n, -1.0 + 2.0 * (y + v) / n)


def dir_to_tile(d, level: int) -> tuple[int, int, int, float, float]:
    """(face, x, y, u, v) of the level-`level` tile containing one direction."""
    face, s, t = dir_to_face_st(np.asarray(d, dtype=np.float64))
    n = 2 ** level
    fx = min(max((float(s) + 1.0) / 2.0 * n, 0.0), n * (1.0 - np.finfo(np.float64).eps))
    fy = min(max((float(t) + 1.0) / 2.0 * n, 0.0), n * (1.0 - np.finfo(np.float64).eps))
    x = min(int(np.floor(fx)), n - 1)
    y = min(int(np.floor(fy)), n - 1)
    return int(face), x, y, fx - x, fy - y


def lat_lon_to_dir(lat_rad, lon_rad) -> np.ndarray:
    lat = np.asarray(lat_rad, dtype=np.float64)
    lon = np.asarray(lon_rad, dtype=np.float64)
    c = np.cos(lat)
    return np.stack([c * np.cos(lon), c * np.sin(lon), np.sin(lat)], axis=-1)


def dir_to_lat_lon(d) -> tuple[np.ndarray, np.ndarray]:
    """Planetocentric latitude and east longitude in radians (lon in (-pi, pi])."""
    d = np.asarray(d, dtype=np.float64)
    return np.arctan2(d[..., 2], np.hypot(d[..., 0], d[..., 1])), np.arctan2(d[..., 1], d[..., 0])


def height_tile_dirs(face: int, level: int, x: int, y: int) -> np.ndarray:
    """Directions of the 259 x 259 samples of a height tile, shape (259, 259, 3), index [row j, column i].

    Sample (i, j) sits at tile u = (i - 1) / 256, v = (j - 1) / 256 (vertex-registered, 1-sample border).
    """
    k = (np.arange(HEIGHT_TILE_STORED, dtype=np.float64) - HEIGHT_TILE_BORDER) / HEIGHT_TILE_CELLS
    u, v = np.meshgrid(k, k, indexing="xy")
    return tile_uv_to_dir(face, level, x, y, u, v)


def image_tile_dirs(face: int, level: int, x: int, y: int, size: int = IMAGE_TILE_SIZE) -> np.ndarray:
    """Directions of the texel centres of an image tile, shape (size, size, 3), index [row, column].

    Texel (c, r) centre sits at tile u = (c + 0.5) / size, v = (r + 0.5) / size (cell-registered, no border).
    """
    k = (np.arange(size, dtype=np.float64) + 0.5) / size
    u, v = np.meshgrid(k, k, indexing="xy")
    return tile_uv_to_dir(face, level, x, y, u, v)


def mean_tile_size(radius: float, level: int) -> float:
    return np.pi * radius / 2.0 / (2 ** level)


def tile_path(tileset: str, layer: str, face: int, level: int, x: int, y: int, ext: str) -> str:
    """Path relative to the tile root (data/tiles): {tileset}/{layer}/{face}/{level}/{x}/{y}.{ext}"""
    return f"{tileset}/{layer}/{face}/{level}/{x}/{y}.{ext}"


def tiles_covering_disc(lat_rad: float, lon_rad: float, radius_m: float, body_radius: float, level: int) -> list[tuple[int, int, int]]:
    """(face, x, y) of every level-`level` tile that intersects a spherical cap (conservative).

    Used to turn a region of interest into the TileRect coverage of a manifest.
    """
    centre = lat_lon_to_dir(lat_rad, lon_rad)
    ang = radius_m / body_radius
    n = 2 ** level
    out: set[tuple[int, int, int]] = set()
    # Sample the cap densely enough that no tile can be skipped: step well under half a tile.
    tile_ang = (np.pi / 2.0) / n
    rings = max(2, int(np.ceil(ang / (tile_ang * 0.35))))
    e1 = np.cross(centre, [0.0, 0.0, 1.0])
    if np.linalg.norm(e1) < 1e-9:
        e1 = np.array([1.0, 0.0, 0.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(centre, e1)
    for ri in range(rings + 1):
        a = ang * ri / rings
        m = max(1, int(np.ceil(2 * np.pi * np.sin(a) / (tile_ang * 0.35)))) if ri else 1
        th = np.arange(m) * (2 * np.pi / m)
        d = np.cos(a) * centre + np.sin(a) * (np.cos(th)[:, None] * e1 + np.sin(th)[:, None] * e2)
        for row in np.atleast_2d(d):
            f, x, y, _, _ = dir_to_tile(row, level)
            out.add((f, x, y))
    return sorted(out)


def rects_from_tiles(tiles: list[tuple[int, int, int]]) -> list[dict]:
    """Bounding rectangle per face as manifest TileRect dicts ({face, x0, y0, x1, y1}, inclusive).

    A bake that uses this must write EVERY tile inside the rectangles (the manifest promises they exist).
    """
    rects = []
    for face in sorted({t[0] for t in tiles}):
        xs = [t[1] for t in tiles if t[0] == face]
        ys = [t[2] for t in tiles if t[0] == face]
        rects.append({"face": face, "x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)})
    return rects
