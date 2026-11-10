"""Sparse Web-Mercator tile mosaics: a (K, 256, 256[, C]) stack of decoded tiles plus a tile index grid.

Used where a dense mosaic would be far too large (Terrarium z15 over a whole island, Sentinel-2 z14 over a
region). Samplers read pixels across tile edges through the index and return NaN where a needed tile is
missing. The stack is stored as .npy under data/cache/earth/work so worker processes share it via mmap.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
from numba import njit

from earth import merc, paths
from earth.sample import _cr


class TileStack:
    def __init__(self, z: int, tx0: int, ty0: int, index: np.ndarray, stack: np.ndarray):
        self.z, self.tx0, self.ty0, self.index, self.stack = z, tx0, ty0, index, stack

    @staticmethod
    def _base(name: str, z: int, tiles: list[tuple[int, int]]) -> Path:
        key = hashlib.sha256(json.dumps([name, z, sorted(set(tiles))]).encode()).hexdigest()[:12]
        return paths.WORK / f"stack-{name}-z{z}-{key}"

    @classmethod
    def load(cls, name: str, z: int, tiles: list[tuple[int, int]]) -> "TileStack":
        """The cached stack of exactly these tiles; FileNotFoundError when it has not been built."""
        base = cls._base(name, z, tiles)
        meta_p = Path(str(base) + ".json")
        if not meta_p.is_file():
            raise FileNotFoundError(meta_p)
        meta = json.loads(meta_p.read_text(encoding="utf-8"))
        index = np.load(str(base) + ".index.npy")
        stack = np.load(str(base) + ".stack.npy", mmap_mode="r")
        return cls(z, meta["tx0"], meta["ty0"], index, stack)

    @classmethod
    def build(cls, name: str, z: int, tiles: list[tuple[int, int]], loader, channels: int = 0,
              dtype=np.float32, allow_missing: bool = False) -> "TileStack":
        """Decode tiles (x, y) at zoom z with loader(z, x, y) -> array or None; cached by tile list. A tile the
        loader cannot provide is an error unless allow_missing (then samplers return NaN there)."""
        tiles = sorted(set(tiles))
        try:
            return cls.load(name, z, tiles)
        except FileNotFoundError:
            pass
        base = cls._base(name, z, tiles)
        meta_p = Path(str(base) + ".json")
        xs = [t[0] for t in tiles]
        ys = [t[1] for t in tiles]
        tx0, ty0 = min(xs), min(ys)
        index = np.full((max(ys) - ty0 + 1, max(xs) - tx0 + 1), -1, np.int32)
        shape = (len(tiles), 256, 256) + ((channels,) if channels else ())
        stack = np.lib.format.open_memmap(str(base) + ".stack.npy.partial", mode="w+", dtype=dtype, shape=shape)
        k = 0
        for x, y in tiles:
            a = loader(z, x, y)
            if a is None:
                if not allow_missing:
                    raise FileNotFoundError(f"{name}: tile z{z}/{x}/{y} is not available")
                continue
            stack[k] = a
            index[y - ty0, x - tx0] = k
            k += 1
        stack.flush()
        del stack
        Path(str(base) + ".stack.npy.partial").replace(str(base) + ".stack.npy")
        np.save(str(base) + ".index.npy", index)
        meta_p.write_text(json.dumps({"tx0": tx0, "ty0": ty0, "count": k}), encoding="utf-8")
        return cls(z, tx0, ty0, index, np.load(str(base) + ".stack.npy", mmap_mode="r"))

    def global_px(self, lat_deg, lon_deg):
        return merc.lonlat_to_global_px(lon_deg, lat_deg, self.z)

    def bicubic(self, lat_deg, lon_deg) -> np.ndarray:
        gx, gy = self.global_px(np.ravel(lat_deg), np.ravel(lon_deg))
        return _bicubic_stack(self.stack, self.index, self.tx0, self.ty0, gx - 0.5, gy - 0.5)

    def bilinear(self, lat_deg, lon_deg) -> np.ndarray:
        gx, gy = self.global_px(np.ravel(lat_deg), np.ravel(lon_deg))
        return _bilinear_stack(self.stack, self.index, self.tx0, self.ty0, gx - 0.5, gy - 0.5)

    def bilinear_rgb(self, lat_deg, lon_deg) -> np.ndarray:
        gx, gy = self.global_px(np.ravel(lat_deg), np.ravel(lon_deg))
        return _bilinear_stack_rgb(self.stack, self.index, self.tx0, self.ty0, gx - 0.5, gy - 0.5)

    def box_rgb(self, lat_deg, lon_deg, half_px: np.ndarray) -> np.ndarray:
        """Mean colour over a square footprint of +-half_px source pixels (area average for downsampling)."""
        gx, gy = self.global_px(np.ravel(lat_deg), np.ravel(lon_deg))
        return _box_stack_rgb(self.stack, self.index, self.tx0, self.ty0, gx - 0.5, gy - 0.5,
                              np.ascontiguousarray(np.ravel(half_px), dtype=np.float64))


@njit(cache=True, inline="always")
def _px(stack, index, tx0, ty0, gx, gy):
    tx = (gx >> 8) - tx0
    ty = (gy >> 8) - ty0
    if tx < 0 or ty < 0 or ty >= index.shape[0] or tx >= index.shape[1]:
        return np.nan
    k = index[ty, tx]
    if k < 0:
        return np.nan
    return float(stack[k, gy & 255, gx & 255])


@njit(cache=True)
def _bicubic_stack(stack, index, tx0, ty0, cx, cy):
    out = np.empty(cx.size, np.float64)
    for n in range(cx.size):
        ix = int(np.floor(cx[n]))
        iy = int(np.floor(cy[n]))
        wx0, wx1, wx2, wx3 = _cr(cx[n] - ix)
        wy0, wy1, wy2, wy3 = _cr(cy[n] - iy)
        acc = 0.0
        for j in range(4):
            wy = wy0 if j == 0 else (wy1 if j == 1 else (wy2 if j == 2 else wy3))
            row = 0.0
            for i in range(4):
                wx = wx0 if i == 0 else (wx1 if i == 1 else (wx2 if i == 2 else wx3))
                row += wx * _px(stack, index, tx0, ty0, ix - 1 + i, iy - 1 + j)
            acc += wy * row
        out[n] = acc
    return out


@njit(cache=True)
def _bilinear_stack(stack, index, tx0, ty0, cx, cy):
    out = np.empty(cx.size, np.float64)
    for n in range(cx.size):
        ix = int(np.floor(cx[n]))
        iy = int(np.floor(cy[n]))
        fx = cx[n] - ix
        fy = cy[n] - iy
        a = _px(stack, index, tx0, ty0, ix, iy) * (1 - fx) + _px(stack, index, tx0, ty0, ix + 1, iy) * fx
        b = _px(stack, index, tx0, ty0, ix, iy + 1) * (1 - fx) + _px(stack, index, tx0, ty0, ix + 1, iy + 1) * fx
        out[n] = a * (1 - fy) + b * fy
    return out


@njit(cache=True, inline="always")
def _pxc(stack, index, tx0, ty0, gx, gy, ch):
    tx = (gx >> 8) - tx0
    ty = (gy >> 8) - ty0
    if tx < 0 or ty < 0 or ty >= index.shape[0] or tx >= index.shape[1]:
        return np.nan
    k = index[ty, tx]
    if k < 0:
        return np.nan
    return float(stack[k, gy & 255, gx & 255, ch])


@njit(cache=True)
def _bilinear_stack_rgb(stack, index, tx0, ty0, cx, cy):
    nc = stack.shape[3]
    out = np.empty((cx.size, nc), np.float64)
    for n in range(cx.size):
        ix = int(np.floor(cx[n]))
        iy = int(np.floor(cy[n]))
        fx = cx[n] - ix
        fy = cy[n] - iy
        for ch in range(nc):
            a = _pxc(stack, index, tx0, ty0, ix, iy, ch) * (1 - fx) + _pxc(stack, index, tx0, ty0, ix + 1, iy, ch) * fx
            b = _pxc(stack, index, tx0, ty0, ix, iy + 1, ch) * (1 - fx) + _pxc(stack, index, tx0, ty0, ix + 1, iy + 1, ch) * fx
            out[n, ch] = a * (1 - fy) + b * fy
    return out


@njit(cache=True)
def _box_stack_rgb(stack, index, tx0, ty0, cx, cy, half):
    """Area average with a box of half-width `half` px (fractional edges weighted)."""
    nc = stack.shape[3]
    out = np.empty((cx.size, nc), np.float64)
    for n in range(cx.size):
        h = max(half[n], 0.5)
        x0 = cx[n] - h + 0.5
        x1 = cx[n] + h + 0.5
        y0 = cy[n] - h + 0.5
        y1 = cy[n] + h + 0.5
        acc = np.zeros(nc)
        wsum = 0.0
        for gy in range(int(np.floor(y0)), int(np.ceil(y1))):
            wy = min(y1, gy + 1.0) - max(y0, float(gy))
            if wy <= 0:
                continue
            for gx in range(int(np.floor(x0)), int(np.ceil(x1))):
                wx = min(x1, gx + 1.0) - max(x0, float(gx))
                if wx <= 0:
                    continue
                w = wx * wy
                for ch in range(nc):
                    acc[ch] += w * _pxc(stack, index, tx0, ty0, gx, gy, ch)
                wsum += w
        for ch in range(nc):
            out[n, ch] = acc[ch] / wsum
    return out
