"""Resampling kernels shared by the Moon and sky bakes.

- Catmull-Rom (the run-time height authority's interpolant) on arbitrary grids.
- `EquirectPyramid`: a global plate-carree raster with an area-averaged mip chain, sampled by direction
  with a footprint-aware filter (trilinear between mips, extra longitude taps where the grid is
  compressed toward the poles, Catmull-Rom within a mip, wrap in longitude and across the poles).
  The result is a pure function of (direction, footprint), so tiles that share samples, including
  across cube edges, get bit-identical values.
- `tile_bicubic`: Catmull-Rom of a decoded 259 x 259 FRT1 height tile at tile-local (u, v), exactly the
  interpolation the run-time height authority applies to data tiles.
- `dirs_to_tiles`: vectorised direction -> (face, x, y, u, v) built on common.cube.dir_to_face_st.
"""
from __future__ import annotations

import numpy as np

from common import cube

NMAX_LON_TAPS = 8


def catmull_rom_weights(f: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    f2 = f * f
    f3 = f2 * f
    return (-0.5 * f3 + f2 - 0.5 * f, 1.5 * f3 - 2.5 * f2 + 1.0, -1.5 * f3 + 2.0 * f2 + 0.5 * f, 0.5 * f3 - 0.5 * f2)


def footprint_m(dirs: np.ndarray, level: int, radius: float, cells: int = cube.HEIGHT_TILE_CELLS) -> np.ndarray:
    """Isotropic sample spacing (m) of a level-`level` tile grid at unit directions `dirs` (..., 3).

    Gnomonic cell area scales as (1 + s^2 + t^2)^(-3/2) = max|d_i|^3 for a unit direction, so the linear
    spacing is R * (2 / (cells * 2^level)) * max|d_i|^1.5. Written in terms of the direction only, so it is
    identical on both sides of a cube edge.
    """
    m = np.max(np.abs(dirs), axis=-1)
    return radius * (2.0 / (cells * 2.0 ** level)) * m ** 1.5


class EquirectPyramid:
    """Global equirectangular raster (W = 2 H, row 0 at lat0 = +90, column 0 at lon0) with mips.

    mips[k] has shape (H / 2^k, W / 2^k[, C]); values are multiplied by `value_scale` on read.
    """

    def __init__(self, mips: list, lon0: float = -180.0, value_scale: float = 1.0):
        h0, w0 = mips[0].shape[:2]
        if w0 != 2 * h0:
            raise ValueError("global equirect raster must have W = 2 H")
        for k, m in enumerate(mips):
            if m.shape[0] * 2 ** k != h0 or m.shape[1] * 2 ** k != w0:
                raise ValueError(f"mip {k} has shape {m.shape}, expected exact halving of {mips[0].shape}")
        self.mips = mips
        self.lon0 = float(lon0)
        self.value_scale = float(value_scale)
        self.px_deg0 = 180.0 / h0
        self.channels = 1 if mips[0].ndim == 2 else mips[0].shape[2]

    # -- one Catmull-Rom lookup in mip m ------------------------------------------------------------
    def _cr(self, m: int, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        a = self.mips[m]
        h, w = a.shape[:2]
        px = self.px_deg0 * 2.0 ** m
        x = (lon - self.lon0) / px - 0.5
        y = (90.0 - lat) / px - 0.5
        ix0 = np.floor(x)
        iy0 = np.floor(y)
        wx = catmull_rom_weights(x - ix0)
        wy = catmull_rom_weights(y - iy0)
        ix0 = ix0.astype(np.int64)
        iy0 = iy0.astype(np.int64)
        shape = lat.shape + ((self.channels,) if self.channels > 1 else ())
        out = np.zeros(shape, dtype=np.float64)
        half = w // 2
        for dy in range(4):
            iy = iy0 + (dy - 1)
            shift = np.zeros_like(iy)
            north = iy < 0
            south = iy >= h
            iy = np.where(north, -1 - iy, np.where(south, 2 * h - 1 - iy, iy))
            shift[north | south] = half
            row = np.zeros(shape, dtype=np.float64)
            for dx in range(4):
                ix = np.mod(ix0 + (dx - 1) + shift, w)
                v = a[iy, ix].astype(np.float64)
                wgt = wx[dx] if self.channels == 1 else wx[dx][..., None]
                row += wgt * v
            out += (wy[dy] if self.channels == 1 else wy[dy][..., None]) * row
        return out

    def _aniso(self, m: int, lat: np.ndarray, lon: np.ndarray, fp_deg: np.ndarray, coslat: np.ndarray) -> np.ndarray:
        """Average of n Catmull-Rom taps spread across the footprint in longitude (n from the compression)."""
        px = self.px_deg0 * 2.0 ** m
        width = fp_deg / coslat
        n = np.clip(np.ceil(width / px - 1e-9), 1, NMAX_LON_TAPS).astype(np.int64)
        nmax = int(n.max()) if n.size else 1
        shape = lat.shape + ((self.channels,) if self.channels > 1 else ())
        acc = np.zeros(shape, dtype=np.float64)
        for k in range(nmax):
            use = k < n
            if not np.any(use):
                break
            off = ((k + 0.5) / n - 0.5) * width
            v = self._cr(m, lat[use], lon[use] + off[use])
            acc[use] += v
        return acc / (n if self.channels == 1 else n[..., None])

    def sample(self, lat_deg, lon_deg, footprint_deg) -> np.ndarray:
        """Filtered value at (lat, lon) degrees for an isotropic angular footprint (degrees)."""
        lat = np.asarray(lat_deg, dtype=np.float64)
        lon = np.asarray(lon_deg, dtype=np.float64)
        fp = np.broadcast_to(np.asarray(footprint_deg, dtype=np.float64), lat.shape)
        coslat = np.maximum(np.cos(np.radians(lat)), 1e-9)
        fp_px0 = fp / self.px_deg0
        lam = np.log2(np.maximum(fp_px0, 1.0))
        lon_px = fp_px0 / (2.0 ** lam * coslat)
        lam = lam + np.log2(np.maximum(lon_px / NMAX_LON_TAPS, 1.0))
        top = len(self.mips) - 1
        lam = np.minimum(lam, top)
        m0 = np.minimum(np.floor(lam).astype(np.int64), max(top - 1, 0))
        t = np.clip(lam - m0, 0.0, 1.0) if top > 0 else np.zeros_like(lam)
        shape = lat.shape + ((self.channels,) if self.channels > 1 else ())
        out = np.zeros(shape, dtype=np.float64)
        flat_m0 = m0
        for m in np.unique(flat_m0):
            sel = flat_m0 == m
            la, lo, f, c, tt = lat[sel], lon[sel], fp[sel], coslat[sel], t[sel]
            v0 = self._aniso(int(m), la, lo, f, c)
            if top > 0:
                v1 = self._aniso(int(m) + 1, la, lo, f, c)
                tw = tt if self.channels == 1 else tt[..., None]
                out[sel] = (1.0 - tw) * v0 + tw * v1
            else:
                out[sel] = v0
        return out * self.value_scale


def tile_bicubic(heights: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Catmull-Rom of a bordered 259 x 259 height tile at tile-local (u, v) in [0, 1].

    Sample (i, j) of the stored grid sits at u = (i - 1) / 256, v = (j - 1) / 256; the 1-sample border makes
    the 4 x 4 stencil available everywhere inside the tile.
    """
    cells = heights.shape[1] - 3
    x = 1.0 + np.asarray(u, dtype=np.float64) * cells
    y = 1.0 + np.asarray(v, dtype=np.float64) * cells
    ix = np.clip(np.floor(x), 1, cells).astype(np.int64)
    iy = np.clip(np.floor(y), 1, cells).astype(np.int64)
    wx = catmull_rom_weights(x - ix)
    wy = catmull_rom_weights(y - iy)
    out = np.zeros(np.shape(x), dtype=np.float64)
    for dy in range(4):
        row = np.zeros_like(out)
        for dx in range(4):
            row += wx[dx] * heights[iy + dy - 1, ix + dx - 1]
        out += wy[dy] * row
    return out


def dirs_to_tiles(d: np.ndarray, level: int):
    """Vectorised cube.dir_to_tile: arrays (face, x, y, u, v) for directions of shape (..., 3)."""
    face, s, t = cube.dir_to_face_st(d)
    n = 2 ** level
    eps = np.finfo(np.float64).eps
    fx = np.clip((s + 1.0) / 2.0 * n, 0.0, n * (1.0 - eps))
    fy = np.clip((t + 1.0) / 2.0 * n, 0.0, n * (1.0 - eps))
    x = np.minimum(np.floor(fx), n - 1).astype(np.int64)
    y = np.minimum(np.floor(fy), n - 1).astype(np.int64)
    return face.astype(np.int64), x, y, fx - x, fy - y


def srgb_encode(lin: np.ndarray) -> np.ndarray:
    lin = np.clip(lin, 0.0, 1.0)
    return np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * np.power(lin, 1.0 / 2.4) - 0.055)


def srgb_decode(enc: np.ndarray) -> np.ndarray:
    enc = np.asarray(enc, dtype=np.float64)
    return np.where(enc <= 0.04045, enc / 12.92, np.power((enc + 0.055) / 1.055, 2.4))


def box_down2(a: np.ndarray) -> np.ndarray:
    """2 x 2 mean (float64 accumulate) of an array with even leading dimensions."""
    h, w = a.shape[:2]
    b = a.reshape(h // 2, 2, w // 2, 2, *a.shape[2:]).astype(np.float64)
    return b.mean(axis=(1, 3))
