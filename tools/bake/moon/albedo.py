"""Moon `albedo` layer (levels 0..7, opaque 256 x 256 WebP) and the `albedoLowRes` global map.

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/moon/albedo.py [--steps svs,resolution,fit,detail,svsdeshade,tiles,lowres]

Base colour: NASA SVS CGI Moon Kit colour (`lroc_color.exr`, linear, LROC WAC 643/566/415 nm as R/G/B from the
Hapke-normalised WAC mosaic, no baked shadows), resampled to 27648 x 13824 so its area-averaged mip chain halves
exactly, and calibrated by one gain so that the red (643 nm) channel of reference maria has normal albedo 0.07
(`calibrate_svs`; the highland median that results is recorded and must fall in 0.15-0.25).

Detail (levels 6 and 7 only, |lat| <= 69 deg with a fade from 65 deg): LROC WAC 100 m morphology mosaic, whose
lighting is baked in (incidence 55-75 deg). It is de-shaded before use:
  1. `fit`: in 1 x 1 deg cells, the high-passed log brightness is regressed on the high-passed LOLA slopes; the
     gradient vector of that fit is the linearised lunar-Lambert response to the sun vector, which gives the
     mosaic's local incidence and azimuth. Cell fits are smoothed (weighted Gaussian over cells).
  2. `detail`: per 1-deg band, LOLA (streamed by HTTP range reads) is resampled to the WAC grid; the modelled
     shading S = R(local normal) / R(flat) (lunar-Lambert, McEwen 1996 L(phase)) divides the WAC brightness;
     cast or self shadows (S < 0.25 or brightness < 0.35 x its 1 km mean) are excluded; the result is
     high-passed against a Gaussian matching the SVS map's effective resolution and clamped to 0.7..1.3.
     Stored as uint8 (1..255 <-> 0.7..1.3, 128 = 1) for rows +-70 deg.
Albedo = SVS_linear x detail, sRGB-encoded. Everything is sampled by direction with footprint-aware filters,
so tiles are seamless across tile and cube edges.
"""
from __future__ import annotations

import argparse
import io
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage  # noqa: E402

from common import cube, layout  # noqa: E402
from moon import craters, fetch, lola, rt  # noqa: E402
from moon.sampling import EquirectPyramid, catmull_rom_weights, footprint_m, srgb_encode  # noqa: E402
from moon.tiles import TileReader  # noqa: E402

GLOBAL_MAX_LEVEL = 7
DETAIL_LEVELS = (6, 7)
WEBP_QUALITY = 95

SVS_URL = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color.exr"
SVS_BYTES = 988_589_585
SVS_FILE = rt.MOON_DL / "svs_color" / "lroc_color.exr"
SVS_W, SVS_H = 27648, 13824
SVS_MIPS = 10
SVS_CREDIT = "NASA's Scientific Visualization Studio, CGI Moon Kit colour map (NASA/GSFC/Arizona State University LROC WAC)"

WAC_URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif"
WAC_BYTES = 5_959_263_751
WAC_W, WAC_H = 109164, 54582
WAC_CREDIT = "LROC WAC global morphology mosaic 100 m, June 2013 (NASA/GSFC/Arizona State University; USGS Astrogeology)"
DETAIL_LAT = 70.0
DETAIL_FADE = (65.0, 69.0)
D_LO, D_HI = 0.7, 1.3
DETAIL_WORKERS = 6  # each band holds ~1.5 GB of float32 work arrays

WORK = rt.MOON_WORK
CALIB = WORK / "albedo_calibration.json"
FIT = WORK / "deshade_fit.npz"
DETAIL = WORK / "wac_detail.u8"
CROPS = WORK / "crater_crops"

MARIA = [("Tranquillitatis", 8.5, 31.0), ("Serenitatis", 28.0, 17.5), ("Imbrium", 35.0, -15.0),
         ("Crisium", 17.0, 59.0), ("Procellarum", 10.0, -55.0), ("Fecunditatis", -6.0, 50.0)]
HIGHLANDS = [("far side 10N 160E", 10.0, 160.0), ("far side 20S 140E", -20.0, 140.0), ("far side 30N 170W", 30.0, -170.0),
             ("near side 30S 10E", -30.0, 10.0), ("central 12S 5E", -12.0, 5.0), ("far side 0N 120E", 0.0, 120.0)]


# -- geometry of the WAC grid -------------------------------------------------------------------------------
def wac_row_lat(r):
    return 90.0 - (np.asarray(r, dtype=np.float64) + 0.5) * 180.0 / WAC_H


def wac_lat_row(lat):
    return (90.0 - np.asarray(lat, dtype=np.float64)) / 180.0 * WAC_H - 0.5


DETAIL_R0 = int(math.floor(wac_lat_row(DETAIL_LAT)))
DETAIL_R1 = int(math.ceil(wac_lat_row(-DETAIL_LAT))) + 1
DETAIL_ROWS = DETAIL_R1 - DETAIL_R0


def wac_offsets() -> tuple[int, int]:
    import rasterio

    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open("/vsicurl/" + WAC_URL) as ds:
            if (ds.width, ds.height) != (WAC_W, WAC_H) or ds.compression is not None:
                raise ValueError("unexpected WAC layout")
            o = [int(ds.get_tag_item(f"BLOCK_OFFSET_0_{r}", "TIFF", bidx=1)) for r in (0, 1, WAC_H // 2, WAC_H - 1)]
    if o[1] - o[0] != WAC_W or o[2] - o[0] != WAC_W * (WAC_H // 2) or o[3] - o[0] != WAC_W * (WAC_H - 1):
        raise ValueError("WAC strips are not contiguous")
    return o[0], WAC_W


def read_wac_rows(off0: int, r0: int, r1: int) -> np.ndarray:
    r0c, r1c = max(0, r0), min(WAC_H, r1)
    buf = fetch.read_range(WAC_URL, off0 + r0c * WAC_W, (r1c - r0c) * WAC_W)
    a = np.frombuffer(buf, dtype=np.uint8).reshape(r1c - r0c, WAC_W)
    if r0c != r0 or r1c != r1:
        a = np.pad(a, ((r0c - r0, r1 - r1c), (0, 0)))
    return a


def read_lola_rows(offs: np.ndarray, r0: int, r1: int) -> np.ndarray:
    r0c, r1c = max(0, r0), min(lola.HEIGHT, r1)
    buf = fetch.read_range(lola.URL, int(offs[r0c]), (r1c - r0c) * lola.WIDTH * 2)
    a = np.frombuffer(buf, dtype="<i2").reshape(r1c - r0c, lola.WIDTH).astype(np.float32) * lola.SCALE_M
    if r0c != r0 or r1c != r1:
        a = np.pad(a, ((r0c - r0, r1 - r1c), (0, 0)), mode="edge")
    return a


def _cr_matrix(src_coord: np.ndarray, n_src: int, wrap: bool):
    """Indices (4, n) and Catmull-Rom weights (4, n) for sampling a 1-D axis at continuous coordinates."""
    i0 = np.floor(src_coord).astype(np.int64)
    w = catmull_rom_weights(src_coord - i0)
    idx = np.stack([i0 - 1, i0, i0 + 1, i0 + 2])
    idx = np.mod(idx, n_src) if wrap else np.clip(idx, 0, n_src - 1)
    return idx, np.stack(w)


_LON_CR = None


def lola_on_wac_rows(offs: np.ndarray, wr0: int, wr1: int) -> np.ndarray:
    """LOLA heights (m) resampled (Catmull-Rom) to WAC rows [wr0, wr1) and every WAC column."""
    global _LON_CR
    lat = wac_row_lat(np.arange(wr0, wr1))
    ly = (90.0 - lat) / 180.0 * lola.HEIGHT - 0.5
    lr0 = int(np.floor(ly.min())) - 2
    lr1 = int(np.floor(ly.max())) + 4
    L = read_lola_rows(offs, lr0, lr1)
    iy, wy = _cr_matrix(ly - lr0, lr1 - lr0, wrap=False)
    rows = sum(wy[k][:, None] * L[iy[k]] for k in range(4))
    if _LON_CR is None:
        lon = -180.0 + (np.arange(WAC_W) + 0.5) * 360.0 / WAC_W
        _LON_CR = _cr_matrix((lon + 180.0) / 360.0 * lola.WIDTH - 0.5, lola.WIDTH, wrap=True)
    ix, wx = _LON_CR
    return sum(wx[k][None, :].astype(np.float32) * rows[:, ix[k]] for k in range(4)).astype(np.float32)


def slopes(h: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """East and north height gradients (m/m) on the WAC grid (columns wrap)."""
    dx = 2.0 * math.pi * rt.MOON_RADIUS / WAC_W * np.cos(np.radians(lat))[:, None]
    dy = math.pi * rt.MOON_RADIUS / WAC_H
    hx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) / (2.0 * dx)
    hy = np.zeros_like(h)
    hy[1:-1] = (h[:-2] - h[2:]) / (2.0 * dy)
    return hx.astype(np.float32), hy.astype(np.float32)


def gauss_iso(a: np.ndarray, sigma_px: float, lat_mid: float) -> np.ndarray:
    """Gaussian isotropic on the ground: sigma rows = sigma, sigma columns = sigma / cos(lat); columns wrap."""
    s_lon = sigma_px / max(math.cos(math.radians(lat_mid)), 0.05)
    b = ndimage.gaussian_filter1d(a, sigma_px, axis=0, mode="nearest")
    return ndimage.gaussian_filter1d(b, s_lon, axis=1, mode="wrap")


def masked_gauss(a: np.ndarray, m: np.ndarray, sigma_px: float, lat_mid: float) -> np.ndarray:
    num = gauss_iso(np.where(m, a, 0.0).astype(np.float32), sigma_px, lat_mid)
    den = gauss_iso(m.astype(np.float32), sigma_px, lat_mid)
    return np.where(den > 1e-3, num / np.maximum(den, 1e-6), np.nan)


# -- photometry ----------------------------------------------------------------------------------------------
def lunar_lambert_L(phase_deg):
    """McEwen (1996) lunar-Lambert limb parameter L(phase) for the Moon (phase in degrees)."""
    g = np.asarray(phase_deg, dtype=np.float64)
    return np.clip(1.0 - 0.019 * g + 2.42e-4 * g * g - 1.46e-6 * g ** 3, 0.0, 1.0)


def lunar_lambert(ci, ce, L):
    ci = np.maximum(ci, 0.0)
    return 2.0 * L * ci / (ci + ce + 1e-9) + (1.0 - L) * ci


def sensitivity(i0_rad, L):
    """d ln R / d cos(i) at a flat surface viewed from nadir."""
    ci = np.cos(i0_rad)
    return (2.0 * L / (ci + 1.0) ** 2 + (1.0 - L)) / np.maximum(lunar_lambert(ci, 1.0, L), 1e-9)


def gradient_to_sun(a: np.ndarray, b: np.ndarray):
    """Sun incidence (rad) and azimuth (rad, from east toward north) from fitted d ln W / d (hx, hy)."""
    mag = np.hypot(a, b)
    az = np.arctan2(-b, -a)
    i0 = np.full(mag.shape, math.radians(60.0))
    grid = np.radians(np.linspace(1.0, 88.0, 870))
    for _ in range(3):
        L = lunar_lambert_L(np.degrees(i0))
        resp = np.array([sensitivity(gi, L) * np.sin(gi) for gi in grid])  # (870, ...) response per incidence
        i0 = grid[np.argmin(np.abs(resp - mag[None]), axis=0)]
    return i0, az


# -- step: SVS colour ------------------------------------------------------------------------------------------
def _svs_mip_path(k: int) -> Path:
    return WORK / f"svs_mip{k}.f16"


def svs_pyramid() -> EquirectPyramid:
    """Calibrated linear SVS colour, registered to the WAC mosaic by the measured longitude offset."""
    mips = [np.memmap(_svs_mip_path(k), dtype=np.float16, mode="r", shape=(SVS_H >> k, SVS_W >> k, 3))
            for k in range(SVS_MIPS)]
    reg = rt.read_json(CALIB).get("svsResolution") if CALIB.is_file() else None
    lon_off, lat_off = (reg["lonOffsetDeg"], reg["latOffsetDeg"]) if reg else (0.0, 0.0)
    return EquirectPyramid(mips, lon0=-180.0 + lon_off, lat0=90.0 + lat_off)


def _resample_axis(a: np.ndarray, n_out: int, axis: int, wrap: bool) -> np.ndarray:
    n_in = a.shape[axis]
    coord = (np.arange(n_out) + 0.5) * (n_in / n_out) - 0.5
    idx, w = _cr_matrix(coord, n_in, wrap)
    out = None
    for k in range(4):
        t = np.take(a, idx[k], axis=axis) * (w[k][:, None] if axis == 0 else w[k][None, :]).astype(np.float32)
        out = t if out is None else out + t
    return out


def region_median(img: np.ndarray, lat: float, lon: float, radius_deg: float = 2.0) -> float:
    h, w = img.shape
    r = np.arange(h)
    la = 90.0 - (r + 0.5) * 180.0 / h
    rows = np.nonzero(np.abs(la - lat) <= radius_deg)[0]
    c0 = int(((lon - radius_deg / math.cos(math.radians(lat)) + 180.0) / 360.0) * w)
    c1 = int(((lon + radius_deg / math.cos(math.radians(lat)) + 180.0) / 360.0) * w)
    cols = np.mod(np.arange(c0, c1 + 1), w)
    return float(np.median(img[rows][:, cols]))


def step_svs() -> None:
    if all(_svs_mip_path(k).is_file() for k in range(SVS_MIPS)) and CALIB.is_file():
        return
    import OpenEXR

    fetch.download(SVS_URL, SVS_FILE, connections=3, expect_bytes=SVS_BYTES)
    with OpenEXR.File(str(SVS_FILE), separate_channels=True) as f:
        ch = f.channels()
        src = {k: ch[k].pixels for k in "RGB"}
    if src["R"].shape != (13680, 27360):
        raise ValueError(f"unexpected SVS size {src['R'].shape}")
    rt.log("SVS colour loaded; resampling to 27648 x 13824")
    chans = []
    for k in "RGB":
        a = src.pop(k).astype(np.float32)
        a = _resample_axis(a, SVS_H, 0, wrap=False)
        a = _resample_axis(a, SVS_W, 1, wrap=True)
        chans.append(np.maximum(a, 0.0))
    red = chans[0]
    mare = {n: region_median(red, la, lo) for n, la, lo in MARIA}
    high = {n: region_median(red, la, lo) for n, la, lo in HIGHLANDS}
    gain = 0.07 / float(np.median(list(mare.values())))
    calib = {
        "source": SVS_URL, "gain": gain, "target": "median 643 nm (red) of reference maria = 0.07 normal albedo",
        "rawMariaMedians": mare, "rawHighlandMedians": high,
        "calibratedMariaMedians": {k: v * gain for k, v in mare.items()},
        "calibratedHighlandMedians": {k: v * gain for k, v in high.items()},
        "calibratedHighlandMedianOfMedians": float(np.median(list(high.values())) * gain),
        "rawMaxRed": float(red.max()),
    }
    rt.log(f"SVS calibration {calib}")
    rgb = np.stack([c * gain for c in chans], axis=-1)
    del chans, red
    level = rgb.astype(np.float16)
    level.tofile(_svs_mip_path(0))
    cur = rgb
    for k in range(1, SVS_MIPS):
        h2, w2 = cur.shape[0] // 2, cur.shape[1] // 2
        cur = cur.reshape(h2, 2, w2, 2, 3).mean(axis=(1, 3), dtype=np.float64).astype(np.float32)
        cur.astype(np.float16).tofile(_svs_mip_path(k))
    rt.write_json(CALIB, {"svs": calib})
    SVS_FILE.unlink()
    rt.log("SVS mips written, EXR deleted")


# -- step: fit the WAC illumination geometry ---------------------------------------------------------------
NB = int(2 * DETAIL_LAT)  # 1-degree bands from +70 to -70
NC = 360


def _fit_band(b: int):
    offs = lola.strip_offsets()
    off0, _ = wac_offsets_cached()
    lat_c = DETAIL_LAT - 0.5 - b
    rc = int(round(wac_lat_row(lat_c)))
    r0, r1 = rc - 70, rc + 70
    W = read_wac_rows(off0, r0, r1).astype(np.float32)
    h = lola_on_wac_rows(offs, r0, r1)
    lat = wac_row_lat(np.arange(r0, r1))
    hx, hy = slopes(h, lat)
    valid = W > 0
    lw = np.log(np.maximum(W, 1.0))
    sig = 12.0
    lw_hp = lw - masked_gauss(lw, valid, sig, lat_c)
    hx_hp = hx - gauss_iso(hx, sig, lat_c)
    hy_hp = hy - gauss_iso(hy, sig, lat_c)
    use = valid & np.isfinite(lw_hp) & (np.abs(lw_hp) < 0.7) & (np.hypot(hx, hy) < 0.3)
    use[:20] = use[-20:] = False
    out = np.zeros((NC, 5))
    cols_per = WAC_W / NC
    for c in range(NC):
        sl = slice(int(round(c * cols_per)), int(round((c + 1) * cols_per)))
        m = use[:, sl]
        n = int(m.sum())
        if n < 2000:
            continue
        x1, x2, y = hx_hp[:, sl][m].astype(np.float64), hy_hp[:, sl][m].astype(np.float64), lw_hp[:, sl][m].astype(np.float64)
        A = np.stack([x1, x2], 1)
        coef, *_ = np.linalg.lstsq(A, y, rcond=None)
        res = y - A @ coef
        r2 = 1.0 - float(res.var() / max(y.var(), 1e-12))
        out[c] = (coef[0], coef[1], n, float((x1 ** 2).mean() + (x2 ** 2).mean()), r2)
    return b, out


_WAC_OFF = None


def wac_offsets_cached():
    global _WAC_OFF
    if _WAC_OFF is None:
        p = WORK / "wac_offsets.npy"
        if p.is_file():
            _WAC_OFF = tuple(int(v) for v in np.load(p))
        else:
            _WAC_OFF = wac_offsets()
            np.save(p, np.array(_WAC_OFF))
    return _WAC_OFF


def step_fit() -> None:
    if FIT.is_file():
        return
    wac_offsets_cached()
    fits = np.zeros((NB, NC, 5))
    with rt.pool() as p:
        for i, (b, out) in enumerate(p.imap_unordered(_fit_band, range(NB))):
            fits[b] = out
            if (i + 1) % 20 == 0:
                rt.log(f"fit bands {i + 1}/{NB}")
    a, bb, n, sxx, r2 = (fits[..., k] for k in range(5))
    wgt = n * sxx * np.clip(r2, 0.0, 1.0)
    sm = lambda v: ndimage.gaussian_filter(v, 1.0, mode=("nearest", "wrap"))  # noqa: E731
    ws = sm(wgt)
    a_s = sm(a * wgt) / np.maximum(ws, 1e-12)
    b_s = sm(bb * wgt) / np.maximum(ws, 1e-12)
    i0, az = gradient_to_sun(a_s, b_s)
    sun = np.stack([np.sin(i0) * np.cos(az), np.sin(i0) * np.sin(az), np.cos(i0)], axis=-1)
    np.savez(FIT, raw=fits, a=a_s, b=b_s, i0=i0, az=az, sun=sun)
    good = wgt > np.percentile(wgt[wgt > 0], 25)
    stats = {"cells": int(good.sum()), "incidenceDegMedian": float(np.degrees(np.median(i0))),
             "incidenceDegP10P90": [float(np.degrees(np.percentile(i0, 10))), float(np.degrees(np.percentile(i0, 90)))],
             "sunFromEastFraction": float(np.mean(np.cos(az) > 0)), "r2Median": float(np.median(r2[good]))}
    c = rt.read_json(CALIB)
    c["deshadeFit"] = stats
    rt.write_json(CALIB, c)
    rt.log(f"de-shading fit {stats}")


# -- step: detail ------------------------------------------------------------------------------------------
def sun_field(lat: np.ndarray, lon: np.ndarray, sun: np.ndarray) -> np.ndarray:
    """Bilinear interpolation of the per-cell sun vectors (cell centres at lat 69.5..-69.5, lon -179.5..179.5)."""
    fy = np.clip(DETAIL_LAT - 0.5 - lat, 0.0, NB - 1.0)
    fx = (lon + 180.0 - 0.5)
    y0 = np.minimum(np.floor(fy).astype(np.int64), NB - 2)
    x0 = np.floor(fx).astype(np.int64)
    ty, tx = (fy - y0)[..., None], (fx - x0)[..., None]
    x0m, x1m = np.mod(x0, NC), np.mod(x0 + 1, NC)
    s = ((1 - ty) * ((1 - tx) * sun[y0, x0m] + tx * sun[y0, x1m]) + ty * ((1 - tx) * sun[y0 + 1, x0m] + tx * sun[y0 + 1, x1m]))
    return s / np.linalg.norm(s, axis=-1, keepdims=True)


def detail_band(r0: int, r1: int, sun: np.ndarray, sigma_svs: float, margin: int = 48):
    """Raw WAC, de-shaded detail D and undeshaded detail for WAC rows [r0, r1)."""
    offs = lola.strip_offsets()
    off0, _ = wac_offsets_cached()
    a0, a1 = r0 - margin, r1 + margin
    W = read_wac_rows(off0, a0, a1).astype(np.float32)
    h = lola_on_wac_rows(offs, a0, a1)
    lat = wac_row_lat(np.arange(a0, a1))
    lat_mid = float(lat[len(lat) // 2])
    hx, hy = slopes(h, lat)
    del h
    lon = -180.0 + (np.arange(WAC_W) + 0.5) * 360.0 / WAC_W
    valid = W > 0
    s = np.empty((a1 - a0, WAC_W, 3), dtype=np.float32)
    for k in range(0, a1 - a0, 64):
        LA, LO = np.meshgrid(lat[k:k + 64], lon, indexing="ij")
        s[k:k + 64] = sun_field(LA, LO, sun)
    nrm = np.sqrt(1.0 + hx * hx + hy * hy)
    ci = (-hx * s[..., 0] - hy * s[..., 1] + s[..., 2]) / nrm
    ce = 1.0 / nrm
    i0 = np.degrees(np.arccos(np.clip(s[..., 2], -1, 1)))
    Lp = lunar_lambert_L(i0).astype(np.float32)
    S = lunar_lambert(ci, ce, Lp) / np.maximum(lunar_lambert(s[..., 2], 1.0, Lp), 1e-6)
    del s, ci, ce, Lp, hx, hy, nrm
    mean1k = masked_gauss(W, valid, 10.0, lat_mid)
    shadow = (S < 0.25) | (W < 0.35 * mean1k)
    ok = valid & ~shadow
    Wd = np.where(ok, W / np.maximum(S, 0.25), 0.0).astype(np.float32)
    lp = masked_gauss(Wd, ok, sigma_svs, lat_mid)
    D = np.where(ok & np.isfinite(lp), Wd / np.maximum(lp, 1e-3), 1.0)
    D = np.clip(D, D_LO, D_HI)
    soft = gauss_iso(ok.astype(np.float32), 1.0, lat_mid)
    D = 1.0 + soft * (D - 1.0)
    lpr = masked_gauss(W, valid, sigma_svs, lat_mid)
    Draw = np.clip(np.where(valid & np.isfinite(lpr), W / np.maximum(lpr, 1e-3), 1.0), D_LO, D_HI)
    m = slice(margin, margin + (r1 - r0))
    return W[m], D[m].astype(np.float32), Draw[m].astype(np.float32), S[m].astype(np.float32)


def encode_detail(D: np.ndarray) -> np.ndarray:
    return (np.round((np.clip(D, D_LO, D_HI) - D_LO) / (D_HI - D_LO) * 254.0) + 1).astype(np.uint8)


def decode_detail(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q, dtype=np.float64)
    return np.where(q > 0, D_LO + (q - 1.0) * (D_HI - D_LO) / 254.0, 1.0)


def crater_windows() -> list[dict]:
    reader = TileReader(rt.TILESET)
    out = []
    for name, la, lo, dk in craters.CRATERS:
        c = craters.refine(reader, name, la, lo, dk)
        half = 1.25 * c["rimRadiusM"] / (math.pi * rt.MOON_RADIUS / 180.0)
        r0 = int(math.floor(wac_lat_row(c["latDeg"] + half)))
        r1 = int(math.ceil(wac_lat_row(c["latDeg"] - half))) + 1
        hw = half / math.cos(math.radians(c["latDeg"]))
        c0 = int(math.floor((c["lonDeg"] - hw + 180.0) / 360.0 * WAC_W))
        c1 = int(math.ceil((c["lonDeg"] + hw + 180.0) / 360.0 * WAC_W)) + 1
        c.update({"r0": r0, "r1": r1, "c0": c0, "c1": c1})
        out.append(c)
    return out


_DETAIL_CTX: dict = {}


def _detail_task(task):
    b0, b1 = task
    if "sun" not in _DETAIL_CTX:
        z = np.load(FIT)
        _DETAIL_CTX["sun"] = z["sun"]
        _DETAIL_CTX["sigma"] = rt.read_json(CALIB)["svsResolution"]["sigmaWacPx"]
        _DETAIL_CTX["windows"] = rt.read_json(WORK / "crater_windows.json")
        _DETAIL_CTX["mm"] = np.memmap(DETAIL, dtype=np.uint8, mode="r+", shape=(DETAIL_ROWS, WAC_W))
    W, D, Draw, S = detail_band(b0, b1, _DETAIL_CTX["sun"], _DETAIL_CTX["sigma"])
    _DETAIL_CTX["mm"][b0 - DETAIL_R0:b1 - DETAIL_R0] = encode_detail(D)
    _DETAIL_CTX["mm"].flush()
    for c in _DETAIL_CTX["windows"]:
        lo, hi = max(b0, c["r0"]), min(b1, c["r1"])
        if lo >= hi:
            continue
        cols = np.mod(np.arange(c["c0"], c["c1"]), WAC_W)
        shape = (c["r1"] - c["r0"], c["c1"] - c["c0"])
        for key, arr in (("W", W), ("D", D), ("Draw", Draw), ("S", S)):
            mm = np.memmap(CROPS / f"{c['name']}.{key}.f32", dtype=np.float32, mode="r+", shape=shape)
            mm[lo - c["r0"]:hi - c["r0"]] = arr[lo - b0:hi - b0][:, cols]
            mm.flush()
            del mm
    return task


def step_detail() -> None:
    if DETAIL.is_file() and (WORK / "detail.done").is_file():
        return
    wins = crater_windows()
    rt.write_json(WORK / "crater_windows.json", wins)
    CROPS.mkdir(parents=True, exist_ok=True)
    for c in wins:
        for key in ("W", "D", "Draw", "S"):
            np.memmap(CROPS / f"{c['name']}.{key}.f32", dtype=np.float32, mode="w+",
                      shape=(c["r1"] - c["r0"], c["c1"] - c["c0"])).flush()
    np.memmap(DETAIL, dtype=np.uint8, mode="w+", shape=(DETAIL_ROWS, WAC_W)).flush()
    edges = np.linspace(DETAIL_R0, DETAIL_R1, 2 * NB + 1).round().astype(int)
    tasks = list(zip(edges[:-1], edges[1:]))
    with rt.pool(DETAIL_WORKERS) as p:
        for i, _ in enumerate(p.imap_unordered(_detail_task, tasks)):
            if (i + 1) % 10 == 0:
                rt.log(f"detail bands {i + 1}/{len(tasks)}")
    (WORK / "detail.done").write_text("ok", encoding="utf-8")


def step_svs_resolution() -> None:
    """Gaussian sigma (WAC pixels) that best matches the SVS red channel: maximise the correlation of the
    SVS red (bicubic onto the WAC grid) with the Gaussian-filtered WAC over maria windows (albedo-dominated)."""
    c = rt.read_json(CALIB)
    if "svsResolution" in c:
        return
    off0, _ = wac_offsets_cached()
    pyr = svs_pyramid()
    res = {}
    for name, la, lo in MARIA[:4]:
        rc = int(round(wac_lat_row(la)))
        W = read_wac_rows(off0, rc - 300, rc + 300).astype(np.float32)
        c0 = int((lo + 180.0) / 360.0 * WAC_W) - 300
        cols = np.mod(np.arange(c0, c0 + 600), WAC_W)
        W = W[:, cols]
        LA, LO = np.meshgrid(wac_row_lat(np.arange(rc - 300, rc + 300)), -180.0 + (cols + 0.5) * 360.0 / WAC_W, indexing="ij")
        svs = pyr.sample(LA, LO, np.zeros_like(LA))[..., 0]
        # registration of SVS against WAC: correlation for integer shifts of the filtered WAC, parabola peak
        g = ndimage.gaussian_filter(W, 4.0)
        cor = np.array([[float(np.corrcoef(np.roll(np.roll(g, dy, 0), dx, 1)[30:-30, 30:-30].ravel(),
                                           svs[30:-30, 30:-30].ravel())[0, 1]) for dx in range(-5, 6)] for dy in range(-5, 6)])
        iy, ix = np.unravel_index(np.argmax(cor), cor.shape)

        def peak(v, i):
            if 0 < i < len(v) - 1:
                den = v[i - 1] - 2 * v[i] + v[i + 1]
                return i + 0.5 * (v[i - 1] - v[i + 1]) / den if den < 0 else float(i)
            return float(i)

        sy, sx = peak(cor[:, ix], iy) - 5, peak(cor[iy, :], ix) - 5
        res.setdefault("registration", []).append({"window": name, "bestCorr": float(cor.max()),
                                                   "shiftRowsColsWacPx": [float(sy), float(sx)]})
        # effective resolution: compare with the registered, Gaussian-filtered WAC
        Ws = ndimage.shift(W, (sy, sx), order=1, mode="nearest")
        for sig in (2.0, 3.0, 4.0, 5.0, 6.0, 7.0):
            gg = ndimage.gaussian_filter(Ws, sig)
            cc = float(np.corrcoef(gg[30:-30, 30:-30].ravel(), svs[30:-30, 30:-30].ravel())[0, 1])
            res.setdefault(str(sig), []).append(cc)
    means = {k: float(np.mean(v)) for k, v in res.items() if k != "registration"}
    sigma = float(max(means, key=means.get))
    # np.roll(g, dx) with dx = sx < 0 matched: svs[c] ~ wac[c - sx], i.e. SVS content sits sx WAC columns west
    sx_med = float(np.median([r["shiftRowsColsWacPx"][1] for r in res["registration"]]))
    sy_med = float(np.median([r["shiftRowsColsWacPx"][0] for r in res["registration"]]))
    c["svsResolution"] = {"sigmaWacPx": sigma, "meanCorrelationBySigma": means, "registration": res["registration"],
                          "lonOffsetDeg": -sx_med * 360.0 / WAC_W, "latOffsetDeg": sy_med * 180.0 / WAC_H}
    rt.write_json(CALIB, c)
    rt.log(f"SVS effective resolution and registration: {c['svsResolution']}")


# -- step: de-shade the SVS base colour ---------------------------------------------------------------------
# The SVS map comes from the Hapke-normalised WAC mosaic. Hapke normalisation corrects the photometric angles
# of the reference sphere only, so the inner walls of craters keep part of the shading of the source images
# (measured east/west wall ratios 0.7-1.2 on 26 craters before this step). The residual is removed with the
# same regression as the WAC de-shading, on the SVS grid: in 1-deg cells the high-passed log red is regressed
# on the high-passed LOLA slopes (filtered to the SVS resolution); the smoothed gradient field (a, b) gives
# the shading factor exp(a hx + b hy) that is divided out of all three channels (clamped to 0.5..2, faded out
# between 66 and 70 deg latitude where the SVS map is inpainted).
SVS_SLOPES = WORK / "svs_slopes.f16"
SVS_FIT = WORK / "svs_deshade_fit.npz"
SVS_LAT = 70.0
SVS_FADE = (66.0, 70.0)


def _svs_geom():
    reg = rt.read_json(CALIB)["svsResolution"]
    px = 180.0 / SVS_H
    lat0, lon0 = 90.0 + reg["latOffsetDeg"], -180.0 + reg["lonOffsetDeg"]
    r0 = int(math.floor((lat0 - SVS_LAT) / px))
    r1 = int(math.ceil((lat0 + SVS_LAT) / px))
    return px, lat0, lon0, r0, r1


def _svs_band(task):
    """Slopes on SVS rows [b0, b1) (LOLA streamed, filtered to the SVS footprint) and regression sums per cell."""
    b0, b1 = task
    px, lat0, lon0, r0, r1 = _svs_geom()
    sig_px = rt.read_json(CALIB)["svsResolution"]["sigmaWacPx"] * 100.0 / 395.0  # SVS effective blur in SVS px
    m = 24
    a0, a1 = b0 - m, b1 + m
    lat = lat0 - (np.arange(a0, a1) + 0.5) * px
    offs = lola.strip_offsets()
    ly = (90.0 - lat) / 180.0 * lola.HEIGHT - 0.5
    lr0, lr1 = int(np.floor(ly.min())) - 8, int(np.floor(ly.max())) + 10
    L = read_lola_rows(offs, lr0, lr1)
    k = 395.0 / 118.45
    L = ndimage.gaussian_filter1d(ndimage.gaussian_filter1d(L, 0.5 * k, axis=0, mode="nearest"), 0.5 * k, axis=1, mode="wrap")
    iy, wy = _cr_matrix(ly - lr0, lr1 - lr0, wrap=False)
    rows = sum(wy[j][:, None] * L[iy[j]] for j in range(4))
    lon = lon0 + (np.arange(SVS_W) + 0.5) * px
    ix, wx = _cr_matrix(np.mod(lon + 180.0, 360.0) / 360.0 * lola.WIDTH - 0.5, lola.WIDTH, wrap=True)
    h = sum(wx[j][None, :] * rows[:, ix[j]] for j in range(4)).astype(np.float32)
    dx = 2.0 * math.pi * rt.MOON_RADIUS / SVS_W * np.cos(np.radians(lat))[:, None]
    dy = math.pi * rt.MOON_RADIUS / SVS_H
    hx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) / (2.0 * dx)
    hy = np.zeros_like(h)
    hy[1:-1] = (h[:-2] - h[2:]) / (2.0 * dy)
    lat_mid = float(lat[len(lat) // 2])
    hx, hy = gauss_iso(hx, sig_px, lat_mid), gauss_iso(hy, sig_px, lat_mid)
    svs = np.memmap(_svs_mip_path(0), dtype=np.float16, mode="r", shape=(SVS_H, SVS_W, 3))
    red = np.asarray(svs[max(a0, 0):a1, :, 0], dtype=np.float32)
    if a0 < 0:
        red = np.pad(red, ((-a0, 0), (0, 0)), mode="edge")
    valid = red > 1e-4
    lr = np.log(np.maximum(red, 1e-4))
    s = 5.0
    y = lr - masked_gauss(lr, valid, s, lat_mid)
    x1 = hx - gauss_iso(hx, s, lat_mid)
    x2 = hy - gauss_iso(hy, s, lat_mid)
    use = valid & np.isfinite(y) & (np.abs(y) < 0.7) & (np.hypot(hx, hy) < 0.5)
    use[:m] = use[-m:] = False
    cell_lat = np.floor(SVS_LAT - lat).astype(int)  # 0 at the +70..+69 deg row of cells
    cell_lon = np.floor(np.mod(lon + 180.0, 360.0)).astype(int)
    sums = np.zeros((NB, NC, 6))
    for rr in range(len(lat)):
        cl = cell_lat[rr]
        if not (0 <= cl < NB):
            continue
        u = use[rr]
        if not u.any():
            continue
        c = cell_lon[u]
        a, b, yy = x1[rr, u].astype(np.float64), x2[rr, u].astype(np.float64), y[rr, u].astype(np.float64)
        for q, v in enumerate((a * a, a * b, b * b, a * yy, b * yy, np.ones_like(a))):
            sums[cl, :, q] += np.bincount(c, weights=v, minlength=NC)
    out = np.memmap(SVS_SLOPES, dtype=np.float16, mode="r+", shape=(r1 - r0, SVS_W, 2))
    out[b0 - r0:b1 - r0, :, 0] = hx[m:m + (b1 - b0)]
    out[b0 - r0:b1 - r0, :, 1] = hy[m:m + (b1 - b0)]
    out.flush()
    return sums


def step_svs_deshade() -> None:
    c = rt.read_json(CALIB)
    if "svsDeshade" in c:
        return
    px, lat0, lon0, r0, r1 = _svs_geom()
    np.memmap(SVS_SLOPES, dtype=np.float16, mode="w+", shape=(r1 - r0, SVS_W, 2)).flush()
    edges = np.linspace(r0, r1, 85).round().astype(int)
    sums = np.zeros((NB, NC, 6))
    with rt.pool(DETAIL_WORKERS) as p:
        for i, s in enumerate(p.imap_unordered(_svs_band, list(zip(edges[:-1], edges[1:])))):
            sums += s
            if (i + 1) % 20 == 0:
                rt.log(f"SVS slope bands {i + 1}/{len(edges) - 1}")
    sxx, sxy, syy, sxv, syv, n = (sums[..., q] for q in range(6))
    det = sxx * syy - sxy * sxy
    ok = (n > 500) & (det > 1e-12)
    a = np.where(ok, (syy * sxv - sxy * syv) / np.where(ok, det, 1.0), 0.0)
    b = np.where(ok, (sxx * syv - sxy * sxv) / np.where(ok, det, 1.0), 0.0)
    wgt = np.where(ok, n * (sxx + syy) / np.maximum(n, 1), 0.0)
    sm = lambda v: ndimage.gaussian_filter(v, 1.0, mode=("nearest", "wrap"))  # noqa: E731
    ws = sm(wgt)
    a_s, b_s = sm(a * wgt) / np.maximum(ws, 1e-12), sm(b * wgt) / np.maximum(ws, 1e-12)
    np.savez(SVS_FIT, a=a_s, b=b_s, a_raw=a, b_raw=b, n=n)
    # apply in place on mip 0 (all channels), then rebuild the mips
    svs = np.memmap(_svs_mip_path(0), dtype=np.float16, mode="r+", shape=(SVS_H, SVS_W, 3))
    sl = np.memmap(SVS_SLOPES, dtype=np.float16, mode="r", shape=(r1 - r0, SVS_W, 2))
    lon = lon0 + (np.arange(SVS_W) + 0.5) * px
    fx = np.mod(lon + 180.0, 360.0) - 0.5
    x0 = np.floor(fx).astype(np.int64)
    tx = fx - x0
    fmin, fmax = 1.0, 1.0
    for q0 in range(r0, r1, 256):
        q1 = min(r1, q0 + 256)
        lat = lat0 - (np.arange(q0, q1) + 0.5) * px
        fy = np.clip(SVS_LAT - 0.5 - lat, 0.0, NB - 1.0)
        y0 = np.minimum(np.floor(fy).astype(np.int64), NB - 2)
        ty = (fy - y0)[:, None]

        def field(g):
            g0 = (1 - tx) * g[y0][:, np.mod(x0, NC)] + tx * g[y0][:, np.mod(x0 + 1, NC)]
            g1 = (1 - tx) * g[y0 + 1][:, np.mod(x0, NC)] + tx * g[y0 + 1][:, np.mod(x0 + 1, NC)]
            return (1 - ty) * g0 + ty * g1

        A, B = field(a_s), field(b_s)
        s_ = np.asarray(sl[q0 - r0:q1 - r0], dtype=np.float32)
        f = np.clip(np.exp(A * s_[..., 0] + B * s_[..., 1]), 0.5, 2.0)
        w = np.clip((SVS_FADE[1] - np.abs(lat)) / (SVS_FADE[1] - SVS_FADE[0]), 0.0, 1.0)[:, None]
        f = 1.0 + w * (f - 1.0)
        fmin, fmax = min(fmin, float(f.min())), max(fmax, float(f.max()))
        blk = np.asarray(svs[q0:q1], dtype=np.float32) / f[..., None]
        svs[q0:q1] = blk.astype(np.float16)
    svs.flush()
    del svs, sl
    cur = np.fromfile(_svs_mip_path(0), dtype=np.float16).reshape(SVS_H, SVS_W, 3).astype(np.float32)
    red = cur[..., 0]
    gain_after = {"maria": {n: region_median(red, la, lo) for n, la, lo in MARIA},
                  "highlands": {n: region_median(red, la, lo) for n, la, lo in HIGHLANDS}}
    for k in range(1, SVS_MIPS):
        h2, w2 = cur.shape[0] // 2, cur.shape[1] // 2
        cur = cur.reshape(h2, 2, w2, 2, 3).mean(axis=(1, 3), dtype=np.float64).astype(np.float32)
        cur.astype(np.float16).tofile(_svs_mip_path(k))
    good = n > 500
    i0, az = gradient_to_sun(a_s, b_s)
    c = rt.read_json(CALIB)
    c["svsDeshade"] = {"cells": int(good.sum()), "factorMin": fmin, "factorMax": fmax,
                       "gradientMagnitudeMedian": float(np.median(np.hypot(a_s, b_s)[good])),
                       "equivalentLunarLambertIncidenceDegMedian": float(np.degrees(np.median(i0[good]))),
                       "sunFromEastFraction": float(np.mean(np.cos(az[good]) > 0)),
                       "medians643nmAfter": gain_after}
    rt.write_json(CALIB, c)
    SVS_SLOPES.unlink()
    rt.log(f"SVS de-shaded: {c['svsDeshade']}")


# -- step: tiles -----------------------------------------------------------------------------------------------
_TILE_CTX: dict = {}


def detail_sample(lat: np.ndarray, lon: np.ndarray, fp_m: np.ndarray) -> np.ndarray:
    """Box-filtered de-shaded detail over the footprint (bilinear taps on the WAC grid), 1 outside the band."""
    if "D" not in _TILE_CTX:
        _TILE_CTX["D"] = np.memmap(DETAIL, dtype=np.uint8, mode="r", shape=(DETAIL_ROWS, WAC_W))
    mm = _TILE_CTX["D"]
    px = math.pi * rt.MOON_RADIUS / WAC_H
    cosl = np.maximum(np.cos(np.radians(lat)), 1e-3)
    ny = np.clip(np.ceil(fp_m / px), 1, 6).astype(np.int64)
    nx = np.clip(np.ceil(fp_m / (px * cosl)), 1, 8).astype(np.int64)
    y = wac_lat_row(lat) - DETAIL_R0
    x = (lon + 180.0) / 360.0 * WAC_W - 0.5
    acc = np.zeros(lat.shape)
    for j in range(int(ny.max())):
        for i in range(int(nx.max())):
            use = (j < ny) & (i < nx)
            yy = y + ((j + 0.5) / ny - 0.5) * (fp_m / px)
            xx = x + ((i + 0.5) / nx - 0.5) * (fp_m / (px * cosl))
            y0 = np.floor(yy).astype(np.int64)
            x0 = np.floor(xx).astype(np.int64)
            ty, tx = yy - y0, xx - x0
            inside = (y0 >= 0) & (y0 + 1 < DETAIL_ROWS)
            y0c = np.clip(y0, 0, DETAIL_ROWS - 2)
            x0m, x1m = np.mod(x0, WAC_W), np.mod(x0 + 1, WAC_W)
            v = ((1 - ty) * ((1 - tx) * decode_detail(mm[y0c, x0m]) + tx * decode_detail(mm[y0c, x1m]))
                 + ty * ((1 - tx) * decode_detail(mm[y0c + 1, x0m]) + tx * decode_detail(mm[y0c + 1, x1m])))
            acc += np.where(use, np.where(inside, v, 1.0), 0.0)
    return acc / (ny * nx)


def albedo_linear(dirs: np.ndarray, level: int) -> np.ndarray:
    """Calibrated linear albedo RGB at texel directions for a level (SVS x de-shaded detail at levels 6-7)."""
    if "svs" not in _TILE_CTX:
        _TILE_CTX["svs"] = svs_pyramid()
    lat, lon = (np.degrees(a) for a in cube.dir_to_lat_lon(dirs))
    fp = footprint_m(dirs, level, rt.MOON_RADIUS, cube.IMAGE_TILE_SIZE)
    rgb = _TILE_CTX["svs"].sample(lat, lon, np.degrees(fp / rt.MOON_RADIUS))
    if level in DETAIL_LEVELS:
        a = np.abs(lat)
        w = np.clip((DETAIL_FADE[1] - a) / (DETAIL_FADE[1] - DETAIL_FADE[0]), 0.0, 1.0)
        w = w * w * (3 - 2 * w)
        if np.any(w > 0):
            D = np.ones(lat.shape)
            sel = w > 0
            D[sel] = detail_sample(lat[sel], lon[sel], fp[sel])
            w = w * steep_attenuation(dirs, fp)
            rgb = rgb * (1.0 + w * (D - 1.0))[..., None]
    return np.clip(rgb, 0.0, 1.0)


STEEP_DEG = (10.0, 20.0)


def steep_attenuation(dirs: np.ndarray, fp: np.ndarray) -> np.ndarray:
    """1 on slopes below 10 deg, 0 above 20 deg (smoothstep), from the level-6 heights.

    `dirs` is a texel-centre grid (rows along v, columns along u) of one tile; heights are evaluated on that
    grid extended by one texel on every side, and the slope is the central difference over two texels
    (166 m at level 7, 333 m at level 6). The 118 m LOLA cannot model the mosaic's shading on steep crater
    walls (nor cast shadows there), so the de-shaded detail is attenuated where slopes are steep
    (moon-sky-data.md 3.6)."""
    if "dem" not in _TILE_CTX:
        _TILE_CTX["dem"] = TileReader(rt.TILESET, cache_tiles=256)
    dem = _TILE_CTX["dem"]
    # extend the grid by one texel by linear extrapolation in direction space (renormalised)
    ext = np.empty((dirs.shape[0] + 2, dirs.shape[1] + 2, 3))
    ext[1:-1, 1:-1] = dirs
    ext[0, 1:-1] = 2 * dirs[0] - dirs[1]
    ext[-1, 1:-1] = 2 * dirs[-1] - dirs[-2]
    ext[:, 0] = 2 * ext[:, 1] - ext[:, 2]
    ext[:, -1] = 2 * ext[:, -2] - ext[:, -3]
    ext /= np.linalg.norm(ext, axis=-1, keepdims=True)
    h = dem.bicubic(ext, 6)
    du = rt.MOON_RADIUS * np.linalg.norm(ext[1:-1, 2:] - ext[1:-1, :-2], axis=-1)
    dv = rt.MOON_RADIUS * np.linalg.norm(ext[2:, 1:-1] - ext[:-2, 1:-1], axis=-1)
    gu = (h[1:-1, 2:] - h[1:-1, :-2]) / du
    gv = (h[2:, 1:-1] - h[:-2, 1:-1]) / dv
    s = np.degrees(np.arctan(np.hypot(gu, gv)))
    t = np.clip((STEEP_DEG[1] - s) / (STEEP_DEG[1] - STEEP_DEG[0]), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def encode_webp(lin: np.ndarray) -> bytes:
    u8 = (srgb_encode(lin) * 255.0 + 0.5).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(u8, "RGB").save(buf, "WEBP", quality=WEBP_QUALITY, method=4)
    return buf.getvalue()


def bake_albedo_tile(key):
    face, level, x, y = key
    d = cube.image_tile_dirs(face, level, x, y)
    data = encode_webp(albedo_linear(d, level))
    layout.write_atomic(layout.tile_file(rt.TILESET, "albedo", face, level, x, y, "webp"), data)
    return key, len(data)


def albedo_layer() -> dict:
    return {"encoding": "webp", "ext": "webp", "globalMaxLevel": GLOBAL_MAX_LEVEL, "coverage": {},
            "sources": [SVS_CREDIT, WAC_CREDIT + " (de-shaded detail, levels 6-7)", lola.CREDIT + " (de-shading)"]}


def step_tiles() -> None:
    keys = [(f, L, x, y) for L in range(GLOBAL_MAX_LEVEL + 1) for f in range(6) for y in range(2 ** L) for x in range(2 ** L)]
    t0 = time.time()
    total = 0
    with rt.pool() as p:
        for i, (key, n) in enumerate(p.imap_unordered(bake_albedo_tile, keys, chunksize=16)):
            total += n
            if (i + 1) % 5000 == 0 or i + 1 == len(keys):
                rt.log(f"albedo tiles {i + 1}/{len(keys)}  {total / 1e9:.2f} GB")
    layout.merge_layer(rt.TILESET, rt.MOON_RADIUS, "albedo", albedo_layer(),
                       attribution=["NASA's Scientific Visualization Studio (CGI Moon Kit)", "LROC: NASA/GSFC/Arizona State University"])
    c = rt.read_json(CALIB)
    c["tiles"] = {"count": len(keys), "bytes": total, "seconds": time.time() - t0, "webpQuality": WEBP_QUALITY}
    rt.write_json(CALIB, c)


def step_lowres() -> None:
    w, h = 1024, 512
    lat = 90.0 - (np.arange(h) + 0.5) * 180.0 / h
    lon = -180.0 + (np.arange(w) + 0.5) * 360.0 / w
    LA, LO = np.meshgrid(lat, lon, indexing="ij")
    pyr = svs_pyramid()
    rgb = np.clip(pyr.sample(LA, LO, np.full(LA.shape, 180.0 / h)), 0.0, 1.0)
    u8 = (srgb_encode(rgb) * 255.0 + 0.5).astype(np.uint8)
    path = rt.TILES_ROOT / rt.TILESET / "globals" / "albedo-lowres.png"
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    Image.fromarray(u8, "RGB").save(buf, "PNG", optimize=True)
    layout.write_atomic(path, buf.getvalue())
    m = layout.read_manifest(rt.TILESET)
    layout.merge_layer(rt.TILESET, rt.MOON_RADIUS, "albedo", m["layers"]["albedo"],
                       globals_={"albedoLowRes": {"path": "globals/albedo-lowres.png", "width": w, "height": h,
                                                  "channels": ["r", "g", "b"], "format": "png"}})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", default="svs,resolution,fit,detail,svsdeshade,tiles,lowres")
    a = ap.parse_args()
    rt.check_python()
    rt.below_normal_priority()
    WORK.mkdir(parents=True, exist_ok=True)
    steps = {"svs": step_svs, "resolution": step_svs_resolution, "fit": step_fit, "detail": step_detail,
             "svsdeshade": step_svs_deshade,
             "tiles": step_tiles, "lowres": step_lowres}
    for s in a.steps.split(","):
        t0 = time.time()
        steps[s]()
        rt.log(f"step {s} done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
