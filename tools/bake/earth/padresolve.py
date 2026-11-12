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
LC-1's site-selection test, the open ocean sector (every azimuth of oceanAzimuthDeg reaches the sea within
oceanReachKm, then no land out to openOceanKm), is evaluated and REPORTED per pad, not gated: with it gated no
second pad exists within 45 km of LC-1 (the hand-off, "Pads", has the numbers). --strict gates it too (a measurement).
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
    def __init__(self, region: dict, nominal: tuple[float, float], search_km: float | None, strict: bool = False):
        self.region = region
        self.strict = strict           # also gate LC-1's site-selection tests (to measure how far they reach)
        self.cfg = dict(region["siteResolution"])
        self.nominal = nominal
        self.search_m = (search_km if search_km is not None else float(self.cfg["searchRadiusKm"])) * 1000.0
        # bare ground as LC-1 was placed (site.ALLOWED_WC: WorldCover 60 bare / sparse vegetation and 100 moss and
        # lichen, which the regional land cover stores as bareRock, sand or sparseScrub)
        self.allowed = [CLASS[c] for c in BARE]
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
        disc_failures = [f for f in self.failures(out) if f not in ("shore",) and not f.startswith("ocean")]
        if disc_failures and not full:
            return {**out, "failures": disc_failures, "pass": False, "partial": True}
        k2 = np.arange(-3000.0, 3000.0 + 1e-6, 10.0)
        E2, N2 = np.meshgrid(k2, k2)
        la2, lo2 = destination(lat, lon, E2.ravel(), N2.ravel())
        wat = g.water(la2, lo2)
        dist = np.hypot(E2.ravel(), N2.ravel())
        out["shoreDistanceM"] = float(dist[wat].min()) if wat.any() else 3000.0
        out["shoreBeyondWindow"] = not bool(wat.any())          # no water in the 6 x 6 km window: farther than 3 km
        out["oceanRays"] = self.rays(lat, lon)
        out["failures"] = self.failures(out)
        out["pass"] = not out["failures"]
        return out

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
        if self.strict and "oceanRays" in e:
            f += [k for k, ok in self.site_tests(e, c).items() if not ok]
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
        tests = {
            "height": H >= c["minHeightM"],
            "shore": shore >= c["minShoreDistanceM"] - g,
            "slope": slope < c["maxSlopeDeg"] + 0.5,
            "relief": plane_rms <= c["maxReliefM"],
            "dry": dry & (frac >= c["minAllowedFraction"] - 0.05),
            "latitude": LA.reshape(E.shape) < c["maxLatDeg"],
            "search": dist <= self.search_m,
        }
        ok = np.ones(E.shape, bool)
        stats = {"cells": int(E.size), "landCells": int((~water & (dist <= self.search_m)).sum())}
        for name, t in tests.items():
            ok &= t
            stats[f"after{name.capitalize()}"] = int(ok.sum())
        idx = np.nonzero(ok.ravel())[0]
        order = idx[np.argsort(dist.ravel()[idx], kind="stable")]
        return {"lat": LA[order], "lon": LO[order], "dist": dist.ravel()[order], "stats": stats}


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


def place(res: Resolver, grid: dict, classes: dict, fixed: list[dict]) -> tuple[list[dict], dict]:
    placed = list(fixed)
    evaluated: dict[int, dict] = {}
    tally = {"explicit": 0, "rejected": {}}
    clat, clon = grid["lat"], grid["lon"]
    dist_to = [gc_distance_m(p["latDeg"], p["lonDeg"], clat, clon) for p in placed]   # candidate distances per pad
    for cls in CLASS_ORDER:
        need = classes[cls]["count"] - sum(1 for p in fixed if p["class"] == cls)
        if need < 0:
            raise ValueError(f"more fixed {cls} pads than the class count")
        for _ in range(need):
            found = None
            free = np.ones(clat.size, bool)
            for p, d in zip(placed, dist_to):
                free &= d >= min_distance(classes, cls, p["class"])
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
                if e["pass"]:
                    found = e
                    break
            if found is None:
                raise RuntimeError(f"pads: no place for another {cls} pad within {res.search_m / 1000:g} km of the "
                                   f"nominal point ({len(placed)} placed; explicit rejections {tally['rejected']}; "
                                   f"grid {grid['stats']})")
            placed.append({"class": cls, "latDeg": found["latDeg"], "lonDeg": found["lonDeg"],
                           "padElevation": round(found["height"], 2), "fixed": False, "evaluation": found})
            dist_to.append(gc_distance_m(found["latDeg"], found["lonDeg"], clat, clon))
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
    res = Resolver(reg, nominal, args.search_km, strict=bool(getattr(args, "strict", False)))
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
    placed, tally = place(res, grid, classes, fixed)
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
                       "centreClass": e["centreClass"], "oceanRays": e["oceanRays"],
                       "siteTests": Resolver.site_tests(e, res.cfg), "passes": e["pass"], "failures": e["failures"],
                       "distanceFromNominalM": round(gc_distance_m(nominal[0], nominal[1], p["latDeg"], p["lonDeg"]), 0)}})
    try:
        content_hash = layout.read_manifest(paths.TILESET).get("contentHash")
    except FileNotFoundError:
        content_hash = None
    from earth import stage
    doc = {
        "site": args.site, "region": region_id, "tileset": paths.TILESET, "bodyId": "earth",
        "nominal": {"latDeg": nominal[0], "lonDeg": nominal[1]},
        "ground": (f"baked tiles of {region_id} ({'staged' if stage.state(region_id) in stage.HIDDEN_STATES else 'live'} "
                   f"when resolved): level-{res.ground.level} heights (bilinear on the vertex grid: the collision "
                   f"surface), water mask and land cover; global level 7 beyond the finest coverage"),
        "liveManifestContentHash": content_hash,
        "rule": {**{k: v for k, v in res.cfg.items() if k not in ("nominal", "allowedLandcover")},
                 "searchRadiusKm": res.search_m / 1000.0,
                 "gates": f"flat (slope, relief over the disc), dry (the centre and minAllowedFraction of the disc bare "
                          f"ground: {', '.join(BARE)}, i.e. WorldCover 60/100 as LC-1 was placed), clear of the shore "
                          f"(minShoreDistanceM to any water, minHeightM), latitude",
                 "reported": "the open ocean sector (oceanAzimuthDeg, oceanReachKm, openOceanKm)",
                 "classes": classes, "spacing": "pads of classes a and b at least (spacing_a + spacing_b) / 2 apart"},
        "referencePad": ref["id"],
        "pads": pads,
    }
    if res.strict:
        doc["rule"]["gates"] += "; STRICT: the open ocean sector gated too (a measurement, not the rule)"
    else:
        STAGED_SITES.mkdir(parents=True, exist_ok=True)
        write_json(STAGED_SITES / f"{args.site}.pads.json", doc)
    OUT.mkdir(parents=True, exist_ok=True)
    write_json(OUT / f"pads-{args.site}{'-strict' if res.strict else ''}.json", {**doc, "search": {"grid": grid["stats"], **tally,
                                                                  "seconds": round(time.time() - t0, 1)}})
    log(f"pads: {len(pads)} pads of {args.site} resolved" + ("" if res.strict else f", written to {STAGED_SITES / (args.site + '.pads.json')}"))
    print(report_table(doc), flush=True)
    return doc


def report_table(doc: dict) -> str:
    rows = ["| Pad | Class | Lat, lon | Elevation m | Slope deg | Relief m | Roughness 10 m (m) | Plane RMS m | Water m | Dry | Bare | Centre class | Ocean sector 60-130 | From nominal km |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for p in doc["pads"]:
        r = p["report"]
        oc = "open" if r["oceanRays"]["ok"] else f"no: {r['oceanRays']['failAzimuthDeg']:.0f} deg, {r['oceanRays']['reason']}"
        rows.append(f"| {p['id']}{' (fixed)' if p['fixed'] else ''} | {p['class']} | {p['latDeg']:.6f}, {p['lonDeg']:.6f} | "
                    f"{p['padElevation']:.2f} | {r['slopeDeg']:.2f} | {r['reliefM']:.1f} | {r['roughness10M']:.2f} | "
                    f"{r['planeRmsM']:.2f} | {'> ' if r['shoreBeyondWindow'] else ''}{r['shoreDistanceM']:.0f} | {r['dryFraction']:.2f} | {r['bareFraction']:.2f} | "
                    f"{r['centreClass']} | {oc} | {r['distanceFromNominalM'] / 1000:.2f} |")
    return "\n".join(rows)
