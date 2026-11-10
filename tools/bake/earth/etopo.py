"""Global height source: NOAA ETOPO 2022 15 arc-second surface elevation (ice surface, bathymetry), public domain.

288 GeoTIFF tiles of 15 x 15 degrees (3600 x 3600 cells, pixel-is-area, EGM2008 heights). They are assembled
into one global memmap, int16 in half-metre units (86400 x 43200 cells; row 0 = north edge, column 0 =
lon -180), and every downloaded tile is deleted as soon as its block is copied and checked (max error
0.25 m). Rows poleward of ~61 deg are low-passed along longitude (sample.lon_prefilter_rows) so cube tiles
near the poles do not alias the ever narrower cells.
"""
from __future__ import annotations

import math
import re
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from earth import fetch, paths
from earth.util import log

BASE = "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/15s/15s_surface_elev_gtif/"
CELLS_PER_DEG = 240
W, H = 360 * CELLS_PER_DEG, 180 * CELLS_PER_DEG
UNIT = 0.5                 # metres per int16 count in the memmap
LON_PREFILTER_RATIO = 0.6  # effective E-W cell >= 0.6 x the N-S cell (463 m) after prefiltering
MEMMAP = paths.WORK / "etopo15s_int16_halfm.npy"
DONE = paths.STATE / "etopo_memmap.done"


def tile_names() -> list[str]:
    out = []
    for top in range(90, -90, -15):
        lat_tag = f"N{top:02d}" if top >= 0 else f"S{-top:02d}"
        for left in range(-180, 180, 15):
            lon_tag = f"E{left:03d}" if left >= 0 else f"W{-left:03d}"
            out.append(f"ETOPO_2022_v1_15s_{lat_tag}{lon_tag}_surface.tif")
    return out


def tile_origin(name: str) -> tuple[int, int]:
    """(top latitude, left longitude) in degrees from a tile file name."""
    m = re.search(r"_([NS])(\d\d)([EW])(\d\d\d)_", name)
    top = int(m.group(2)) * (1 if m.group(1) == "N" else -1)
    left = int(m.group(4)) * (1 if m.group(3) == "E" else -1)
    return top, left


def tile_path(name: str) -> Path:
    return paths.src_dir("etopo2022-15s") / name


def read_tile(p: Path) -> np.ndarray:
    import rasterio
    with rasterio.open(p) as d:
        if d.width != 3600 or d.height != 3600:
            raise ValueError(f"{p.name}: unexpected size {d.width}x{d.height}")
        a = d.read(1).astype(np.float32)
        nd = d.nodata
    if nd is not None and np.any(a == nd):
        raise ValueError(f"{p.name}: contains nodata cells")
    return a


def memmap_ready() -> bool:
    return DONE.is_file() and MEMMAP.is_file()


def open_memmap(mode: str = "r") -> np.ndarray:
    return np.load(MEMMAP, mmap_mode=mode)


def delete_memmap() -> None:
    for p in (DONE, MEMMAP):
        if p.exists():
            p.unlink()
    log("etopo: global memmap deleted")


def lat_of_row(r) -> np.ndarray:
    return 90.0 - (np.asarray(r, np.float64) + 0.5) / CELLS_PER_DEG


def build_memmap() -> None:
    """Download all tiles (3 at a time, resumable), copy them into the memmap, delete each tile once copied."""
    if memmap_ready():
        log("etopo: global memmap ready")
        return
    names = tile_names()
    if MEMMAP.is_file():
        mm = np.load(MEMMAP, mmap_mode="r+")
    else:
        mm = np.lib.format.open_memmap(MEMMAP, mode="w+", dtype=np.int16, shape=(H, W))
    copied_dir = paths.STATE / "etopo_copied"
    copied_dir.mkdir(parents=True, exist_ok=True)
    todo = [n for n in names if not (copied_dir / n).is_file()]
    log(f"etopo: {len(names) - len(todo)} of {len(names)} tiles already in the memmap")
    t0 = time.time()

    def get(n: str) -> str:
        fetch.download(BASE + n, tile_path(n), quiet=True)
        return n

    with ThreadPoolExecutor(3) as ex:
        for i, n in enumerate(ex.map(get, todo), 1):
            p = tile_path(n)
            a = read_tile(p)
            top, left = tile_origin(n)
            r0 = (90 - top) * CELLS_PER_DEG
            c0 = (left + 180) * CELLS_PER_DEG
            q = np.floor(a / UNIT + 0.5)
            if q.min() < -32768 or q.max() > 32767:
                raise ValueError(f"{n}: heights out of int16 range")
            mm[r0:r0 + 3600, c0:c0 + 3600] = q.astype(np.int16)
            back = mm[r0:r0 + 3600, c0:c0 + 3600].astype(np.float32) * UNIT
            err = float(np.max(np.abs(back - a)))
            if err > UNIT / 2 + 1e-3:
                raise ValueError(f"{n}: memmap copy error {err}")
            (copied_dir / n).write_text(f"{float(a.min())} {float(a.max())}", encoding="utf-8")
            p.unlink()
            sha = p.with_name(p.name + ".sha256")
            if sha.exists():
                sha.unlink()
            if i % 12 == 0 or i == len(todo):
                log(f"etopo: {i}/{len(todo)} tiles copied ({time.time() - t0:.0f} s)")
    mm.flush()
    del mm
    _prefilter_poles()
    DONE.write_text("ok", encoding="utf-8")


def _prefilter_poles() -> None:
    from earth.sample import lon_prefilter_rows
    mm = np.load(MEMMAP, mmap_mode="r+")
    lim = math.degrees(math.acos(LON_PREFILTER_RATIO / 1.25))
    rows = np.nonzero(np.abs(lat_of_row(np.arange(H))) > lim)[0]
    log(f"etopo: longitude prefilter on {rows.size} polar rows (|lat| > {lim:.1f})")
    runs = np.split(rows, np.nonzero(np.diff(rows) != 1)[0] + 1)   # north cap, south cap
    marks = paths.STATE / "etopo_prefilter"
    marks.mkdir(parents=True, exist_ok=True)
    for run in runs:
        for k in range(0, run.size, 512):
            rr = run[k:k + 512]
            m = marks / f"{rr[0]}-{rr[-1]}"
            if m.is_file():        # a block must never be filtered twice
                continue
            block = mm[rr[0]:rr[-1] + 1].astype(np.float64)
            lon_prefilter_rows(block, lat_of_row(rr), LON_PREFILTER_RATIO)
            mm[rr[0]:rr[-1] + 1] = np.floor(block + 0.5).astype(np.int16)
            mm.flush()
            m.write_text("ok", encoding="utf-8")


def crop(lat0: float, lat1: float, lon0: float, lon1: float) -> tuple[np.ndarray, float, float]:
    """Float32 metres for a lat/lon box (no antimeridian crossing), plus (lat of row 0 centre, lon of col 0
    centre). Reads the global memmap when ready, else the source tiles (downloaded as needed, then kept)."""
    r0 = max(0, int(math.floor((90.0 - lat1) * CELLS_PER_DEG)) - 2)
    r1 = min(H, int(math.ceil((90.0 - lat0) * CELLS_PER_DEG)) + 2)
    c0 = max(0, int(math.floor((lon0 + 180.0) * CELLS_PER_DEG)) - 2)
    c1 = min(W, int(math.ceil((lon1 + 180.0) * CELLS_PER_DEG)) + 2)
    if memmap_ready():
        a = open_memmap()[r0:r1, c0:c1].astype(np.float32) * UNIT
    else:
        a = np.full((r1 - r0, c1 - c0), np.nan, np.float32)
        for n in tile_names():
            top, left = tile_origin(n)
            tr0 = (90 - top) * CELLS_PER_DEG
            tc0 = (left + 180) * CELLS_PER_DEG
            ir0, ir1 = max(r0, tr0), min(r1, tr0 + 3600)
            ic0, ic1 = max(c0, tc0), min(c1, tc0 + 3600)
            if ir0 >= ir1 or ic0 >= ic1:
                continue
            p = fetch.download(BASE + n, tile_path(n))
            t = read_tile(p)
            a[ir0 - r0:ir1 - r0, ic0 - c0:ic1 - c0] = t[ir0 - tr0:ir1 - tr0, ic0 - tc0:ic1 - tc0]
        if np.isnan(a).any():
            raise ValueError("etopo crop incomplete")
    return a, float(lat_of_row(r0)), -180.0 + (c0 + 0.5) / CELLS_PER_DEG


class LocalGrid:
    """A float32 lat/lon raster with cell centres on a regular grid (row 0 = north)."""

    def __init__(self, data: np.ndarray, lat_r0: float, lon_c0: float, step_deg: float):
        self.data, self.lat_r0, self.lon_c0, self.step = data, lat_r0, lon_c0, step_deg

    def px(self, lat_deg, lon_deg):
        return (np.asarray(lon_deg, np.float64) - self.lon_c0) / self.step, (self.lat_r0 - np.asarray(lat_deg, np.float64)) / self.step

    def bicubic(self, lat_deg, lon_deg) -> np.ndarray:
        from earth.sample import bicubic
        cx, cy = self.px(np.ravel(lat_deg), np.ravel(lon_deg))
        return bicubic(self.data, cx, cy)


def local_grid(lat0: float, lat1: float, lon0: float, lon1: float) -> LocalGrid:
    """ETOPO crop for a region, cached permanently in data/cache/earth/work (a few MB)."""
    key = f"etopo-crop-{lat0:.4f}-{lat1:.4f}-{lon0:.4f}-{lon1:.4f}.npz"
    p = paths.WORK / key
    if p.is_file():
        z = np.load(p)
        return LocalGrid(z["data"], float(z["lat_r0"]), float(z["lon_c0"]), 1.0 / CELLS_PER_DEG)
    a, la, lo = crop(lat0, lat1, lon0, lon1)
    np.savez(p, data=a, lat_r0=la, lon_c0=lo)
    return LocalGrid(a, la, lo, 1.0 / CELLS_PER_DEG)
