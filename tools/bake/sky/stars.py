"""HYG v4.1 star catalogue -> data/sky/stars.f32 (+ named-stars.json), the SkyManifest `stars` block.

Records (little-endian float32, STAR_RECORD_FLOATS = 8, brightest first):
  [0..2] unit direction in ROOT = J2000 equatorial axes, from HYG rarad/decrad (epoch and equinox J2000)
  [3]    illuminance at Earth, lux = 2.54e-6 * 10^(-0.4 V)
  [4..6] linear-sRGB colour normalised to luminance 1 (0.2126 R + 0.7152 G + 0.0722 B = 1): blackbody at
         T(B-V) (Ballesteros 2012), integrated against the CIE 1931 2-degree observer (Wyman, Sloan & Shirley
         2013 analytic fit), XYZ -> linear sRGB (D65), negative channels clipped, renormalised
  [7]    V magnitude
Stars without B-V take it from their spectral class (Morgan-Keenan table below); the count is reported.
"""
from __future__ import annotations

import csv
import re
from pathlib import Path

import numpy as np

HYG_URL = "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv"
HYG_BYTES = 33_932_548
CUTOFF_MAG = 6.5
MAG0_LUX = 2.54e-6
RECORD_FLOATS = 8
CREDIT = "HYG Database v4.1 by David Nash / astronexus (CC BY-SA 4.0), derived star table"

# Main-sequence B-V by spectral class and subclass 0 / 5 (Johnson-Morgan; used only when HYG has no ci).
_MK_BV = {"O": (-0.33, -0.32), "B": (-0.30, -0.16), "A": (0.00, 0.15), "F": (0.30, 0.44), "G": (0.58, 0.68),
          "K": (0.81, 1.15), "M": (1.40, 1.64)}
_NEXT = {"O": "B", "B": "A", "A": "F", "F": "G", "G": "K", "K": "M"}


def bv_from_spectrum(spect: str) -> float | None:
    m = re.match(r"\s*([OBAFGKM])\s*(\d(?:\.\d)?)?", spect or "")
    if not m:
        return None
    cls = m.group(1)
    sub = float(m.group(2)) if m.group(2) else 5.0
    a0, a5 = _MK_BV[cls]
    if sub <= 5.0:
        return a0 + (a5 - a0) * sub / 5.0
    b0 = _MK_BV[_NEXT[cls]][0] if cls in _NEXT else a5 + (a5 - a0)
    return a5 + (b0 - a5) * (sub - 5.0) / 5.0


def _g(lam, mu, s1, s2):
    s = np.where(lam < mu, s1, s2)
    return np.exp(-0.5 * ((lam - mu) / s) ** 2)


def cie_xyz_bar(lam_nm: np.ndarray) -> np.ndarray:
    x = 1.056 * _g(lam_nm, 599.8, 37.9, 31.0) + 0.362 * _g(lam_nm, 442.0, 16.0, 26.7) - 0.065 * _g(lam_nm, 501.1, 20.4, 26.2)
    y = 0.821 * _g(lam_nm, 568.8, 46.9, 40.5) + 0.286 * _g(lam_nm, 530.9, 16.3, 31.1)
    z = 1.217 * _g(lam_nm, 437.0, 11.8, 36.0) + 0.681 * _g(lam_nm, 459.0, 26.0, 13.8)
    return np.stack([x, y, z], axis=-1)


XYZ_TO_SRGB = np.array([[3.2404542, -1.5371385, -0.4985314],
                        [-0.9692660, 1.8760108, 0.0415560],
                        [0.0556434, -0.2040259, 1.0572252]])
LUMA = np.array([0.2126, 0.7152, 0.0722])


def bv_to_temperature(bv: np.ndarray) -> np.ndarray:
    bv = np.clip(bv, -0.4, 2.0)
    return 4600.0 * (1.0 / (0.92 * bv + 1.7) + 1.0 / (0.92 * bv + 0.62))


def blackbody_srgb(temp_k: np.ndarray) -> np.ndarray:
    """Linear sRGB of blackbodies, normalised to luminance 1. temp_k: (n,)."""
    lam = np.arange(380.0, 781.0, 1.0)
    cmf = cie_xyz_bar(lam)
    l_m = lam * 1e-9
    c2 = 1.4387769e-2
    planck = 1.0 / (l_m[None, :] ** 5 * (np.exp(c2 / (l_m[None, :] * np.asarray(temp_k)[:, None])) - 1.0))
    xyz = planck @ cmf
    rgb = np.clip(xyz @ XYZ_TO_SRGB.T, 0.0, None)
    return rgb / (rgb @ LUMA)[:, None]


def load_hyg(path: Path) -> list[dict]:
    rows = []
    with open(path, newline="", encoding="utf-8") as fh:
        for r in csv.DictReader(fh):
            if r["id"] == "0" or r["proper"] == "Sol":
                continue
            if not r["mag"]:
                continue
            rows.append(r)
    return rows


def build_catalogue(hyg_path: Path, cutoff: float = CUTOFF_MAG) -> dict:
    rows = [r for r in load_hyg(hyg_path) if float(r["mag"]) <= cutoff]
    rows.sort(key=lambda r: (float(r["mag"]), int(r["id"])))
    n = len(rows)
    ra = np.array([float(r["rarad"]) for r in rows])
    dec = np.array([float(r["decrad"]) for r in rows])
    mag = np.array([float(r["mag"]) for r in rows])
    bv = np.full(n, np.nan)
    from_spect = 0
    default_bv = 0
    for i, r in enumerate(rows):
        if r["ci"].strip():
            bv[i] = float(r["ci"])
        else:
            s = bv_from_spectrum(r["spect"])
            if s is None:
                bv[i] = 0.65
                default_bv += 1
            else:
                bv[i] = s
                from_spect += 1
    d = np.stack([np.cos(dec) * np.cos(ra), np.cos(dec) * np.sin(ra), np.sin(dec)], axis=-1)
    lux = MAG0_LUX * 10.0 ** (-0.4 * mag)
    rgb = blackbody_srgb(bv_to_temperature(bv))
    rec = np.zeros((n, RECORD_FLOATS), dtype="<f4")
    rec[:, 0:3] = d
    rec[:, 3] = lux
    rec[:, 4:7] = rgb
    rec[:, 7] = mag
    named = [{"name": r["proper"], "index": i} for i, r in enumerate(rows) if r["proper"].strip()]
    return {"records": rec, "rows": rows, "named": named, "bvFromSpectrum": from_spect, "bvDefaulted": default_bv,
            "ra": ra, "dec": dec, "mag": mag}


def faint_stars(hyg_path: Path, lo: float, hi: float) -> dict:
    """Stars with lo < V <= hi (for the photometric fit of the star map; not part of the shipped catalogue)."""
    rows = [r for r in load_hyg(hyg_path) if lo < float(r["mag"]) <= hi]
    return {"ra": np.array([float(r["rarad"]) for r in rows]), "dec": np.array([float(r["decrad"]) for r in rows]),
            "mag": np.array([float(r["mag"]) for r in rows])}
