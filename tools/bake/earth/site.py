"""Launch-site resolution: snap the nominal pad coordinates of a region's site to real, flat, dry terrain.

Criteria (region["siteResolution"], defaults from the bake-earth brief):
  - natural height at the centre >= minHeightM above sea level;
  - distance from the centre to the nearest water (regional height < 0 or WorldCover water) >= minShoreDistanceM;
  - slope of the least-squares plane through the heights of the disc of radius discRadiusM < maxSlopeDeg, and
    no point of the disc deviates from that plane by more than maxReliefM (no hidden gully or cliff);
  - land cover: the centre and at least minAllowedFraction of the disc are WorldCover "bare / sparse
    vegetation" (60) or "moss and lichen" (100), i.e. bare lava / sparse scrub (never trees, crops, built-up);
  - open ocean to the east: along every azimuth of oceanAzimuthDeg (2 deg steps) the ray reaches water within
    oceanReachKm and then meets no land out to openOceanKm;
  - latitude below maxLatDeg.
The answer is the passing point nearest to the nominal coordinates (30 m candidate grid, then a 5 m refinement
around the winner). Heights come from the same regional source the bake samples into the level-12 tiles, so
padElevation equals the baked natural height at the pad.
"""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage, signal

from earth import paths, region as regmod
from earth.regsrc import RegionalHeight
from earth.util import log, write_json
from earth.worldcover import WATER, WorldCoverGrid

ALLOWED_WC = (60, 100)


def destination(lat_deg, lon_deg, east_m, north_m):
    """Azimuthal-equidistant offset (east, north metres) from a point, on the sphere of paths.RADIUS."""
    lat1 = math.radians(lat_deg)
    lon1 = math.radians(lon_deg)
    rho = np.hypot(east_m, north_m) / paths.RADIUS
    az = np.arctan2(east_m, north_m)
    sl = math.sin(lat1) * np.cos(rho) + math.cos(lat1) * np.sin(rho) * np.cos(az)
    lat2 = np.arcsin(np.clip(sl, -1, 1))
    lon2 = lon1 + np.arctan2(np.sin(az) * np.sin(rho) * math.cos(lat1), np.cos(rho) - math.sin(lat1) * sl)
    return np.degrees(lat2), (np.degrees(lon2) + 540.0) % 360.0 - 180.0


def gc_distance_m(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(np.asarray(lon2) - lon1)
    c = np.sin(p1) * np.sin(p2) + np.cos(p1) * np.cos(p2) * np.cos(dl)
    return np.arccos(np.clip(c, -1, 1)) * paths.RADIUS


class SiteResolver:
    def __init__(self, region: dict, rh: RegionalHeight | None = None):
        self.region = region
        self.cfg = region["siteResolution"]
        self.rh = rh or RegionalHeight(region, slack_km=self.cfg["searchRadiusKm"] + 5.0)
        n = self.cfg["nominal"]
        span = (self.cfg["searchRadiusKm"] + 3.0) * 1000.0
        la0, _ = destination(n["latDeg"], n["lonDeg"], 0.0, -span)
        la1, _ = destination(n["latDeg"], n["lonDeg"], 0.0, span)
        _, lo0 = destination(n["latDeg"], n["lonDeg"], -span * 1.05, 0.0)
        _, lo1 = destination(n["latDeg"], n["lonDeg"], span * 1.05, 0.0)
        self.wc = WorldCoverGrid(float(la0), float(la1), float(lo0), float(lo1))

    # -- explicit evaluation at one point -----------------------------------------------------------------
    def water(self, lat, lon, h=None) -> np.ndarray:
        h = self.rh.height(lat, lon) if h is None else h
        return (h < 0.0) | (self.wc.nearest(lat, lon) == WATER)

    def evaluate(self, lat: float, lon: float) -> dict:
        c = self.cfg
        out: dict = {"latDeg": lat, "lonDeg": lon}
        h0 = float(self.rh.height(np.array([lat]), np.array([lon]))[0])
        out["height"] = h0
        # disc samples on a 10 m grid
        r = float(c["discRadiusM"])
        k = np.arange(-r, r + 1e-6, 10.0)
        E, N = np.meshgrid(k, k)
        inside = E ** 2 + N ** 2 <= r * r
        E, N = E[inside], N[inside]
        la, lo = destination(lat, lon, E, N)
        h = self.rh.height(la, lo)
        A = np.stack([np.ones_like(E), E, N], axis=1)
        coef, *_ = np.linalg.lstsq(A, h, rcond=None)
        out["slopeDeg"] = math.degrees(math.atan(math.hypot(coef[1], coef[2])))
        out["reliefM"] = float(np.max(np.abs(h - A @ coef)))
        wc = self.wc.nearest(la, lo)
        allowed = np.isin(wc, ALLOWED_WC)
        out["allowedFraction"] = float(allowed.mean())
        out["centreClass"] = int(self.wc.nearest(np.array([lat]), np.array([lon]))[0])
        # shore distance on a 10 m grid out to 2 km
        k2 = np.arange(-2000.0, 2000.0 + 1e-6, 10.0)
        E2, N2 = np.meshgrid(k2, k2)
        la2, lo2 = destination(lat, lon, E2.ravel(), N2.ravel())
        wat = self.water(la2, lo2)
        out["shoreDistanceM"] = float(np.min(np.hypot(E2.ravel(), N2.ravel())[wat])) if wat.any() else 2000.0
        # open ocean to the east
        out["oceanRays"] = self._rays(lat, lon)
        out["pass"] = self._passes(out)
        return out

    def _rays(self, lat: float, lon: float) -> dict:
        """Open ocean to the east: every ray of the sector reaches the sea within oceanReachKm (the pad's own
        coast, where headlands may still be crossed), and the sector between oceanReachKm and openOceanKm
        holds no land at all."""
        c = self.cfg
        a0, a1 = c["oceanAzimuthDeg"]
        reach = c["oceanReachKm"] * 1000.0
        far = c["openOceanKm"] * 1000.0
        worst_reach = 0.0
        nearest_land_beyond = math.inf
        for az in np.arange(a0, a1 + 1e-6, 2.0):
            s = np.concatenate([np.arange(0.0, reach, 15.0), np.arange(reach, far + 1.0, 100.0)])
            la, lo = destination(lat, lon, s * math.sin(math.radians(az)), s * math.cos(math.radians(az)))
            wet = self.water(la, lo)
            near = s < reach
            idx = np.nonzero(wet & near)[0]
            if idx.size == 0:
                return {"ok": False, "failAzimuthDeg": float(az), "reason": "no sea within reach"}
            worst_reach = max(worst_reach, float(s[idx[0]]))
            dry = np.nonzero(~wet & ~near)[0]
            if dry.size:
                return {"ok": False, "failAzimuthDeg": float(az),
                        "reason": f"land at {s[dry[0]] / 1000:.1f} km"}
        return {"ok": True, "maxCoastDistanceM": worst_reach}

    def failures(self, e: dict) -> list[str]:
        c = self.cfg
        f = []
        if e["height"] < c["minHeightM"]:
            f.append("height")
        if e["shoreDistanceM"] < c["minShoreDistanceM"]:
            f.append("shore")
        if e["slopeDeg"] >= c["maxSlopeDeg"]:
            f.append("slope")
        if e["reliefM"] > c["maxReliefM"]:
            f.append("relief")
        if e["centreClass"] not in ALLOWED_WC or e["allowedFraction"] < c["minAllowedFraction"]:
            f.append("landcover")
        if e["latDeg"] >= c["maxLatDeg"]:
            f.append("latitude")
        if not e["oceanRays"]["ok"]:
            f.append("ocean")
        return f

    def _passes(self, e: dict) -> bool:
        return not self.failures(e)

    # -- gridded pre-filter -------------------------------------------------------------------------------
    def candidates(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict]:
        c = self.cfg
        n = c["nominal"]
        g = float(c["gridM"])
        r = float(c["discRadiusM"])
        span = (c["searchRadiusKm"] * 1000.0) + r + 1000.0
        k = np.arange(-span, span + 1e-6, g)
        E, N = np.meshgrid(k, k)            # row = north offset ascending
        log(f"site: candidate grid {E.shape[0]} x {E.shape[1]} at {g:g} m")
        LA, LO = destination(n["latDeg"], n["lonDeg"], E.ravel(), N.ravel())
        H = np.empty(LA.size)
        for i in range(0, LA.size, 2_000_000):
            H[i:i + 2_000_000] = self.rh.height(LA[i:i + 2_000_000], LO[i:i + 2_000_000])
        H = H.reshape(E.shape)
        WC = self.wc.nearest(LA, LO).reshape(E.shape)
        water = (H < 0.0) | (WC == WATER)
        shore = ndimage.distance_transform_edt(~water) * g
        rr = int(math.ceil(r / g))
        ky, kx = np.mgrid[-rr:rr + 1, -rr:rr + 1] * g
        disc = (kx ** 2 + ky ** 2 <= r * r).astype(np.float64)
        nd = disc.sum()
        sxx = (kx ** 2 * disc).sum()
        mean = signal.fftconvolve(H, disc, mode="same") / nd
        bx = signal.fftconvolve(H, (kx * disc)[::-1, ::-1], mode="same") / sxx
        by = signal.fftconvolve(H, (ky * disc)[::-1, ::-1], mode="same") / sxx
        slope = np.degrees(np.arctan(np.hypot(bx, by)))
        allowed = np.isin(WC, ALLOWED_WC).astype(np.float64)
        frac = signal.fftconvolve(allowed, disc, mode="same") / nd
        dist = np.hypot(E, N)
        ok = ((H >= c["minHeightM"]) & (shore >= c["minShoreDistanceM"]) & (shore <= c["oceanReachKm"] * 1000.0)
              & (slope < c["maxSlopeDeg"] + 0.5)
              & (allowed > 0) & (frac >= c["minAllowedFraction"] - 0.05) & (LA.reshape(E.shape) < c["maxLatDeg"])
              & (dist <= c["searchRadiusKm"] * 1000.0))
        stats = {"cells": int(E.size), "prefilterPass": int(ok.sum()), "landCells": int((~water).sum())}
        idx = np.nonzero(ok.ravel())[0]
        order = idx[np.argsort(dist.ravel()[idx])]
        self.grid = {"E": E, "N": N, "H": H, "WC": WC, "water": water, "shore": shore, "slope": slope,
                     "frac": frac, "mean": mean, "LA": LA.reshape(E.shape), "LO": LO.reshape(E.shape)}
        return LA[order], LO[order], dist.ravel()[order], stats

    def resolve(self) -> dict:
        n = self.cfg["nominal"]
        la, lo, dist, stats = self.candidates()
        log(f"site: {stats['prefilterPass']} grid candidates pass the pre-filter")
        tested = 0
        best = None
        for a, b, d in zip(la, lo, dist):
            tested += 1
            if tested % 2000 == 0:
                log(f"site: {tested} candidates tested, now at {d / 1000:.2f} km from nominal")
            if not self._rays(float(a), float(b))["ok"]:      # cheap and the most selective test first
                continue
            e = self.evaluate(float(a), float(b))
            if e["pass"]:
                best = e
                break
        if best is None:
            raise RuntimeError("site: no location satisfies the criteria within the search radius")
        log(f"site: grid winner at {gc_distance_m(n['latDeg'], n['lonDeg'], best['latDeg'], best['lonDeg']) / 1000:.3f} km "
            f"after {tested} explicit evaluations")
        # refinement: 5 m grid within +-45 m of the winner
        refined = best
        bd = gc_distance_m(n["latDeg"], n["lonDeg"], best["latDeg"], best["lonDeg"])
        for de in np.arange(-45.0, 46.0, 5.0):
            for dn in np.arange(-45.0, 46.0, 5.0):
                a, b = destination(best["latDeg"], best["lonDeg"], de, dn)
                d = gc_distance_m(n["latDeg"], n["lonDeg"], float(a), float(b))
                if d >= bd:
                    continue
                e = self.evaluate(float(a), float(b))
                if e["pass"]:
                    refined, bd = e, d
        refined["distanceFromNominalM"] = float(bd)
        refined["explicitEvaluations"] = tested
        refined["grid"] = stats
        return refined


def resolve_site(region_id: str) -> dict:
    reg = regmod.load(region_id)
    res = SiteResolver(reg).resolve()
    site_id = reg["site"]
    loc = {"latDeg": round(res["latDeg"], 6), "lonDeg": round(res["lonDeg"], 6),
           "padElevation": round(float(res["height"]), 2)}
    write_json(paths.SITES_DIR / f"{site_id}.location.json", loc)
    regmod.set_centre(reg, loc["latDeg"], loc["lonDeg"])
    report = {k: v for k, v in res.items()}
    report["location"] = loc
    write_json(paths.OUT / f"site-{site_id}.json", report)
    log(f"site: {site_id} -> {loc} ({res['distanceFromNominalM']:.0f} m from nominal; slope {res['slopeDeg']:.2f} deg, "
        f"shore {res['shoreDistanceM']:.0f} m, class {res['centreClass']}, allowed {res['allowedFraction']:.2f})")
    return report
