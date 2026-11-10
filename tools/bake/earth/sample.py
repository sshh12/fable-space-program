"""Numba raster samplers used by every layer.

Coordinates are fractional array indices with pixel centres at integers: (cx, cy) = (column, row).
`*_wrap` variants wrap columns (global equirectangular rasters, column 0 at lon -180); rows clamp.
Catmull-Rom is the interpolant of the height authority (terrain.ts), so heights use it; images use
bilinear or clamped Catmull-Rom (no overshoot halos at coastlines).
"""
from __future__ import annotations

import numpy as np
from numba import njit, prange


@njit(cache=True, inline="always")
def _cr(t):
    t2 = t * t
    t3 = t2 * t
    return ((-t3 + 2.0 * t2 - t) * 0.5, (3.0 * t3 - 5.0 * t2 + 2.0) * 0.5,
            (-3.0 * t3 + 4.0 * t2 + t) * 0.5, (t3 - t2) * 0.5)


@njit(cache=True, inline="always")
def _clampi(i, n):
    return 0 if i < 0 else (n - 1 if i > n - 1 else i)


@njit(cache=True, inline="always")
def _wrapi(i, n):
    i = i % n
    return i + n if i < 0 else i


@njit(cache=True, parallel=False)
def bicubic(img, cx, cy, wrap_x=False, scale=1.0):
    """Catmull-Rom of a 2-D array at many points (cx, cy flat float64 arrays). Returns float64."""
    h, w = img.shape
    out = np.empty(cx.size, np.float64)
    for k in range(cx.size):
        x = cx[k]
        y = cy[k]
        ix = int(np.floor(x))
        iy = int(np.floor(y))
        wx0, wx1, wx2, wx3 = _cr(x - ix)
        wy0, wy1, wy2, wy3 = _cr(y - iy)
        acc = 0.0
        for j in range(4):
            r = _clampi(iy - 1 + j, h)
            wy = wy0 if j == 0 else (wy1 if j == 1 else (wy2 if j == 2 else wy3))
            row = 0.0
            for i in range(4):
                c = _wrapi(ix - 1 + i, w) if wrap_x else _clampi(ix - 1 + i, w)
                wx = wx0 if i == 0 else (wx1 if i == 1 else (wx2 if i == 2 else wx3))
                row += wx * img[r, c]
            acc += wy * row
        out[k] = acc * scale
    return out


@njit(cache=True)
def bilinear(img, cx, cy, wrap_x=False, scale=1.0):
    h, w = img.shape
    out = np.empty(cx.size, np.float64)
    for k in range(cx.size):
        x = cx[k]
        y = cy[k]
        ix = int(np.floor(x))
        iy = int(np.floor(y))
        fx = x - ix
        fy = y - iy
        r0 = _clampi(iy, h)
        r1 = _clampi(iy + 1, h)
        if wrap_x:
            c0 = _wrapi(ix, w)
            c1 = _wrapi(ix + 1, w)
        else:
            c0 = _clampi(ix, w)
            c1 = _clampi(ix + 1, w)
        a = img[r0, c0] * (1.0 - fx) + img[r0, c1] * fx
        b = img[r1, c0] * (1.0 - fx) + img[r1, c1] * fx
        out[k] = (a * (1.0 - fy) + b * fy) * scale
    return out


@njit(cache=True)
def bicubic_rgb_clamped(img, cx, cy, wrap_x=False):
    """Catmull-Rom of an (h, w, c) uint8/float image, clamped per channel to the 2x2 neighbourhood range
    (keeps the sharpness of bicubic without overshoot rings). Returns float64 (n, c)."""
    h, w, nc = img.shape
    out = np.empty((cx.size, nc), np.float64)
    for k in range(cx.size):
        x = cx[k]
        y = cy[k]
        ix = int(np.floor(x))
        iy = int(np.floor(y))
        wx0, wx1, wx2, wx3 = _cr(x - ix)
        wy0, wy1, wy2, wy3 = _cr(y - iy)
        for ch in range(nc):
            acc = 0.0
            lo = 1e30
            hi = -1e30
            for j in range(4):
                r = _clampi(iy - 1 + j, h)
                wy = wy0 if j == 0 else (wy1 if j == 1 else (wy2 if j == 2 else wy3))
                row = 0.0
                for i in range(4):
                    c = _wrapi(ix - 1 + i, w) if wrap_x else _clampi(ix - 1 + i, w)
                    wx = wx0 if i == 0 else (wx1 if i == 1 else (wx2 if i == 2 else wx3))
                    v = float(img[r, c, ch])
                    row += wx * v
                    if (j == 1 or j == 2) and (i == 1 or i == 2):
                        lo = min(lo, v)
                        hi = max(hi, v)
                acc += wy * row
            out[k, ch] = min(max(acc, lo), hi)
    return out


@njit(cache=True, parallel=True)
def lon_prefilter_rows(img, lat_of_row, ratio):
    """In-place box filter along longitude (wrapping) of a float 2-D block of equirectangular rows.

    Row r is averaged over a centred box of fractional width w = ratio / cos(lat) pixels (when w > 1.25),
    which brings high-latitude cells, ever narrower in longitude, to at least `ratio` times their height in
    metres before they are resampled onto the cube (anti-aliasing near the poles). Multi-channel images are
    filtered one channel at a time.
    """
    h, w = img.shape
    for r in prange(h):
        c = np.cos(np.radians(lat_of_row[r]))
        width = ratio / max(c, 1e-6)
        if width <= 1.25:
            continue
        width = min(width, w)
        # prefix sums of the wrapped row
        p = np.empty(w + 1, np.float64)
        p[0] = 0.0
        for i in range(w):
            p[i + 1] = p[i] + img[r, i]
        total = p[w]
        half = 0.5 * width
        row = np.empty(w, np.float64)
        for i in range(w):
            a = i + 0.5 - half
            b = i + 0.5 + half
            row[i] = (_integral(p, total, w, b) - _integral(p, total, w, a)) / width
        for i in range(w):
            img[r, i] = row[i]


@njit(cache=True, inline="always")
def _integral(p, total, w, x):
    """Integral of the wrapped piecewise-constant row from 0 to x (x may be negative or > w)."""
    k = int(np.floor(x / w))
    xr = x - k * w
    i = int(np.floor(xr))
    if i >= w:
        i = w - 1
    return k * total + p[i] + (xr - i) * (p[i + 1] - p[i])
