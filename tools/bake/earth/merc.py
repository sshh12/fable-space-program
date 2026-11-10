"""Web-Mercator (XYZ, 256 px) tile sources: Terrarium elevation and EOX Sentinel-2 cloudless.

A `MercMosaic` is a dense array covering a rectangle of tiles at one zoom, with pixel-centre registration:
pixel (row r, col c) of tile (x, y) has its centre at global pixel (256 x + c + 0.5, 256 y + r + 0.5).
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

from earth import fetch, paths

TERRARIUM_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
S2_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-{year}_3857/default/g/{z}/{y}/{x}.jpg"


def lonlat_to_global_px(lon_deg, lat_deg, z: int):
    """Continuous global pixel coordinates (x right, y down) at zoom z; pixel centres at integer + 0.5."""
    n = 256.0 * (2 ** z)
    lon = np.asarray(lon_deg, dtype=np.float64)
    lat = np.radians(np.clip(np.asarray(lat_deg, dtype=np.float64), -85.0511, 85.0511))
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - np.arcsinh(np.tan(lat)) / math.pi) / 2.0 * n
    return x, y


def global_px_to_lonlat(x, y, z: int):
    n = 256.0 * (2 ** z)
    lon = np.asarray(x, dtype=np.float64) / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * np.asarray(y, dtype=np.float64) / n))))
    return lon, lat


def tile_range(lat0: float, lat1: float, lon0: float, lon1: float, z: int) -> tuple[int, int, int, int]:
    """Inclusive (x0, y0, x1, y1) of the tiles covering a lat/lon box."""
    xa, ya = lonlat_to_global_px(lon0, lat1, z)
    xb, yb = lonlat_to_global_px(lon1, lat0, z)
    return int(xa // 256), int(ya // 256), int(xb // 256), int(yb // 256)


def terrarium_path(z: int, x: int, y: int) -> Path:
    return paths.src_dir("terrarium") / str(z) / str(x) / f"{y}.png"


def s2_path(year: int, z: int, x: int, y: int) -> Path:
    return paths.src_dir(f"s2cloudless-{year}") / str(z) / str(x) / f"{y}.jpg"


def fetch_terrarium(tiles: list[tuple[int, int, int]], rate: float = 15.0) -> dict:
    items = [(TERRARIUM_URL.format(z=z, x=x, y=y), terrarium_path(z, x, y)) for z, x, y in tiles]
    return fetch.fetch_many(items, rate=rate, label="terrarium")


def fetch_s2(year: int, tiles: list[tuple[int, int, int]], rate: float = 12.0) -> dict:
    items = [(S2_URL.format(year=year, z=z, x=x, y=y), s2_path(year, z, x, y)) for z, x, y in tiles]
    return fetch.fetch_many(items, rate=rate, label=f"s2cloudless-{year}")


def decode_terrarium(p: Path) -> np.ndarray:
    a = np.asarray(Image.open(p).convert("RGB"), dtype=np.float64)
    return (a[..., 0] * 256.0 + a[..., 1] + a[..., 2] / 256.0 - 32768.0).astype(np.float32)


class MercMosaic:
    def __init__(self, z: int, x0: int, y0: int, data: np.ndarray):
        self.z, self.x0, self.y0, self.data = z, x0, y0, data

    @classmethod
    def build(cls, z: int, x0: int, y0: int, x1: int, y1: int, loader, channels: int = 0,
              dtype=np.float32, fill=np.nan) -> "MercMosaic":
        shape = ((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256) + ((channels,) if channels else ())
        data = np.full(shape, fill, dtype=dtype)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                t = loader(z, x, y)
                if t is not None:
                    data[(y - y0) * 256:(y - y0 + 1) * 256, (x - x0) * 256:(x - x0 + 1) * 256] = t
        return cls(z, x0, y0, data)



def terrarium_loader(z: int, x: int, y: int):
    p = terrarium_path(z, x, y)
    return decode_terrarium(p) if p.is_file() else None


def s2_loader(year: int):
    def load(z: int, x: int, y: int):
        p = s2_path(year, z, x, y)
        if not p.is_file():
            return None
        return np.asarray(Image.open(p).convert("RGB"), dtype=np.uint8)
    return load
