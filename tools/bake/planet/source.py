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
            raise ValueError(f"{path.name}: rotated transform")
        crs = ds.crs
        info = {"width": ds.width, "height": ds.height, "count": ds.count, "dtype": ds.dtypes[0],
                "nodata": ds.nodata, "crs": crs.to_wkt() if crs else None}
        if crs is None or crs.is_geographic:
            lon0, lat0, dx, dy = t.c, t.f, t.a, -t.e
        else:
            d = crs.to_dict()
            if d.get("proj") != "eqc":
                raise ValueError(f"{path.name}: projection {d.get('proj')} is not equirectangular")
            r = d.get("R") or d.get("a")
            if not r:
                raise ValueError(f"{path.name}: no sphere radius in the CRS {d}")
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
    if nodata is not None and g["nodata"] is not None and float(g["nodata"]) != float(nodata):
        raise ValueError(f"{body.id}.{key}: file nodata {g['nodata']} != config {nodata}")
    if exact:
        h, w = g["height"], g["width"]
        lon_left = g["lonLeftEdgeDeg"]
    else:
        # canonical grid: about the source's pixel size, rows a multiple of 64 (six exact mips)
        h = max(64, int(round(180.0 / g["degPerPxY"] / 64.0)) * 64)
        w = 2 * h
        lon_left = -180.0
    K = _mip_chain_depth(h)
    # 8-bit imagery keeps its mips (and any copy) in float16: exact to 1/8 of a level, half the disk of float32
    vdt = np.dtype(np.float16) if np.dtype(g["dtype"]) == np.uint8 else np.dtype(np.float32)
    est = int(h * w * c * vdt.itemsize * (0 if (nodata is None and exact) else 1) + h * w * c * vdt.itemsize / 3)
    rt.check_disk(est)
    meta = {"width": w, "height": h, "channels": c, "mips": K, "lonLeftEdgeDeg": lon_left, "regridded": not exact,
            "valueDtype": vdt.name, "fingerprint": source_fingerprint(body, key),
            "georef": {k: v for k, v in g.items() if k != "crs"}, "fileBytes": path.stat().st_size}
    mm = _strip_memmap(path, src) if (nodata is None and exact) else None
    rt.log(f"{body.id}.{key}: {g['width']} x {g['height']} x {c} ({g['dtype']}), lon edge {g['lonLeftEdgeDeg']:.4f}, "
           f"grid {w} x {h}, {K} mips, mip 0 {'memory-mapped' if mm is not None else ('copied' if exact else 'regridded')}")
    level_w = None
    if not exact:
        dst = np.memmap(out / "m0.f32", dtype=vdt, mode="w+", shape=(h, w) if c == 1 else (h, w, c))
        mask = np.memmap(out / "m0.mask", dtype=np.uint8, mode="w+", shape=(h, w)) if nodata is not None else None
        valid = _regrid(path, bands, g, nodata, dst, mask)
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
            blk = _read_band_rows(path, bands, r0, r1).astype(np.float32)
            if mask is not None:
                ok = np.all(blk != nodata, axis=-1) & np.all(np.isfinite(blk), axis=-1)
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
    rt.write_json(out / "meta.json", meta)
    return meta


def _regrid(path: Path, bands: list[int], g: dict, nodata, dst: np.ndarray, mask) -> int:
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
        band = _read_band_rows(path, bands, lo, hi).astype(np.float64)
        ok = np.all(np.isfinite(band), axis=-1)
        if nodata is not None:
            ok &= np.all(band != nodata, axis=-1)
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


PREPARE_VERSION = 3


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
