"""ESA WorldCover 2021 v200 (10 m land cover, CC BY 4.0): regional land cover and water.

Classes: 10 tree cover, 20 shrubland, 30 grassland, 40 cropland, 50 built-up, 60 bare / sparse vegetation,
70 snow and ice, 80 permanent water bodies, 90 herbaceous wetland, 95 mangroves, 100 moss and lichen,
0 no data (outside the land tiles: open ocean).
"""
from __future__ import annotations

import hashlib
import math

import numpy as np

from earth import fetch, paths

URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tag}_Map.tif"
PX_PER_DEG = 12000
WATER = 80


def tile_tag(lat_s: int, lon_w: int) -> str:
    return f"{'N' if lat_s >= 0 else 'S'}{abs(lat_s):02d}{'E' if lon_w >= 0 else 'W'}{abs(lon_w):03d}"


class WorldCoverGrid:
    """uint8 class raster on the WorldCover grid for a lat/lon box (pixel-is-area)."""

    def __init__(self, lat0: float, lat1: float, lon0: float, lon1: float):
        self.r_top = math.floor(lat1 * PX_PER_DEG) + 1         # global row index of the north edge (lat*12000)
        self.c_left = math.floor(lon0 * PX_PER_DEG)
        rows = self.r_top - math.floor(lat0 * PX_PER_DEG)
        cols = math.floor(lon1 * PX_PER_DEG) + 1 - self.c_left
        key = hashlib.sha256(f"{self.r_top} {self.c_left} {rows} {cols}".encode()).hexdigest()[:12]
        p = paths.WORK / f"worldcover-{key}.npy"
        if not p.is_file():
            self._build(p, rows, cols)
        self.key = key
        self.data = np.load(p, mmap_mode="r")

    def _build(self, p, rows: int, cols: int) -> None:
        import rasterio
        from rasterio.windows import Window
        tmp = p.with_name(p.name + ".partial.npy")
        a = np.lib.format.open_memmap(tmp, mode="w+", dtype=np.uint8, shape=(rows, cols))
        a[:] = 0
        lat_top = self.r_top / PX_PER_DEG
        lon_left = self.c_left / PX_PER_DEG
        lat_bot = lat_top - rows / PX_PER_DEG
        lon_right = lon_left + cols / PX_PER_DEG
        for ls in range(int(math.floor(lat_bot / 3) * 3), int(math.ceil(lat_top / 3) * 3), 3):
            for lw in range(int(math.floor(lon_left / 3) * 3), int(math.ceil(lon_right / 3) * 3), 3):
                tag = tile_tag(ls, lw)
                f = paths.src_dir("worldcover") / f"ESA_WorldCover_10m_2021_v200_{tag}_Map.tif"
                miss = f.with_name(f.name + ".missing")
                if not f.is_file() and not miss.is_file():
                    try:
                        fetch.download(URL.format(tag=tag), f)
                    except FileNotFoundError:  # tiles exist only over land: absent means open ocean
                        miss.write_text("absent", encoding="utf-8")
                if not f.is_file():
                    continue
                with rasterio.open(f) as d:
                    t_top = round(d.bounds.top * PX_PER_DEG)
                    t_left = round(d.bounds.left * PX_PER_DEG)
                    # tile row k spans lat*12000 in [t_top - k - 1, t_top - k]; array row i = r_top - t_top + k
                    k0 = max(0, t_top - self.r_top)
                    k1 = min(d.height, t_top - (self.r_top - rows))
                    j0 = max(0, self.c_left - t_left)
                    j1 = min(d.width, self.c_left + cols - t_left)
                    if k0 >= k1 or j0 >= j1:
                        continue
                    win = d.read(1, window=Window(j0, k0, j1 - j0, k1 - k0))
                    ar0 = (self.r_top - t_top) + k0
                    ac0 = (t_left - self.c_left) + j0
                    a[ar0:ar0 + win.shape[0], ac0:ac0 + win.shape[1]] = win
        a.flush()
        del a
        tmp.replace(p)

    def px(self, lat, lon):
        """Fractional (col, row) with pixel centres at integers."""
        return (np.asarray(lon, np.float64) * PX_PER_DEG - self.c_left - 0.5,
                self.r_top - np.asarray(lat, np.float64) * PX_PER_DEG - 0.5)

    def nearest(self, lat, lon) -> np.ndarray:
        cx, cy = self.px(np.ravel(lat), np.ravel(lon))
        c = np.clip(np.floor(cx + 0.5).astype(np.int64), 0, self.data.shape[1] - 1)
        r = np.clip(np.floor(cy + 0.5).astype(np.int64), 0, self.data.shape[0] - 1)
        return np.asarray(self.data[r, c])
