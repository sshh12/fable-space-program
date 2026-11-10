"""Tile I/O and per-tile geometry for the earth tile set (layout and codecs from tools/bake/common)."""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from numba import njit
from PIL import Image

from common import cube, frt1, layout
from earth import paths

EXT = {"height": "hgt", "albedo": "webp", "watermask": "u8", "night": "webp", "landcover": "u8"}
WEBP_QUALITY = 90
WEBP_METHOD = 6


def tile_file(layer: str, face: int, level: int, x: int, y: int) -> Path:
    return layout.tile_file(paths.TILESET, layer, face, level, x, y, EXT[layer])


def exists(layer: str, face: int, level: int, x: int, y: int) -> bool:
    return tile_file(layer, face, level, x, y).is_file()


def dirs_latlon(d: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Latitude/longitude in degrees of directions (..., 3)."""
    lat, lon = cube.dir_to_lat_lon(d)
    return np.degrees(lat), np.degrees(lon)


# -- heights -----------------------------------------------------------------------------------------------
def write_height(face: int, level: int, x: int, y: int, h: np.ndarray, preferred_scale: float) -> int:
    if h.shape != (259, 259):
        raise ValueError("height tile must be 259 x 259")
    data = frt1.to_file_bytes(frt1.encode_height(h, preferred_scale), level=9)
    layout.write_atomic(tile_file("height", face, level, x, y), data)
    return len(data)


def read_height(face: int, level: int, x: int, y: int) -> np.ndarray | None:
    p = tile_file("height", face, level, x, y)
    if not p.is_file():
        return None
    return frt1.from_file_bytes(p.read_bytes())["heights"]


# -- u8 rasters --------------------------------------------------------------------------------------------
def write_u8(layer: str, face: int, level: int, x: int, y: int, a: np.ndarray) -> int:
    if a.shape != (256, 256) or a.dtype != np.uint8:
        raise ValueError("u8 tile must be uint8 256 x 256")
    data = frt1.to_file_bytes(frt1.encode_u8(a), level=9)
    layout.write_atomic(tile_file(layer, face, level, x, y), data)
    return len(data)


def read_u8(layer: str, face: int, level: int, x: int, y: int) -> np.ndarray | None:
    p = tile_file(layer, face, level, x, y)
    if not p.is_file():
        return None
    return frt1.from_file_bytes(p.read_bytes())["data"][:, :, 0]


# -- images ------------------------------------------------------------------------------------------------
def encode_webp(rgb: np.ndarray, quality: int = WEBP_QUALITY, lossless: bool = False) -> bytes:
    """Opaque RGB WebP (no alpha chunk): lossy at `quality`, or lossless (used where exact values matter)."""
    if rgb.shape != (256, 256, 3) or rgb.dtype != np.uint8:
        raise ValueError("image tile must be uint8 256 x 256 x 3")
    buf = io.BytesIO()
    if lossless:
        Image.fromarray(rgb, "RGB").save(buf, "WEBP", lossless=True, quality=60, method=4)
    else:
        Image.fromarray(rgb, "RGB").save(buf, "WEBP", quality=quality, method=WEBP_METHOD)
    return buf.getvalue()


def write_webp(layer: str, face: int, level: int, x: int, y: int, rgb: np.ndarray, quality: int = WEBP_QUALITY,
               lossless: bool = False) -> int:
    data = encode_webp(rgb, quality, lossless)
    layout.write_atomic(tile_file(layer, face, level, x, y), data)
    return len(data)


def read_webp(layer: str, face: int, level: int, x: int, y: int) -> np.ndarray | None:
    p = tile_file(layer, face, level, x, y)
    if not p.is_file():
        return None
    im = Image.open(io.BytesIO(p.read_bytes()))
    if im.mode != "RGB":
        raise ValueError(f"{p}: image mode {im.mode}, expected opaque RGB")
    return np.asarray(im, dtype=np.uint8)


# -- colour ------------------------------------------------------------------------------------------------
def _srgb_to_linear_f(c: np.ndarray) -> np.ndarray:
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


_SRGB_LUT = _srgb_to_linear_f(np.arange(256))


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    """sRGB 0..255 (uint8 or float) to linear 0..1 (float64)."""
    c = np.asarray(c)
    if c.dtype == np.uint8:
        return _SRGB_LUT[c]
    return _srgb_to_linear_f(c)


@njit(cache=True)
def _encode_srgb8(lin: np.ndarray, out: np.ndarray) -> None:
    for i in range(lin.size):
        v = min(max(lin[i], 0.0), 1.0)
        s = v * 12.92 if v <= 0.0031308 else 1.055 * v ** (1.0 / 2.4) - 0.055
        out[i] = min(max(int(np.floor(s * 255.0 + 0.5)), 0), 255)


def linear_to_srgb8(lin: np.ndarray) -> np.ndarray:
    """Linear 0..1 to sRGB uint8 (rounded)."""
    lin = np.ascontiguousarray(lin, dtype=np.float64)
    out = np.empty(lin.shape, np.uint8)
    _encode_srgb8(lin.reshape(-1), out.reshape(-1))
    return out


def box2(a: np.ndarray) -> np.ndarray:
    """2x2 mean of an (2n, 2n, ...) array."""
    return 0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2])


def assemble_children(ch: list[np.ndarray]) -> np.ndarray:
    """Children in childTiles order [(2x,2y), (2x+1,2y), (2x,2y+1), (2x+1,2y+1)] -> one 512 x 512 array
    (rows follow v, columns follow u)."""
    top = np.concatenate([ch[0], ch[1]], axis=1)
    bot = np.concatenate([ch[2], ch[3]], axis=1)
    return np.concatenate([top, bot], axis=0)


def children(face: int, level: int, x: int, y: int) -> list[tuple[int, int, int, int]]:
    return [(face, level + 1, 2 * x, 2 * y), (face, level + 1, 2 * x + 1, 2 * y),
            (face, level + 1, 2 * x, 2 * y + 1), (face, level + 1, 2 * x + 1, 2 * y + 1)]
