"""Helpers shared by the regional image layers (albedo, watermask, landcover).

Coverage-edge feather (ARCHITECTURE 7.1): the outer FEATHER_TEXELS texels of the coverage of every regional
level are blended into the bilinear upsample of the parent level AS STORED (decoded parent tiles), with weight
w = smootherstep(d / FEATHER_TEXELS), d = distance in texels from the texel centre to the coverage boundary, so
the outermost texel row (d = 0.5) is the parent upsample to within 1e-5 and the renderer can switch levels at
the coverage edge without a seam.
"""
from __future__ import annotations

import math

import numpy as np

from common import cube
from earth import paths, region as regmod, tiles

FEATHER_TEXELS = 64


def boundary_distance(rects: list[dict], face: int, level: int, x: int, y: int) -> np.ndarray:
    """(256, 256) distance in texels from each texel centre of a tile to the boundary of its coverage rect
    (largest over the rects that contain the tile; rects are per-face bounding boxes)."""
    k = np.arange(256) + 0.5
    gx = x * 256 + k[None, :]
    gy = y * 256 + k[:, None]
    best = np.zeros((256, 256))
    for r in rects:
        if r["face"] != face or not (r["x0"] <= x <= r["x1"] and r["y0"] <= y <= r["y1"]):
            continue
        d = np.minimum(np.minimum(gx - r["x0"] * 256, (r["x1"] + 1) * 256 - gx),
                       np.minimum(gy - r["y0"] * 256, (r["y1"] + 1) * 256 - gy))
        best = np.maximum(best, d)
    return best


def feather_weight(d: np.ndarray) -> np.ndarray:
    return regmod.smootherstep(d / FEATHER_TEXELS)


def parent_upsample(layer: str, face: int, level: int, x: int, y: int, reader, ancestor: int | None = None) -> np.ndarray:
    """Bilinear upsample of the stored tiles of an ancestor level (default level - 1) at the texel centres of
    tile (face, level, x, y). reader(face, level, x, y) -> (256, 256, C) float array of a stored tile.
    Texel (c, r) of the child sits at ancestor texel coordinate (x*256 + c + 0.5) / 2^(level - ancestor) - 0.5."""
    pl = level - 1 if ancestor is None else ancestor
    div = 2.0 ** (level - pl)
    k = np.arange(256) + 0.5
    px = (x * 256 + k) / div - 0.5            # ancestor-level global texel coordinates (centres at integers)
    py = (y * 256 + k) / div - 0.5
    ix0 = np.floor(px).astype(np.int64)
    iy0 = np.floor(py).astype(np.int64)
    fx = px - ix0
    fy = py - iy0
    gx0, gx1 = ix0.min(), ix0.max() + 1
    gy0, gy1 = iy0.min(), iy0.max() + 1
    n = 2 ** pl
    tx0, tx1 = max(gx0 // 256, 0), min(gx1 // 256, n - 1)
    ty0, ty1 = max(gy0 // 256, 0), min(gy1 // 256, n - 1)
    # mosaic of the needed parent tiles (clamped at face edges)
    tiles_ = {}
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            tiles_[(tx, ty)] = reader(face, pl, tx, ty)
    c = next(iter(tiles_.values())).shape[2]
    W = (tx1 - tx0 + 1) * 256
    H = (ty1 - ty0 + 1) * 256
    mos = np.empty((H, W, c), np.float64)
    for (tx, ty), t in tiles_.items():
        mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = t
    cx0 = np.clip(ix0 - tx0 * 256, 0, W - 1)
    cx1 = np.clip(ix0 + 1 - tx0 * 256, 0, W - 1)
    cy0 = np.clip(iy0 - ty0 * 256, 0, H - 1)
    cy1 = np.clip(iy0 + 1 - ty0 * 256, 0, H - 1)
    a = mos[cy0][:, cx0] * (1 - fx)[None, :, None] + mos[cy0][:, cx1] * fx[None, :, None]
    b = mos[cy1][:, cx0] * (1 - fx)[None, :, None] + mos[cy1][:, cx1] * fx[None, :, None]
    return a * (1 - fy)[:, None, None] + b * fy[:, None, None]


def texel_metres(face: int, level: int, x: int, y: int) -> float:
    """Mean texel edge length (m) of a tile, from its centre texels."""
    d0 = cube.tile_uv_to_dir(face, level, x, y, 0.5, 0.5)
    d1 = cube.tile_uv_to_dir(face, level, x, y, 0.5 + 1 / 256, 0.5)
    d2 = cube.tile_uv_to_dir(face, level, x, y, 0.5, 0.5 + 1 / 256)
    return 0.5 * (np.linalg.norm(d1 - d0) + np.linalg.norm(d2 - d0)) * paths.RADIUS


def texel_latlon(face: int, level: int, x: int, y: int) -> tuple[np.ndarray, np.ndarray]:
    return tiles.dirs_latlon(cube.image_tile_dirs(face, level, x, y).reshape(-1, 3))


def level_tiles(region: dict, level: int) -> list[tuple[int, int, int]]:
    return regmod.rect_tiles(regmod.coverage_rects(region, level))


def merc_px_m(lat_deg: float, z: int) -> float:
    return 2 * math.pi * paths.RADIUS * math.cos(math.radians(lat_deg)) / (256 * 2 ** z)
