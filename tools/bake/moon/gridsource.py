"""Regional raster sources (SLDEM2015 windows, LROC NAC DTMs, ...) in their own map projection.

A `ProjectedGrid` holds one band of heights (metres above the 1737.4 km sphere, NaN = no data) with its
GeoTIFF affine transform and CRS, a NaN-aware mip chain, and footprint-aware Catmull-Rom sampling by
latitude/longitude. Projections are evaluated through GDAL/PROJ (rasterio.warp.transform), so any lunar
GeoTIFF projection works; the georeferencing comes from the file itself, never from guesses.
"""
from __future__ import annotations

import math
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import Affine
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window
from scipy import ndimage

from moon import fetch
from moon.sampling import catmull_rom_weights

# Geographic lunar CRS on the IAU 1737.4 km sphere: planetocentric latitude, east longitude.
MOON_GEOGRAPHIC = CRS.from_wkt(
    'GEOGCS["GCS_Moon",DATUM["D_Moon",SPHEROID["Moon",1737400,0]],PRIMEM["Reference_Meridian",0],'
    'UNIT["degree",0.0174532925199433]]'
)
_GDAL_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", GDAL_HTTP_MULTIRANGE="YES",
                 GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.TIF")


def smootherstep(x: np.ndarray) -> np.ndarray:
    t = np.clip(x, 0.0, 1.0)
    return t * t * t * (t * (6.0 * t - 15.0) + 10.0)


class ProjectedGrid:
    def __init__(self, name: str, data: np.ndarray, transform: Affine, crs: CRS):
        self.name = name
        self.transform = transform
        self.inv = ~transform
        self.crs = crs
        self.mips = [np.asarray(data, dtype=np.float32)]
        while min(self.mips[-1].shape) >= 8:
            a = self.mips[-1]
            h, w = (a.shape[0] // 2) * 2, (a.shape[1] // 2) * 2
            b = a[:h, :w].reshape(h // 2, 2, w // 2, 2).astype(np.float64)
            m = ((b[:, 0, :, 0] + b[:, 0, :, 1]) + (b[:, 1, :, 0] + b[:, 1, :, 1])) / 4.0  # NaN if any child is NaN
            self.mips.append(m.astype(np.float32))
        if len(self.mips) < 2:
            raise ValueError(f"{name}: raster too small for a mip chain {data.shape}")
        self.valid = np.isfinite(self.mips[0])
        # ground metres per column / row at the raster centre (numerical Jacobian of the projection)
        cr, cc = data.shape[0] / 2.0, data.shape[1] / 2.0
        lat0, lon0 = self.pixel_to_latlon(np.array([cr, cr, cr + 1.0]), np.array([cc, cc + 1.0, cc]))
        R = 1_737_400.0
        dlat = np.radians(lat0 - lat0[0])
        dlon = np.radians(((lon0 - lon0[0]) + 180.0) % 360.0 - 180.0) * math.cos(math.radians(lat0[0]))
        self.kx = float(R * math.hypot(dlat[1], dlon[1]))
        self.ky = float(R * math.hypot(dlat[2], dlon[2]))

    # -- georeferencing ---------------------------------------------------------------------------------
    def latlon_to_pixel(self, lat_deg: np.ndarray, lon_deg: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Continuous (row, col) of mip 0, pixel centres at integers."""
        lon = ((np.asarray(lon_deg, dtype=np.float64) + 180.0) % 360.0) - 180.0
        xs, ys = warp_transform(MOON_GEOGRAPHIC, self.crs, lon.ravel(), np.asarray(lat_deg, dtype=np.float64).ravel())
        xs = np.asarray(xs).reshape(lon.shape)
        ys = np.asarray(ys).reshape(lon.shape)
        a = self.inv
        col = a.a * xs + a.b * ys + a.c - 0.5
        row = a.d * xs + a.e * ys + a.f - 0.5
        return row, col

    def pixel_to_latlon(self, row: np.ndarray, col: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        t = self.transform
        x = t.a * (col + 0.5) + t.b * (row + 0.5) + t.c
        y = t.d * (col + 0.5) + t.e * (row + 0.5) + t.f
        lon, lat = warp_transform(self.crs, MOON_GEOGRAPHIC, np.ravel(x), np.ravel(y))
        return np.asarray(lat).reshape(np.shape(x)), np.asarray(lon).reshape(np.shape(x))

    # -- sampling -----------------------------------------------------------------------------------------
    def _cr(self, m: int, row: np.ndarray, col: np.ndarray) -> np.ndarray:
        a = self.mips[m]
        f = 2.0 ** m
        y = (row + 0.5) / f - 0.5
        x = (col + 0.5) / f - 0.5
        iy0 = np.floor(y)
        ix0 = np.floor(x)
        wy = catmull_rom_weights(y - iy0)
        wx = catmull_rom_weights(x - ix0)
        iy0 = iy0.astype(np.int64)
        ix0 = ix0.astype(np.int64)
        h, w = a.shape
        bad = (iy0 < 1) | (iy0 > h - 3) | (ix0 < 1) | (ix0 > w - 3)
        iy0 = np.clip(iy0, 1, h - 3)
        ix0 = np.clip(ix0, 1, w - 3)
        out = np.zeros(row.shape, dtype=np.float64)
        for dy in range(4):
            r = np.zeros_like(out)
            for dx in range(4):
                r += wx[dx] * a[iy0 + dy - 1, ix0 + dx - 1]
            out += wy[dy] * r
        out[bad] = np.nan
        return out

    def _aniso(self, m: int, row: np.ndarray, col: np.ndarray, fp: np.ndarray) -> np.ndarray:
        """Catmull-Rom in mip m, with extra taps along a compressed pixel axis so the footprint is isotropic."""
        k_fine, k_coarse = min(self.kx, self.ky), max(self.kx, self.ky)
        if k_coarse / k_fine < 1.05:
            return self._cr(m, row, col)
        width_px = fp / k_fine  # footprint in mip-0 pixels along the compressed axis
        n = np.clip(np.ceil(width_px / 2.0 ** m - 1e-9), 1, 8).astype(np.int64)
        acc = np.zeros(row.shape)
        for k in range(int(n.max())):
            use = k < n
            off = np.where(use, ((k + 0.5) / n - 0.5) * width_px, 0.0)
            v = self._cr(m, row, col + off) if self.kx < self.ky else self._cr(m, row + off, col)
            acc += np.where(use, v, 0.0)
        return acc / n

    def sample(self, lat_deg, lon_deg, footprint_m) -> np.ndarray:
        """Heights at (lat, lon) filtered over an isotropic ground footprint (m); NaN where data is missing."""
        lat = np.asarray(lat_deg, dtype=np.float64)
        row, col = self.latlon_to_pixel(lat, lon_deg)
        fp = np.broadcast_to(np.asarray(footprint_m, dtype=np.float64), lat.shape)
        top = len(self.mips) - 1
        # mip level from the axis with the larger ground pixel (trilinear between mips)
        lam = np.minimum(np.log2(np.maximum(fp / max(self.kx, self.ky), 1.0)), top)
        m0 = np.minimum(np.floor(lam).astype(np.int64), top - 1)
        t = np.clip(lam - m0, 0.0, 1.0)
        out = np.full(lat.shape, np.nan)
        for m in np.unique(m0):
            sel = m0 == m
            r, c, f = row[sel], col[sel], fp[sel]
            v0 = self._aniso(int(m), r, c, f)
            v1 = self._aniso(int(m) + 1, r, c, f)
            out[sel] = (1.0 - t[sel]) * v0 + t[sel] * v1
        return out

    def stencil_reach_m(self, footprint_m) -> np.ndarray:
        """Ground distance from a sample to the farthest mip-0 pixel that `sample` may read at this footprint:
        Catmull-Rom reach (2 pixels) plus one block of the coarser of the two mips, plus the extra taps."""
        kc = max(self.kx, self.ky)
        top = len(self.mips) - 1
        fp = np.asarray(footprint_m, dtype=np.float64)
        lam = np.minimum(np.log2(np.maximum(fp / kc, 1.0)), top)
        m1 = np.minimum(np.floor(lam), top - 1) + 1
        return 3.0 * 2.0 ** m1 * kc + kc + 0.5 * fp

    def distance_inside(self) -> np.ndarray:
        """Ground distance (m) from each valid mip-0 pixel to the nearest invalid pixel or the raster edge."""
        pad = np.pad(self.valid, 1, constant_values=False)
        d = ndimage.distance_transform_edt(pad, sampling=(self.ky, self.kx))[1:-1, 1:-1]
        return d.astype(np.float32)


# -- loading sources ------------------------------------------------------------------------------------
def _read_rows_by_range(url: str, first_offset: int, row_bytes: int, r0: int, r1: int, dtype: str, width: int) -> np.ndarray:
    """Rows [r0, r1) of an uncompressed, contiguous one-row-per-strip TIFF via parallel range requests."""
    chunk = max(1, (32 << 20) // row_bytes)
    parts = [(a, min(r1, a + chunk)) for a in range(r0, r1, chunk)]
    out = np.empty((r1 - r0, width), dtype=dtype)
    lock = threading.Lock()

    def get(p):
        a, b = p
        buf = fetch.read_range(url, first_offset + a * row_bytes, (b - a) * row_bytes)
        arr = np.frombuffer(buf, dtype=dtype).reshape(b - a, width)
        with lock:
            out[a - r0:b - r0] = arr

    with ThreadPoolExecutor(max_workers=6) as ex:
        list(ex.map(get, parts))
    return out


def read_geotiff_window(url: str, lat_range: tuple[float, float], lon_range: tuple[float, float], name: str) -> ProjectedGrid:
    """Window of a remote (HTTP Range) GeoTIFF covering a lat/lon box; heights scaled by the file's scale/offset."""
    with rasterio.Env(**_GDAL_ENV):
        with rasterio.open("/vsicurl/" + url) as ds:
            crs, tr, nodata = ds.crs, ds.transform, ds.nodata
            scale, offset = ds.scales[0], ds.offsets[0]
            lats = np.array([lat_range[0], lat_range[0], lat_range[1], lat_range[1]])
            lons = np.array([lon_range[0], lon_range[1], lon_range[0], lon_range[1]])
            xs, ys = warp_transform(MOON_GEOGRAPHIC, crs, (((lons + 180) % 360) - 180).tolist(), lats.tolist())
            inv = ~tr
            cols = [inv.a * x + inv.b * y + inv.c for x, y in zip(xs, ys)]
            rows = [inv.d * x + inv.e * y + inv.f for x, y in zip(xs, ys)]
            c0, c1 = max(0, int(math.floor(min(cols)))), min(ds.width, int(math.ceil(max(cols))) + 1)
            r0, r1 = max(0, int(math.floor(min(rows)))), min(ds.height, int(math.ceil(max(rows))) + 1)
            dtype = np.dtype(ds.dtypes[0]).newbyteorder("<").str
            strips = ds.block_shapes[0] == (1, ds.width) and ds.compression is None
            contiguous = False
            if strips:
                o0 = int(ds.get_tag_item("BLOCK_OFFSET_0_0", "TIFF", bidx=1))
                row_bytes = ds.width * np.dtype(dtype).itemsize
                probe = [0, 1, ds.height // 2, ds.height - 1]
                contiguous = all(int(ds.get_tag_item(f"BLOCK_OFFSET_0_{r}", "TIFF", bidx=1)) == o0 + r * row_bytes for r in probe)
            if contiguous:
                rows_arr = _read_rows_by_range(url, o0, row_bytes, r0, r1, dtype, ds.width)
                raw = rows_arr[:, c0:c1]
            else:
                raw = ds.read(1, window=Window(c0, r0, c1 - c0, r1 - r0))
    data = raw.astype(np.float64)
    bad = raw == nodata if nodata is not None else np.zeros(raw.shape, bool)
    data = data * scale + offset
    data[bad] = np.nan
    wtr = tr * Affine.translation(c0, r0)
    return ProjectedGrid(name, data.astype(np.float32), wtr, crs)


def read_geotiff_file(path: Path, name: str) -> ProjectedGrid:
    with rasterio.open(str(path)) as ds:
        raw = ds.read(1)
        crs, tr, nodata = ds.crs, ds.transform, ds.nodata
        scale, offset = ds.scales[0], ds.offsets[0]
    data = raw.astype(np.float64)
    bad = ~np.isfinite(data)
    if nodata is not None:
        bad |= (raw == nodata) | (data < -1e30)
    data = data * scale + offset
    data[bad] = np.nan
    return ProjectedGrid(name, data.astype(np.float32), tr, crs)
