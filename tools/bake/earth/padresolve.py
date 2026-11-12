"""Pad resolution of a launch site (work package site-bake; ARCHITECTURE 9.3): the pads of the launch complex on
real, flat, dry ground clear of the shore, by the rule that placed LC-1.

    python -I tools/bake/earth/bake.py pads --region earth-madrakah --site madrakah --nominal 19.0,57.8
    python -I tools/bake/earth/bake.py pads --region earth-ka-lae --site ka-lae --nominal 18.987556,-155.603239 \
        --fixed lc-1:heavy:18.987556:-155.603239:21.62

Inputs are ARGUMENTS only: the site id, the nominal point the complex is resolved around, the region (whose
`siteResolution` block is the rule that placed LC-1, and whose baked tiles are the ground) and the pads that stay
where they are. No site file is read (the sites are renamed in parallel by sim-core-v2).

Ground: the BAKED tiles of the region, staged or live (stage.py): height = bilinear interpolation of the level-12
vertex grid, i.e. the collision surface and the rendered surface (ARCHITECTURE 10.2); water = height below sea
level or water mask >= 50 % (the coastline of the ocean and inland water); land cover = level-12 classes.
Beyond the finest coverage (ocean rays far out) the global level 7 answers.

The rule per pad is the brief's "flat, dry, clear of the shore": the ground tests of the rule that placed LC-1, with
its numbers (the region's siteResolution; LC-1's are those of earth-ka-lae.json):
  FLAT   plane through the heights of the disc of radius discRadiusM (10 m grid): slope < maxSlopeDeg and no point
         further than maxReliefM from the plane;
  DRY    bare, dry ground as LC-1's land-cover test: the centre and at least minAllowedFraction of the disc are
         WorldCover "bare / sparse vegetation" or "moss and lichen" (site.ALLOWED_WC), which the regional land
         cover stores as bareRock, sand or sparseScrub (never water, wetland, trees, crops, grass or built-up);
  CLEAR OF THE SHORE  nearest water (sea or inland, 10 m grid) >= minShoreDistanceM, natural height at the centre
         >= minHeightM; and latitude < maxLatDeg.
  ON THE COAST  the sea within oceanReachKm (any direction).
  NO SETTLEMENT  no built-up land (WorldCover 50) within max(blend radius, keep-out radius) of the pad's class plus
         BUILT_MARGIN_M.
  A LAUNCH CORRIDOR  the sector of launch azimuths CORRIDOR_AZ out to CORRIDOR_KM is free of built-up land and of
         every other pad's keep-out disc, and the pad's own keep-out disc lies in no other pad's corridor
         (ARCHITECTURE 9.4: range safety destroys a vehicle whose impact point enters another pad's keep-out radius),
         so pads string out ACROSS the launch direction.
  NOT EXCLUDED  outside every --exclude circle: ground rejected after LOOKING at the level-12 imagery (a wadi bed, a
         road, a borrow pit; recorded with its reason in the pads file).
LC-1's site-selection test, the open ocean sector (every azimuth of oceanAzimuthDeg reaches the sea within
oceanReachKm, then no land out to openOceanKm), is gated with --strict (the full rule that placed LC-1: Madrakah)
and otherwise reported (Ka Lae, where with it gated no second pad exists within 45 km of LC-1).
Spacing (ARCHITECTURE 9.3): heavy pads at least 2.5 km apart, medium 1.5 km, light 1 km. Each pad owns a disc of
half its class spacing and no two discs overlap, i.e. pads of classes a and b are at least (s_a + s_b) / 2 apart:
exactly the class spacing between pads of one class, 1.75 km between a heavy and a light pad.
Placement: heavy pads first, then medium, then light; each pad on the passing point of a 30 m grid (gridM) nearest
to the nominal point that keeps the spacing to every pad placed before it (the fixed pads first). If not every pad
fits within the search radius the run stops and says which test stopped it.
Reported per pad: slope, relief, roughness at 10 m (RMS height difference of points 10 m apart in the disc), RMS
deviation from the plane, distance to water, land-cover share, the ocean rays.

Output: data/staged/sites/<site>.pads.json (pads in placement order; the first is the site's reference point,
offsetEnu are metres east/north of it), out/bake/earth/site-bake/pads-<site>.json (with the search statistics).
"""
from __future__ import annotations

import json
import math
import time
from pathlib import Path

import numpy as np
from scipy import ndimage, signal

from common import cube, layout
from earth import paths, region as regmod, tiles
from earth.hpyramid import locate
from earth.landcover import CLASS
from earth.site import destination, gc_distance_m
from earth.util import log, write_json

STAGED_SITES = paths.REPO / "data" / "staged" / "sites"
OUT = paths.OUT / "site-bake"
CLASS_ORDER = ("heavy", "medium", "light")
CLASS_NAME = {v: k for k, v in CLASS.items()}
WET = [CLASS["water"], CLASS["wetland"]]
BARE = ("bareRock", "sand", "sparseScrub")
BUILT = CLASS["builtUp"]
# flatten disc and keep-out radius per class (m): heavy = LC-1's pad (450 / 900), light = fleet-docking 5.1
# (150 / 300), medium between; keep-out radii = UniverseRules.pads.keepOutRadius defaults (ARCHITECTURE 9.4)
PAD_RADII = {"heavy": {"flat": 450.0, "blend": 900.0, "keepOut": 600.0},
             "medium": {"flat": 300.0, "blend": 600.0, "keepOut": 450.0},
             "light": {"flat": 150.0, "blend": 300.0, "keepOut": 300.0}}
BUILT_MARGIN_M = 300.0
CORRIDOR_AZ = (60.0, 130.0)
CORRIDOR_KM = 12.0


def built_radius(cls: str) -> float:
    return max(PAD_RADII[cls]["blend"], PAD_RADII[cls]["keepOut"]) + BUILT_MARGIN_M


def bearing_deg(lat1, lon1, lat2, lon2):
    """Initial great-circle bearing (deg clockwise from north) from point 1 to point 2 (arrays allowed)."""
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(np.asarray(lon2) - lon1)
    return (np.degrees(np.arctan2(np.sin(dl) * np.cos(p2), np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)))
            + 360.0) % 360.0


def disc_hits_sector(d, b, r, az=CORRIDOR_AZ, reach_m=CORRIDOR_KM * 1000.0):
    """Does a disc of radius r whose centre lies at distance d and bearing b from an apex intersect the sector of
    azimuths az out to reach_m? (Arrays allowed.)"""
    d, b, r = np.asarray(d, float), np.asarray(b, float), np.asarray(r, float)
    half = np.degrees(np.arcsin(np.clip(r / np.maximum(d, 1e-9), 0.0, 1.0)))
    mid, wid = 0.5 * (az[0] + az[1]), 0.5 * (az[1] - az[0])
    off = np.abs((b - mid + 180.0) % 360.0 - 180.0)
    return (d <= r) | ((d - r <= reach_m) & (off <= wid + half))


# -- the ground: baked tiles ----------------------------------------------------------------------------------
class Field:
    """One layer of the baked tile set at the finest regional level, the global level 7 where that level has no
    tile. Heights: bilinear on the vertex grid (the collision surface); u8 layers: the texel containing the point."""

    def __init__(self, layer: str, level: int):
        self.layer, self.level = layer, level
        self.cache: dict = {}

    def _tile(self, level: int, f: int, x: int, y: int):
        k = (level, f, x, y)
        if k not in self.cache:
            if len(self.cache) > 1500:
                for old in list(self.cache)[:500]:
                    del self.cache[old]
            if self.layer == "height":
                t = tiles.read_height(f, level, x, y)
                self.cache[k] = None if t is None else np.asarray(t[1:258, 1:258], np.float64)
            else:
                self.cache[k] = tiles.read_u8(self.layer, f, level, x, y)
        return self.cache[k]

    def _sample(self, level: int, d: np.ndarray) -> np.ndarray:
        face, x, y, u, v = locate(d, level)
        n = 2 ** level
        key = (face * n + y) * n + x
        order = np.argsort(key, kind="stable")
        ks, starts = np.unique(key[order], return_index=True)
        ends = np.append(starts[1:], key.size)
        out = np.full(key.size, np.nan)
        for k, a, b in zip(ks, starts, ends):
            idx = order[a:b]
            t = self._tile(level, int(k // (n * n)), int(k % n), int((k // n) % n))
            if t is None:
                continue
            if self.layer == "height":
                gi, gj = u[idx] * 256.0, v[idx] * 256.0
                i0 = np.minimum(np.floor(gi).astype(np.int64), 255)
                j0 = np.minimum(np.floor(gj).astype(np.int64), 255)
                fx, fy = gi - i0, gj - j0
                out[idx] = ((t[j0, i0] * (1 - fx) + t[j0, i0 + 1] * fx) * (1 - fy)
                            + (t[j0 + 1, i0] * (1 - fx) + t[j0 + 1, i0 + 1] * fx) * fy)
            else:
                out[idx] = t[np.minimum((v[idx] * 256).astype(np.int64), 255), np.minimum((u[idx] * 256).astype(np.int64), 255)]
        return out

    def __call__(self, lat, lon) -> np.ndarray:
        lat = np.ravel(np.asarray(lat, np.float64))
        lon = np.ravel(np.asarray(lon, np.float64))
        out = np.empty(lat.size)
        for i in range(0, lat.size, 2_000_000):
            d = cube.lat_lon_to_dir(np.radians(lat[i:i + 2_000_000]), np.radians(lon[i:i + 2_000_000]))
            v = self._sample(self.level, d)
            miss = np.isnan(v)
            if miss.any():
                v[miss] = self._sample(paths.GLOBAL_MAX_LEVEL, d[miss])
            out[i:i + 2_000_000] = v
        return out


class Ground:
    def __init__(self, region: dict):
        lv = regmod.levels(region)[-1]
        self.level = lv
        self.h = Field("height", lv)
        self.wm = Field("watermask", lv)
        self.lc = Field("landcover", lv)

    def water(self, lat, lon, h=None) -> np.ndarray:
        h = self.h(lat, lon) if h is None else h
        return (h < 0.0) | (self.wm(lat, lon) >= 128)


# -- the rule ---------------------------------------------------------------------------------------------------
class Resolver:
    def __init__(self, region: dict, nominal: tuple[float, float], search_km: float | None, strict: bool = False,
                 excludes: list | None = None):
        self.region = region
        self.strict = strict           # the full rule that placed LC-1: the open-ocean sector gated too
        self.excludes = excludes or []  # [(lat, lon, radius m, reason)]: ground rejected after looking at it
        self.cfg = dict(region["siteResolution"])
        self.nominal = nominal
        self.search_m = (search_km if search_km is not None else float(self.cfg["searchRadiusKm"])) * 1000.0
        # bare ground as LC-1 was placed (site.ALLOWED_WC: WorldCover 60 bare / sparse vegetation and 100 moss and
        # lichen, which the regional land cover stores as bareRock, sand or sparseScrub)
        self.allowed = [CLASS[c] for c in BARE]
        if getattr(self, "dry_any_land", False):
            self.allowed = [v for k, v in CLASS.items() if k not in ("water", "wetland", "builtUp", "unknown")]
        self.ground = Ground(region)

    def evaluate(self, lat: float, lon: float, full: bool = True) -> dict:
        """The rule at one point. full=False stops after the disc tests (height, slope, relief, dry, latitude) when
        one of them fails: the shore window and the ocean rays cost twenty times more, and a failed candidate is
        never reported."""
        c = self.cfg
        g = self.ground
        out: dict = {"latDeg": lat, "lonDeg": lon}
        out["height"] = float(g.h(np.array([lat]), np.array([lon]))[0])
        r = float(c["discRadiusM"])
        k = np.arange(-r, r + 1e-6, 10.0)
        E, N = np.meshgrid(k, k)
        inside = E ** 2 + N ** 2 <= r * r
        la, lo = destination(lat, lon, E.ravel(), N.ravel())
        H = g.h(la, lo).reshape(E.shape)
        A = np.stack([np.ones(int(inside.sum())), E[inside], N[inside]], axis=1)
        coef, *_ = np.linalg.lstsq(A, H[inside], rcond=None)
        res = H[inside] - A @ coef
        out["slopeDeg"] = math.degrees(math.atan(math.hypot(coef[1], coef[2])))
        out["reliefM"] = float(np.max(np.abs(res)))
        out["planeRmsM"] = float(np.sqrt(np.mean(res ** 2)))
        both_e = inside[:, 1:] & inside[:, :-1]
        both_n = inside[1:, :] & inside[:-1, :]
        d10 = np.concatenate([(H[:, 1:] - H[:, :-1])[both_e], (H[1:, :] - H[:-1, :])[both_n]])
        out["roughness10M"] = float(np.sqrt(np.mean(d10 ** 2)))
        lc = g.lc(la, lo).reshape(E.shape)[inside]
        out["allowedFraction"] = float(np.isin(lc, self.allowed).mean())
        out["dryFraction"] = float((~np.isin(lc, WET)).mean())
        cls = int(g.lc(np.array([lat]), np.array([lon]))[0])
        out["centreClass"] = CLASS_NAME.get(cls, str(cls))
        out["centreAllowed"] = cls in self.allowed
        out["centreDry"] = cls not in WET
        out["excluded"] = [x[3] for x in self.excludes if gc_distance_m(lat, lon, x[0], x[1]) <= x[2]]

        def stop():
            f = self.failures(out)
            return {**out, "failures": f, "pass": False, "partial": True} if (f and not full) else None
        if (r_ := stop()) is not None:
            return r_
        k2 = np.arange(-3000.0, 3000.0 + 1e-6, 10.0)
        E2, N2 = np.meshgrid(k2, k2)
        la2, lo2 = destination(lat, lon, E2.ravel(), N2.ravel())
        wat = g.water(la2, lo2)
        dist = np.hypot(E2.ravel(), N2.ravel())
        out["shoreDistanceM"] = float(dist[wat].min()) if wat.any() else 3000.0
        out["shoreBeyondWindow"] = not bool(wat.any())          # no water in the 6 x 6 km window: farther than 3 km
        reach = float(c["oceanReachKm"]) * 1000.0
        k3 = np.arange(-reach, reach + 1e-6, 50.0)
        E3, N3 = np.meshgrid(k3, k3)
        la3, lo3 = destination(lat, lon, E3.ravel(), N3.ravel())
        sea = g.h(la3, lo3) < 0.0
        d3 = np.hypot(E3.ravel(), N3.ravel())
        out["seaDistanceM"] = float(d3[sea].min()) if sea.any() else None
        if (r_ := stop()) is not None:
            return r_
        rb = max(built_radius(c_) for c_ in PAD_RADII) + 300.0
        k4 = np.arange(-rb, rb + 1e-6, 10.0)
        E4, N4 = np.meshgrid(k4, k4)
        la4, lo4 = destination(lat, lon, E4.ravel(), N4.ravel())
        built = g.lc(la4, lo4) == BUILT
        d4 = np.hypot(E4.ravel(), N4.ravel())
        out["builtUpM"] = float(d4[built].min()) if built.any() else None      # None: none within rb
        out["builtUpWindowM"] = rb
        if (r_ := stop()) is not None:
            return r_
        out["oceanRays"] = self.rays(lat, lon)
        if (r_ := stop()) is not None:
            return r_
        out["corridorBuiltUp"] = self.corridor_built(lat, lon)
        out["failures"] = self.failures(out)
        out["pass"] = not out["failures"]
        return out

    def corridor_built(self, lat: float, lon: float, az=CORRIDOR_AZ, reach_m: float = CORRIDOR_KM * 1000.0,
                       step_deg: float = 0.25, step_m: float = 20.0):
        """The nearest built-up texel inside the launch sector (distance m, azimuth deg), or None."""
        s = np.arange(step_m, reach_m + 1.0, step_m)
        a = np.arange(az[0], az[1] + 1e-6, step_deg)
        S, A = np.meshgrid(s, np.radians(a))
        la, lo = destination(lat, lon, (S * np.sin(A)).ravel(), (S * np.cos(A)).ravel())
        b = (self.ground.lc(la, lo) == BUILT).reshape(S.shape)
        if not b.any():
            return None
        i, j = np.unravel_index(np.argmin(np.where(b, S, np.inf)), S.shape)
        return {"distanceM": float(S[i, j]), "azimuthDeg": float(a[i])}

    def rays(self, lat: float, lon: float) -> dict:
        """LC-1's test: every ray of the sector reaches the sea within oceanReachKm, and the sector between
        oceanReachKm and openOceanKm holds no land at all."""
        c = self.cfg
        a0, a1 = c["oceanAzimuthDeg"]
        reach = c["oceanReachKm"] * 1000.0
        far = c["openOceanKm"] * 1000.0
        s = np.concatenate([np.arange(0.0, reach, 15.0), np.arange(reach, far + 1.0, 100.0)])
        az = np.arange(a0, a1 + 1e-6, 2.0)
        S, AZ = np.meshgrid(s, np.radians(az))
        la, lo = destination(lat, lon, (S * np.sin(AZ)).ravel(), (S * np.cos(AZ)).ravel())
        wet = self.ground.water(la, lo).reshape(S.shape)
        near = s < reach
        worst = 0.0
        for i, a in enumerate(az):
            idx = np.nonzero(wet[i] & near)[0]
            if idx.size == 0:
                return {"ok": False, "failAzimuthDeg": float(a), "reason": "no sea within reach"}
            worst = max(worst, float(s[idx[0]]))
            dry = np.nonzero(~wet[i] & ~near)[0]
            if dry.size:
                return {"ok": False, "failAzimuthDeg": float(a), "reason": f"land at {s[dry[0]] / 1000:.1f} km"}
        return {"ok": True, "maxCoastDistanceM": worst}

    def failures(self, e: dict) -> list[str]:
        """The gates: flat (slope, relief), dry (bare ground), clear of the shore (shore, height), latitude."""
        c = self.cfg
        f = []
        if e["height"] < c["minHeightM"]:
            f.append("height")
        if "shoreDistanceM" in e and e["shoreDistanceM"] < c["minShoreDistanceM"]:
            f.append("shore")
        if e["slopeDeg"] >= c["maxSlopeDeg"]:
            f.append("slope")
        if e["reliefM"] > c["maxReliefM"]:
            f.append("relief")
        if not e["centreAllowed"] or e["allowedFraction"] < c["minAllowedFraction"]:
            f.append("dry")
        if e["latDeg"] >= c["maxLatDeg"]:
            f.append("latitude")
        if e.get("excluded"):
            f.append("excluded")
        if "seaDistanceM" in e and (e["seaDistanceM"] is None or e["seaDistanceM"] > float(c["oceanReachKm"]) * 1000.0):
            f.append("coast")
        if "builtUpM" in e and e["builtUpM"] is not None and e["builtUpM"] < min(built_radius(k) for k in PAD_RADII):
            f.append("builtUp")
        if self.strict and "oceanRays" in e:
            f += [k for k, ok in self.site_tests(e, c).items() if not ok]
        if e.get("corridorBuiltUp") is not None:
            f.append("corridorBuiltUp")
        return f

    @staticmethod
    def site_tests(e: dict, c: dict) -> dict:
        """LC-1's site-selection test, reported: the open ocean sector."""
        return {"oceanSector": bool(e["oceanRays"]["ok"])}

    # -- gridded pre-filter (necessary conditions, cheap) ---------------------------------------------------
    def grid(self) -> dict:
        c = self.cfg
        g = float(c["gridM"])
        r = float(c["discRadiusM"])
        span = self.search_m + r + 1000.0
        k = np.arange(-span, span + 1e-6, g)
        E, N = np.meshgrid(k, k)
        log(f"pads: candidate grid {E.shape[0]} x {E.shape[1]} at {g:g} m")
        LA, LO = destination(self.nominal[0], self.nominal[1], E.ravel(), N.ravel())
        H = self.ground.h(LA, LO).reshape(E.shape)
        WM = self.ground.wm(LA, LO).reshape(E.shape)
        LC = self.ground.lc(LA, LO).reshape(E.shape)
        water = (H < 0.0) | (WM >= 128)
        shore = ndimage.distance_transform_edt(~water) * g
        sea_d = ndimage.distance_transform_edt(~(H < 0.0)) * g
        built_d = ndimage.distance_transform_edt(~(LC == BUILT)) * g
        # built-up land in the launch sector: the built-up cells convolved with the sector seen backwards (a cell
        # whose corridor holds built-up land lies in the opposite sector of that land), on the candidate grid
        rk = int(math.ceil(CORRIDOR_KM * 1000.0 / g))
        yy, xx = np.mgrid[-rk:rk + 1, -rk:rk + 1]
        ang = (np.degrees(np.arctan2(xx, yy)) + 360.0) % 360.0          # bearing of offset (east = +x, north = +y)
        sector = ((xx ** 2 + yy ** 2) * g * g <= (CORRIDOR_KM * 1000.0) ** 2) & (ang >= CORRIDOR_AZ[0]) & (ang <= CORRIDOR_AZ[1])
        # E/N grids: row index = north offset ascending, column = east ascending: a built-up cell at (r + dy, c + dx)
        # is in the corridor of (r, c) when (dx, dy) is in the sector
        hits = signal.fftconvolve((LC == BUILT).astype(np.float32), sector[::-1, ::-1].astype(np.float32), mode="same")
        corridor_clear = hits < 0.5
        rr = int(math.ceil(r / g))
        ky, kx = np.mgrid[-rr:rr + 1, -rr:rr + 1] * g
        disc = (kx ** 2 + ky ** 2 <= r * r).astype(np.float64)
        nd = disc.sum()
        sxx = (kx ** 2 * disc).sum()
        bx = signal.fftconvolve(H, (kx * disc)[::-1, ::-1], mode="same") / sxx
        by = signal.fftconvolve(H, (ky * disc)[::-1, ::-1], mode="same") / sxx
        slope = np.degrees(np.arctan(np.hypot(bx, by)))
        # RMS deviation from the plane through the disc (the disc's 1, e, n are orthogonal): the largest deviation,
        # which the rule bounds by maxReliefM, is never smaller than it
        mean = signal.fftconvolve(H, disc, mode="same") / nd
        ss = signal.fftconvolve(H * H, disc, mode="same") - nd * mean ** 2 - sxx * (bx ** 2 + by ** 2)
        plane_rms = np.sqrt(np.maximum(ss, 0.0) / nd)
        dry = np.isin(LC, self.allowed)
        frac = signal.fftconvolve(dry.astype(np.float64), disc, mode="same") / nd
        dist = np.hypot(E, N)
        ocean = np.ones(E.shape, bool)
        if self.strict:
            # a necessary condition of LC-1's ocean test (rays): the rays at every 10 deg of the sector reach water
            # within oceanReachKm. Each ray is a line three cells wide, two cells longer than the reach, correlated
            # with the water cells (the explicit rays sample at 15 m and 2 deg steps that include these azimuths)
            reach_c = int(math.ceil(float(c["oceanReachKm"]) * 1000.0 / g)) + 2
            a0, a1 = c["oceanAzimuthDeg"]
            for az in np.arange(a0, a1 + 1e-6, 10.0):
                line = np.zeros((2 * reach_c + 3, 2 * reach_c + 3), np.float32)
                s = np.arange(0.0, reach_c + 0.5, 0.25)
                cx = np.round(reach_c + 1 + s * math.sin(math.radians(az))).astype(int)
                cy = np.round(reach_c + 1 + s * math.cos(math.radians(az))).astype(int)
                for oy in (-1, 0, 1):
                    for ox in (-1, 0, 1):
                        line[cy + oy, cx + ox] = 1.0
                ocean &= signal.fftconvolve(water.astype(np.float32), line[::-1, ::-1], mode="same") > 0.5
        tests = {
            "ocean": ocean,
            "height": H >= c["minHeightM"],
            "shore": shore >= c["minShoreDistanceM"] - g,
            "slope": slope < c["maxSlopeDeg"] + 0.5,
            "relief": plane_rms <= c["maxReliefM"],
            "dry": dry & (frac >= c["minAllowedFraction"] - 0.05),
            "latitude": LA.reshape(E.shape) < c["maxLatDeg"],
            "coast": sea_d <= float(c["oceanReachKm"]) * 1000.0 + g,
            "builtUp": built_d >= min(built_radius(k) for k in PAD_RADII) - g,
            "corridorBuiltUp": corridor_clear,
            "search": dist <= self.search_m,
        }
        ok = np.ones(E.shape, bool)
        stats = {"cells": int(E.size), "landCells": int((~water & (dist <= self.search_m)).sum())}
        for name, t in tests.items():
            ok &= t
            stats[f"after{name.capitalize()}"] = int(ok.sum())
        idx = np.nonzero(ok.ravel())[0]
        order = idx[np.argsort(dist.ravel()[idx], kind="stable")]
        return {"lat": LA[order], "lon": LO[order], "dist": dist.ravel()[order], "stats": stats,
                "builtD": built_d.ravel()[order], "gridM": g}


# -- placement --------------------------------------------------------------------------------------------------
def parse_classes(spec: str) -> dict:
    out = {}
    for part in spec.split(","):
        name, rest = part.split("=")
        n, s = rest.split(":")
        out[name.strip()] = {"count": int(n), "spacingM": float(s)}
    if set(out) != set(CLASS_ORDER):
        raise ValueError(f"--classes must name {CLASS_ORDER}")
    return out


def min_distance(classes: dict, a: str, b: str) -> float:
    """Each pad owns a disc of half its class spacing; discs do not overlap."""
    return 0.5 * (classes[a]["spacingM"] + classes[b]["spacingM"])


def place(res: Resolver, grid: dict, classes: dict, fixed: list[dict], partial: bool = False) -> tuple[list[dict], dict]:
    """partial=True: a pad that finds no place is recorded in tally["unplaced"] and the next class is tried (to
    measure how many pads a site holds); otherwise the run stops there."""
    placed = list(fixed)
    evaluated: dict[int, dict] = {}
    tally = {"explicit": 0, "rejected": {}, "unplaced": {}}
    clat, clon = grid["lat"], grid["lon"]
    dist_to = [gc_distance_m(p["latDeg"], p["lonDeg"], clat, clon) for p in placed]   # candidate distances per pad
    b_from = [bearing_deg(p["latDeg"], p["lonDeg"], clat, clon) for p in placed]       # pad -> candidate
    b_to = [bearing_deg(clat, clon, p["latDeg"], p["lonDeg"]) for p in placed]         # candidate -> pad
    for cls in CLASS_ORDER:
        need = classes[cls]["count"] - sum(1 for p in fixed if p["class"] == cls)
        if need < 0:
            raise ValueError(f"more fixed {cls} pads than the class count")
        for _ in range(need):
            found = None
            free = grid["builtD"] >= built_radius(cls) - grid["gridM"]      # the class's built-up clearance
            for p, d, bf, bt in zip(placed, dist_to, b_from, b_to):
                free &= d >= min_distance(classes, cls, p["class"])
                # the placed pad's keep-out disc stays out of the candidate's corridor, and the candidate's keep-out
                # disc out of the placed pad's corridor
                free &= ~disc_hits_sector(d, bt, PAD_RADII[p["class"]]["keepOut"])
                free &= ~disc_hits_sector(d, bf, PAD_RADII[cls]["keepOut"])
            for i in np.nonzero(free)[0]:
                i = int(i)
                la, lo = float(clat[i]), float(clon[i])
                if i not in evaluated:
                    e = res.evaluate(la, lo, full=False)
                    evaluated[i] = e
                    tally["explicit"] += 1
                    for f in e["failures"]:
                        tally["rejected"][f] = tally["rejected"].get(f, 0) + 1
                    if tally["explicit"] % 500 == 0:
                        log(f"pads: {tally['explicit']} explicit evaluations, now {grid['dist'][i] / 1000:.2f} km out")
                e = evaluated[i]
                if e["pass"] and (e["builtUpM"] is None or e["builtUpM"] >= built_radius(cls)):
                    found = e
                    break
            if found is None:
                msg = (f"pads: no place for another {cls} pad within {res.search_m / 1000:g} km of the nominal point "
                       f"({len(placed)} placed; explicit rejections {tally['rejected']}; grid {grid['stats']})")
                if not partial:
                    raise RuntimeError(msg)
                log(msg)
                tally["unplaced"][cls] = tally["unplaced"].get(cls, 0) + 1
                continue
            placed.append({"class": cls, "latDeg": found["latDeg"], "lonDeg": found["lonDeg"],
                           "padElevation": round(found["height"], 2), "fixed": False, "evaluation": found})
            dist_to.append(gc_distance_m(found["latDeg"], found["lonDeg"], clat, clon))
            b_from.append(bearing_deg(found["latDeg"], found["lonDeg"], clat, clon))
            b_to.append(bearing_deg(clat, clon, found["latDeg"], found["lonDeg"]))
            log(f"pads: {cls} pad {len(placed)} at {found['latDeg']:.6f} {found['lonDeg']:.6f}, "
                f"{gc_distance_m(res.nominal[0], res.nominal[1], found['latDeg'], found['lonDeg']) / 1000:.2f} km from nominal; "
                f"slope {found['slopeDeg']:.2f} deg, shore {found['shoreDistanceM']:.0f} m")
    return placed, tally


def bearing_offset(lat0: float, lon0: float, lat: float, lon: float) -> tuple[float, float]:
    """Azimuthal-equidistant (east, north) metres of (lat, lon) about (lat0, lon0): the inverse of site.destination."""
    p1, p2 = math.radians(lat0), math.radians(lat)
    dl = math.radians(lon - lon0)
    d = gc_distance_m(lat0, lon0, lat, lon)
    az = math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))
    return float(d * math.sin(az)), float(d * math.cos(az))


def run(region_id: str, args) -> dict:
    if not args.site or not args.nominal:
        raise ValueError("bake.py pads needs --site and --nominal")
    reg = regmod.load(region_id)
    nominal = tuple(float(v) for v in args.nominal.split(","))
    classes = parse_classes(args.classes)
    excludes = []
    for spec in getattr(args, "exclude", []) or []:
        la_, lo_, r_, reason = spec.split(":", 3)
        excludes.append((float(la_), float(lo_), float(r_), reason))
    Resolver.dry_any_land = bool(getattr(args, "dry_any_land", False))     # a measurement only (out/)
    res = Resolver(reg, nominal, args.search_km, strict=bool(getattr(args, "strict", False)), excludes=excludes)
    t0 = time.time()
    fixed = []
    for spec in args.fixed:
        pid, cls, la, lo, el = spec.split(":")
        e = res.evaluate(float(la), float(lo))
        fixed.append({"id": pid, "class": cls, "latDeg": float(la), "lonDeg": float(lo), "padElevation": float(el),
                      "fixed": True, "evaluation": e})
        log(f"pads: fixed {pid} ({cls}) at {la} {lo}: {'passes' if e['pass'] else 'fails ' + ', '.join(e['failures'])} "
            f"the rule on the baked tiles (height {e['height']:.2f} m, slope {e['slopeDeg']:.2f} deg)")
    grid = res.grid()
    log(f"pads: grid pre-filter {grid['stats']}")
    partial = bool(getattr(args, "allow_partial", False))
    placed, tally = place(res, grid, classes, fixed, partial=partial)
    used = {p["id"] for p in placed if "id" in p}
    n = 0
    for p in placed:
        if "id" not in p:
            n += 1
            while f"lc-{n}" in used:
                n += 1
            p["id"] = f"lc-{n}"
            used.add(p["id"])
    ref = placed[0]
    pads = []
    for p in placed:
        e = p["evaluation"]
        east, north = bearing_offset(ref["latDeg"], ref["lonDeg"], p["latDeg"], p["lonDeg"])
        pads.append({
            "id": p["id"], "class": p["class"], "latDeg": round(p["latDeg"], 6), "lonDeg": round(p["lonDeg"], 6),
            "padElevation": p["padElevation"], "azimuthDeg": float(args.azimuth),
            "offsetEnu": [round(east, 1), round(north, 1)], "fixed": p["fixed"],
            "report": {"naturalHeightM": round(e["height"], 2), "slopeDeg": round(e["slopeDeg"], 3),
                       "reliefM": round(e["reliefM"], 2), "planeRmsM": round(e["planeRmsM"], 3),
                       "roughness10M": round(e["roughness10M"], 3), "shoreDistanceM": round(e["shoreDistanceM"], 0),
                       "shoreBeyondWindow": e["shoreBeyondWindow"],
                       "dryFraction": round(e["dryFraction"], 3), "bareFraction": round(e["allowedFraction"], 3),
                       "seaDistanceM": None if e.get("seaDistanceM") is None else round(e["seaDistanceM"], 0),
                       "builtUpM": None if e.get("builtUpM") is None else round(e["builtUpM"], 0),
                       "builtUpWindowM": e.get("builtUpWindowM"),
                       "builtUpRadiusM": built_radius(p["class"]),
                       "centreClass": e["centreClass"], "oceanRays": e["oceanRays"],
                       "siteTests": Resolver.site_tests(e, res.cfg), "passes": e["pass"], "failures": e["failures"],
                       "distanceFromNominalM": round(gc_distance_m(nominal[0], nominal[1], p["latDeg"], p["lonDeg"]), 0)}})
    from earth import stage
    if stage.state(region_id) in stage.HIDDEN_STATES or (stage.state(region_id) == "staging" and stage.is_replace(region_id)):
        import hashlib
        pm = stage.prospective_manifest(region_id)
        content_hash = hashlib.sha256(json.dumps({k: v for k, v in pm.items() if k != "contentHash"},
                                                 sort_keys=True).encode("utf-8")).hexdigest()[:16]
    else:
        content_hash = layout.read_manifest(paths.TILESET).get("contentHash")
    doc = {
        "site": args.site, "region": region_id, "tileset": paths.TILESET, "bodyId": "earth",
        "nominal": {"latDeg": nominal[0], "lonDeg": nominal[1]},
        "ground": (f"baked tiles of {region_id} ({'staged' if stage.state(region_id) in stage.HIDDEN_STATES else 'live'} "
                   f"when resolved): level-{res.ground.level} heights (bilinear on the vertex grid: the collision "
                   f"surface), water mask and land cover; global level 7 beyond the finest coverage"),
        "tilesetContentHash": content_hash,
        "rule": {**{k: v for k, v in res.cfg.items() if k not in ("nominal", "allowedLandcover")},
                 "searchRadiusKm": res.search_m / 1000.0,
                 "gates": ("flat (slope, relief over the disc), dry (the centre and minAllowedFraction of the disc any "
                           "land cover but water, wetland and built-up: A MEASUREMENT, not the rule that placed LC-1)"
                           if Resolver.dry_any_land else
                           f"flat (slope, relief over the disc), dry (the centre and minAllowedFraction of the disc bare "
                           f"ground: {', '.join(BARE)}, i.e. WorldCover 60/100 as LC-1 was placed)")
                          + f", clear of the shore "
                          f"(minShoreDistanceM to any water, minHeightM), on the coast (the sea within oceanReachKm), no "
                          f"built-up land within max(blend, keep-out) + {BUILT_MARGIN_M:g} m, a launch corridor "
                          f"({CORRIDOR_AZ[0]:g}-{CORRIDOR_AZ[1]:g} deg to {CORRIDOR_KM:g} km free of built-up land and of "
                          f"every other pad's keep-out disc, both ways), not excluded after looking, latitude"
                          + ("; the open ocean sector (oceanAzimuthDeg, oceanReachKm, openOceanKm): the full rule that "
                             "placed LC-1" if res.strict else ""),
                 "reported": "" if res.strict else "the open ocean sector (oceanAzimuthDeg, oceanReachKm, openOceanKm)",
                 "strict": res.strict, "dry": "anyLand" if Resolver.dry_any_land else "bareGround",
                 "padRadii": PAD_RADII, "builtUpMarginM": BUILT_MARGIN_M,
                 "corridor": {"azimuthDeg": list(CORRIDOR_AZ), "reachKm": CORRIDOR_KM},
                 "excluded": [{"latDeg": x[0], "lonDeg": x[1], "radiusM": x[2], "reason": x[3]} for x in excludes],
                 "classes": classes, "spacing": "pads of classes a and b at least (spacing_a + spacing_b) / 2 apart"},
        "referencePad": ref["id"],
        "pads": pads,
    }
    doc["corridors"] = corridor_table(res, pads)
    if tally["unplaced"]:
        doc["unplaced"] = tally["unplaced"]
    dry = bool(getattr(args, "dry_run", False)) or bool(tally["unplaced"]) or Resolver.dry_any_land
    if not dry:
        STAGED_SITES.mkdir(parents=True, exist_ok=True)
        write_json(STAGED_SITES / f"{args.site}.pads.json", doc)
    OUT.mkdir(parents=True, exist_ok=True)
    if getattr(args, "candidate_out", None):
        cp = Path(args.candidate_out)
        cp.parent.mkdir(parents=True, exist_ok=True)
        write_json(cp, {**doc, "candidate": True, "unplaced": tally["unplaced"]})
    write_json(OUT / f"pads-{args.site}{'-dryrun' if dry else ''}.json",
               {**doc, "search": {"grid": grid["stats"], **tally, "seconds": round(time.time() - t0, 1)}})
    log(f"pads: {len(pads)} pads of {args.site} resolved" + (" (dry run: out/ only)" if dry else
                                                             f", written to {STAGED_SITES / (args.site + '.pads.json')}"))
    print(report_table(doc), flush=True)
    print(corridor_report(doc), flush=True)
    return doc


def corridor_table(res: Resolver, pads: list[dict]) -> list[dict]:
    """Per pad: the contiguous range of launch azimuths about 90 deg (0-180 deg, 0.5 deg steps) whose ray is free out
    to CORRIDOR_KM of built-up land and of every other pad's keep-out disc; the nearest other pad whose keep-out disc
    lies in the CORRIDOR_AZ sector (any distance) and the nearest built-up land in that sector out to 30 km."""
    out = []
    reach = CORRIDOR_KM * 1000.0
    for p in pads:
        a = np.arange(0.0, 180.0 + 1e-6, 0.5)
        s = np.arange(25.0, reach + 1.0, 25.0)
        S, A = np.meshgrid(s, np.radians(a))
        la, lo = destination(p["latDeg"], p["lonDeg"], (S * np.sin(A)).ravel(), (S * np.cos(A)).ravel())
        built = (res.ground.lc(la, lo) == BUILT).reshape(S.shape).any(axis=1)
        blocked = built.copy()
        others = [q for q in pads if q["id"] != p["id"]]
        for q in others:
            d = gc_distance_m(p["latDeg"], p["lonDeg"], q["latDeg"], q["lonDeg"])
            b = float(bearing_deg(p["latDeg"], p["lonDeg"], q["latDeg"], q["lonDeg"]))
            r = PAD_RADII[q["class"]]["keepOut"]
            for i, az in enumerate(a):
                blocked[i] |= bool(disc_hits_sector(d, b, r, az=(az, az), reach_m=reach))
        i0 = int(np.argmin(np.abs(a - 90.0)))
        lo_i = hi_i = i0
        if blocked[i0]:
            clear = None
        else:
            while lo_i > 0 and not blocked[lo_i - 1]:
                lo_i -= 1
            while hi_i < a.size - 1 and not blocked[hi_i + 1]:
                hi_i += 1
            clear = [float(a[lo_i]), float(a[hi_i])]
        near_pad = None
        for q in others:
            d = gc_distance_m(p["latDeg"], p["lonDeg"], q["latDeg"], q["lonDeg"])
            b = float(bearing_deg(p["latDeg"], p["lonDeg"], q["latDeg"], q["lonDeg"]))
            if bool(disc_hits_sector(d, b, PAD_RADII[q["class"]]["keepOut"], reach_m=1e9)):
                if near_pad is None or d < near_pad["distanceM"]:
                    near_pad = {"id": q["id"], "distanceM": round(d, 0), "bearingDeg": round(b, 1)}
        nb = res.corridor_built(p["latDeg"], p["lonDeg"], reach_m=30000.0, step_deg=0.5, step_m=25.0)
        out.append({"id": p["id"], "clearAzimuthDeg": clear, "nearestPadInSector": near_pad,
                    "nearestBuiltUpInSector30km": nb})
    return out


def corridor_report(doc: dict) -> str:
    rows = [f"| Pad | Clear launch azimuths (deg, free to {CORRIDOR_KM:g} km) | Nearest pad keep-out in the {CORRIDOR_AZ[0]:g}-{CORRIDOR_AZ[1]:g} deg sector | Nearest built-up land in the sector (to 30 km) |",
            "|---|---|---|---|"]
    for c in doc["corridors"]:
        clear = "blocked at 90" if c["clearAzimuthDeg"] is None else f"{c['clearAzimuthDeg'][0]:g}-{c['clearAzimuthDeg'][1]:g}"
        np_ = c["nearestPadInSector"]
        nb = c["nearestBuiltUpInSector30km"]
        rows.append(f"| {c['id']} | {clear} | " + (f"{np_['id']} at {np_['distanceM'] / 1000:.1f} km, {np_['bearingDeg']:.0f} deg" if np_ else "none") +
                    " | " + (f"{nb['distanceM'] / 1000:.1f} km at {nb['azimuthDeg']:.0f} deg" if nb else "none within 30 km") + " |")
    return "\n".join(rows)


def report_table(doc: dict) -> str:
    rows = ["| Pad | Class | Lat, lon | Elevation m | Slope deg | Relief m | Roughness 10 m (m) | Plane RMS m | Water m | Sea m | Built-up m (need) | Bare | Centre class | Ocean sector 60-130 | From nominal km |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for p in doc["pads"]:
        r = p["report"]
        oc = "open" if r["oceanRays"]["ok"] else f"no: {r['oceanRays']['failAzimuthDeg']:.0f} deg, {r['oceanRays']['reason']}"
        rows.append(f"| {p['id']}{' (fixed)' if p['fixed'] else ''} | {p['class']} | {p['latDeg']:.6f}, {p['lonDeg']:.6f} | "
                    f"{p['padElevation']:.2f} | {r['slopeDeg']:.2f} | {r['reliefM']:.1f} | {r['roughness10M']:.2f} | "
                    f"{r['planeRmsM']:.2f} | {'> ' if r['shoreBeyondWindow'] else ''}{r['shoreDistanceM']:.0f} | "
                    f"{'-' if r.get('seaDistanceM') is None else format(r['seaDistanceM'], '.0f')} | "
                    f"{('> ' + format(r['builtUpWindowM'], '.0f')) if r.get('builtUpM') is None else format(r['builtUpM'], '.0f')} ({r['builtUpRadiusM']:.0f}) | {r['bareFraction']:.2f} | "
                    f"{r['centreClass']} | {oc} | {r['distanceFromNominalM'] / 1000:.2f} |")
    return "\n".join(rows)
