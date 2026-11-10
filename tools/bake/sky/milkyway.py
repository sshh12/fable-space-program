"""SVS Deep Star Maps 2020 -> Milky Way cube (catalogue stars removed), photometric calibration.

Facts established from the data by this module (and re-checked by sky/verify.py):
  * Plate carree, row 0 = Dec +90, RA = 180 deg - 360 deg * (column + 0.5) / W (RA 0 at the centre column,
    increasing to the left) -- the orientation hypothesis that puts the catalogue's bright stars on bright
    pixels (`orientation_scores`).
  * The SVS combined map is starmap = a * milkyway + b * hiptyc with a = 0.5, b = 1.0 to 0.2 % (fitted on
    the 4k triple in `layer_weights`), so the background enters the cube as a * milkyway in hiptyc units.
  * Pixel values are clipped at 1.0: stars brighter than V ~ 5.5 saturate in the hiptyc layer. Flux is
    linear (10^(-0.4 V)) for unsaturated Tycho-range stars, which therefore set luminanceScale.
"""
from __future__ import annotations

import math

import numpy as np
import OpenEXR
from scipy.spatial import cKDTree

from sky import cubemap

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)
SVS_BASE = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/"
FILES = {
    "milkyway_2020_16k.exr": 434_041_232,
    "hiptyc_2020_16k.exr": 71_265_298,
    "starmap_2020_4k.exr": 35_997_085,
    "milkyway_2020_4k.exr": 36_436_668,
    "hiptyc_2020_4k.exr": 21_251_204,
}
CREDIT = "NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020 (Ernie Wright): Hipparcos-2, Tycho-2, Gaia DR2"


def load_exr(path) -> np.ndarray:
    """(H, W, 3) float32 linear RGB."""
    with OpenEXR.File(str(path), separate_channels=True) as f:
        ch = f.channels()
        return np.stack([ch[k].pixels.astype(np.float32) for k in "RGB"], axis=-1)


# -- equirect geometry (orientation chosen by orientation_scores) ------------------------------------
def radec_to_pixel(ra_rad, dec_rad, h: int, w: int, ra_at_left_deg: float = 180.0, ra_sign: float = -1.0):
    """Continuous (row, col) with pixel centres at integers: RA = ra_at_left + ra_sign * 360 * (col + 0.5) / w."""
    ra = np.degrees(np.asarray(ra_rad, dtype=np.float64))
    x = np.mod((ra - ra_at_left_deg) * ra_sign, 360.0) / 360.0 * w - 0.5
    y = (90.0 - np.degrees(np.asarray(dec_rad, dtype=np.float64))) / 180.0 * h - 0.5
    return y, x


def pixel_radec(h: int, w: int, rows: np.ndarray, ra_at_left_deg=180.0, ra_sign=-1.0):
    dec = np.radians(90.0 - (rows + 0.5) * 180.0 / h)
    cols = np.arange(w, dtype=np.float64)
    ra = np.radians(np.mod(ra_at_left_deg + ra_sign * 360.0 * (cols + 0.5) / w, 360.0))
    return ra, dec


def orientation_scores(Y: np.ndarray, ra: np.ndarray, dec: np.ndarray) -> dict:
    """Fraction of the given (bright) stars that land on a bright pixel, per orientation hypothesis."""
    h, w = Y.shape
    out = {}
    for left in (0.0, 90.0, 180.0, 270.0):
        for sign in (1.0, -1.0):
            for flip in (False, True):
                d = -dec if flip else dec
                y, x = radec_to_pixel(ra, d, h, w, left, sign)
                r = np.clip(np.round(y).astype(np.int64), 0, h - 1)
                c = np.mod(np.round(x).astype(np.int64), w)
                out[f"raAtLeft={left:g} sign={sign:+g} decFlip={flip}"] = float(np.mean(Y[r, c] > 0.05))
    return out


def layer_weights(star4k: np.ndarray, mw4k: np.ndarray, ht4k: np.ndarray) -> dict:
    """Least-squares a, b per channel for starmap = a * milkyway + b * hiptyc on unsaturated pixels."""
    ok = (star4k.max(-1) < 0.95) & (mw4k.max(-1) < 0.95) & (ht4k.max(-1) < 0.95)
    res = {}
    for c, name in enumerate("RGB"):
        A = np.stack([mw4k[..., c][ok], ht4k[..., c][ok]], 1).astype(np.float64)
        s = star4k[..., c][ok].astype(np.float64)
        coef = np.linalg.lstsq(A, s, rcond=None)[0]
        rel = float(np.sqrt(np.mean((A @ coef - s) ** 2)) / np.sqrt(np.mean(s ** 2)))
        res[name] = {"a": float(coef[0]), "b": float(coef[1]), "relRms": rel}
    return res


# -- star photometry in the equirect raster ------------------------------------------------------------
def pixel_solid_angle(h: int, w: int, dec_rad) -> np.ndarray:
    return (2.0 * math.pi / w) * (math.pi / h) * np.cos(dec_rad)


def disc_stats(Y: np.ndarray, ra: float, dec: float, radius_px: float, ring_px: float = 2.0):
    """Pixels within an angular disc around a star (angular radius = radius_px * dec-pixel size)."""
    h, w = Y.shape
    y, x = radec_to_pixel(ra, dec, h, w)
    pix = math.pi / h
    cosd = max(math.cos(dec), 1e-6)
    dy = int(math.ceil(radius_px + ring_px + 2))
    dx = int(min(w // 2 - 1, math.ceil((radius_px + ring_px + 2) / cosd)))
    r0, r1 = max(0, int(math.floor(y)) - dy), min(h, int(math.floor(y)) + dy + 2)
    rows = np.arange(r0, r1)
    cols = np.mod(np.arange(int(math.floor(x)) - dx, int(math.floor(x)) + dx + 2), w)
    pra, pdec = pixel_radec(h, w, rows.astype(np.float64))
    pra = pra[cols]
    sd, cd = np.sin(pdec)[:, None], np.cos(pdec)[:, None]
    cosang = sd * math.sin(dec) + cd * math.cos(dec) * np.cos(pra[None, :] - ra)
    ang = np.arccos(np.clip(cosang, -1.0, 1.0)) / pix  # in dec-pixel units
    return rows, cols, ang, pdec


def integrated_flux(Y: np.ndarray, ra: float, dec: float, radius_px: float = 4.0) -> tuple[float, float, float]:
    """(sum of (Y - background) * pixel solid angle over the disc [unit * sr], background, peak)."""
    rows, cols, ang, pdec = disc_stats(Y, ra, dec, radius_px)
    win = Y[rows][:, cols].astype(np.float64)
    ring = (ang >= radius_px) & (ang < radius_px + 2.0)
    bg = float(np.median(win[ring])) if np.any(ring) else 0.0
    disc = ang < radius_px
    omega = pixel_solid_angle(Y.shape[0], Y.shape[1], pdec)[:, None] * np.ones((1, len(cols)))
    return float(((win - bg) * omega)[disc].sum()), bg, float(win[disc].max())


def fit_luminance_scale(Y: np.ndarray, faint: dict, all_ra: np.ndarray, all_dec: np.ndarray, all_mag: np.ndarray,
                        vlo: float, vhi: float, mag0_lux: float) -> dict:
    """luminanceScale (cd/m^2 per stored unit) = median over isolated unsaturated stars of E_cat / flux_map."""
    xyz_all = cubemap.radec_to_dir(all_ra, all_dec)
    tree = cKDTree(xyz_all)
    pix = math.pi / Y.shape[0]
    sel = np.nonzero((faint["mag"] > vlo) & (faint["mag"] <= vhi) & (np.abs(faint["dec"]) < math.radians(70)))[0]
    rng = np.random.default_rng(12345)
    if len(sel) > 6000:
        sel = np.sort(rng.choice(sel, 6000, replace=False))
    ratios, mags = [], []
    xyz = cubemap.radec_to_dir(faint["ra"][sel], faint["dec"][sel])
    for i, p in zip(sel, xyz):
        # isolated: no other catalogue star brighter than V + 3 within 10 pixels
        near = [j for j in tree.query_ball_point(p, 10 * pix) if np.linalg.norm(xyz_all[j] - p) > 1e-9]
        if any(all_mag[j] < faint["mag"][i] + 3.0 for j in near):
            continue
        f, bg, peak = integrated_flux(Y, faint["ra"][i], faint["dec"][i])
        if peak >= 0.5 or f <= 0:
            continue
        e = mag0_lux * 10 ** (-0.4 * faint["mag"][i])
        ratios.append(e / f)
        mags.append(faint["mag"][i])
    ratios = np.array(ratios)
    mags = np.array(mags)
    k = float(np.median(ratios))
    bins = {}
    for lo in np.arange(vlo, vhi, 0.5):
        b = (mags > lo) & (mags <= lo + 0.5)
        if b.sum():
            bins[f"{lo:.1f}-{lo + 0.5:.1f}"] = {"n": int(b.sum()), "medianRatio": float(np.median(ratios[b]))}
    mad_mag = float(np.median(np.abs(2.5 * np.log10(ratios / k))))
    return {"luminanceScale": k, "stars": int(len(ratios)), "vRange": [vlo, vhi], "madMag": mad_mag, "bins": bins}


# -- star removal ---------------------------------------------------------------------------------------
def removal_radius(Y: np.ndarray, ra: float, dec: float, threshold: float = 1e-4, rmax: int = 18) -> int:
    """Smallest angular radius (dec pixels) beyond which the star's ring mean stays below `threshold`."""
    rows, cols, ang, _ = disc_stats(Y, ra, dec, float(rmax))
    win = Y[rows][:, cols]
    outer = (ang >= rmax) & (ang < rmax + 2)
    bg = float(np.median(win[outer])) if np.any(outer) else 0.0
    r = 1
    for k in range(1, rmax + 1):
        ring = (ang >= k) & (ang < k + 1)
        if not np.any(ring):
            continue
        if float(np.mean(win[ring])) - bg < threshold:
            r = k
            break
        r = k
    return r + 1


def remove_stars(img: np.ndarray, ra: np.ndarray, dec: np.ndarray, mag: np.ndarray) -> dict:
    """Disc inpainting (in place) of every star: the disc is filled with the per-channel median of the 2-px ring
    around it. Radii are measured per star from its luminance profile. Brightest first."""
    Y = img @ LUMA.astype(np.float32)
    radii = np.zeros(len(ra), dtype=np.int64)
    removed_flux = 0.0
    for i in np.argsort(mag, kind="stable"):
        r = removal_radius(Y, ra[i], dec[i])
        radii[i] = r
        rows, cols, ang, pdec = disc_stats(Y, ra[i], dec[i], float(r))
        sub = img[rows][:, cols]
        ring = (ang >= r) & (ang < r + 2.0)
        fill = np.median(sub[ring], axis=0) if np.any(ring) else np.zeros(3, np.float32)
        disc = ang < r
        omega = pixel_solid_angle(img.shape[0], img.shape[1], pdec)[:, None] * np.ones((1, len(cols)))
        removed_flux += float((((sub @ LUMA.astype(np.float32)) - float(fill @ LUMA)) * omega)[disc].sum())
        sub[disc] = fill
        rr, cc = np.nonzero(disc)
        img[rows[rr], cols[cc]] = sub[rr, cc]
        Y[rows[rr], cols[cc]] = float(fill @ LUMA)
    return {"radii": radii, "removedFluxUnitSr": removed_flux}


# -- cube resampling --------------------------------------------------------------------------------
def equirect_to_cube(img: np.ndarray, n: int, row_chunk: int = 256) -> np.ndarray:
    """Radiance-weighted bilinear splat of an equirect (H, W, 3) image into six n x n faces (WebGPU order).

    Each source pixel distributes value * solid angle to the 4 texels around its direction with bilinear
    weights; each texel's value is (sum of w * L * omega) / (sum of w * omega). Returns (6, n, n, 3) float32.
    """
    h, w = img.shape[:2]
    nb = 6 * n * n
    S = np.zeros((nb, 3), dtype=np.float64)
    A = np.zeros(nb, dtype=np.float64)
    for r0 in range(0, h, row_chunk):
        rows = np.arange(r0, min(h, r0 + row_chunk), dtype=np.float64)
        ra, dec = pixel_radec(h, w, rows)
        D = cubemap.radec_to_dir(ra[None, :], dec[:, None])
        face, u, v = cubemap.dir_to_face_uv(D)
        omega = np.broadcast_to(pixel_solid_angle(h, w, dec)[:, None], face.shape)
        xt = u * n - 0.5
        yt = v * n - 0.5
        i0 = np.floor(xt).astype(np.int64)
        j0 = np.floor(yt).astype(np.int64)
        fx, fy = xt - i0, yt - j0
        vals = img[r0:r0 + len(rows)].reshape(-1, 3).astype(np.float64)
        om = omega.ravel()
        base = face.ravel() * n * n
        for di, wx in ((0, 1.0 - fx), (1, fx)):
            for dj, wy in ((0, 1.0 - fy), (1, fy)):
                ii = np.clip(i0 + di, 0, n - 1).ravel()
                jj = np.clip(j0 + dj, 0, n - 1).ravel()
                idx = base + jj * n + ii
                wt = (wx * wy).ravel() * om
                A += np.bincount(idx, weights=wt, minlength=nb)
                for c in range(3):
                    S[:, c] += np.bincount(idx, weights=wt * vals[:, c], minlength=nb)
    if np.any(A <= 0):
        raise ValueError(f"{int(np.sum(A <= 0))} cube texels received no source pixels")
    return (S / A[:, None]).reshape(6, n, n, 3).astype(np.float32)
