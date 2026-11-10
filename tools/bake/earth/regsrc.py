"""Regional height SOURCE of a region bake: Terrarium (USGS 3DEP in Hawai'i) on land, ETOPO 2022 offshore,
feathered into the global source (ETOPO 2022 bicubic) at the edge of the region.

    t  = Terrarium z15 Catmull-Rom, g = ETOPO 2022 15" Catmull-Rom,
    L  = bilinear ESA WorldCover land indicator (class not water/no-data): the COASTLINE is L = 0.5
    land (L >= 0.5):         s = max(t, 0.2 m)                    (g where Terrarium has no tile)
    sea  (L <  0.5):         s = min(g, -1 m) * smootherstep(d / d1)    d = distance to that coastline
    regional source:         S = a s + (1 - a) g                     a = region.source_weight (1 inside the
                                                                       AOI, 0 featherKm beyond it)
The coastline is WorldCover's (10 m, Sentinel-2 based, the same sensor as the regional imagery): Terrarium's
own shoreline follows z15 tile edges in places (blocks of 3DEP-filled sea or sea-filled land). Terrarium is
used on land only; its sea values are a blocky resampling of coarse bathymetry. The sea floor is ETOPO 2022
(multibeam detail offshore), ramped from 0 m at the coastline to the ETOPO depth over d1 (seaFloorRampKm),
below sea level everywhere; at the coastline the land meets it with its own height (sea cliffs stay cliffs).
"""
from __future__ import annotations

import json
import math

import numpy as np
from scipy import ndimage

from earth import etopo, merc, paths, region as regmod
from earth.tilestack import TileStack
from earth.util import log

COAST_GRID_M = 40.0
LAND_BUFFER_KM = 3.5
MIN_LAND_M = 0.2       # land (by the coastline) never dips below sea level


def land_bbox(region: dict) -> tuple[float, float, float, float]:
    """Lat/lon box of the land (Terrarium survey > 0 m) inside the region's coverage, plus 0.02 deg."""
    lat0, lat1, lon0, lon1 = regmod.source_bbox(region, 0.0)
    z = 12
    x0, y0, x1, y1 = merc.tile_range(lat0, lat1, lon0, lon1, z)
    merc.fetch_terrarium([(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)])
    m = merc.MercMosaic.build(z, x0, y0, x1, y1, merc.terrarium_loader)
    rr, cc = np.nonzero(m.data > 0.0)
    lon_a, lat_a = merc.global_px_to_lonlat(256 * x0 + cc.min(), 256 * y0 + rr.max() + 1, z)
    lon_b, lat_b = merc.global_px_to_lonlat(256 * x0 + cc.max() + 1, 256 * y0 + rr.min(), z)
    return float(lat_a) - 0.02, float(lat_b) + 0.02, float(lon_a) - 0.02, float(lon_b) + 0.02


class RegionalHeight:
    def __init__(self, region: dict, slack_km: float = 50.0):
        self.region = region
        src = region["sources"]["height"]
        self.z_land = int(src["landZoom"])
        self.z_survey = int(src["surveyZoom"])
        self.d1 = float(src["seaFloorRampKm"]) * 1000.0
        self.slack_km = slack_km
        self.bbox = regmod.source_bbox(region, slack_km)
        lat0, lat1, lon0, lon1 = self.bbox
        self.g = etopo.local_grid(lat0 - 0.05, lat1 + 0.05, lon0 - 0.05, lon1 + 0.05)
        self._t = None
        self._wc = None
        self._coast_grid()

    # -- data -----------------------------------------------------------------------------------------
    @property
    def t(self) -> TileStack:
        """The Terrarium z15 stack, built (downloading as needed) on first use: steps that only need the
        coastline distance (regional imagery) never touch it."""
        if self._t is None:
            self._ensure_terrarium()
        return self._t

    def _ensure_terrarium(self) -> None:
        lat0, lat1, lon0, lon1 = self.bbox
        listing = paths.WORK / (f"terrarium-z{self.z_land}-{lat0:.4f}-{lat1:.4f}-{lon0:.4f}-{lon1:.4f}"
                                f"-{self.slack_km:g}.json")
        if listing.is_file():
            tiles = [tuple(t) for t in json.loads(listing.read_text(encoding="utf-8"))]
            self._t = self._stack(tiles)
            return
        z = self.z_survey
        x0, y0, x1, y1 = merc.tile_range(lat0, lat1, lon0, lon1, z)
        merc.fetch_terrarium([(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)])
        survey = merc.MercMosaic.build(z, x0, y0, x1, y1, merc.terrarium_loader)
        if np.isnan(survey.data).any():
            raise ValueError("terrarium survey mosaic incomplete")
        # z15 tiles wherever the survey shows land within LAND_BUFFER_KM
        px_m = 2 * math.pi * paths.RADIUS / (256 * 2 ** z) * math.cos(math.radians(0.5 * (lat0 + lat1)))
        land = survey.data > 0.0
        near = ndimage.distance_transform_edt(~land) * px_m <= LAND_BUFFER_KM * 1000.0
        f = 2 ** (self.z_land - z)                 # z15 tiles per survey tile edge
        block = 256 // f                           # survey pixels per z15 tile edge
        h, w = near.shape
        nb = near.reshape(h // block, block, w // block, block).any(axis=(1, 3))
        ty, tx = np.nonzero(nb)
        # only where the regional source can have weight (AOI + feather + coastal blend + slack)
        cx = (x0 * f + tx + 0.5) * 256.0
        cy = (y0 * f + ty + 0.5) * 256.0
        lon_c, lat_c = merc.global_px_to_lonlat(cx, cy, self.z_land)
        reach = (regmod.max_radius_km(self.region) + float(self.region["featherKm"]) + LAND_BUFFER_KM
                 + self.slack_km + 2.0) * 1000.0
        keep = regmod.distance_to_shape_m(self.region, lat_c, lon_c) <= reach
        tiles = [(int(x0 * f + i), int(y0 * f + j)) for j, i, k in zip(ty, tx, keep) if k]
        log(f"regsrc: {len(tiles)} Terrarium z{self.z_land} tiles over land + {LAND_BUFFER_KM} km")
        self._t = self._stack(tiles)
        listing.write_text(json.dumps(tiles), encoding="utf-8")

    def _stack(self, tiles: list) -> TileStack:
        """Fetch (resumably) and stack the z15 tiles; a cached stack is reused without touching the network."""
        try:
            return TileStack.load("terrarium", self.z_land, tiles)
        except FileNotFoundError:
            pass
        counts = merc.fetch_terrarium([(self.z_land, x, y) for x, y in tiles])
        if counts.get("missing"):
            raise ValueError(f"terrarium: {counts['missing']} z{self.z_land} tiles missing upstream")
        return TileStack.build("terrarium", self.z_land, tiles, merc.terrarium_loader)

    @property
    def wc(self):
        if self._wc is None:
            from earth.worldcover import WorldCoverGrid
            self._wc = WorldCoverGrid(*land_bbox(self.region))
        return self._wc

    def land_fraction(self, lat, lon) -> np.ndarray:
        """Bilinear WorldCover land indicator (class not 0 / 80): the coastline is its 0.5 contour."""
        from earth.worldcover import WATER
        cx, cy = self.wc.px(np.ravel(lat), np.ravel(lon))
        a = self.wc.data
        h, w = a.shape
        ix = np.floor(cx).astype(np.int64)
        iy = np.floor(cy).astype(np.int64)
        fx, fy = cx - ix, cy - iy
        out = np.zeros(ix.size)
        for dy, wy in ((0, 1.0 - fy), (1, fy)):
            for dx, wx in ((0, 1.0 - fx), (1, fx)):
                c = a[np.clip(iy + dy, 0, h - 1), np.clip(ix + dx, 0, w - 1)]
                out += wx * wy * ((c != 0) & (c != WATER))
        return out

    def _coast_grid(self) -> None:
        lat0, lat1, lon0, lon1 = self.bbox
        latc = 0.5 * (lat0 + lat1)
        dlat = COAST_GRID_M / (math.pi * paths.RADIUS / 180.0)
        dlon = dlat / math.cos(math.radians(latc))
        key = paths.WORK / f"coastdist-wc-{lat0:.4f}-{lat1:.4f}-{lon0:.4f}-{lon1:.4f}.npy"
        meta = key.with_suffix(".json")
        if key.is_file() and meta.is_file():           # memory-mapped: shared by all worker processes
            z = json.loads(meta.read_text(encoding="utf-8"))
            self.coast = etopo.LocalGrid(np.load(key, mmap_mode="r"), z["la"], z["lo"], z["s"])
            self.coast_dlon = z["dlon"]
            return
        old = key.with_suffix(".npz")
        if old.is_file():                               # earlier .npz cache: convert once
            with np.load(old) as z:
                np.save(key, z["d"])
                meta.write_text(json.dumps({"la": float(z["la"]), "lo": float(z["lo"]), "s": float(z["s"]),
                                            "dlon": float(z["dlon"])}), encoding="utf-8")
            old.unlink()
            return self._coast_grid()
        lats = np.arange(lat1, lat0, -dlat)
        lons = np.arange(lon0, lon1, dlon)
        land = np.zeros((lats.size, lons.size), bool)
        for i in range(0, lats.size, 512):
            LA, LO = np.meshgrid(lats[i:i + 512], lons, indexing="ij")
            land[i:i + 512] = (self.land_fraction(LA, LO) >= 0.5).reshape(LA.shape)
        d = (ndimage.distance_transform_edt(~land, sampling=(1.0, 1.0)) * COAST_GRID_M).astype(np.float32)
        np.save(key, d)
        meta.write_text(json.dumps({"la": float(lats[0]), "lo": float(lons[0]), "s": float(dlat), "dlon": float(dlon)}),
                        encoding="utf-8")
        self.coast = etopo.LocalGrid(np.load(key, mmap_mode="r"), float(lats[0]), float(lons[0]), dlat)
        self.coast_dlon = dlon

    def coast_distance(self, lat, lon) -> np.ndarray:
        """Distance (m) from sea points to the nearest land of the regional coastline (0 on land)."""
        from earth.sample import bilinear
        cx = (np.ravel(lon) - self.coast.lon_c0) / self.coast_dlon
        cy = (self.coast.lat_r0 - np.ravel(lat)) / self.coast.step
        return bilinear(self.coast.data, cx, cy)

    # -- the source -----------------------------------------------------------------------------------
    def local(self, lat, lon) -> np.ndarray:
        """s: Terrarium/ETOPO merge on the WorldCover coastline, without the regional feather."""
        lat = np.ravel(np.asarray(lat, np.float64))
        lon = np.ravel(np.asarray(lon, np.float64))
        g = self.g.bicubic(lat, lon)
        land = self.land_fraction(lat, lon) >= 0.5
        s = np.empty_like(g)
        if land.any():
            t = self.t.bicubic(lat[land], lon[land])
            s[land] = np.maximum(np.where(np.isnan(t), g[land], t), MIN_LAND_M)
        sea = ~land
        if sea.any():
            d = self.coast_distance(lat[sea], lon[sea])
            s[sea] = np.minimum(g[sea], -1.0) * regmod.smootherstep(d / self.d1)
        return s

    def height(self, lat, lon) -> np.ndarray:
        lat = np.ravel(np.asarray(lat, np.float64))
        lon = np.ravel(np.asarray(lon, np.float64))
        a = regmod.source_weight(self.region, lat, lon)
        g = self.g.bicubic(lat, lon)
        out = g.copy()
        m = a > 0.0
        if m.any():
            out[m] = a[m] * self.local(lat[m], lon[m]) + (1.0 - a[m]) * g[m]
        return out

    def global_height(self, lat, lon) -> np.ndarray:
        return self.g.bicubic(np.ravel(lat), np.ravel(lon))
