"""A downloaded global raster as a filtered sampler: windowed reads into a memory-mapped mip chain.

Pipeline for one source (a pure function of the file and its config entry):
  1. Georeference from the GeoTIFF itself (rasterio): longitude of the left edge, latitude of the top edge and
     the pixel size in degrees, derived from the CRS (geographic, or equirectangular on the CRS sphere with its
     lon_0 / lat_ts) and the transform. The values must agree with the config (`lonLeftEdgeDeg`, `width`,
     `height`, a global 360 x 180 extent) or the bake stops: a shifted or flipped map is a config error, not
     something to guess around.
  2. Mip 0: the file itself, memory-mapped, when it is an uncompressed strip TIFF without nodata (no copy);
     otherwise a copy made by windowed reads of row bands (never the whole raster in memory) into
     data/cache/planets/<id>/work/<key>.m0, with nodata pixels filled by pull-push from the mip chain.
  3. Mips 1..K: area means (2 x 2, nodata-weighted) written band by band to float32 memmaps.
  4. Sampling: moon.sampling.EquirectPyramid (Catmull-Rom inside a mip, trilinear across mips, extra longitude
     taps toward the poles) at the footprint of the tile level: an area filter, a pure function of direction
     and footprint, so shared tile edges get identical values. Longitude sense and planetographic latitude
     are converted at the query.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from moon.sampling import EquirectPyramid
from planet import config, rt

BAND_ROWS = 512
MIN_MIP_ROWS = 32
MAX_MIPS = 9


class _Channels:
    """A (H, W, C) memmap restricted to some channels, as a 2-D (mono) or 3-D array for EquirectPyramid."""

    def __init__(self, base: np.ndarray, channels: list[int]):
        self.base = base
        self.channels = channels
        self.mono = len(channels) == 1
        self.shape = base.shape[:2] + (() if self.mono else (len(channels),))
        self.ndim = 2 if self.mono else 3

    def __getitem__(self, idx):
        iy, ix = idx
        if self.base.ndim == 2:
            return self.base[iy, ix]
        v = self.base[iy, ix]
        return v[..., self.channels[0]] if self.mono else v[..., self.channels]

    def rows(self, r0: int, r1: int) -> np.ndarray:
        v = np.asarray(self.base[r0:r1])
        if self.base.ndim == 2:
            return v
        return v[..., self.channels[0]] if self.mono else v[..., self.channels]


def georef(path: Path) -> dict:
    """Left-edge longitude, top-edge latitude, degrees per pixel (x, y), size and nodata from the GeoTIFF."""
    import rasterio

    with rasterio.open(path) as ds:
        t = ds.transform
        if abs(t.b) > 1e-12 or abs(t.d) > 1e-12:
            raise ValueError(f"{path}: rotated transform")
        crs = ds.crs
        info = {"width": ds.width, "height": ds.height, "count": ds.count, "dtype": ds.dtypes[0],
                "nodata": ds.nodata, "crs": crs.to_wkt() if crs else None}
        if crs is None or crs.is_geographic:
            lon0, lat0, dx, dy = t.c, t.f, t.a, -t.e
        else:
            d = crs.to_dict()
            if d.get("proj") != "eqc":
                raise ValueError(f"{path}: projection {d.get('proj')} is not equirectangular")
            r = d.get("R") or d.get("a")
            if not r:
                raise ValueError(f"{path}: no sphere radius in the CRS {d}")
            k = math.cos(math.radians(d.get("lat_ts", 0.0)))
            lon_c = d.get("lon_0", 0.0)
            lon0 = lon_c + math.degrees((t.c - d.get("x_0", 0.0)) / (r * k))
            lat0 = math.degrees((t.f - d.get("y_0", 0.0)) / r) + d.get("lat_0", 0.0)
            dx = math.degrees(t.a / (r * k))
            dy = math.degrees(-t.e / r)
            info["crsRadius"] = r
        info.update({"lonLeftEdgeDeg": lon0, "latTopEdgeDeg": lat0, "degPerPxX": dx, "degPerPxY": dy})
        return info


REGRID_TOLERANCE_PX = 2.0


def check_georef(body_id: str, key: str, src: dict, g: dict) -> bool:
    """Check the file against the config. Returns True when the grid is an exact global 2:1 grid (within half a
    pixel, sampled as it is), False when it is global within REGRID_TOLERANCE_PX pixels but not exact (it is
    then resampled onto a canonical grid). Anything else is an error."""
    where = f"{body_id}.{key}"
    if (g["width"], g["height"]) != (src["width"], src["height"]):
        raise ValueError(f"{where}: file is {g['width']} x {g['height']}, config says {src['width']} x {src['height']}")
    if max(src["bands"]) > g["count"]:
        raise ValueError(f"{where}: config bands {src['bands']} but the file has {g['count']}")
    errs = {
        "lon extent": (g["degPerPxX"] * g["width"] - 360.0) / g["degPerPxX"],
        "lat extent": (g["degPerPxY"] * g["height"] - 180.0) / g["degPerPxY"],
        "top edge": (g["latTopEdgeDeg"] - 90.0) / g["degPerPxY"],
        "left edge": ((g["lonLeftEdgeDeg"] - src["lonLeftEdgeDeg"] + 180.0) % 360.0 - 180.0) / g["degPerPxX"],
    }
    bad = {k: round(v, 3) for k, v in errs.items() if abs(v) > REGRID_TOLERANCE_PX}
    if bad:
        raise ValueError(f"{where}: georeference differs from a global grid with the configured left edge "
                         f"{src['lonLeftEdgeDeg']} deg by {bad} pixels ({g})")
    exact = all(abs(v) <= 0.5 for v in errs.values()) and g["width"] == 2 * g["height"]
    return exact


def check_nodata(body_id: str, key: str, configured, declared) -> None:
    """The config must state exactly the nodata value the file declares (null only when the file declares none):
    a declared value the config does not state would silently be drawn as data (review finding 1)."""
    if (configured is None) != (declared is None) or (configured is not None and float(configured) != float(declared)):
        raise ValueError(f"{body_id}.{key}: config nodata {configured} disagrees with the nodata {declared} the file declares")


def _feather_wrap(dst: np.ndarray, mask, width_deg: float) -> dict:
    """Remove the step between a grid's two ends at the +-180 meridian (a DEM stitched there from halves that
    disagree): per row, the valid pixels within width_deg of the seam on each side are shifted toward each
    other, by half the step at the last valid column before the seam and by nothing width_deg from it, so the
    two ends meet; the masked columns between them (edgeColumnsInvalid) are bridged linearly along the row and
    become valid (a pull-push fill there would sag toward the far side's mean). Returns the step statistics."""
    h, w = dst.shape[:2]
    n = max(4, int(round(width_deg / 360.0 * w)))
    x = np.arange(w)
    steps = []
    for r in range(h):
        row = np.asarray(dst[r], dtype=np.float64)
        ok = np.ones(w, bool) if mask is None else np.asarray(mask[r]) > 0
        east = np.nonzero(ok[:n])[0]                 # valid columns just east of the seam (from -180)
        west = np.nonzero(ok[w - n:])[0] + (w - n)   # valid columns just west of it (to +180)
        if east.size == 0 or west.size == 0:
            continue
        e0, w0 = int(east[0]), int(west[-1])
        d = float(row[east[:3]].mean() - row[west[-3:]].mean())
        steps.append(d)
        adj = -0.5 * d * np.clip(1.0 - (x - e0) / n, 0.0, 1.0) * (x < e0 + n)
        adj += 0.5 * d * np.clip(1.0 - (w0 - x) / n, 0.0, 1.0) * (x > w0 - n)
        out = row + adj * ok
        gap = (w - 1 - w0) + e0                      # masked columns w0+1 .. w-1, 0 .. e0-1
        if gap > 0 and mask is not None:
            a0, a1 = out[w0], out[e0]
            for i in range(1, gap + 1):
                col = (w0 + i) % w
                out[col] = a0 + (a1 - a0) * i / (gap + 1)
            cols = [(w0 + i) % w for i in range(1, gap + 1)]
            mask[r, cols] = 1
        dst[r] = out.astype(dst.dtype)
    dst.flush()
    if mask is not None:
        mask.flush()
    a = np.abs(np.asarray(steps)) if steps else np.zeros(1)
    return {"widthDeg": width_deg, "meanAbsStep": round(float(a.mean()), 2), "maxAbsStep": round(float(a.max()), 2)}


def _drop_edges(ok: np.ndarray, edges) -> None:
    """Mark the first edges[0] and last edges[1] columns invalid (a source's stitch columns at its wrap)."""
    left, right = int(edges[0]), int(edges[1])
    if left:
        ok[:, :left] = False
    if right:
        ok[:, ok.shape[1] - right:] = False


def _dilate_invalid(ok: np.ndarray, px: int) -> np.ndarray:
    """Shrink the valid mask by px pixels around every invalid pixel (the dark fringe of resampled dropouts)."""
    if px <= 0 or ok.all():
        return ok
    from scipy.ndimage import binary_erosion
    return binary_erosion(ok, structure=np.ones((3, 3), bool), iterations=px, border_value=1)


def _strip_memmap(path: Path, src: dict):
    """The TIFF's pixels as a read-only memmap when it is uncompressed, unpadded and contiguous; else None."""
    import tifffile

    with tifffile.TiffFile(str(path)) as tf:
        p = tf.pages[0]
        if p.compression != 1 or p.is_tiled or (p.samplesperpixel > 1 and p.planarconfig != 1):
            return None
        off = np.asarray(p.dataoffsets, dtype=np.int64)
        cnt = np.asarray(p.databytecounts, dtype=np.int64)
        if not np.all(off[1:] == off[:-1] + cnt[:-1]):
            return None
        dtype = np.dtype(p.dtype).newbyteorder(tf.byteorder)
        shape = (p.imagelength, p.imagewidth) + ((p.samplesperpixel,) if p.samplesperpixel > 1 else ())
        if int(cnt.sum()) != int(np.prod(shape)) * dtype.itemsize:
            return None
        return np.memmap(path, dtype=dtype, mode="r", offset=int(off[0]), shape=shape)


def _read_band_rows(path: Path, bands: list[int], r0: int, r1: int) -> np.ndarray:
    import rasterio
    from rasterio.windows import Window

    with rasterio.open(path) as ds:
        a = ds.read(bands, window=Window(0, r0, ds.width, r1 - r0))
    return np.moveaxis(a, 0, -1)  # (rows, W, C)


class Raster:
    """Prepared source: EquirectPyramid over mip 0..K, plus the query conventions."""

    def __init__(self, body: config.Body, key: str):
        self.body = body
        self.key = key
        self.src = body.source(key)
        self.dir = rt.work_dir(body.id) / f"src-{key}"
        meta = rt.read_json(self.dir / "meta.json")
        self.meta = meta
        h, w, c = meta["height"], meta["width"], meta["channels"]
        vdt = np.dtype(meta.get("valueDtype", "float32"))
        mips: list = []
        m0 = meta["mip0"]
        if m0["kind"] == "tiff":
            base = np.memmap(m0["path"], dtype=np.dtype(m0["dtype"]), mode="r", offset=m0["offset"], shape=tuple(m0["shape"]))
            mips.append(_Channels(base, m0["channels"]))
        elif m0["kind"] == "u8":
            shape = (h, w) if c == 1 else (h, w, c)
            mips.append(np.memmap(self.dir / "m0.u8", dtype=np.uint8, mode="r", shape=shape))
        else:
            shape = (h, w) if c == 1 else (h, w, c)
            mips.append(np.memmap(self.dir / "m0.f32", dtype=vdt, mode="r", shape=shape))
        for k in range(1, meta["mips"] + 1):
            shape = (h >> k, w >> k) if c == 1 else (h >> k, w >> k, c)
            mips.append(np.memmap(self.dir / f"m{k}.f32", dtype=vdt, mode="r", shape=shape))
        self.pyramid = EquirectPyramid(mips, lon0=meta["lonLeftEdgeDeg"], lat0=90.0)
        self.channels = c
        self.west = self.src["lonPositive"] == "west"
        a, b, cc = body.abc
        self.graphic = self.src["latitude"] == "planetographic"
        self.flat2 = ((a + b) / 2.0 / cc) ** 2

    def sample(self, dirs: np.ndarray, footprint_m: np.ndarray) -> np.ndarray:
        """Area-filtered source values (DN units, float64) at unit directions (..., 3); shape (...[, C])."""
        lat = np.arctan2(dirs[..., 2], np.hypot(dirs[..., 0], dirs[..., 1]))
        lon = np.degrees(np.arctan2(dirs[..., 1], dirs[..., 0]))
        if self.graphic:
            lat = np.arctan(np.tan(lat) * self.flat2)
        if self.west:
            lon = -lon
        fp_deg = np.degrees(np.asarray(footprint_m) / self.body.radius)
        return self.pyramid.sample(np.degrees(lat), lon, fp_deg)

    def coarse_percentile(self, fn, q: float) -> float:
        """Area-weighted q-th percentile over the globe of the scalar fn(values) at the coarse mip."""
        k = max(0, min(self.meta["mips"], int(np.log2(max(1, self.meta["height"] // 256)))))
        a = np.asarray(self.pyramid.mips[k][np.arange(self.meta["height"] >> k)[:, None],
                                            np.arange(self.meta["width"] >> k)[None, :]], dtype=np.float64)
        hk, wk = a.shape[:2]
        lat = 90.0 - (np.arange(hk) + 0.5) * 180.0 / hk
        w = np.repeat(np.cos(np.radians(lat))[:, None], wk, axis=1).ravel()
        v = np.asarray(fn(a), dtype=np.float64).ravel()
        o = np.argsort(v)
        cdf = np.cumsum(w[o]) / w.sum()
        return float(v[o][min(len(v) - 1, int(np.searchsorted(cdf, q / 100.0)))])

    def coarse_mean(self, fn=None, region: dict | None = None) -> np.ndarray:
        """Area-weighted mean over the globe (or a disc) of fn(values) at the coarsest mip with >= 256 rows."""
        k = max(0, min(self.meta["mips"], int(np.log2(max(1, self.meta["height"] // 256)))))
        a = np.asarray(self.pyramid.mips[k][np.arange(self.meta["height"] >> k)[:, None],
                                            np.arange(self.meta["width"] >> k)[None, :]], dtype=np.float64)
        hk, wk = a.shape[:2]
        lat = 90.0 - (np.arange(hk) + 0.5) * 180.0 / hk
        lon = self.meta["lonLeftEdgeDeg"] + (np.arange(wk) + 0.5) * 360.0 / wk
        if self.west:
            lon = -lon
        if self.graphic:
            lat = np.degrees(np.arctan(np.tan(np.radians(lat)) / self.flat2))
        wgt = np.repeat(np.cos(np.radians(lat))[:, None], wk, axis=1)
        if region is not None:
            la, lo = np.radians(lat)[:, None], np.radians(lon)[None, :]
            c0, l0 = math.radians(region["latDeg"]), math.radians(region["lonDegE"])
            cosd = np.sin(la) * math.sin(c0) + np.cos(la) * math.cos(c0) * np.cos(lo - l0)
            wgt = wgt * (np.arccos(np.clip(cosd, -1, 1)) * self.body.radius <= region["radiusKm"] * 1000.0)
        v = fn(a) if fn else a
        if v.ndim == 3:
            return np.tensordot(wgt, v, axes=([0, 1], [0, 1])) / wgt.sum()
        return np.array((wgt * v).sum() / wgt.sum())


def _mip_chain_depth(h: int) -> int:
    k = 0
    while k < MAX_MIPS and h % 2 == 0 and (h >> 1) >= MIN_MIP_ROWS:
        h >>= 1
        k += 1
    return k


def _down2(a: np.ndarray, w: np.ndarray | None):
    """2 x 2 mean of (rows, W[, C]) with optional weights (rows, W); returns (values, weights)."""
    r, c = a.shape[:2]
    if w is None:
        b = a.reshape(r // 2, 2, c // 2, 2, *a.shape[2:]).astype(np.float64)
        return ((b[:, 0, :, 0] + b[:, 0, :, 1]) + (b[:, 1, :, 0] + b[:, 1, :, 1])) / 4.0, None
    ww = w.reshape(r // 2, 2, c // 2, 2).astype(np.float64)
    ws = ww.sum(axis=(1, 3))
    aa = a.reshape(r // 2, 2, c // 2, 2, *a.shape[2:]).astype(np.float64)
    wexp = ww if a.ndim == 2 else ww[..., None]
    s = (aa * wexp).sum(axis=(1, 3))
    with np.errstate(invalid="ignore", divide="ignore"):
        v = s / (ws if a.ndim == 2 else ws[..., None])
    v[ws == 0] = 0.0
    return v, ws / 4.0


def _decimate_rows(rows_src, r0: int, r1: int, dst: np.ndarray, dec: int, nodata, empty: list) -> int:
    """Decimated rows r0..r1 of dst: block means of the valid pixels; a block with none takes the nearest valid
    block of its row (dropouts in otherwise complete mosaics); a row with none at all (a polar gap) is appended
    to `empty` and filled afterwards by _fill_empty_rows. rows_src(a, b) gives full-resolution rows a..b.
    Returns the number of blocks with data."""
    w = dst.shape[1]
    valid = 0
    step = max(1, BAND_ROWS // dec)
    for q0 in range(r0, r1, step):
        q1 = min(r1, q0 + step)
        blk = np.asarray(rows_src(q0 * dec, q1 * dec), dtype=np.float64)
        if blk.ndim == 2:
            blk = blk[..., None]
        c = blk.shape[2]
        ok = np.ones(blk.shape[:2], bool) if nodata is None else np.all(blk != nodata, axis=-1)
        ws = ok.reshape(q1 - q0, dec, w, dec).sum(axis=(1, 3)).astype(np.float64)
        vv = (blk * ok[..., None]).reshape(q1 - q0, dec, w, dec, c).sum(axis=(1, 3))
        mean = np.where(ws[..., None] > 0, vv / np.maximum(ws, 1)[..., None], 0.0)
        good = ws > 0
        valid += int(good.sum())
        for j in np.nonzero(~good.all(axis=1))[0]:
            idx = np.nonzero(good[j])[0]
            if idx.size == 0:
                empty.append(q0 + j)
                continue
            for ch in range(c):
                mean[j, :, ch] = np.interp(np.arange(w), idx, mean[j, idx, ch], period=w)
        q = np.clip(np.floor(mean + 0.5), 0, 255).astype(np.uint8)
        dst[q0:q1] = q[..., 0] if c == 1 else q
    return valid


def _fill_empty_rows(dst: np.ndarray, empty: list) -> None:
    """Each decimated row without any valid pixel (a polar gap) takes the mean of the nearest row with data
    (a flat zonal cap; never more than a few rows next to a pole in the sources that need it)."""
    if not empty:
        return
    bad = set(empty)
    h = dst.shape[0]
    for r in sorted(bad):
        for d in range(1, h):
            for q in (r - d, r + d):
                if 0 <= q < h and q not in bad:
                    v = np.asarray(dst[q], dtype=np.float64).mean(axis=0)
                    dst[r] = np.clip(np.floor(v + 0.5), 0, 255).astype(np.uint8)
                    break
            else:
                continue
            break


class _HttpFile:
    """Read-only, seekable view of a remote file through HTTP range requests (for parsing a TIFF header)."""

    def __init__(self, url: str, size: int):
        self.url, self.size, self.pos = url, size, 0
        self.cache: dict = {}

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos

    def tell(self):
        return self.pos

    def read(self, n=-1):
        from moon.fetch import read_range
        n = self.size - self.pos if n is None or n < 0 else min(n, self.size - self.pos)
        out = bytearray()
        blk = 1 << 20
        while n > 0:
            b0 = (self.pos // blk) * blk
            if b0 not in self.cache:
                self.cache[b0] = read_range(self.url, b0, min(blk, self.size - b0))
            chunk = self.cache[b0][self.pos - b0:self.pos - b0 + n]
            out += chunk
            self.pos += len(chunk)
            n -= len(chunk)
        return bytes(out)

    def seekable(self):
        return True

    def readable(self):
        return True


def stream_rows(url: str, size: int, on_rows, expect_md5: str | None, expect_sha256: str | None) -> tuple[str, str, np.dtype]:
    """Stream an uncompressed, strip-contiguous single-band TIFF from `url` in order (parallel 64 MB range reads),
    hash every byte (md5 and sha256) and hand its rows to on_rows(rows_array) in order as they complete. Nothing
    is written to disk. Raises when the hashes differ from the expected ones (when given)."""
    import hashlib
    from concurrent.futures import ThreadPoolExecutor
    import tifffile
    from moon.fetch import read_range

    with tifffile.TiffFile(_HttpFile(url, size)) as tf:
        p = tf.pages[0]
        if p.compression != 1 or p.is_tiled or p.samplesperpixel != 1:
            raise ValueError(f"{url}: streaming needs an uncompressed single-band strip TIFF")
        off = np.asarray(p.dataoffsets, dtype=np.int64)
        cnt = np.asarray(p.databytecounts, dtype=np.int64)
        if not np.all(off[1:] == off[:-1] + cnt[:-1]):
            raise ValueError(f"{url}: strips are not contiguous")
        dtype = np.dtype(p.dtype).newbyteorder(tf.byteorder)
        H, W = p.imagelength, p.imagewidth
    row_bytes = W * dtype.itemsize
    d0, d1 = int(off[0]), int(off[0]) + H * row_bytes
    md5, sha = hashlib.md5(), hashlib.sha256()
    ch = 64 << 20
    starts = list(range(0, size, ch))
    pending = bytearray()
    got = 0
    def chunks():
        # at most 8 ranges in flight or waiting: memory stays bounded however slow the consumer is
        with ThreadPoolExecutor(max_workers=6) as ex:
            futs = []
            for st in starts:
                futs.append((st, ex.submit(read_range, url, st, min(ch, size - st))))
                if len(futs) >= 8:
                    s, f = futs.pop(0)
                    yield s, f.result()
            for s, f in futs:
                yield s, f.result()
    if True:
        for s0, data in chunks():
            md5.update(data)
            sha.update(data)
            a, b = max(s0, d0), min(s0 + len(data), d1)
            if a < b:
                pending += data[a - s0:b - s0]
                nrows = len(pending) // row_bytes
                if nrows:
                    on_rows(np.frombuffer(bytes(pending[:nrows * row_bytes]), dtype=dtype).reshape(nrows, W))
                    got += nrows
                    del pending[:nrows * row_bytes]
    if got != H:
        raise ValueError(f"{url}: streamed {got} of {H} rows")
    m, sh = md5.hexdigest(), sha.hexdigest()
    if expect_md5 and m != expect_md5:
        raise ValueError(f"{url}: streamed md5 {m} != {expect_md5}")
    if expect_sha256 and sh != expect_sha256:
        raise ValueError(f"{url}: streamed sha256 {sh} != {expect_sha256}")
    return m, sh, dtype


def prepare_streamed(body: config.Body, key: str, record: bool = False) -> dict:
    """prepare() for a decimated 8-bit source without a local copy of the full file: the georeference is read
    from the remote header, the rows are streamed (every byte hashed against the config's md5 and sha256, or,
    for a new source with --record-checksums, against the provider's .md5, then recorded) into the decimated
    mip 0, then the mips are built. Peak disk: the decimated copy only."""
    from planet import fetch
    src = body.source(key)
    url = src["url"]
    want_md5 = src["md5"]
    if want_md5 is None or src["sha256"] is None:
        if not record:
            raise RuntimeError(f"{body.id}.{key}: no md5/sha256 in the config (run with --record-checksums once)")
        want_md5 = want_md5 or fetch.provider_md5(url)
        if want_md5 is None:
            raise RuntimeError(f"{body.id}.{key}: a streamed source needs the provider's .md5 to be pinned")
    out = rt.work_dir(body.id) / f"src-{key}"
    out.mkdir(parents=True, exist_ok=True)
    dec = int(src.get("decimate", 1))
    g = georef("/vsicurl/" + url)
    if not check_georef(body.id, key, src, g) or g["height"] % dec:
        raise ValueError(f"{body.id}.{key}: streamed decimation needs an exact global grid")
    check_nodata(body.id, key, src["nodata"], g["nodata"])
    H, W = g["height"], g["width"]
    h, w = H // dec, W // dec
    K = _mip_chain_depth(h)
    rt.check_disk(int(h * w * (1 + 2 / 3)))
    dst = np.memmap(out / "m0.u8", dtype=np.uint8, mode="w+", shape=(h, w))
    st = {"buf": np.zeros((0, W), np.uint8), "row": 0, "valid": 0, "empty": []}
    band = max(1, BAND_ROWS // dec) * dec

    def drain(final: bool) -> None:
        while st["buf"].shape[0] >= band or (final and st["buf"].shape[0] > 0):
            take = min(band, st["buf"].shape[0])
            rows = st["buf"][:take]
            st["buf"] = st["buf"][take:]
            r0 = st["row"] // dec
            base = st["row"]
            st["valid"] += _decimate_rows(lambda a, b: rows[a - base:b - base], r0, r0 + take // dec, dst, dec, src["nodata"], st["empty"])
            st["row"] += take

    def on_rows(arr):
        st["buf"] = np.concatenate([st["buf"], arr]) if st["buf"].shape[0] else np.array(arr)
        drain(False)

    rt.log(f"{body.id}.{key}: streaming {src['bytes'] / 1e6:.0f} MB into a 1/{dec} 8-bit mip 0 (no local copy)")
    m, sh, _ = stream_rows(url, src["bytes"], on_rows, want_md5, src["sha256"])
    drain(True)
    _fill_empty_rows(dst, st["empty"])
    if src["sha256"] is None:
        fetch._record(body, key, m, sh)
        body = config.load(body.id)
    dst.flush()
    del dst
    meta = {"width": w, "height": h, "channels": 1, "mips": K, "lonLeftEdgeDeg": g["lonLeftEdgeDeg"], "regridded": False,
            "valueDtype": "float16", "fingerprint": source_fingerprint(body, key), "streamed": {"md5": m, "sha256": sh},
            "georef": {k: v for k, v in g.items() if k != "crs"}, "mip0": {"kind": "u8", "decimate": dec},
            "validFraction": st["valid"] / (h * w), "emptyRowsFilled": len(st["empty"])}
    m0 = np.memmap(out / "m0.u8", dtype=np.uint8, mode="r", shape=(h, w))

    def prev_rows(r0, r1):
        return np.asarray(m0[r0:r1], dtype=np.float32), None
    for k in range(1, K + 1):
        hk, wk = h >> k, w >> k
        dk = np.memmap(out / f"m{k}.f32", dtype=np.float16, mode="w+", shape=(hk, wk))
        for r0 in range(0, hk, BAND_ROWS):
            r1 = min(hk, r0 + BAND_ROWS)
            v, _ = _down2(*prev_rows(2 * r0, 2 * r1))
            dk[r0:r1] = v
        dk.flush()

        def prev_rows(r0, r1, dk=dk):
            return np.asarray(dk[r0:r1]), None
    del m0
    rt.write_json(out / "meta.json", meta)
    return meta


def prepare(body: config.Body, key: str, path: Path) -> dict:
    """Steps 1-3 of the module docstring. Writes work/src-<key>/meta.json last (the resume marker)."""
    src = body.source(key)
    out = rt.work_dir(body.id) / f"src-{key}"
    out.mkdir(parents=True, exist_ok=True)
    g = georef(path)
    # an exact grid is sampled as it is only when it has at least two exact mips (a height with an odd factor
    # such as 7569 = 3 x 2523 has none: it is regridded onto a canonical grid like an inexact one)
    exact = check_georef(body.id, key, src, g) and _mip_chain_depth(g["height"]) >= 2
    bands = src["bands"][:3]
    c = len(bands)
    nodata = src["nodata"]
    check_nodata(body.id, key, nodata, g["nodata"])
    if (src.get("edgeColumnsInvalid") or src.get("nodataDilatePx")) and nodata is None:
        raise ValueError(f"{body.id}.{key}: edgeColumnsInvalid / nodataDilatePx need a source with nodata (the fill uses its mask)")
    dec = int(src.get("decimate", 1))
    if dec > 1 and (not exact or g["height"] % dec or np.dtype(g["dtype"]) != np.uint8):
        raise ValueError(f"{body.id}.{key}: decimate needs an exact 8-bit grid whose height divides by {dec}")
    if exact:
        h, w = g["height"] // dec, g["width"] // dec
        lon_left = g["lonLeftEdgeDeg"]
    else:
        # canonical grid: about the source's pixel size, rows a multiple of 64 (six exact mips)
        h = max(64, int(round(180.0 / g["degPerPxY"] / 64.0)) * 64)
        w = 2 * h
        lon_left = -180.0
    K = _mip_chain_depth(h)
    # 8-bit imagery keeps its mips (and any copy) in float16: exact to 1/8 of a level, half the disk of float32
    vdt = np.dtype(np.float16) if np.dtype(g["dtype"]) == np.uint8 else np.dtype(np.float32)
    est = int(h * w * c * (1 if dec > 1 else vdt.itemsize) * (0 if (nodata is None and exact and dec == 1) else 1)
              + h * w * c * vdt.itemsize / 3)
    rt.check_disk(est)
    meta = {"width": w, "height": h, "channels": c, "mips": K, "lonLeftEdgeDeg": lon_left, "regridded": not exact,
            "valueDtype": vdt.name, "fingerprint": source_fingerprint(body, key),
            "georef": {k: v for k, v in g.items() if k != "crs"}, "fileBytes": path.stat().st_size}
    mm = _strip_memmap(path, src) if (nodata is None and exact and dec == 1) else None
    rt.log(f"{body.id}.{key}: {g['width']} x {g['height']} x {c} ({g['dtype']}), lon edge {g['lonLeftEdgeDeg']:.4f}, "
           f"grid {w} x {h}, {K} mips, mip 0 {'memory-mapped' if mm is not None else ('copied' if exact else 'regridded')}")
    level_w = None
    if dec > 1:
        # area mean of the valid pixels of dec x dec blocks into an 8-bit mip 0 (the full-resolution file is read
        # in row bands; prepare_streamed never stores it at all)
        dst = np.memmap(out / "m0.u8", dtype=np.uint8, mode="w+", shape=(h, w) if c == 1 else (h, w, c))
        empty: list = []
        valid = _decimate_rows(lambda r0, r1: _read_band_rows(path, bands, r0, r1), 0, h, dst, dec, nodata, empty)
        _fill_empty_rows(dst, empty)
        meta["emptyRowsFilled"] = len(empty)
        dst.flush()
        meta["mip0"] = {"kind": "u8", "decimate": dec}
        meta["validFraction"] = valid / (h * w)

        def rows0(r0, r1):
            return np.asarray(dst[r0:r1], dtype=np.float32), None
    elif not exact:
        dst = np.memmap(out / "m0.f32", dtype=vdt, mode="w+", shape=(h, w) if c == 1 else (h, w, c))
        mask = np.memmap(out / "m0.mask", dtype=np.uint8, mode="w+", shape=(h, w)) if nodata is not None else None
        valid = _regrid(path, bands, g, nodata, dst, mask, int(src.get("nodataDilatePx", 0)), src.get("edgeColumnsInvalid", (0, 0)))
        meta["mip0"] = {"kind": "f32"}
        meta["validFraction"] = valid / (h * w) if mask is not None else 1.0

        def rows0(r0, r1):
            return np.asarray(dst[r0:r1]), (np.asarray(mask[r0:r1], dtype=np.float32) if mask is not None else None)
        level_w = mask
    elif mm is not None:
        meta["mip0"] = {"kind": "tiff", "path": str(path), "dtype": mm.dtype.str, "offset": int(mm.offset),
                        "shape": list(mm.shape), "channels": [b - 1 for b in bands]}
        m0 = _Channels(mm, [b - 1 for b in bands])

        def rows0(r0, r1):
            return m0.rows(r0, r1).astype(np.float32), None
    else:
        shape = (h, w) if c == 1 else (h, w, c)
        dst = np.memmap(out / "m0.f32", dtype=vdt, mode="w+", shape=shape)
        mask = np.memmap(out / "m0.mask", dtype=np.uint8, mode="w+", shape=(h, w)) if nodata is not None else None
        valid = 0
        for r0 in range(0, h, BAND_ROWS):
            r1 = min(h, r0 + BAND_ROWS)
            dl = int(src.get("nodataDilatePx", 0))
            q0, q1 = max(0, r0 - dl), min(h, r1 + dl)
            blk = _read_band_rows(path, bands, q0, q1).astype(np.float32)
            okd = None
            if mask is not None:
                okd = np.all(blk != nodata, axis=-1) & np.all(np.isfinite(blk), axis=-1)
                _drop_edges(okd, src.get("edgeColumnsInvalid", (0, 0)))
                okd = _dilate_invalid(okd, dl)[r0 - q0:r1 - q0]
            blk = blk[r0 - q0:r1 - q0]
            if mask is not None:
                ok = okd
                mask[r0:r1] = ok
                valid += int(ok.sum())
                blk[~ok] = 0.0
            dst[r0:r1] = blk[..., 0] if c == 1 else blk
        dst.flush()
        meta["mip0"] = {"kind": "f32"}
        meta["validFraction"] = valid / (h * w) if mask is not None else 1.0

        def rows0(r0, r1):
            return np.asarray(dst[r0:r1]), (np.asarray(mask[r0:r1], dtype=np.float32) if mask is not None else None)
        level_w = mask
    if src.get("wrapFeatherDeg"):
        if meta["mip0"]["kind"] != "f32" or abs(meta["lonLeftEdgeDeg"] + 180.0) > 1e-9 or c != 1:
            raise ValueError(f"{body.id}.{key}: wrapFeatherDeg needs a single-band copied or regridded grid starting at -180")
        meta["wrapFeather"] = _feather_wrap(dst, mask, float(src["wrapFeatherDeg"]))
    # mips 1..K (weighted by validity when there is nodata)
    prev_rows = rows0
    weights = []
    for k in range(1, K + 1):
        hk, wk = h >> k, w >> k
        shape = (hk, wk) if c == 1 else (hk, wk, c)
        dk = np.memmap(out / f"m{k}.f32", dtype=vdt, mode="w+", shape=shape)
        wkm = np.memmap(out / f"m{k}.w", dtype=np.float32, mode="w+", shape=(hk, wk)) if level_w is not None else None
        step = BAND_ROWS
        for r0 in range(0, hk, step):
            r1 = min(hk, r0 + step)
            a, wa = prev_rows(2 * r0, 2 * r1)
            v, ws = _down2(a, wa)
            dk[r0:r1] = v
            if wkm is not None:
                wkm[r0:r1] = ws
        dk.flush()
        if wkm is not None:
            wkm.flush()
            weights.append(wkm)

        def prev_rows(r0, r1, dk=dk, wkm=wkm):
            return np.asarray(dk[r0:r1]), (np.asarray(wkm[r0:r1]) if wkm is not None else None)
    if level_w is not None:
        _pull_push(out, h, w, c, K, meta)
    if src.get("polarSmooth"):
        _polar_smooth(out, meta, src["polarSmooth"])
    rt.write_json(out / "meta.json", meta)
    return meta


def _zonal_box(row: np.ndarray, n: int) -> np.ndarray:
    """Circular box mean of n pixels along a row (w, c)."""
    w = row.shape[0]
    if n >= w:
        return np.repeat(row.mean(axis=0, keepdims=True), w, axis=0)
    ext = np.concatenate([row[-(n // 2) - 1:], row, row[:n]], axis=0)
    cs = np.concatenate([np.zeros((1, row.shape[1])), np.cumsum(ext, axis=0)], axis=0)
    start = np.arange(w) + 1  # ext[start] is row[j - n // 2]
    return (cs[start + n] - cs[start]) / n


def _polar_smooth(out: Path, meta: dict, cfg: dict) -> None:
    """Toward the poles, south of cfg["southDeg"] and north of cfg["northDeg"], mip 0 pixels are replaced by
    their row's circular longitude box mean, the window growing from nothing at the limit to the whole row at
    the pole (linearly, or with cfg["profile"] = "quadratic" as the square of the distance), then (cfg["meridionalDeg"], optional) by the mean of the rows within a latitude window
    growing likewise to +-meridionalDeg at the pole: the source's radial streaks ('pinwheels', cfg["pixels"] =
    "all") or the fill's flat polygons ("filled": only the pixels the nodata fill made) become a smooth cap,
    without the rings that row-to-row differences of zonal means alone would leave. The mips are then rebuilt
    from mip 0."""
    h, w, c, K = meta["height"], meta["width"], meta["channels"], meta["mips"]
    kind = meta["mip0"]["kind"]
    if kind == "tiff":
        raise ValueError("polarSmooth needs a copied mip 0 (a source with nodata, regridded or decimated)")
    if cfg["pixels"] not in ("all", "filled"):
        raise ValueError(f"polarSmooth.pixels {cfg['pixels']!r} is not 'all' or 'filled'")
    vdt = np.dtype(np.uint8) if kind == "u8" else np.dtype(meta["valueDtype"])
    shape = lambda k: ((h >> k, w >> k) if c == 1 else (h >> k, w >> k, c))  # noqa: E731
    m0 = np.memmap(out / ("m0.u8" if kind == "u8" else "m0.f32"), dtype=vdt, mode="r+", shape=shape(0))
    mask = np.memmap(out / "m0.mask", dtype=np.uint8, mode="r", shape=(h, w)) if cfg["pixels"] == "filled" else None
    lat = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    mer = float(cfg.get("meridionalDeg", 0.0))
    profile = cfg.get("profile", "linear")
    if profile not in ("linear", "quadratic"):
        raise ValueError(f"polarSmooth.profile {profile!r} is not 'linear' or 'quadratic'")
    rows = 0
    # each zone: its rows, contiguous, the pole's first
    for limit, zone in ((float(cfg["northDeg"]), np.nonzero(lat > float(cfg["northDeg"]))[0]),
                        (float(cfg["southDeg"]), np.nonzero(lat < float(cfg["southDeg"]))[0][::-1])):
        if zone.size == 0:
            continue
        t = (np.abs(lat[zone]) - abs(limit)) / (90.0 - abs(limit))
        if profile == "quadratic":
            # gentler start: near a high-latitude limit a linear ramp already averages tens of degrees of
            # longitude a degree inside it, which leaves a hard rim
            t = t * t
        orig = [np.asarray(m0[i], dtype=np.float64) for i in zone]
        orig = [r if r.ndim == 2 else r[:, None] for r in orig]
        zon = np.stack([_zonal_box(r, int(round(tt * w))) if int(round(tt * w)) >= 2 else r for r, tt in zip(orig, t)]).astype(np.float32)
        if mer > 0:
            half = np.rint(t * mer / (180.0 / h)).astype(int)
            cs = np.concatenate([np.zeros((1,) + zon.shape[1:], np.float64), np.cumsum(zon, axis=0, dtype=np.float64)], axis=0)
            lo = np.maximum(0, np.arange(zone.size) - half)
            hi = np.minimum(zone.size, np.arange(zone.size) + half + 1)
            zon = ((cs[hi] - cs[lo]) / (hi - lo)[:, None, None]).astype(np.float32)
        for j, i in enumerate(zone):
            if int(round(t[j] * w)) < 2 and mer <= 0:
                continue
            sm = zon[j].astype(np.float64)
            if mask is not None:
                keep = np.asarray(mask[i]) > 0
                sm[keep] = orig[j][keep]
            sm = sm if c > 1 else sm[:, 0]
            m0[i] = np.clip(np.floor(sm + 0.5), 0, 255).astype(np.uint8) if kind == "u8" else sm.astype(vdt)
            rows += 1
        del orig, zon
    m0.flush()
    for k in range(1, K + 1):
        prev = np.memmap(out / ("m0.u8" if (k == 1 and kind == "u8") else ("m0.f32" if k == 1 else f"m{k - 1}.f32")),
                         dtype=vdt if k == 1 else np.dtype(meta["valueDtype"]), mode="r", shape=shape(k - 1))
        dk = np.memmap(out / f"m{k}.f32", dtype=np.dtype(meta["valueDtype"]), mode="r+", shape=shape(k))
        for r0 in range(0, h >> k, BAND_ROWS):
            r1 = min(h >> k, r0 + BAND_ROWS)
            v, _ = _down2(np.asarray(prev[2 * r0:2 * r1], dtype=np.float32), None)
            dk[r0:r1] = v
        dk.flush()
        del prev, dk
    del m0, mask
    meta["polarSmooth"] = dict(cfg)
    meta["polarSmoothRows"] = rows


def _regrid(path: Path, bands: list[int], g: dict, nodata, dst: np.ndarray, mask, dilate: int = 0, edges=(0, 0)) -> int:
    """Bilinear resampling of a nearly global grid onto the canonical one (row 0 at +90, column 0 at -180),
    read in row bands; nodata taps are left out of the weights. Returns the number of valid pixels."""
    h, w = dst.shape[:2]
    H, W = g["height"], g["width"]
    lon = -180.0 + (np.arange(w) + 0.5) * 360.0 / w
    sx = ((lon - g["lonLeftEdgeDeg"]) % 360.0) / g["degPerPxX"] - 0.5
    x0 = np.floor(sx).astype(np.int64)
    fx = sx - x0
    xa, xb = np.mod(x0, W), np.mod(x0 + 1, W)
    valid = 0
    for r0 in range(0, h, BAND_ROWS):
        r1 = min(h, r0 + BAND_ROWS)
        lat = 90.0 - (np.arange(r0, r1) + 0.5) * 180.0 / h
        sy = np.clip((g["latTopEdgeDeg"] - lat) / g["degPerPxY"] - 0.5, 0.0, H - 1.0)
        y0 = np.floor(sy).astype(np.int64)
        fy = sy - y0
        ya, yb = y0, np.minimum(y0 + 1, H - 1)
        lo, hi = int(ya.min()), int(yb.max()) + 1
        m0, m1 = max(0, lo - dilate), min(H, hi + dilate)
        band = _read_band_rows(path, bands, m0, m1).astype(np.float64)
        ok = np.all(np.isfinite(band), axis=-1)
        if nodata is not None:
            ok &= np.all(band != nodata, axis=-1)
        _drop_edges(ok, edges)
        ok = _dilate_invalid(ok, dilate)[lo - m0:hi - m0]
        band = band[lo - m0:hi - m0]
        band[~ok] = 0.0
        okf = ok.astype(np.float64)
        acc = np.zeros((r1 - r0, w, band.shape[-1]))
        wsum = np.zeros((r1 - r0, w))
        for yy, wy in ((ya - lo, 1.0 - fy), (yb - lo, fy)):
            for xx, wx in ((xa, 1.0 - fx), (xb, fx)):
                wt = wy[:, None] * wx[None, :] * okf[yy][:, xx]
                acc += band[yy][:, xx] * wt[..., None]
                wsum += wt
        good = wsum > 1e-9
        v = np.where(good[..., None], acc / np.maximum(wsum, 1e-12)[..., None], 0.0).astype(np.float32)
        dst[r0:r1] = v[..., 0] if v.shape[-1] == 1 else v
        if mask is not None:
            mask[r0:r1] = good
        valid += int(good.sum())
    dst.flush()
    if mask is not None:
        mask.flush()
    return valid


def _pull_push(out: Path, h: int, w: int, c: int, K: int, meta: dict) -> None:
    """Fill nodata: each level's invalid part takes the bilinear upsample of the filled level above it,
    from the coarsest mip (whose remaining holes take the mean of its valid pixels) down to mip 0."""
    shape = lambda k: ((h >> k, w >> k) if c == 1 else (h >> k, w >> k, c))  # noqa: E731
    vdt = np.dtype(meta.get("valueDtype", "float32"))
    top = np.array(np.memmap(out / f"m{K}.f32", dtype=vdt, mode="r", shape=shape(K)), dtype=np.float64)
    wt = np.array(np.memmap(out / f"m{K}.w", dtype=np.float32, mode="r", shape=(h >> K, w >> K)), dtype=np.float64)
    if not np.any(wt > 0):
        raise ValueError("source has no valid pixel")
    wexp = wt if c == 1 else wt[..., None]
    mean = (top * wexp).sum(axis=(0, 1)) / max(wt.sum(), 1e-12)
    filled = top * wexp + mean * (1.0 - wexp)
    np.memmap(out / f"m{K}.f32", dtype=vdt, mode="r+", shape=shape(K))[:] = filled
    del filled
    for k in range(K - 1, -1, -1):
        hk, wk = h >> k, w >> k
        dst = np.memmap(out / f"m{k}.f32", dtype=vdt, mode="r+", shape=shape(k))
        wm = (np.memmap(out / f"m{k}.w", dtype=np.float32, mode="r", shape=(hk, wk)) if k else
              np.memmap(out / "m0.mask", dtype=np.uint8, mode="r", shape=(hk, wk)))
        coarse = np.memmap(out / f"m{k + 1}.f32", dtype=vdt, mode="r", shape=shape(k + 1))
        for r0 in range(0, hk, BAND_ROWS):
            r1 = min(hk, r0 + BAND_ROWS)
            up = _upsample_rows(coarse, r0, r1, wk)
            wv = np.asarray(wm[r0:r1], dtype=np.float64)
            wv = wv if c == 1 else wv[..., None]
            dst[r0:r1] = np.asarray(dst[r0:r1], dtype=np.float64) * wv + up * (1.0 - wv)
        dst.flush()
        del dst, coarse
    meta["filled"] = True


def _upsample_rows(coarse: np.ndarray, r0: int, r1: int, wk: int) -> np.ndarray:
    """Bilinear 2x upsample of a global equirect grid (wrap in longitude, clamp in latitude), rows r0..r1;
    reads only the coarse rows it needs (the grid may be a memmap)."""
    hc, wc = coarse.shape[:2]
    y = (np.arange(r0, r1) + 0.5) / 2.0 - 0.5
    x = (np.arange(wk) + 0.5) / 2.0 - 0.5
    y0 = np.floor(y).astype(np.int64)
    x0 = np.floor(x).astype(np.int64)
    fy = (y - y0)[:, None]
    fx = (x - x0)[None, :]
    lo = max(0, int(y0.min()))
    hi = min(hc - 1, int(y0.max()) + 1)
    band = np.asarray(coarse[lo:hi + 1], dtype=np.float64)
    ya, yb = np.clip(y0, 0, hc - 1) - lo, np.clip(y0 + 1, 0, hc - 1) - lo
    xa, xb = np.mod(x0, wc), np.mod(x0 + 1, wc)
    if band.ndim == 3:
        fy = fy[..., None]
        fx = fx[..., None]
    top = band[ya][:, xa] * (1 - fx) + band[ya][:, xb] * fx
    bot = band[yb][:, xa] * (1 - fx) + band[yb][:, xb] * fx
    return top * (1 - fy) + bot * fy


PREPARE_VERSION = 4


def source_fingerprint(body: config.Body, key: str) -> str:
    """What a prepared source depends on: its config entry, the body's radii and the code version."""
    import hashlib
    import json
    h = json.dumps({"src": body.source(key), "radii": body.raw["radii"], "v": PREPARE_VERSION}, sort_keys=True)
    return hashlib.sha256(h.encode("utf-8")).hexdigest()[:16]


def is_prepared(body: config.Body, key: str) -> bool:
    m = rt.work_dir(body.id) / f"src-{key}" / "meta.json"
    return m.is_file() and rt.read_json(m).get("fingerprint") == source_fingerprint(body, key)


def delete_prepared(body: config.Body, key: str) -> None:
    rt.remove_tree(rt.work_dir(body.id) / f"src-{key}")
