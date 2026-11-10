"""Height pyramid maths shared by the global and regional height bakes.

Every height sample is a pure function of its unit direction and its level, which is what makes tiles
seamless across tile and cube-face edges (shared vertices have bit-identical directions, so they get
bit-identical values) and places border samples at their true neighbouring directions.

  finest level F:   H_F(d) = source(d)                          (or a tent average of a finer source)
  coarser level L:  H_L(d) = sum_ab w_a w_b B_(L+1)(p_ab(d))     w = (1, 2, 1) / 4,  a, b in {-1, 0, 1}
                    p_ab(d) = normalize(d + D_(L+1)(d) (a e1(d) + b e2(d)))
B_(L+1) is the bilinear surface of the stored level-(L+1) tiles, e1/e2 the local east/north directions at d
and D_(L+1)(d) the local angular vertex spacing of level L+1, (2 / (2^(L+1) 256)) m(d)^1.5 with m(d) the
largest absolute component of d (the gnomonic area element, the same on both faces of a shared edge).
This is full weighting, i.e. the area average of the finer bilinear surface over each coarse vertex's
footprint, evaluated in a face-independent frame.
"""
from __future__ import annotations

import numpy as np
from numba import njit

from common import cube

_EPS = np.finfo(np.float64).eps
# cube basis as (axis, sign) pairs: component `axis` of the direction times `sign` (cube.py FACE_N/U/V)
_N_AX = np.array([0, 0, 1, 1, 2, 2])
_N_SG = np.array([1.0, -1.0, 1.0, -1.0, 1.0, -1.0])
_U_AX = np.array([1, 1, 0, 0, 0, 0])
_U_SG = np.array([1.0, -1.0, -1.0, 1.0, 1.0, 1.0])
_V_AX = np.array([2, 2, 2, 2, 1, 1])
_V_SG = np.array([1.0, 1.0, 1.0, 1.0, 1.0, -1.0])


@njit(cache=True)
def stencil(d: np.ndarray, child_level: int) -> np.ndarray:
    """(9, n, 3) stencil points around unit directions d (n, 3) at the vertex spacing of child_level.
    Scalar per-direction arithmetic only, so a direction always yields the same bits."""
    n = d.shape[0]
    out = np.empty((9, n, 3))
    base = 2.0 / (2.0 ** child_level * 256.0)
    for i in range(n):
        x, y, z = d[i, 0], d[i, 1], d[i, 2]
        ex, ey = -y, x                                  # Z x d (east)
        en = np.sqrt(ex * ex + ey * ey)
        if en < 1e-12:                                  # the poles: any horizontal direction
            ex, ey = 0.0, 1.0
        else:
            ex, ey = ex / en, ey / en
        ez = 0.0
        nx = y * ez - z * ey                            # d x e1 (north)
        ny = z * ex - x * ez
        nz = x * ey - y * ex
        m = max(max(abs(x), abs(y)), abs(z))
        h = base * (m * np.sqrt(m))
        k = 0
        for a in (-1.0, 0.0, 1.0):
            for b in (-1.0, 0.0, 1.0):
                px = x + h * (a * ex + b * nx)
                py = y + h * (a * ey + b * ny)
                pz = z + h * (a * ez + b * nz)
                ln = np.sqrt(px * px + py * py + pz * pz)
                out[k, i, 0] = px / ln
                out[k, i, 1] = py / ln
                out[k, i, 2] = pz / ln
                k += 1
    return out


@njit(cache=True)
def tent(values9: np.ndarray) -> np.ndarray:
    """Weighted sum of the 9 stencil values (9, n) in a fixed order (full weighting)."""
    n = values9.shape[1]
    out = np.zeros(n)
    w = (0.25, 0.5, 0.25)
    for i in range(n):
        acc = 0.0
        k = 0
        for a in range(3):
            for b in range(3):
                acc = acc + (w[a] * w[b]) * values9[k, i]
                k += 1
        out[i] = acc
    return out


@njit(cache=True, inline="always")
def _locate1(px, py, pz, nt, n_ax, n_sg, u_ax, u_sg, v_ax, v_sg, eps):
    """cube.dir_to_tile for one direction: (face, x, y, u, v); ties to the lower face id."""
    ax, ay, az = abs(px), abs(py), abs(pz)
    if ax >= ay and ax >= az:
        f = 0 if px >= 0 else 1
    elif ay >= az:
        f = 2 if py >= 0 else 3
    else:
        f = 4 if pz >= 0 else 5
    c = (px, py, pz)
    dn = c[n_ax[f]] * n_sg[f]
    s = c[u_ax[f]] * u_sg[f] / dn
    t = c[v_ax[f]] * v_sg[f] / dn
    fx = min(max((s + 1.0) / 2.0 * nt, 0.0), nt * (1.0 - eps))
    fy = min(max((t + 1.0) / 2.0 * nt, 0.0), nt * (1.0 - eps))
    x = min(int(np.floor(fx)), nt - 1)
    y = min(int(np.floor(fy)), nt - 1)
    return f, x, y, fx - x, fy - y


@njit(cache=True)
def point_keys(p: np.ndarray, level: int, n_ax, n_sg, u_ax, u_sg, v_ax, v_sg, eps) -> np.ndarray:
    """Tile keys (face * N + y) * N + x of directions (m, 3) at a level."""
    nt = 2 ** level
    out = np.empty(p.shape[0], np.int64)
    for i in range(p.shape[0]):
        f, x, y, _, _ = _locate1(p[i, 0], p[i, 1], p[i, 2], nt, n_ax, n_sg, u_ax, u_sg, v_ax, v_sg, eps)
        out[i] = (f * nt + y) * nt + x
    return out


@njit(cache=True)
def gather_bilinear(p: np.ndarray, level: int, keys: np.ndarray, stack: np.ndarray, present: np.ndarray,
                    n_ax, n_sg, u_ax, u_sg, v_ax, v_sg, eps) -> np.ndarray:
    """Bilinear interpolation of stacked vertex grids (K, 259, 259) at directions (m, 3); NaN where the
    tile is absent (keys sorted, `present` flags the loaded ones)."""
    nt = 2 ** level
    out = np.empty(p.shape[0])
    for i in range(p.shape[0]):
        f, x, y, u, v = _locate1(p[i, 0], p[i, 1], p[i, 2], nt, n_ax, n_sg, u_ax, u_sg, v_ax, v_sg, eps)
        key = (f * nt + y) * nt + x
        k = np.searchsorted(keys, key)
        if k >= keys.size or keys[k] != key or not present[k]:
            out[i] = np.nan
            continue
        gi = 1.0 + u * 256.0
        gj = 1.0 + v * 256.0
        i0 = min(int(np.floor(gi)), 256)
        j0 = min(int(np.floor(gj)), 256)
        fx = gi - i0
        fy = gj - j0
        a = float(stack[k, j0, i0]) * (1.0 - fx) + float(stack[k, j0, i0 + 1]) * fx
        b = float(stack[k, j0 + 1, i0]) * (1.0 - fx) + float(stack[k, j0 + 1, i0 + 1]) * fx
        out[i] = a * (1.0 - fy) + b * fy
    return out


_BASIS = (_N_AX, _N_SG, _U_AX, _U_SG, _V_AX, _V_SG, _EPS)


def locate(p: np.ndarray, level: int):
    """Vectorised cube.dir_to_tile: (face, x, y, u, v) arrays for directions (n, 3)."""
    face, s, t = cube.dir_to_face_st(p)
    n = 2 ** level
    fx = np.minimum(np.maximum((s + 1.0) / 2.0 * n, 0.0), n * (1.0 - _EPS))
    fy = np.minimum(np.maximum((t + 1.0) / 2.0 * n, 0.0), n * (1.0 - _EPS))
    x = np.minimum(np.floor(fx).astype(np.int64), n - 1)
    y = np.minimum(np.floor(fy).astype(np.int64), n - 1)
    return face.astype(np.int64), x, y, fx - x, fy - y


class TileCache:
    """Decoded height tiles of one level (bounded LRU-free dict; units are small enough)."""

    def __init__(self, level: int, loader):
        self.level = level
        self.loader = loader
        self.tiles: dict[tuple[int, int, int], np.ndarray | None] = {}

    def get(self, f: int, x: int, y: int):
        k = (f, x, y)
        if k not in self.tiles:
            self.tiles[k] = self.loader(f, self.level, x, y)
        return self.tiles[k]

    def trim(self, keep: int = 1200) -> None:
        if len(self.tiles) > keep:
            for k in list(self.tiles)[: len(self.tiles) - keep]:
                del self.tiles[k]


def bilinear_from_tiles(p: np.ndarray, cache: TileCache, fallback=None) -> np.ndarray:
    """Bilinear interpolation of the vertex grids of the tiles containing p. Points whose tile is absent
    are evaluated with fallback(p) (required when any tile can be absent)."""
    level = cache.level
    p = np.ascontiguousarray(p, dtype=np.float64)
    n = 2 ** level
    uk = np.unique(point_keys(p, level, *_BASIS))
    stack = np.zeros((uk.size, 259, 259), np.float32)
    present = np.zeros(uk.size, bool)
    for i, k in enumerate(uk):
        t = cache.get(int(k // (n * n)), int(k % n), int((k // n) % n))
        if t is not None:
            stack[i] = t
            present[i] = True
    out = gather_bilinear(p, level, uk, stack, present, *_BASIS)
    miss = np.isnan(out)
    if miss.any():
        if fallback is None:
            raise FileNotFoundError(f"level-{level} height tile missing for a stencil point")
        out[miss] = fallback(p[miss])
    return out


def downsample_tile(face: int, level: int, x: int, y: int, child: TileCache, fallback=None) -> np.ndarray:
    """H_level on the 259 x 259 samples of a tile from the level+1 tiles in `child`."""
    d = np.ascontiguousarray(cube.height_tile_dirs(face, level, x, y).reshape(-1, 3))
    pts = stencil(d, level + 1)
    vals = bilinear_from_tiles(pts.reshape(-1, 3), child, fallback).reshape(9, -1)
    return tent(vals).reshape(259, 259)


def tent_of_function(face: int, level: int, x: int, y: int, fn) -> np.ndarray:
    """H_level from a continuous finer source fn(points (n, 3)) -> heights (finest stored level)."""
    d = np.ascontiguousarray(cube.height_tile_dirs(face, level, x, y).reshape(-1, 3))
    pts = stencil(d, level + 1)
    return tent(np.ascontiguousarray(fn(pts.reshape(-1, 3)).reshape(9, -1))).reshape(259, 259)
