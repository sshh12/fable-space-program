"""Recovery-zone report: land fraction of every recoveryZones disc of every launch site that has an earth
region, from the level-5 water mask, and the land inside it (named from a small island gazetteer).

Sampling: an azimuthal-equidistant grid around the disc centre at REPORT_GRID_KM, each sample weighted by its
true area on the sphere (sin(rho) / rho), the water mask read at the nearest level-5 texel (about 1-1.2 km).
Land components are connected sets of samples with mask < 128.
"""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

from common import cube
from earth import paths, region as regmod, tiles
from earth.hpyramid import locate
from earth.site import destination, gc_distance_m
from earth.util import log, read_json, write_json

LEVEL = 5
REPORT_GRID_KM = 1.0

# (name, lat, lon) of small islands in and around the recovery areas
GAZETTEER = [
    ("Nuku Hiva (Marquesas)", -8.86, -140.14), ("Ua Pou (Marquesas)", -9.40, -140.08), ("Ua Huka (Marquesas)", -8.92, -139.55),
    ("Hiva Oa (Marquesas)", -9.75, -139.00), ("Tahuata (Marquesas)", -9.94, -139.10), ("Fatu Hiva (Marquesas)", -10.47, -138.65),
    ("Eiao (Marquesas)", -7.99, -140.68), ("Hatutu (Marquesas)", -7.93, -140.57),
    ("Kiritimati / Christmas Island (Line Islands)", 1.87, -157.40), ("Malden Island (Line Islands)", -4.02, -154.93),
    ("Starbuck Island (Line Islands)", -5.62, -155.93), ("Caroline Island (Line Islands)", -9.96, -150.21),
    ("Vostok Island (Line Islands)", -10.06, -152.31), ("Jarvis Island", -0.37, -160.02), ("Clipperton Island", 10.30, -109.22),
    ("Pitcairn Island", -25.07, -130.10), ("Henderson Island", -24.37, -128.32), ("Oeno Island", -23.93, -130.74),
    ("Ducie Island", -24.67, -124.79), ("Rapa Nui / Easter Island", -27.11, -109.35), ("Salas y Gomez", -26.47, -105.36),
    ("Mangareva (Gambier Islands)", -23.12, -134.97), ("Temoe (Gambier)", -23.33, -134.48), ("Morane (Tuamotu)", -23.17, -137.13),
    ("Tureia (Tuamotu)", -20.78, -138.57), ("Marutea Sud (Tuamotu)", -21.52, -135.55), ("Maria Est (Acteon Group)", -22.00, -136.19),
    ("Tematangi (Tuamotu)", -21.68, -140.62), ("Vanavana (Tuamotu)", -20.78, -139.13), ("Nukutavake (Tuamotu)", -19.28, -138.78),
    ("Vahitahi (Tuamotu)", -18.78, -138.85), ("Pukarua (Tuamotu)", -18.30, -137.02), ("Reao (Tuamotu)", -18.50, -136.43),
    ("Hao (Tuamotu)", -18.07, -140.95), ("Mururoa (Tuamotu)", -21.84, -138.89), ("Fangataufa (Tuamotu)", -22.24, -138.73),
    ("Ascension Island", -7.95, -14.37), ("Saint Helena", -15.97, -5.70), ("Fernando de Noronha", -3.85, -32.42),
    ("Atol das Rocas", -3.86, -33.82), ("Saint Peter and Saint Paul Archipelago", 0.92, -29.35),
]


def mask_at(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    d = cube.lat_lon_to_dir(np.radians(lat), np.radians(lon))
    face, x, y, u, v = locate(d, LEVEL)
    out = np.empty(lat.size, np.uint8)
    key = (face * 32 + y) * 32 + x
    for k in np.unique(key):
        f, yy, xx = int(k // 1024), int((k // 32) % 32), int(k % 32)
        t = tiles.read_u8("watermask", f, LEVEL, xx, yy)
        sel = key == k
        out[sel] = t[np.minimum((v[sel] * 256).astype(int), 255), np.minimum((u[sel] * 256).astype(int), 255)]
    return out


def zone_report(z: dict) -> dict:
    r_m = z["radiusKm"] * 1000.0
    step = REPORT_GRID_KM * 1000.0
    k = np.arange(-r_m, r_m + 1, step)
    E, N = np.meshgrid(k, k)
    rho = np.hypot(E, N)
    inside = rho <= r_m
    la, lo = destination(z["latDeg"], z["lonDeg"], E.ravel(), N.ravel())
    m = mask_at(la, lo).reshape(E.shape)
    ang = rho / paths.RADIUS
    w = np.where(ang > 0, np.sin(ang) / np.maximum(ang, 1e-12), 1.0) * inside
    land = (m < 128) & inside
    frac = float((w * (1.0 - m / 255.0)).sum() / w.sum())
    lab, n = ndimage.label(land)
    comps = []
    for i in range(1, n + 1):
        sel = lab == i
        cla, clo = la.reshape(E.shape)[sel], lo.reshape(E.shape)[sel]
        area = float(w[sel].sum() * (step / 1000.0) ** 2)
        c_lat, c_lon = float(cla.mean()), float(clo.mean())
        names = sorted(((gc_distance_m(c_lat, c_lon, g[1], g[2]), g[0]) for g in GAZETTEER))
        name = names[0][1] if names and names[0][0] < 60000 else "unnamed"
        comps.append({"name": name, "latDeg": round(c_lat, 3), "lonDeg": round(c_lon, 3), "areaKm2": round(area, 1),
                      "extentKm": [round((cla.max() - cla.min()) * 111.2 + REPORT_GRID_KM, 1),
                                   round((clo.max() - clo.min()) * 111.2 * math.cos(math.radians(c_lat)) + REPORT_GRID_KM, 1)],
                      "distanceFromCentreKm": round(gc_distance_m(z["latDeg"], z["lonDeg"], c_lat, c_lon) / 1000.0, 0)})
    comps.sort(key=lambda c: -c["areaKm2"])
    unresolved = [{"name": g[0], "latDeg": g[1], "lonDeg": g[2],
                   "distanceFromCentreKm": round(gc_distance_m(z["latDeg"], z["lonDeg"], g[1], g[2]) / 1000.0, 0)}
                  for g in GAZETTEER if gc_distance_m(z["latDeg"], z["lonDeg"], g[1], g[2]) <= r_m
                  and not any(c["name"] == g[0] for c in comps)]
    return {"name": z["name"], "latDeg": z["latDeg"], "lonDeg": z["lonDeg"], "radiusKm": z["radiusKm"],
            "landFraction": frac, "landComponents": comps, "knownIslandsNotResolvedAtLevel5": unresolved}


def report(region_ids: list[str]) -> dict:
    out = {"level": LEVEL, "gridKm": REPORT_GRID_KM, "sites": {}}
    for rid in region_ids:
        reg = regmod.load(rid)
        site = read_json(paths.SITES_DIR / f"{reg['site']}.json")
        out["sites"][reg["site"]] = [zone_report(z) for z in site.get("recoveryZones", [])]
        for zr in out["sites"][reg["site"]]:
            log(f"recovery {zr['name']}: land fraction {zr['landFraction'] * 100:.4f} %, {len(zr['landComponents'])} land "
                f"components, {len(zr['knownIslandsNotResolvedAtLevel5'])} gazetteer islands not resolved")
    write_json(paths.OUT / "recovery-zones.json", out)
    return out
