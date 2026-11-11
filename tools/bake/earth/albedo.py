"""`albedo` layer: opaque sRGB WebP, 256 x 256, cell-registered, LOSSLESS (tiles.LOSSLESS_LAYERS: lossy tiles
compressed one by one differ more across their shared border than between interior texels, which the seam
acceptance test measures; lossless costs about 6x the bytes of q90, ~2 GB for the global levels).

Global levels 0-7: NASA Blue Marble Next Generation, August 2004 base map (no relief shading added by the
producer), topographically de-shaded. Level 7 samples the per-face crop (clamped Catmull-Rom, longitude-
prefiltered near the poles); levels 6..0 are 2 x 2 means in linear light. Regional levels: Sentinel-2
cloudless (regalbedo.py).

De-shading. The MODIS Terra surface reflectance behind Blue Marble still carries the shading of its morning
overpass sun: to first order a slope of unit normal n (east, north, up) is brighter than flat ground by
    1 + alpha n_east + beta n_north
A Lambertian surface lit by the sun alone has (alpha, beta) = c = (s_east, s_north) / s_up (s = unit vector to
the sun); diffuse light scales that down. (alpha, beta) are fitted per 5 deg latitude band AND per class of
local brightness (the source's mean luminance over ~3 km, local_brightness: light reflected by bright
surrounding terrain fills the shade, so bright deserts show about half the shading contrast of dark scrub),
on level-7 texels of sparsely vegetated or bare ground (raw imagery greenness < 0: vegetation that follows
aspect would masquerade as shading), with the SAME normals the correction divides by (the stored level-7
height tile, tile_normals), by least squares of
    log(Y / local mean of Y)   on   n_h - local mean of n_h      (Gaussian, FIT_SIGMA_TEXELS)
(centring the predictor with the same weights removes the attenuation a plain local ratio has); interpolated
across bands (then classes) with too few samples, then clipped into the physically possible box between 0
and the Lambertian sun vectors c of 10:00-12:00 local solar time at the band (sun_box); linear between band and
class centres. The correction is
    Y_albedo = Y / clamp(1 + alpha(lat, Y_local) n_east + beta(lat, Y_local) n_north, 0.6, 1.6)
tapered off between 60 and 70 deg latitude (ice sheets, August polar night). A strength-only fit along the
10:30 sun vector left 5-7 % residuals on the bright northern ranges, whose shading is more north-south than
the 10:30 sun (the composite mixes view geometries). The fit runs as a first pass over every face before any
tile is written (the per-face crops are built twice).
"""
from __future__ import annotations

import io
import math

import numpy as np

from common import cube
from earth import deshade, equirect, manifest, paths, sample, tiles
from earth.util import log, read_json, run_units, units_done, write_json

MONTH = 8
BANDS = 36                      # 5 deg latitude bands for the de-shading fit
FIT_VERSION = 3
FIT_FILE = paths.WORK / f"deshade-bmng-{MONTH:02d}-v{FIT_VERSION}.json"
FIT_DIR = paths.WORK / f"deshade-acc-v{FIT_VERSION}"
BRIGHTNESS_EDGES = np.array([0.0, 0.05, 0.08, 0.12, 0.18, 0.26, 1.0])   # local mean linear luminance classes
NCLASS = BRIGHTNESS_EDGES.size - 1
YLOC_STEP = 4                   # local brightness: source sampled every 4 texels ...
YLOC_PAD = 32                   # ... over the tile padded by 32 texels (3.2 sigma)
OVERPASS_SOLAR_HOUR = 10.5      # MODIS Terra descending node
DECLINATION_DEG = 13.6          # mid-August
FIT_SIGMA_TEXELS = 10.0         # local neighbourhood of the fit, ~3 km at level 7
FIT_MIN_SLOPE_DEG = 2.0
FIT_MAX_PREDICTOR = 0.6         # |c . n_h| beyond this is far from the linear regime
FIT_MIN_SAMPLES = 20000         # per band and brightness class
FIT_MODEL = "alpha-beta per band and brightness class, clipped to the 10-12 h sun box"
L3_DIR = paths.WORK / "albedo-l3"
SOURCES_GLOBAL = ["NASA Earth Observatory Blue Marble Next Generation, August 2004 (public domain; Reto Stockli, NASA GSFC)"]
LUMA = np.array([0.2126, 0.7152, 0.0722])
POLAR_TAPER = (60.0, 70.0)     # the fit is unreliable over ice sheets and the August polar night


# -- sun geometry and normals -----------------------------------------------------------------------------
def sun_vector(lat_deg) -> tuple[np.ndarray, np.ndarray]:
    """c = (s_east, s_north) / s_up of the overpass sun at latitude lat (s_up floored at sin 5 deg)."""
    phi = np.radians(np.asarray(lat_deg, np.float64))
    dec = math.radians(DECLINATION_DEG)
    H = math.radians(15.0 * (OVERPASS_SOLAR_HOUR - 12.0))
    s_e = -math.cos(dec) * math.sin(H) * np.ones_like(phi)
    s_n = math.sin(dec) * np.cos(phi) - math.cos(dec) * np.sin(phi) * math.cos(H)
    s_u = np.maximum(math.sin(dec) * np.sin(phi) + math.cos(dec) * np.cos(phi) * math.cos(H), math.sin(math.radians(5.0)))
    return s_e / s_u, s_n / s_u


def tile_normals(h259: np.ndarray, face: int, level: int, x: int, y: int):
    """East/north normal components and height at the 256 x 256 texel centres of a tile, from the stored
    height tile of the same key (texel (c, r) spans vertices c..c+1, r..r+1 of the interior grid)."""
    g = h259[1:258, 1:258].astype(np.float64)
    hc = 0.25 * (g[:-1, :-1] + g[:-1, 1:] + g[1:, :-1] + g[1:, 1:])
    hu = 0.5 * ((g[:-1, 1:] + g[1:, 1:]) - (g[:-1, :-1] + g[1:, :-1]))     # per texel step in u
    hv = 0.5 * ((g[1:, :-1] + g[1:, 1:]) - (g[:-1, :-1] + g[:-1, 1:]))     # per texel step in v
    V = cube.height_tile_dirs(face, level, x, y)[1:258, 1:258]       # texel corner (vertex) directions
    d = V[:-1, :-1] + V[:-1, 1:] + V[1:, :-1] + V[1:, 1:]
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    du = 0.5 * ((V[:-1, 1:] + V[1:, 1:]) - (V[:-1, :-1] + V[1:, :-1])) * paths.RADIUS   # one texel step in u
    dv = 0.5 * ((V[1:, :-1] + V[1:, 1:]) - (V[:-1, :-1] + V[:-1, 1:])) * paths.RADIUS   # one texel step in v
    east = np.stack([-d[..., 1], d[..., 0], np.zeros_like(d[..., 0])], axis=-1)
    en = np.linalg.norm(east, axis=-1, keepdims=True)
    east = np.where(en > 1e-12, east / np.maximum(en, 1e-12), np.array([0.0, 1.0, 0.0]))
    north = np.cross(d, east)
    # J maps (du, dv) texel steps to (east, north) metres; gradient g = [hu, hv] J^-1
    a, b = np.sum(du * east, -1), np.sum(dv * east, -1)
    c, e = np.sum(du * north, -1), np.sum(dv * north, -1)
    det = a * e - b * c
    ge = (hu * e - hv * c) / det
    gn = (hv * a - hu * b) / det
    nrm = np.sqrt(1.0 + ge * ge + gn * gn)
    return -ge / nrm, -gn / nrm, hc


def load_fit() -> dict:
    return read_json(FIT_FILE)


def sun_box(lat_deg: float) -> tuple[float, float, float, float]:
    """(alpha_min, alpha_max, beta_min, beta_max): the physically possible shading coefficients at a latitude,
    the box spanned by 0 (all diffuse light) and the Lambertian sun vectors c between 10:00 and 12:00 local solar
    time (MODIS Terra pixels off nadir see 9:50-11:10; noon bounds the north-south component)."""
    es, ns = [0.0], [0.0]
    for hour in np.linspace(10.0, 12.0, 9):
        phi, dec, H = math.radians(lat_deg), math.radians(DECLINATION_DEG), math.radians(15.0 * (hour - 12.0))
        su = max(math.sin(dec) * math.sin(phi) + math.cos(dec) * math.cos(phi) * math.cos(H), math.sin(math.radians(5.0)))
        es.append(-math.cos(dec) * math.sin(H) / su)
        ns.append((math.sin(dec) * math.cos(phi) - math.cos(dec) * math.sin(phi) * math.cos(H)) / su)
    return min(es), max(es), min(ns), max(ns)


def coefficients(fit: dict, lat: np.ndarray, yloc: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(alpha, beta) w(lat) per texel: the fitted coefficients, linear between band centres and between the
    brightness-class centres, times the polar taper."""
    band_lat = 90.0 - 5.0 * np.arange(BANDS) - 2.5
    ab = np.array(fit["alphaBeta"])                                    # (BANDS, classes, 2)
    yc = np.array(fit["brightnessCentres"])
    y = np.clip(yloc.ravel(), yc[0], yc[-1])
    i = np.clip(np.searchsorted(yc, y) - 1, 0, yc.size - 2)
    t = (y - yc[i]) / (yc[i + 1] - yc[i])
    r = np.arange(y.size)
    w = np.clip((POLAR_TAPER[1] - np.abs(lat)) / (POLAR_TAPER[1] - POLAR_TAPER[0]), 0.0, 1.0)
    out = []
    for q in range(2):
        kb = np.stack([np.interp(-lat.ravel(), -band_lat, ab[:, j, q]) for j in range(ab.shape[1])], -1)
        out.append(w * (kb[r, i] * (1.0 - t) + kb[r, i + 1] * t).reshape(lat.shape))
    return out[0], out[1]


def shading_factor(fit: dict, ne: np.ndarray, nn: np.ndarray, lat: np.ndarray, yloc: np.ndarray) -> np.ndarray:
    a, b = coefficients(fit, lat, yloc)
    return deshade.factor(ne, nn, a, b)


def deshade_tile(lin: np.ndarray, face: int, x: int, y: int, fit: dict, lat: np.ndarray, yloc: np.ndarray) -> np.ndarray:
    h = tiles.read_height(face, 7, x, y)
    ne, nn, hc = tile_normals(h, face, 7, x, y)
    f = np.where(hc > 0.0, shading_factor(fit, ne, nn, lat.reshape(256, 256), yloc), 1.0)   # seafloor slopes cast no shading
    return lin / f[..., None]


def _raw_l7(crop: equirect.FaceCrop, face: int, x: int, y: int):
    """Linear RGB (256, 256, 3) of the source at the texel centres of a level-7 tile, and the latitudes."""
    d = cube.image_tile_dirs(face, 7, x, y).reshape(-1, 3)
    lat, lon = tiles.dirs_latlon(d)
    cx, cy = crop.px(lat, lon)
    rgb = sample.bicubic_rgb_clamped(crop.data, cx, cy, crop.wrap)
    return tiles.srgb_to_linear(rgb.reshape(256, 256, 3)), lat.reshape(256, 256)


def local_brightness(crop: equirect.FaceCrop, face: int, x: int, y: int) -> np.ndarray:
    """(256, 256) local mean linear luminance of the source around each texel of a level-7 tile: the source
    sampled every YLOC_STEP texels over the tile padded by YLOC_PAD texels, dark water (Y < 0.025) left out,
    Gaussian over FIT_SIGMA_TEXELS, bilinear back to the texels. A function of position only (the padding
    holds the neighbours' texels), so neighbouring tiles agree along their shared border."""
    from scipy import ndimage
    n = (256 + 2 * YLOC_PAD) // YLOC_STEP
    k = (np.arange(n) * YLOC_STEP + 0.5 * YLOC_STEP - YLOC_PAD) / 256.0
    uu, vv = np.meshgrid(k, k)
    lat, lon = tiles.dirs_latlon(cube.tile_uv_to_dir(face, 7, x, y, uu, vv).reshape(-1, 3))
    cx, cy = crop.px(lat, lon)
    Y = (tiles.srgb_to_linear(sample.bicubic_rgb_clamped(crop.data, cx, cy, crop.wrap)) @ LUMA).reshape(n, n)
    w = (Y > 0.025).astype(np.float64)
    s = FIT_SIGMA_TEXELS / YLOC_STEP
    m = ndimage.gaussian_filter(Y * w, s, mode="nearest") / np.maximum(ndimage.gaussian_filter(w, s, mode="nearest"), 1e-6)
    m = np.where(ndimage.gaussian_filter(w, s, mode="nearest") > 1e-3, m, 0.0)
    c = (np.arange(256) + 0.5 + YLOC_PAD) / YLOC_STEP - 0.5
    CY, CX = np.meshgrid(c, c, indexing="ij")
    return ndimage.map_coordinates(m, [CY, CX], order=1, mode="nearest")


# -- de-shading fit (pass 1) --------------------------------------------------------------------------------
def fit_selection(lin: np.ndarray, wm: np.ndarray, ne: np.ndarray, nn: np.ndarray, hc: np.ndarray) -> np.ndarray:
    """Sparsely vegetated or bare land with relief: not water, not green, not snow, slope above 2 deg."""
    R, G = lin[..., 0], lin[..., 1]
    Y = lin @ LUMA
    green = (G - R) / (G + R + 1e-4)
    mx = lin.max(axis=-1)
    sat = (mx - lin.min(axis=-1)) / (mx + 1e-4)
    snow = (Y > 0.30) & (sat < 0.20)
    steep = np.hypot(ne, nn) > math.sin(math.radians(FIT_MIN_SLOPE_DEG))
    return (wm < 64) & (hc > 0.0) & (Y > 0.02) & (Y < 0.45) & (green < 0.0) & ~snow & steep


def brightness_class(yloc: np.ndarray) -> np.ndarray:
    return np.clip(np.searchsorted(BRIGHTNESS_EDGES, yloc, side="right") - 1, 0, BRIGHTNESS_EDGES.size - 2)


def fit_terms(lin: np.ndarray, wm: np.ndarray, ne: np.ndarray, nn: np.ndarray, hc: np.ndarray, lat: np.ndarray,
              yloc: np.ndarray):
    """(cell, x, y, ne', nn') of the selected texels of one tile: the centred predictor and response;
    cell = band * classes + brightness class."""
    from scipy import ndimage
    sel = fit_selection(lin, wm, ne, nn, hc)
    if sel.sum() < 50:
        return None
    ce, cn = sun_vector(lat)
    p = ce * ne + cn * nn
    Y = np.maximum(lin @ LUMA, 1e-5)
    wsum = ndimage.gaussian_filter(sel.astype(np.float64), FIT_SIGMA_TEXELS, mode="nearest")

    def local(a):
        return ndimage.gaussian_filter(np.where(sel, a, 0.0), FIT_SIGMA_TEXELS, mode="nearest") / np.maximum(wsum, 1e-9)
    ly = np.log(Y)
    ok = sel & (wsum > 0.25) & (np.abs(p) < FIT_MAX_PREDICTOR)
    if ok.sum() < 50:
        return None
    band = np.clip(((90.0 - lat) // 5).astype(int), 0, BANDS - 1)
    cell = band * NCLASS + brightness_class(yloc)
    return (cell[ok], (p - local(p))[ok], (ly - local(ly))[ok], (ne - local(ne))[ok], (nn - local(nn))[ok])


def _fit_unit(u: tuple[int, int, int]) -> int:
    """Normal-equation sums of the fit over the level-7 tiles under one level-3 tile, per band and brightness
    class: [n, Sxx, Sxy, Syy, See, Sen, Snn, Sey, Sny] (x = c . n_h centred, e/n = normal components centred)."""
    face, x3, y3 = u
    crop = equirect.open_face_crop("bmng", face, MONTH)
    acc = np.zeros((BANDS * NCLASS, 9))
    for dx in range(16):
        for dy in range(16):
            x, y = x3 * 16 + dx, y3 * 16 + dy
            wm = tiles.read_u8("watermask", face, 7, x, y)
            if wm.min() >= 250:
                continue
            lin, lat = _raw_l7(crop, face, x, y)
            ne, nn, hc = tile_normals(tiles.read_height(face, 7, x, y), face, 7, x, y)
            t = fit_terms(lin, wm, ne, nn, hc, lat, local_brightness(crop, face, x, y))
            if t is None:
                continue
            b, px, py, pe, pn = t
            for col, v in enumerate((np.ones_like(px), px * px, px * py, py * py, pe * pe, pe * pn, pn * pn, pe * py, pn * py)):
                acc[:, col] += np.bincount(b, weights=v, minlength=BANDS * NCLASS)
    FIT_DIR.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    np.save(buf, acc)
    (FIT_DIR / f"{face}-{x3}-{y3}.npy").write_bytes(buf.getvalue())
    return 1


FIT_CFG = {"v": FIT_VERSION, "month": MONTH, "hour": OVERPASS_SOLAR_HOUR, "dec": DECLINATION_DEG,
           "sigma": FIT_SIGMA_TEXELS, "minSlope": FIT_MIN_SLOPE_DEG, "maxPredictor": FIT_MAX_PREDICTOR,
           "brightness": BRIGHTNESS_EDGES.tolist(), "ylocStep": YLOC_STEP, "ylocPad": YLOC_PAD,
           "minCell": FIT_MIN_SAMPLES}


def fit_deshading() -> dict:
    """Pass 1 over every face (resumable), then the per-band and per-class coefficients; cached in FIT_FILE."""
    acc_key = str(dict(FIT_CFG, inputs={L: manifest.build_hash(L, "global") for L in ("height", "watermask")}))
    key = acc_key + " model=" + FIT_MODEL
    if FIT_FILE.is_file() and read_json(FIT_FILE).get("key") == key:
        return load_fit()
    units_all = []
    for face in range(6):
        units = [(face, x, y) for x in range(8) for y in range(8)]
        units_all += units
        k = lambda u: "%d-%d-%d" % u   # noqa: E731
        if units_done(f"albedo-fit-f{face}", units, k, {"key": acc_key}) and \
                all((FIT_DIR / f"{f}-{x}-{y}.npy").is_file() for f, x, y in units):
            continue
        equirect.download("bmng", MONTH)
        equirect.build_face_crop("bmng", face, MONTH)
        run_units(f"albedo-fit-f{face}", _fit_unit, units, key=k, config={"key": acc_key})
        equirect.delete_face_crop("bmng", face, MONTH)
    acc = sum(np.load(FIT_DIR / f"{f}-{x}-{y}.npy") for f, x, y in units_all).reshape(BANDS, NCLASS, 9)
    band_lat = 90.0 - 5.0 * np.arange(BANDS) - 2.5
    raw = np.full((BANDS, NCLASS, 2), np.nan)
    for b in range(BANDS):
        for j in range(NCLASS):
            n, sxx, sxy, syy, see, sen, snn, sey, sny = acc[b, j]
            if n >= FIT_MIN_SAMPLES:
                raw[b, j] = np.linalg.solve(np.array([[see, sen], [sen, snn]]) + 1e-9 * np.eye(2), np.array([sey, sny]))
    if np.isnan(raw).all():
        raise ValueError("de-shading fit: no latitude band has enough bare sloping ground")
    # fill: across bands within each brightness class, then classes without any band from the nearest class;
    # then clip into the physically possible box of the band
    ab = np.full_like(raw, np.nan)
    idx = np.arange(BANDS)
    for j in range(NCLASS):
        ok = ~np.isnan(raw[:, j, 0])
        if ok.any():
            for q in range(2):
                ab[:, j, q] = np.interp(idx, idx[ok], raw[ok, j, q])
    have = [j for j in range(NCLASS) if not np.isnan(ab[0, j, 0])]
    for j in range(NCLASS):
        if np.isnan(ab[0, j, 0]):
            ab[:, j] = ab[:, min(have, key=lambda q: abs(q - j))]
    boxes = [sun_box(float(la)) for la in band_lat]
    for b, (a0, a1, b0, b1) in enumerate(boxes):
        ab[b, :, 0] = np.clip(ab[b, :, 0], a0, a1)
        ab[b, :, 1] = np.clip(ab[b, :, 1], b0, b1)
    centres = [float(0.5 * (BRIGHTNESS_EDGES[j] + BRIGHTNESS_EDGES[j + 1])) for j in range(NCLASS)]
    out = {"key": key, "bands": "5 deg from north (centres +87.5 .. -87.5)", "alphaBeta": ab.tolist(),
           "brightnessEdges": BRIGHTNESS_EDGES.tolist(), "brightnessCentres": centres,
           "raw": [[[None if np.isnan(v) else float(v) for v in c] for c in r] for r in raw],
           "sunBox": [list(bx) for bx in boxes], "samples": acc[:, :, 0].astype(int).tolist()}
    write_json(FIT_FILE, out)
    log("deshade fit alpha/beta per brightness class " + str([f"{e:.2f}" for e in BRIGHTNESS_EDGES]) + " (band centre: "
        "alpha/beta per class, '-' = interpolated): " + "; ".join(
            f"{band_lat[b]:+.1f}: " + " ".join(f"{ab[b, j, 0]:+.2f}/{ab[b, j, 1]:+.2f}{'' if not np.isnan(raw[b, j, 0]) else '-'}"
                                             for j in range(NCLASS)) for b in range(BANDS)))
    return out


# -- level 7 and the subtree (pass 2) -----------------------------------------------------------------------
def _sample_l7(crop: equirect.FaceCrop, face: int, x: int, y: int, fit: dict) -> np.ndarray:
    lin, lat = _raw_l7(crop, face, x, y)
    return deshade_tile(lin, face, x, y, fit, lat, local_brightness(crop, face, x, y))


def _subtree_unit(u: tuple[int, int, int]) -> int:
    """All level 7..3 tiles under one level-3 tile."""
    face, x3, y3 = u
    crop = equirect.open_face_crop("bmng", face, MONTH)
    fit = load_fit()
    lin = {}
    n = 0
    for dx in range(16):
        for dy in range(16):
            x, y = x3 * 16 + dx, y3 * 16 + dy
            t = _sample_l7(crop, face, x, y, fit)
            n += tiles.write_webp("albedo", face, 7, x, y, tiles.linear_to_srgb8(t))
            lin[(x, y)] = t
    for level in range(6, 2, -1):
        k = 2 ** (level - 3)
        nxt = {}
        for dx in range(k):
            for dy in range(k):
                x, y = x3 * k + dx, y3 * k + dy
                ch = [lin[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]
                t = tiles.box2(tiles.assemble_children(ch))
                n += tiles.write_webp("albedo", face, level, x, y, tiles.linear_to_srgb8(t))
                nxt[(x, y)] = t
        lin = nxt
    L3_DIR.mkdir(parents=True, exist_ok=True)
    np.save(L3_DIR / f"{face}-{x3}-{y3}.npy", lin[(x3, y3)].astype(np.float32))
    return n


def _top_levels() -> None:
    for face in range(6):
        lin = {(x, y): np.load(L3_DIR / f"{face}-{x}-{y}.npy").astype(np.float64) for x in range(8) for y in range(8)}
        for level in (2, 1, 0):
            k = 2 ** level
            nxt = {}
            for x in range(k):
                for y in range(k):
                    ch = [lin[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]
                    t = tiles.box2(tiles.assemble_children(ch))
                    tiles.write_webp("albedo", face, level, x, y, tiles.linear_to_srgb8(t))
                    nxt[(x, y)] = t
            lin = nxt


def bake_global() -> None:
    fit = fit_deshading()
    cfg = {"v": 6, "month": MONTH, "lossless": True, "deshade": fit["key"], "alphaBeta": fit["alphaBeta"]}
    if manifest.is_marked("albedo", "global") and (paths.STATE / "albedo-global.cfg").is_file() \
            and (paths.STATE / "albedo-global.cfg").read_text(encoding="utf-8") == str(cfg):
        log("albedo: global levels already baked")
        return
    for face in range(6):
        units = [(face, x, y) for x in range(8) for y in range(8)]
        key = lambda u: "%d-%d-%d" % u   # noqa: E731
        if units_done(f"albedo-f{face}", units, key, cfg):
            continue
        equirect.download("bmng", MONTH)                 # resumable; a no-op when the quadrants are cached
        equirect.build_face_crop("bmng", face, MONTH)
        run_units(f"albedo-f{face}", _subtree_unit, units, key=key, config=cfg)
        equirect.delete_face_crop("bmng", face, MONTH)
    _top_levels()
    (paths.STATE / "albedo-global.cfg").write_text(str(cfg), encoding="utf-8")
    manifest.mark("albedo", "global")


def bake_region(region_id: str) -> None:
    from earth import regalbedo
    regalbedo.bake(region_id)


def layer_manifest(regions: list[dict]) -> dict:
    from earth import region as regmod
    coverage: dict[str, list] = {}
    sources = list(SOURCES_GLOBAL)
    for reg in regions:
        for L in regmod.levels(reg):
            coverage.setdefault(str(L), []).extend(regmod.coverage_rects(reg, L))
        s = reg["sources"]["albedo"]
        txt = (f"Sentinel-2 cloudless {', '.join(str(y) for y in s['years'])} by EOX IT Services GmbH "
               f"(contains modified Copernicus Sentinel data), {s['licence']}; swappable")
        if txt not in sources:
            sources.append(txt)
    return {"encoding": "webp", "ext": "webp", "globalMaxLevel": paths.GLOBAL_MAX_LEVEL, "coverage": coverage,
            "sources": sources}
