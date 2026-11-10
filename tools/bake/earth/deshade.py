"""Topographic de-shading of satellite imagery (no baked relief shading in the albedo layer).

Imagery taken under a real sun is brighter on slopes facing it. With n = (n_east, n_north, n_up) the unit
surface normal from the DEM, the shading is modelled to first order as

    Y = A (1 + alpha n_east + beta n_north)          (Y = linear luminance, A = albedo)

alpha and beta (the horizontal sun direction times a strength) are fitted by least squares on
log Y - log(local mean of Y over ~30 km) over land with slope (so albedo patterns average out), in latitude
bands for the global mosaic (the sun geometry of the composite changes with latitude) and once for a regional
mosaic. The correction divides every colour channel by (1 + alpha n_east + beta n_north), clamped to
[0.6, 1.6].
"""
from __future__ import annotations

import numpy as np
from scipy import ndimage

CLAMP = (0.6, 1.6)


def normals_equirect(h: np.ndarray, lat_rows: np.ndarray, cell_deg: float, radius: float):
    """East/north components of the unit normal of an equirectangular DEM block (rows = lat descending)."""
    dy = np.deg2rad(cell_deg) * radius
    dx = (dy * np.cos(np.deg2rad(lat_rows)))[:, None]
    gx = np.empty_like(h, dtype=np.float64)
    gy = np.empty_like(h, dtype=np.float64)
    gx[:, 1:-1] = (h[:, 2:] - h[:, :-2]) / (2.0 * dx)
    gx[:, 0] = gx[:, 1]
    gx[:, -1] = gx[:, -2]
    gy[1:-1] = (h[:-2] - h[2:]) / (2.0 * dy)          # north = up the rows
    gy[0] = gy[1]
    gy[-1] = gy[-2]
    nrm = np.sqrt(1.0 + gx * gx + gy * gy)
    return -gx / nrm, -gy / nrm, 1.0 / nrm


class Accumulator:
    """Normal equations of log(Y / Ybar) = alpha n_e + beta n_n (+ c), per band."""

    def __init__(self, nbands: int = 1):
        self.ata = np.zeros((nbands, 3, 3))
        self.atb = np.zeros((nbands, 3))
        self.n = np.zeros(nbands, np.int64)

    def add(self, band: int, ne: np.ndarray, nn: np.ndarray, ratio_log: np.ndarray) -> None:
        a = np.stack([ne, nn, np.ones_like(ne)], axis=1)
        self.ata[band] += a.T @ a
        self.atb[band] += a.T @ ratio_log
        self.n[band] += ne.size

    def solve(self, min_n: int = 20000) -> np.ndarray:
        """(nbands, 2) alpha, beta; bands with too few samples borrow from their neighbours."""
        out = np.full((self.ata.shape[0], 2), np.nan)
        for b in range(self.ata.shape[0]):
            if self.n[b] >= min_n:
                out[b] = np.linalg.solve(self.ata[b] + 1e-9 * np.eye(3), self.atb[b])[:2]
        ok = ~np.isnan(out[:, 0])
        if not ok.any():
            return np.zeros_like(out)
        idx = np.arange(out.shape[0])
        for k in range(2):
            out[:, k] = np.interp(idx, idx[ok], out[ok, k])
        return out


def local_log_ratio(y: np.ndarray, valid: np.ndarray, sigma_px: float) -> np.ndarray:
    """log(Y) - log(Gaussian mean of Y over valid pixels)."""
    w = ndimage.gaussian_filter(valid.astype(np.float64), sigma_px, mode="nearest")
    m = ndimage.gaussian_filter(np.where(valid, y, 0.0), sigma_px, mode="nearest") / np.maximum(w, 1e-6)
    return np.log(np.maximum(y, 1e-5)) - np.log(np.maximum(m, 1e-5))


def factor(ne: np.ndarray, nn: np.ndarray, alpha, beta) -> np.ndarray:
    return np.clip(1.0 + alpha * ne + beta * nn, *CLAMP)
