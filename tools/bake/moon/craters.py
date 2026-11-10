"""Reference craters for the albedo de-shading check (east/west inner-wall brightness), with the centre and rim
radius refined from the baked level-6 heights so that approximate catalogue positions suffice.

Nominal positions (IAU names, lat N, lon E, diameter km) are approximate; `refine` searches the DEM.
"""
from __future__ import annotations

import math

import numpy as np

from common import cube

CRATERS = [
    ("Kepler", 8.1, -38.0, 31), ("Aristarchus", 23.7, -47.4, 40), ("Timocharis", 26.7, -13.1, 33),
    ("Euler", 23.3, -29.2, 26), ("Lambert", 25.8, -21.0, 30), ("Bessel", 21.8, 17.9, 15),
    ("Dawes", 17.2, 26.4, 18), ("Plinius", 15.4, 23.7, 41), ("Manilius", 14.5, 9.1, 38),
    ("Menelaus", 16.3, 16.0, 26), ("Arago", 6.2, 21.4, 26), ("Delisle", 29.9, -34.6, 25),
    ("Diophantus", 27.6, -34.3, 17), ("Pytheas", 20.5, -20.6, 20), ("Mosting", -0.7, -5.9, 25),
    ("Lalande", -4.4, -8.6, 24), ("Godin", 1.8, 10.2, 34), ("Dionysius", 2.8, 17.3, 18),
    ("Maskelyne", 2.2, 30.1, 23), ("Proclus", 16.1, 46.8, 28), ("Picard", 14.6, 54.7, 23),
    ("Taruntius", 5.5, 46.5, 56), ("Bullialdus", -20.7, -22.2, 61), ("Agrippa", 4.1, 10.5, 44),
    ("Herschel", -5.7, -2.1, 41), ("Theon Senior", -0.8, 15.4, 18),
]

R = 1_737_400.0


def local_grid(lat: float, lon: float, half_m: float, step_m: float):
    """Directions of a north-up local tangent grid (rows north->south, columns west->east)."""
    la, lo = math.radians(lat), math.radians(lon)
    c = cube.lat_lon_to_dir(la, lo)
    e = np.array([-math.sin(lo), math.cos(lo), 0.0])
    n = np.cross(c, e)
    k = np.arange(-half_m, half_m + step_m / 2, step_m)
    X, Y = np.meshgrid(k, -k)
    p = R * c + X[..., None] * e + Y[..., None] * n
    return p / np.linalg.norm(p, axis=-1, keepdims=True), X, Y


def refine(reader, name: str, lat: float, lon: float, diam_km: float) -> dict:
    """Bowl centre (minimum of the smoothed DEM near the nominal position) and rim radius (radial-profile max)."""
    from scipy import ndimage

    rad_nom = diam_km * 500.0
    step = max(100.0, rad_nom / 40.0)
    d, X, Y = local_grid(lat, lon, 1.8 * rad_nom, step)
    h = reader.bicubic(d, 6)
    hs = ndimage.gaussian_filter(h, rad_nom / step / 4.0)
    near = np.hypot(X, Y) < 0.5 * rad_nom
    i = np.argmin(np.where(near, hs, np.inf))
    cx, cy = X.flat[i], Y.flat[i]
    rr = np.hypot(X - cx, Y - cy)
    bins = np.arange(0.3 * rad_nom, 1.6 * rad_nom, step)
    prof = [h[(rr >= b) & (rr < b + step)].mean() for b in bins]
    rim = float(bins[int(np.argmax(prof))] + step / 2)
    la, lo = math.radians(lat), math.radians(lon)
    c = cube.lat_lon_to_dir(la, lo)
    e = np.array([-math.sin(lo), math.cos(lo), 0.0])
    n = np.cross(c, e)
    p = R * c + cx * e + cy * n
    clat, clon = (math.degrees(v) for v in cube.dir_to_lat_lon(p / np.linalg.norm(p)))
    return {"name": name, "latDeg": float(clat), "lonDeg": float(clon), "rimRadiusM": rim,
            "depthM": float(max(prof) - h.flat[i])}


def wall_ratio(sample_fn, crater: dict, step_m: float) -> dict:
    """Mean of sample_fn over the inner east wall / inner west wall (0.45-0.85 rim radius, +-35 deg of due E/W).

    The east wall faces west and the west wall faces east, so baked illumination from either side shows up as
    a ratio far from 1."""
    rim = crater["rimRadiusM"]
    d, X, Y = local_grid(crater["latDeg"], crater["lonDeg"], 0.9 * rim, step_m)
    r = np.hypot(X, Y) / rim
    az = np.degrees(np.arctan2(X, Y))  # 0 = north, 90 = east
    ring = (r > 0.45) & (r < 0.85)
    east = ring & (np.abs(az - 90.0) < 35.0)
    west = ring & (np.abs(az + 90.0) < 35.0)
    v = sample_fn(d)
    ve, vw = float(v[east].mean()), float(v[west].mean())
    return {"east": ve, "west": vw, "ratio": ve / vw}
