"""Copernicus DEM GLO-30 (1 arc-second, about 30 m; TanDEM-X 2011-2015, edited), the regional land source a region
names with `sources.height.id: "copernicus-glo30"`.

Tiles of 1 x 1 degree from the public AWS bucket (Registry of Open Data, no account), heights in metres above the
EGM2008 geoid (the same vertical datum as ETOPO 2022), Cloud-Optimised GeoTIFF, float32; tiles exist over land only.
Licence: free of charge for any use with the attribution "Copernicus DEM - produced using Copernicus WorldDEM-30 (c)
DLR e.V. 2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union
and ESA; all rights reserved" (the GLO-30 public licence). Every download lands in data/cache/earth/src/copernicus-glo30.

A region's tiles are assembled into one float32 memmap on the GLO-30 grid (data/cache/earth/work) that worker
processes share; absent tiles (open sea) are NaN. Sampled bicubically (Catmull-Rom) in the tiles' own georeferencing.
"""
from __future__ import annotations

import json
import math

import numpy as np

from earth import fetch, paths
from earth.util import log

URL = ("https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{tag}_DEM/"
       "Copernicus_DSM_COG_10_{tag}_DEM.tif")
PX_PER_DEG = 3600                    # below 50 deg latitude the tiles are 3600 x 3600 (1 arc-second both ways)
CREDIT = ("Copernicus DEM GLO-30 (1 arc-second, about 30 m) - produced using Copernicus WorldDEM-30 (c) DLR e.V. "
          "2010-2014 and (c) Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union "
          "and ESA; all rights reserved")


def tag(lat_s: int, lon_w: int) -> str:
    return (f"{'N' if lat_s >= 0 else 'S'}{abs(lat_s):02d}_00_"
            f"{'E' if lon_w >= 0 else 'W'}{abs(lon_w):03d}_00")


def tile_path(lat_s: int, lon_w: int):
    return paths.src_dir("copernicus-glo30") / f"Copernicus_DSM_COG_10_{tag(lat_s, lon_w)}_DEM.tif"


def fetch_tile(lat_s: int, lon_w: int):
    """The tile's path, downloaded if needed; None where no tile exists (open sea)."""
    p = tile_path(lat_s, lon_w)
    miss = p.with_name(p.name + ".missing")
    if p.is_file():
        return p
    if miss.is_file():
        return None
    try:
        fetch.download(URL.format(tag=tag(lat_s, lon_w)), p)
    except FileNotFoundError:
        miss.write_text("absent", encoding="utf-8")
        return None
    return p


class Glo30Grid:
    """GLO-30 heights over a lat/lon box, on the tiles' 1 arc-second grid (row 0 = north), cached as a memmap."""

    def __init__(self, lat0: float, lat1: float, lon0: float, lon1: float):
        self.lat_top = math.ceil(lat1)
        self.lon_left = math.floor(lon0)
        n_lat = self.lat_top - math.floor(lat0)
        n_lon = math.ceil(lon1) - self.lon_left
        key = f"{self.lat_top}-{self.lon_left}-{n_lat}-{n_lon}"
        p = paths.WORK / f"glo30-{key}.npy"
        meta = paths.WORK / f"glo30-{key}.json"
        if not (p.is_file() and meta.is_file()):
            self._build(p, meta, n_lat, n_lon)
        self.meta = json.loads(meta.read_text(encoding="utf-8"))
        self.data = np.load(p, mmap_mode="r")

    def _build(self, p, meta, n_lat: int, n_lon: int) -> None:
        import rasterio
        rows, cols = n_lat * PX_PER_DEG, n_lon * PX_PER_DEG
        tmp = p.with_name(p.stem + ".partial.npy")
        a = np.lib.format.open_memmap(tmp, mode="w+", dtype=np.float32, shape=(rows, cols))
        a[:] = np.nan
        origin = None
        tiles = []
        for i in range(n_lat):
            for j in range(n_lon):
                lat_s, lon_w = self.lat_top - 1 - i, self.lon_left + j
                f = fetch_tile(lat_s, lon_w)
                if f is None:
                    continue
                with rasterio.open(f) as d:
                    if (d.width, d.height) != (PX_PER_DEG, PX_PER_DEG):
                        raise ValueError(f"{f.name}: {d.width} x {d.height}, expected {PX_PER_DEG} square")
                    t = d.transform
                    # pixel centres: lon = t.c + (col + 0.5) t.a, lat = t.f + (row + 0.5) t.e
                    o = (round(t.c - lon_w, 9), round(t.f - (lat_s + 1), 9), t.a, t.e)
                    if origin is None:
                        origin = o
                    elif o != origin:
                        raise ValueError(f"{f.name}: registration {o} differs from {origin}")
                    a[i * PX_PER_DEG:(i + 1) * PX_PER_DEG, j * PX_PER_DEG:(j + 1) * PX_PER_DEG] = d.read(1)
                tiles.append(f.name)
        a.flush()
        del a
        tmp.replace(p)
        dx, dy, sa, se = origin
        meta.write_text(json.dumps({"lat0": self.lat_top + dy + 0.5 * se, "lon0": self.lon_left + dx + 0.5 * sa,
                                    "dlat": se, "dlon": sa, "tiles": tiles}), encoding="utf-8")
        log(f"glo30: {len(tiles)} tiles assembled ({rows} x {cols})")

    def bicubic(self, lat, lon) -> np.ndarray:
        """Catmull-Rom of the grid (NaN where a needed sample is absent)."""
        from earth.sample import bicubic
        m = self.meta
        cx = (np.ravel(np.asarray(lon, np.float64)) - m["lon0"]) / m["dlon"]
        cy = (np.ravel(np.asarray(lat, np.float64)) - m["lat0"]) / m["dlat"]
        return bicubic(self.data, cx, cy)
