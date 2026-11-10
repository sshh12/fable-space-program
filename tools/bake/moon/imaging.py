"""Small image helpers for contact sheets: hillshade, tone mapping, PNG writing, simple drawing."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def hillshade(h: np.ndarray, spacing_m: float, az_deg: float = 270.0, elev_deg: float = 30.0, z: float = 1.0) -> np.ndarray:
    """Lambert hillshade in [0, 1] of a height grid (rows = north-up image rows); az = direction TO the sun."""
    gy, gx = np.gradient(h * z, spacing_m)
    # image rows increase downward (south), so north component of the gradient is -gy
    nx, ny, nz = -gx, gy, np.ones_like(h)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    a, e = np.radians(az_deg), np.radians(elev_deg)
    sx, sy, sz = np.sin(a) * np.cos(e), np.cos(a) * np.cos(e), np.sin(e)
    return np.clip((nx * sx + ny * sy + nz * sz) / norm, 0.0, 1.0)


def to_u8(a: np.ndarray, lo: float | None = None, hi: float | None = None) -> np.ndarray:
    lo = float(np.nanpercentile(a, 0.5)) if lo is None else lo
    hi = float(np.nanpercentile(a, 99.5)) if hi is None else hi
    return (np.clip((a - lo) / max(hi - lo, 1e-12), 0, 1) * 255 + 0.5).astype(np.uint8)


def save_png(path: Path, a: np.ndarray) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(a).save(path, optimize=True)
    return path


def label(img: Image.Image, xy, text: str, fill=(255, 255, 0)) -> None:
    d = ImageDraw.Draw(img)
    x, y = xy
    d.text((x + 1, y + 1), text, fill=(0, 0, 0))
    d.text((x, y), text, fill=fill)


def grid_sheet(tiles: list[np.ndarray], cols: int, pad: int = 4, bg: int = 32) -> np.ndarray:
    """Arrange equally sized (h, w[, 3]) uint8 images in a grid."""
    h, w = tiles[0].shape[:2]
    ch = 3
    rows = (len(tiles) + cols - 1) // cols
    out = np.full((rows * (h + pad) + pad, cols * (w + pad) + pad, ch), bg, np.uint8)
    for k, t in enumerate(tiles):
        r, c = divmod(k, cols)
        tt = t if t.ndim == 3 else np.repeat(t[..., None], 3, axis=2)
        out[pad + r * (h + pad):pad + r * (h + pad) + h, pad + c * (w + pad):pad + c * (w + pad) + w] = tt[..., :3]
    return out
