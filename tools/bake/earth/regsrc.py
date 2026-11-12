"""Regional height SOURCE of a region bake: Terrarium (USGS 3DEP in Hawai'i) on land and inland water, ETOPO
2022 offshore, feathered into the global source (ETOPO 2022 bicubic) at the edge of the region.

    t  = Terrarium z15 Catmull-Rom, g = ETOPO 2022 15" Catmull-Rom,
    L  = bilinear ESA WorldCover land indicator (class not water/no-data): the COASTLINE is L = 0.5
    O  = the OCEAN: WorldCover water connected to the open sea, at WorldCover's own 10 m resolution: the
         8-connected components of the WorldCover water OPENED by an OPEN_PX square that touch the border of
         the WorldCover grid (open ocean 0.02 deg beyond the land) and reach MARINE_DEPTH_M in ETOPO, plus the
         water pixels next to them; a point is ocean when it is water (L < 0.5) and one of the four WorldCover
         pixels around it is. Every other WorldCover water point (lakes, ponds, reservoirs, rivers, pockets
         joined to the sea only by a channel narrower than ~45 m, at any altitude) is INLAND water.
    land:                    s = max(t, MIN_LAND_M)        (g where Terrarium has no tile)
    inland water:            s = max(t', MIN_LAND_M)       t' = t, or g where Terrarium departs from ETOPO by more
                                                            than INLAND_MAX_DEV_M (3DEP has corrupt values in a few
                                                            coastal ponds): a lake keeps its surface, it never
                                                            becomes a hole down to sea level
    ocean:                   s = min(w far + (1 - w) shallower(near, far), -MIN_SEA_M)   (seaFloorNearShore
                                 "shallower", the default); "deeper" (Madrakah): s = min(w2 far + (1 - w2)
                                 deeper(max(near, -k d1), far), -MIN_SEA_M), w2 = smootherstep((D_ramp - d1) / d1),
                                 deeper = smooth minimum: ETOPO only where it is itself sea deeper than the ramp
                                 far  = min(g, -1 m)                    (ETOPO sea floor)
                                 near = -k max(D_near, 0)                (k = nearShoreSlope of the region file)
                                 shallower = smooth maximum (1 m soft) of near and far
                                 w    = smootherstep(max(D_ramp, 0) / d1)     (d1 = seaFloorRampKm)
                             D = signed distance to the ocean's coastline (+ at sea, - on land), Gaussian
                             smoothed over NEAR_SMOOTH_M (D_near) and RAMP_SMOOTH_M (D_ramp)
    regional source:         S = a s + (1 - a) g                     a = region.source_weight (1 inside the
                                                                       AOI, 0 featherKm beyond it)
The coastline is WorldCover's (10 m, Sentinel-2 based, the same sensor as the regional imagery): Terrarium's
own shoreline follows z15 tile edges in places (blocks of 3DEP-filled sea or sea-filled land). Terrarium is
used on land only; its sea values are a blocky resampling of coarse bathymetry.

Near-shore profile: the sea floor starts at the coastline with a finite slope k (a lava coast drops to several
metres within tens of metres) wherever ETOPO is deeper than that slope, follows ETOPO where ETOPO is shallower
(bays and shelves), and becomes ETOPO itself d1 from the coast. A Gaussian-smoothed SIGNED distance is exactly
the distance at a straight coast (smoothing keeps linear functions), so the slope starts at the coastline, while
the smoothing removes the creases a plain Euclidean distance has along the medial axes of bays and headlands
(they showed as facets fanning out from the coast, docs/requests/terrain-core-3.md). Ocean samples are at most
-MIN_SEA_M and land samples at least MIN_LAND_M, so the stored sign is the coastline's (heights.py also keeps the
sign through quantisation).
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
GRID_VERSION = 5       # 2: ocean-connected water only; 3: connectivity at 10 m; 4/5: of the opened water
OPEN_PX = 5            # opening of the WorldCover water before its ocean connectivity (5 px = ~45 m)
RAMP_SMOOTH_M = 300.0  # Gaussian smoothing of the signed coast distance that blends the near-shore slope into ETOPO
NEAR_SMOOTH_M = 80.0   # Gaussian smoothing of the signed coast distance for the near-shore slope
SOFT_M = 1.0           # softness of the shallower-of(near-shore slope, ETOPO)
MARINE_DEPTH_M = -20.0  # a water component on the WorldCover grid border is the ocean if it reaches this ETOPO depth
INLAND_MAX_DEV_M = 100.0  # inland water: Terrarium further than this from ETOPO is a corrupt value
LAND_BUFFER_KM = 3.5
MIN_LAND_M = 0.2       # land and inland water never dip below sea level
MIN_SEA_M = 0.2        # the ocean never rises above -MIN_SEA_M


def land_bbox(region: dict) -> tuple[float, float, float, float]:
    """Lat/lon box of the land (Terrarium survey > 0 m) inside the region's coverage, plus 0.02 deg (cached in
    data/cache/earth/work: every worker process needs it and it costs a mosaic of ~1400 survey tiles)."""
    lat0, lat1, lon0, lon1 = regmod.source_bbox(region, 0.0)
    z = 12
    p = paths.WORK / f"landbbox-z{z}-{lat0:.4f}-{lat1:.4f}-{lon0:.4f}-{lon1:.4f}.json"
    if p.is_file():
        return tuple(json.loads(p.read_text(encoding="utf-8")))
    x0, y0, x1, y1 = merc.tile_range(lat0, lat1, lon0, lon1, z)
    merc.fetch_terrarium([(z, x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)])
    m = merc.MercMosaic.build(z, x0, y0, x1, y1, merc.terrarium_loader)
    rr, cc = np.nonzero(m.data > 0.0)
    lon_a, lat_a = merc.global_px_to_lonlat(256 * x0 + cc.min(), 256 * y0 + rr.max() + 1, z)
    lon_b, lat_b = merc.global_px_to_lonlat(256 * x0 + cc.max() + 1, 256 * y0 + rr.min(), z)
    out = (float(lat_a) - 0.02, float(lat_b) + 0.02, float(lon_a) - 0.02, float(lon_b) + 0.02)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(out), encoding="utf-8")
    tmp.replace(p)
    return out


class RegionalHeight:
    def __init__(self, region: dict, slack_km: float = 50.0):
        self.region = region
        src = region["sources"]["height"]
        self.land_source = src["id"]                    # "terrarium" (z15 / z14 tiles) or "copernicus-glo30"
        self.z_land = int(src.get("landZoom", 14))
        self.z_survey = int(src.get("surveyZoom", 12))
        # near-shore sea floor: "shallower" (default, Ka Lae: ETOPO where it is shallower than the ramp: bays and
        # shelves) or "deeper" (ETOPO only where it is itself sea deeper than the ramp, otherwise the ramp: where
        # ETOPO's coarse coast lies offshore of the real one it says -1 m for a kilometre below a cliff)
        self.near_shore_rule = src.get("seaFloorNearShore", "shallower")
        # inland water: WorldCover water that is not the ocean is kept only where the land source is flat under it
        # (region option `sources.watermask.inlandMaxRangeM` / `inlandMaxSlopeDeg`; dark rock on a hillside that
        # WorldCover reads as water becomes land again)
        wm = region["sources"].get("watermask", {})
        self.inland_filter = ((float(wm["inlandMaxRangeM"]), float(wm["inlandMaxSlopeDeg"]),
                               float(wm.get("inlandMinAreaM2", 0.0)))
                              if "inlandMaxRangeM" in wm else None)
        self.d1 = float(src["seaFloorRampKm"]) * 1000.0
        self.k = float(src["nearShoreSlope"])
        self.slack_km = slack_km
        self.bbox = regmod.source_bbox(region, slack_km)
        lat0, lat1, lon0, lon1 = self.bbox
        self.g = etopo.local_grid(lat0 - 0.05, lat1 + 0.05, lon0 - 0.05, lon1 + 0.05)
        self._t = None
        self._wc = None
        self._coast_grid()

    # -- data -----------------------------------------------------------------------------------------
    @property
    def t(self):
        """The land source (anything with .bicubic(lat, lon), NaN where it has no data): the Terrarium stack or
        the Copernicus GLO-30 grid, built (downloading as needed) on first use: steps that only need the
        coastline (regional imagery, water mask) never touch it."""
        if self._t is None:
            if self.land_source == "copernicus-glo30":
                from earth.glo30 import Glo30Grid
                lat0, lat1, lon0, lon1 = self.bbox
                self._t = Glo30Grid(lat0 - 0.02, lat1 + 0.02, lon0 - 0.02, lon1 + 0.02)
            else:
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

    def prepare(self) -> None:
        """Build every cached input in the calling process (the coast grid is built by the constructor; this adds
        the land source and the inland-water filter), so that worker processes only memory-map them."""
        _ = self.t
        self.prepare_inland()

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

    # -- the ocean at 10 m, and its coastline on a 40 m grid ---------------------------------------------
    def _ocean_path(self):
        return paths.WORK / f"ocean10-v{GRID_VERSION}-{self.wc.key}.npy"

    def _ensure_ocean10(self) -> None:
        """Packed-bit raster on the WorldCover grid: 1 where the pixel is water (class 80 or no data) of a
        component that touches the grid border (the open ocean) and reaches MARINE_DEPTH_M in ETOPO; a border
        component that stays shallower is a lake or pond cut by the grid edge and counts as inland water."""
        p = self._ocean_path()
        if not p.is_file():
            from earth.worldcover import PX_PER_DEG
            a = self.wc.data
            # connectivity of the water OPENED by an OPEN_PX square: pockets that touch the sea only through a
            # channel narrower than OPEN_PX px are not the ocean (on the cliffed lava coasts these are dark rock
            # WorldCover reads as water, and the 9.6 m height grid could not hold the channel anyway)
            opened = ndimage.binary_opening(self._water_rows(a, 0, a.shape[0]),
                                            structure=np.ones((OPEN_PX, OPEN_PX), bool))
            # labels as uint16 when they fit (half the memory of int32; the same labels): a grid of a billion
            # pixels (a long coast) would otherwise need 4 GB for them
            try:
                lab = np.empty(opened.shape, np.uint16)
                n = ndimage.label(opened, structure=np.ones((3, 3), int), output=lab)
            except RuntimeError:
                log("regsrc: more than 65535 water components: int32 labels")
                lab, n = ndimage.label(opened, structure=np.ones((3, 3), int))
            del opened
            border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
            border = border[border > 0]
            if border.size == 0:
                raise ValueError("regsrc: no water on the border of the WorldCover grid: no ocean to ramp")
            rng = np.random.default_rng(0)
            marine = []
            for b in border:
                # 20,000 random pixels of the component, drawn exactly as from its sorted flat indices, without
                # materialising them (the ocean component can hold most of a billion pixels)
                per_row = np.concatenate([(lab[r0:r0 + 2048] == b).sum(axis=1) for r0 in range(0, lab.shape[0], 2048)])
                size = int(per_row.sum())
                k = rng.integers(0, size, min(size, 20000))
                csum = np.cumsum(per_row)
                r = np.searchsorted(csum, k, side="right")
                c = np.empty_like(r)
                for row in np.unique(r):
                    cols = np.flatnonzero(lab[row] == b)
                    sel = r == row
                    c[sel] = cols[k[sel] - (csum[row] - per_row[row])]
                la = (self.wc.r_top - r - 0.5) / PX_PER_DEG
                lo = (self.wc.c_left + c + 0.5) / PX_PER_DEG
                if float(self.g.bicubic(la, lo).min()) <= MARINE_DEPTH_M:
                    marine.append(b)
            if not marine:
                raise ValueError(f"regsrc: no water component on the WorldCover grid border reaches "
                                 f"{MARINE_DEPTH_M:g} m in ETOPO: no ocean to ramp")
            border = np.array(marine)
            ocean = np.empty(lab.shape, bool)
            for r0 in range(0, lab.shape[0], 2048):
                ocean[r0:r0 + 2048] = np.isin(lab[r0:r0 + 2048], border)
            del lab
            # its own shore: water within OPEN_PX // 2 px of the opened ocean (what the opening shaved off it)
            ocean = ndimage.binary_dilation(ocean, structure=np.ones((OPEN_PX, OPEN_PX), bool))
            inland = 0
            for r0 in range(0, ocean.shape[0], 2048):
                w = self._water_rows(a, r0, min(r0 + 2048, ocean.shape[0]))
                ocean[r0:r0 + 2048] &= w
                inland += int((w & ~ocean[r0:r0 + 2048]).sum())
            log(f"regsrc: {n} components of the opened WorldCover water, {border.size} of them the ocean; inland "
                f"water {inland} px ({inland * 82e-6:.2f} km2)")
            tmp = p.with_name(p.stem + ".partial.npy")
            np.save(tmp, np.packbits(ocean, axis=1))
            del ocean
            tmp.replace(p)
        self._ocean10 = np.load(p, mmap_mode="r")

    @staticmethod
    def _water_rows(a, r0: int, r1: int) -> np.ndarray:
        """WorldCover water (class 80 or no data, i.e. open ocean beyond the land tiles) of rows r0..r1."""
        from earth.worldcover import WATER
        out = np.empty((r1 - r0, a.shape[1]), bool)
        for q0 in range(r0, r1, 2048):
            blk = np.asarray(a[q0:min(q0 + 2048, r1)])
            out[q0 - r0:q0 - r0 + blk.shape[0]] = (blk == 0) | (blk == WATER)
        return out

    def _ocean_px(self, iy: np.ndarray, ix: np.ndarray) -> np.ndarray:
        """Ocean bit of WorldCover pixels (row iy, column ix); pixels beyond the grid are open ocean."""
        h, w = self.wc.data.shape
        out = np.ones(iy.size, bool)
        inside = (iy >= 0) & (iy < h) & (ix >= 0) & (ix < w)
        r, c = iy[inside], ix[inside]
        out[inside] = (np.asarray(self._ocean10[r, c >> 3]) >> (7 - (c & 7))) & 1 == 1
        return out

    def ocean_near(self, lat, lon) -> np.ndarray:
        """True where one of the four WorldCover pixels around the point (those of the bilinear land
        fraction) belongs to the ocean component."""
        cx, cy = self.wc.px(np.ravel(lat), np.ravel(lon))
        ix = np.floor(cx).astype(np.int64)
        iy = np.floor(cy).astype(np.int64)
        out = np.zeros(ix.size, bool)
        for dy in (0, 1):
            for dx in (0, 1):
                out |= self._ocean_px(iy + dy, ix + dx)
        return out

    def _coast_files(self):
        lat0, lat1, lon0, lon1 = self.bbox
        base = f"coastdist-v{GRID_VERSION}-{lat0:.4f}-{lat1:.4f}-{lon0:.4f}-{lon1:.4f}"
        return {k: paths.WORK / f"{base}-{k}.npy" for k in ("sd", "near", "ramp")}, paths.WORK / f"{base}.json"

    def _coast_grid(self) -> None:
        self._ensure_ocean10()
        files, meta = self._coast_files()
        if not (meta.is_file() and all(p.is_file() for p in files.values())):
            self._build_coast_grid(files, meta)
        z = json.loads(meta.read_text(encoding="utf-8"))
        self.coast_meta = z
        # memory-mapped: shared by all worker processes
        self.sd, self.sd_near, self.sd_ramp = (np.load(files[k], mmap_mode="r") for k in ("sd", "near", "ramp"))

    def _build_coast_grid(self, files: dict, meta) -> None:
        """Signed distance (m, + at sea) to the coastline of the OCEAN on a COAST_GRID_M grid over the region
        box (a cell is ocean when the WorldCover pixel at its centre is), and its two smoothed versions."""
        from earth.worldcover import PX_PER_DEG
        lat0, lat1, lon0, lon1 = self.bbox
        latc = 0.5 * (lat0 + lat1)
        dlat = COAST_GRID_M / (math.pi * paths.RADIUS / 180.0)
        dlon = dlat / math.cos(math.radians(latc))
        lats = np.arange(lat1, lat0, -dlat)
        lons = np.arange(lon0, lon1, dlon)
        log(f"regsrc: coast grid {lats.size} x {lons.size} at {COAST_GRID_M:g} m")
        ocean = np.zeros((lats.size, lons.size), bool)
        ix = np.floor(lons * PX_PER_DEG - self.wc.c_left).astype(np.int64)
        for i in range(lats.size):
            iy = np.full(lons.size, int(math.floor(self.wc.r_top - lats[i] * PX_PER_DEG)), np.int64)
            ocean[i] = self._ocean_px(iy, ix)
        half = 0.5 * COAST_GRID_M
        sd = (ndimage.distance_transform_edt(ocean) * COAST_GRID_M - half).astype(np.float32)   # at sea
        d_in = (ndimage.distance_transform_edt(~ocean) * COAST_GRID_M - half).astype(np.float32)
        sd[~ocean] = -d_in[~ocean]
        del d_in, ocean
        for k, arr in (("sd", sd),
                       ("near", ndimage.gaussian_filter(sd, NEAR_SMOOTH_M / COAST_GRID_M, mode="nearest")),
                       ("ramp", ndimage.gaussian_filter(sd, RAMP_SMOOTH_M / COAST_GRID_M, mode="nearest"))):
            tmp = files[k].with_name(files[k].stem + ".partial.npy")
            np.save(tmp, arr)
            tmp.replace(files[k])
            del arr
        tmp = meta.with_suffix(".tmp")
        tmp.write_text(json.dumps({"la": float(lats[0]), "lo": float(lons[0]), "s": float(dlat), "dlon": float(dlon),
                                   "rows": int(lats.size), "cols": int(lons.size)}), encoding="utf-8")
        tmp.replace(meta)

    def _grid(self, arr: np.ndarray, lat, lon) -> np.ndarray:
        from earth.sample import bilinear
        z = self.coast_meta
        cx = (np.ravel(np.asarray(lon, np.float64)) - z["lo"]) / z["dlon"]
        cy = (z["la"] - np.ravel(np.asarray(lat, np.float64))) / z["s"]
        return bilinear(arr, cx, cy)

    def signed_distance(self, lat, lon) -> np.ndarray:
        """Distance (m) to the ocean's coastline: positive at sea, negative on land and inland water."""
        return self._grid(self.sd, lat, lon)

    def coast_distance(self, lat, lon) -> np.ndarray:
        """Distance (m) from sea points to the ocean's coastline (0 on land and inland water)."""
        return np.maximum(self.signed_distance(lat, lon), 0.0)

    def classify(self, lat, lon) -> tuple[np.ndarray, np.ndarray]:
        """(land, ocean) boolean arrays; points that are neither are inland water."""
        land = self.land_fraction(lat, lon) >= 0.5
        ocean = ~land & self.ocean_near(lat, lon)
        if self.inland_filter is not None:
            inland = ~land & ~ocean
            if inland.any():
                idx = np.flatnonzero(inland)
                land[idx[self.implausible_inland(np.ravel(lat)[idx], np.ravel(lon)[idx])]] = True
        return land, ocean

    # -- inland water that the land source contradicts ------------------------------------------------------
    INLAND_CELL = 2                     # WorldCover pixels per cell edge of the component grid (20 m)

    def _inland_path(self):
        rng, slope, area = self.inland_filter
        return paths.WORK / f"inlandbad-v2-{self.wc.key}-{self.land_source}-{rng:g}-{slope:g}-{area:g}.npy"

    def prepare_inland(self) -> None:
        if self.inland_filter is not None:
            self._ensure_inland()

    def _ensure_inland(self) -> None:
        """Packed bits on a 20 m grid (2 x 2 WorldCover pixels): 1 where inland water (WorldCover water that is not
        the ocean) belongs to a component the land source contradicts: height range (5th to 95th percentile) above
        inlandMaxRangeM or mean slope above inlandMaxSlopeDeg. A lake, a khawr or a wet sabkha is flat; dark rock on
        a hillside that WorldCover reads as water is not."""
        p = self._inland_path()
        if not p.is_file():
            from earth.worldcover import PX_PER_DEG
            max_range, max_slope, min_area = self.inland_filter
            cell_m2 = (self.INLAND_CELL * 1852.0 * 60.0 / PX_PER_DEG) ** 2 * math.cos(math.radians(0.5 * (
                self.bbox[0] + self.bbox[1])))
            a = self.wc.data
            c = self.INLAND_CELL
            H, W = a.shape[0] // c, a.shape[1] // c
            inl = np.zeros((H, W), bool)
            for r0 in range(0, H, 1024):
                r1 = min(r0 + 1024, H)
                water = self._water_rows(a, r0 * c, r1 * c)[:, :W * c]
                ii, jj = np.nonzero(water)
                ocean = self._ocean_px(ii + r0 * c, jj)
                w = np.zeros(water.shape, bool)
                w[ii[~ocean], jj[~ocean]] = True
                inl[r0:r1] = w.reshape(r1 - r0, c, W, c).any(axis=(1, 3))
            try:
                lab = np.empty(inl.shape, np.uint16)
                n = ndimage.label(inl, structure=np.ones((3, 3), int), output=lab)
            except RuntimeError:
                lab, n = ndimage.label(inl, structure=np.ones((3, 3), int))
            del inl
            bad = np.zeros(n + 1, bool)
            rng = np.random.default_rng(0)
            step = 15.0
            dlat = step / (math.pi * paths.RADIUS / 180.0)
            for k, sl in enumerate(ndimage.find_objects(lab), start=1):
                if sl is None:
                    continue
                rr, cc = np.nonzero(lab[sl] == k)
                if rr.size * cell_m2 < min_area:          # a speck of a few WorldCover pixels: not a pond
                    bad[k] = True
                    continue
                if rr.size > 2000:
                    pick = rng.choice(rr.size, 2000, replace=False)
                    rr, cc = rr[pick], cc[pick]
                rr = (rr + sl[0].start) * c + 0.5 * c
                cc = (cc + sl[1].start) * c + 0.5 * c
                la = (self.wc.r_top - rr) / PX_PER_DEG
                lo = (self.wc.c_left + cc) / PX_PER_DEG
                h = self.t.bicubic(la, lo)
                ok = ~np.isnan(h)
                if not ok.any():
                    continue
                spread = float(np.percentile(h[ok], 95) - np.percentile(h[ok], 5)) if ok.sum() > 1 else 0.0
                dlon = dlat / max(0.1, math.cos(math.radians(float(np.mean(la)))))
                ge = (self.t.bicubic(la, lo + dlon) - self.t.bicubic(la, lo - dlon)) / (2 * step)
                gn = (self.t.bicubic(la + dlat, lo) - self.t.bicubic(la - dlat, lo)) / (2 * step)
                sl_deg = np.degrees(np.arctan(np.hypot(ge, gn)))
                mean_slope = float(np.nanmean(sl_deg)) if np.isfinite(sl_deg).any() else 0.0
                bad[k] = spread > max_range or mean_slope > max_slope
            out = bad[lab]
            log(f"regsrc: {n} inland water components on the 20 m grid, {int(bad.sum())} contradicted by the land "
                f"source (range > {max_range:g} m or slope > {max_slope:g} deg) or smaller than {min_area:g} m2: "
                f"{int(out.sum()) * cell_m2 / 1e6:.2f} km2 made land")
            del lab
            tmp = p.with_name(p.stem + ".partial.npy")
            np.save(tmp, np.packbits(out, axis=1))
            del out
            tmp.replace(p)
        self._inlandbad = np.load(p, mmap_mode="r")

    def implausible_inland(self, lat, lon) -> np.ndarray:
        """True where a point of inland water lies in a component the land source contradicts."""
        if not hasattr(self, "_inlandbad"):
            self._ensure_inland()
        cx, cy = self.wc.px(np.ravel(lat), np.ravel(lon))
        c = self.INLAND_CELL
        iy = np.floor((cy + 0.5) / c).astype(np.int64)
        ix = np.floor((cx + 0.5) / c).astype(np.int64)
        h, w8 = self._inlandbad.shape
        out = np.zeros(iy.size, bool)
        inside = (iy >= 0) & (iy < h) & (ix >= 0) & (ix < w8 * 8)
        r, cc = iy[inside], ix[inside]
        out[inside] = (np.asarray(self._inlandbad[r, cc >> 3]) >> (7 - (cc & 7))) & 1 == 1
        return out

    def inland_water(self, lat, lon) -> np.ndarray:
        """WorldCover water points that are not the ocean (lakes, ponds, reservoirs, rivers)."""
        land, ocean = self.classify(lat, lon)
        return ~land & ~ocean

    # -- the source -----------------------------------------------------------------------------------
    def sea_floor(self, lat, lon, g) -> np.ndarray:
        far = np.minimum(g, -1.0)
        near = -self.k * np.maximum(self._grid(self.sd_near, lat, lon), 0.0)
        shallower = 0.5 * (near + far + np.sqrt((near - far) ** 2 + SOFT_M ** 2))
        w = regmod.smootherstep(np.maximum(self._grid(self.sd_ramp, lat, lon), 0.0) / self.d1)
        if self.near_shore_rule == "deeper":
            # the lead's rule (2026-11-12): within d1 of the coast ETOPO counts only where it is itself sea deeper
            # than the ramp, otherwise the ramp (held at its depth k d1 beyond d1); from d1 to 2 d1 the floor
            # becomes ETOPO (a blend from the coast as in the default rule would pull the floor up to ETOPO's -1 m
            # inside d1 where ETOPO's coarse coast lies offshore)
            held = np.maximum(near, -self.k * self.d1)
            deeper = 0.5 * (held + far - np.sqrt((held - far) ** 2 + SOFT_M ** 2))
            d = np.maximum(self._grid(self.sd_ramp, lat, lon), 0.0)
            w2 = regmod.smootherstep((d - self.d1) / self.d1)
            return np.minimum(w2 * far + (1.0 - w2) * deeper, -MIN_SEA_M)
        return np.minimum(w * far + (1.0 - w) * shallower, -MIN_SEA_M)

    def local(self, lat, lon) -> np.ndarray:
        """s: Terrarium on land and inland water, the ramped ETOPO sea floor in the ocean, without the
        regional feather."""
        lat = np.ravel(np.asarray(lat, np.float64))
        lon = np.ravel(np.asarray(lon, np.float64))
        g = self.g.bicubic(lat, lon)
        land, ocean = self.classify(lat, lon)
        s = np.empty_like(g)
        dry = ~ocean
        if dry.any():
            t = self.t.bicubic(lat[dry], lon[dry])
            bad = np.isnan(t) | (~land[dry] & (np.abs(t - g[dry]) > INLAND_MAX_DEV_M))
            s[dry] = np.maximum(np.where(bad, g[dry], t), MIN_LAND_M)
        if ocean.any():
            s[ocean] = self.sea_floor(lat[ocean], lon[ocean], g[ocean])
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
