"""LOLA 118 m global DEM (USGS single GeoTIFF) as an `EquirectPyramid` for the global height levels.

Source: https://planetarymaps.usgs.gov/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif (S3 mirror below),
int16, 92160 x 46080, strip-based, uncompressed, no overviews. GeoTIFF georeferencing (read with rasterio
from the remote file): pixel-registered ("Area"), x0 = -pi R (column 0 starts at 180 W), 118.45 m pixels,
scale 0.5, offset 0: height above 1737.4 km = DN * 0.5. (The PDS ldem_* products start at 0 E instead; the
benchmarks of docs/research/moon-sky-data.md were read from PDS ldem_64 and are re-checked against this file
in verify.py.)

The full-resolution file is memory-mapped. Mips 1 and 2 are evaluated on demand from mip 0 (exact block
means, so no 2.6 GB intermediates on disk); mips 3..9 are block means stored as float32 in data/cache/moon/work.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from moon import rt
from moon.sampling import EquirectPyramid

URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif"
BYTES = 8_494_203_833
WIDTH, HEIGHT = 92160, 46080
NODATA = -32768
SCALE_M = 0.5
FILE = rt.MOON_DL / "lola118" / "Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif"
STRIPS = rt.MOON_WORK / "lola118_strips.npy"
STORED_MIPS = range(3, 10)
CREDIT = "LOLA 118 m global DEM (LRO LOLA Team, NASA GSFC; USGS Astrogeology mosaic, Mar 2014)"


def strip_offsets(path: Path = FILE) -> np.ndarray:
    """Byte offset of every row strip (cached in data/cache/moon/work so range reads work after deletion)."""
    if STRIPS.is_file():
        return np.load(STRIPS)
    import tifffile

    with tifffile.TiffFile(str(path)) as t:
        p = t.pages[0]
        if t.byteorder != "<" or p.shape != (HEIGHT, WIDTH) or str(p.dtype) != "int16":
            raise ValueError(f"unexpected LOLA TIFF layout {t.byteorder} {p.shape} {p.dtype}")
        off = np.asarray(p.dataoffsets, dtype=np.int64)
        cnt = np.asarray(p.databytecounts, dtype=np.int64)
    if len(off) != HEIGHT or not np.all(cnt == WIDTH * 2):
        raise ValueError("LOLA TIFF is not one row per strip")
    STRIPS.parent.mkdir(parents=True, exist_ok=True)
    np.save(STRIPS, off)
    return off


def mip0() -> np.memmap:
    off = strip_offsets()
    if not np.all(off[1:] == off[:-1] + WIDTH * 2):
        raise ValueError("LOLA strips are not contiguous; cannot memory-map")
    return np.memmap(FILE, dtype="<i2", mode="r", offset=int(off[0]), shape=(HEIGHT, WIDTH))


class BlockMeanMip:
    """Mip k of a 2-D array evaluated on demand: exact mean of each 2^k x 2^k block (float64)."""

    def __init__(self, base, k: int):
        self.base = base
        self.k = k
        self.f = 2 ** k
        self.shape = (base.shape[0] // self.f, base.shape[1] // self.f)
        self.ndim = 2

    def __getitem__(self, idx):
        iy, ix = idx
        iy = np.asarray(iy, dtype=np.int64)
        ix = np.asarray(ix, dtype=np.int64)
        key = (iy * self.shape[1] + ix).ravel()
        uk, inv = np.unique(key, return_inverse=True)
        r = (uk // self.shape[1]) * self.f
        c = (uk % self.shape[1]) * self.f
        acc = np.zeros(uk.shape, dtype=np.float64)
        for dy in range(self.f):
            for dx in range(self.f):
                acc += self.base[r + dy, c + dx]
        return (acc / (self.f * self.f))[inv].reshape(iy.shape)


def _mip_path(k: int) -> Path:
    return rt.MOON_WORK / f"lola118_mip{k}.f32"


def build_stored_mips() -> None:
    """Block-mean mips 3..9 (float32) from the memory-mapped mip 0, streamed in row bands."""
    if all(_mip_path(k).is_file() for k in STORED_MIPS):
        return
    a = mip0()
    rt.MOON_WORK.mkdir(parents=True, exist_ok=True)
    f = 8
    m3 = np.empty((HEIGHT // f, WIDTH // f), dtype=np.float32)
    band = 1024
    nodata = 0
    lo, hi = np.inf, -np.inf
    for r0 in range(0, HEIGHT, band):
        blk = np.asarray(a[r0:r0 + band], dtype=np.int16)
        nodata += int(np.count_nonzero(blk == NODATA))
        lo = min(lo, float(blk.min()))
        hi = max(hi, float(blk.max()))
        b = blk.astype(np.float64)
        acc = np.zeros((b.shape[0] // f, WIDTH // f), dtype=np.float64)
        for dy in range(f):
            for dx in range(f):
                acc += b[dy::f, dx::f]
        m3[r0 // f:(r0 + band) // f] = (acc / (f * f)).astype(np.float32)
        if r0 % (band * 8) == 0:
            rt.log(f"LOLA mip3 rows {r0}/{HEIGHT}")
    if nodata:
        raise ValueError(f"LOLA 118 m contains {nodata} nodata pixels; a fill strategy would be needed")
    rt.log(f"LOLA DN range {lo} .. {hi} (x0.5 m), no nodata")
    prev = m3
    prev.tofile(_mip_path(3))
    for k in range(4, 10):
        h, w = prev.shape
        nxt = prev.reshape(h // 2, 2, w // 2, 2).astype(np.float64)
        nxt = ((nxt[:, 0, :, 0] + nxt[:, 0, :, 1]) + (nxt[:, 1, :, 0] + nxt[:, 1, :, 1])) / 4.0
        prev = nxt.astype(np.float32)
        prev.tofile(_mip_path(k))
    rt.log("LOLA stored mips 3..9 written")


def pyramid() -> EquirectPyramid:
    """Mip chain 0..9 of the LOLA DEM (values in metres above 1737.4 km after value_scale)."""
    base = mip0()
    mips: list = [base, BlockMeanMip(base, 1), BlockMeanMip(base, 2)]
    for k in STORED_MIPS:
        shape = (HEIGHT >> k, WIDTH >> k)
        mips.append(np.memmap(_mip_path(k), dtype=np.float32, mode="r", shape=shape))
    return EquirectPyramid(mips, lon0=-180.0, value_scale=SCALE_M)


def delete_download() -> None:
    """Remove the 8.5 GB source after the global height levels are baked and verified."""
    strip_offsets()
    if FILE.is_file():
        FILE.unlink()
    for k in STORED_MIPS:
        _mip_path(k).unlink(missing_ok=True)
