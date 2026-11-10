"""NASA GIBS EPSG:4326 tiles: the MODIS (MOD44W) water mask at 250 m (TileMatrix 8: 320 x 160 tiles of
512 px, 1.125 deg per tile, origin lon -180 lat 90). Water = opaque palette colour, land = transparent.

Only tiles that can contain land are fetched (ETOPO maximum above -10 m inside the tile plus a margin, and
every tile over a below-sea-level depression not connected to the ocean, depression_tiles()); the rest of
the ocean is water by construction.
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
DEPRESSION_LISTING = paths.WORK / "gibs-modis-water-depression-tiles.npy"
DEPRESSION_GRID_DEG = 0.0625
DEPRESSION_LEVEL = 4


def depression_tiles() -> list[tuple[int, int]]:
    """Tiles over ground below sea level that is not connected to the world ocean (the Caspian Sea and its
    depression, Qattara, the Dead Sea, ...). The ETOPO-maximum rule of wanted_tiles() misses them where a whole
    tile lies below -10 m (the north Caspian lowland): such a tile would count as open ocean.

    From the baked level-4 heights (2.4 km vertex spacing): cells of a 0.0625 deg grid that lie entirely below
    sea level are labelled into connected regions; every region except the one holding the open Pacific is a
    depression (narrow straits are not resolved at 7 km, so the Black Sea, Azov and parts of the Baltic count
    too, which costs only a few extra tiles). Tiles touching such a region, grown by 3 cells, are wanted."""
    from scipy import ndimage

    from common import cube
    from earth import tiles

    W, H = int(round(360.0 / DEPRESSION_GRID_DEG)), int(round(180.0 / DEPRESSION_GRID_DEG))
    cmax = np.full(H * W, -np.inf)
    n = 2 ** DEPRESSION_LEVEL
    for f in range(6):
        for x in range(n):
            for y in range(n):
                h = tiles.read_height(f, DEPRESSION_LEVEL, x, y)[1:258, 1:258].reshape(-1).astype(np.float64)
                d = cube.height_tile_dirs(f, DEPRESSION_LEVEL, x, y)[1:258, 1:258].reshape(-1, 3)
                lat, lon = tiles.dirs_latlon(d)
                r = np.clip(((90.0 - lat) / DEPRESSION_GRID_DEG).astype(np.int64), 0, H - 1)
                c = (np.floor((lon + 180.0) / DEPRESSION_GRID_DEG).astype(np.int64)) % W
                idx = r * W + c
                order = np.argsort(idx, kind="stable")
                u, first = np.unique(idx[order], return_index=True)
                cmax[u] = np.maximum(cmax[u], np.maximum.reduceat(h[order], first))
    cmax = cmax.reshape(H, W)
    # cells narrower than the vertex spacing (towards the poles) received no sample: take the nearest cell's
    empty = ~np.isfinite(cmax)
    if empty.any():
        _, (ir, ic) = ndimage.distance_transform_edt(empty, return_distances=True, return_indices=True)
        cmax = cmax[ir, ic]
    below = cmax < 0.0
    lab, nlab = ndimage.label(below)
    # join regions across the antimeridian
    for a, b in zip(lab[:, 0], lab[:, -1]):
        if a and b and a != b:
            lab[lab == b] = a
    ocean = lab[int((90.0 - 0.0) / DEPRESSION_GRID_DEG), int((-160.0 + 180.0) / DEPRESSION_GRID_DEG)]
    if ocean == 0:
        raise ValueError("depression_tiles: the reference ocean cell (0 N 160 W) is not below sea level")
    dep = ndimage.binary_dilation((lab > 0) & (lab != ocean), iterations=3)
    rr, cc = np.nonzero(dep)
    lat_c = 90.0 - (rr + 0.5) * DEPRESSION_GRID_DEG
    lon_c = -180.0 + (cc + 0.5) * DEPRESSION_GRID_DEG
    rows = np.clip(((90.0 - lat_c) / SPAN).astype(np.int64), 0, NROW - 1)
    cols = np.clip(((lon_c + 180.0) / SPAN).astype(np.int64), 0, NCOL - 1)
    return sorted({(int(a), int(b)) for a, b in zip(rows, cols)})


def fetch_list() -> list[tuple[int, int]]:
    """The tiles to fetch: wanted_tiles() (computed once from the ETOPO memmap) plus depression_tiles()
    (computed once from the baked heights); both cached in data/cache/earth/work."""
    if LISTING.is_file():
        base = [tuple(int(v) for v in t) for t in np.load(LISTING)]
    else:
        base = wanted_tiles()
        np.save(LISTING, np.array(base, dtype=np.int32))
    if DEPRESSION_LISTING.is_file():
        dep = [tuple(int(v) for v in t) for t in np.load(DEPRESSION_LISTING)]
    else:
        dep = depression_tiles()
        np.save(DEPRESSION_LISTING, np.array(dep, dtype=np.int32).reshape(-1, 2))
    return sorted(set(base) | set(dep))


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
    a = np.asarray(Image.open(tile_path(row, col)).convert("RGBA"))      # palette with transparency -> alpha
    return a[..., 3] > 127


class WaterMask:
    """Nearest-neighbour lookups into the MODIS water mask; tiles not fetched are open ocean (water)."""

    def __init__(self):
        have = np.zeros((NROW, NCOL), bool)
        for r, c in fetch_list():          # cached listings (built by fetch_all in the parent process)
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
