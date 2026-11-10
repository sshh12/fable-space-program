"""NASA GIBS EPSG:4326 tiles: the MODIS (MOD44W) water mask at 250 m (TileMatrix 8: 320 x 160 tiles of
512 px, 1.125 deg per tile, origin lon -180 lat 90). Water = opaque palette colour, land = transparent.

Only tiles that can contain land are fetched (ETOPO maximum above -10 m inside the tile plus a margin);
the rest of the ocean is water by construction.
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image

from earth import etopo, fetch, paths
from earth.util import log

URL = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/MODIS_Water_Mask/default/250m/8/{row}/{col}.png"
LEVEL = 8
NCOL, NROW = 320, 160
SPAN = 1.125
PX = 512
DEG_PX = SPAN / PX


def tile_path(row: int, col: int):
    return paths.src_dir("gibs-modis-water") / str(row) / f"{col}.png"


def wanted_tiles() -> list[tuple[int, int]]:
    """Tiles whose ETOPO maximum (with a 0.05 deg margin) is above -10 m."""
    mm = etopo.open_memmap()
    out = []
    cells = int(SPAN * etopo.CELLS_PER_DEG)          # 270
    m = 12
    for row in range(NROW):
        r0 = max(0, row * cells - m)
        r1 = min(etopo.H, (row + 1) * cells + m)
        band = np.asarray(mm[r0:r1]).astype(np.int32)
        for col in range(NCOL):
            c0 = col * cells - m
            c1 = (col + 1) * cells + m
            idx = np.arange(c0, c1) % etopo.W
            if band[:, idx].max() * etopo.UNIT > -10.0:
                out.append((row, col))
    return out


LISTING = paths.WORK / "gibs-modis-water-tiles.npy"


def fetch_list() -> list[tuple[int, int]]:
    """The tiles to fetch (computed once from the ETOPO memmap, then cached)."""
    if LISTING.is_file():
        return [tuple(int(v) for v in t) for t in np.load(LISTING)]
    tl = wanted_tiles()
    np.save(LISTING, np.array(tl, dtype=np.int32))
    return tl


def fetch_all() -> list[tuple[int, int]]:
    tl = fetch_list()
    log(f"gibs: {len(tl)} of {NROW * NCOL} MODIS water-mask tiles can contain land")
    counts = fetch.fetch_many([(URL.format(row=r, col=c), tile_path(r, c)) for r, c in tl], rate=15.0,
                              label="gibs-modis-water")
    if counts.get("missing"):
        raise ValueError(f"gibs: {counts['missing']} tiles missing upstream")
    return tl


def decode(row: int, col: int) -> np.ndarray:
    """Boolean water raster (512 x 512, row 0 = north) of one tile."""
    p = tile_path(row, col)
    im = Image.open(p)
    if im.mode == "P":
        a = np.asarray(im.convert("RGBA"))
    else:
        a = np.asarray(im.convert("RGBA"))
    return a[..., 3] > 127


class WaterMask:
    """Nearest-neighbour lookups into the MODIS water mask; tiles not fetched are open ocean (water)."""

    def __init__(self):
        listing = paths.WORK / "gibs-modis-water-tiles.npy"
        have = np.zeros((NROW, NCOL), bool)
        for r, c in np.load(listing):
            have[r, c] = True
        self.have = have
        self.cache: dict[tuple[int, int], np.ndarray] = {}

    def water(self, lat, lon) -> np.ndarray:
        lat = np.ravel(np.asarray(lat, np.float64))
        lon = np.ravel(np.asarray(lon, np.float64))
        gx = np.floor((np.mod(lon + 180.0, 360.0)) / DEG_PX).astype(np.int64) % (NCOL * PX)
        gy = np.clip(np.floor((90.0 - lat) / DEG_PX).astype(np.int64), 0, NROW * PX - 1)
        tr, tc = gy // PX, gx // PX
        out = np.ones(lat.size, bool)
        key = tr * NCOL + tc
        for k in np.unique(key):
            r, c = int(k // NCOL), int(k % NCOL)
            if not self.have[r, c]:
                continue
            t = self.cache.get((r, c))
            if t is None:
                t = decode(r, c)
                self.cache[(r, c)] = t
            sel = key == k
            out[sel] = t[gy[sel] - r * PX, gx[sel] - c * PX]
        if len(self.cache) > 400:
            self.cache.clear()
        return out
