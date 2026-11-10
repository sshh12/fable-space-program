"""Touchdown target recommendation inside a region's high-resolution source, from the baked level tiles.

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/moon/target.py moon-tranquility

Criteria (region.targetSearch; all evaluated on the baked level-`level` data, i.e. what the mission flies on):
  * real high-resolution data: the source band's weight is 1 at the target, and at least
    `minMissionDiscSourceFraction` of the mission disc (missionRadiusM) is real source data;
  * slope < maxSlopeDeg over slopeBaselineM: plane fit over the disc of that diameter AND the steepest
    height difference across that baseline in 8 directions;
  * no crater with diameter >= craterMinDiameterM within craterExclusionRadiusM. Craters are connected
    depressions found two ways on a gridSpacingM grid: closed depressions (sink filling by morphological
    reconstruction, depth > 0.3 m) and bowls relative to a 20 m Gaussian (residual < -0.5 m); a component
    counts when its equivalent diameter >= craterMinDiameterM and its depth >= max(0.4 m, 0.03 D);
  * lit: the terrain horizon toward every azimuth in sunAzimuthsDeg is below minSunElevationDeg minus
    horizonMarginDeg (curvature included), at the target and 50 m around it;
  * the whole disc of discRadiusM + discInsetM lies inside the level's coverage, and the coverage weight is 1
    over the disc of discRadiusM.
Among candidates passing everything, the one nearest `preferNear` wins. The result is written into the
region file as `recommendedTarget`.

    ... target.py moon-tranquility --keep

re-evaluates the region's existing `recommendedTarget` (same latitude and longitude) on the current tiles
after a re-bake: every criterion is measured again at that point and the height and numbers are rewritten;
it fails, changing nothing, if the point no longer meets the criteria. Scenarios are built on the target, so
a re-bake keeps it unless it has become invalid.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from scipy import ndimage, signal  # noqa: E402
from skimage.morphology import reconstruction  # noqa: E402

from common import cube  # noqa: E402
from moon import rt  # noqa: E402
from moon.region import RegionModel, load_region, region_path  # noqa: E402
from moon.sampling import dirs_to_tiles, footprint_m  # noqa: E402
from moon.tiles import TileReader  # noqa: E402

R = rt.MOON_RADIUS


class Plane:
    """Local gnomonic tangent plane: x east, y north (m) at a centre direction."""

    def __init__(self, lat_deg: float, lon_deg: float):
        la, lo = math.radians(lat_deg), math.radians(lon_deg)
        self.c = cube.lat_lon_to_dir(la, lo)
        self.e = np.array([-math.sin(lo), math.cos(lo), 0.0])
        self.n = np.cross(self.c, self.e)

    def dirs(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        p = R * self.c + np.asarray(x)[..., None] * self.e + np.asarray(y)[..., None] * self.n
        return p / np.linalg.norm(p, axis=-1, keepdims=True)

    def xy(self, d: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        d = np.asarray(d, dtype=np.float64)
        k = R / (d @ self.c)
        return k * (d @ self.e), k * (d @ self.n)


def grid_heights(reader: TileReader, model: RegionModel, plane: Plane, xs: np.ndarray, ys: np.ndarray, level: int,
                 band: int, chunk_rows: int = 400):
    """Level heights and 'real source data' mask on the grid (rows = ys, columns = xs)."""
    h = np.empty((len(ys), len(xs)), dtype=np.float64)
    real = np.zeros((len(ys), len(xs)), dtype=bool)
    for r0 in range(0, len(ys), chunk_rows):
        yy, xx = np.meshgrid(ys[r0:r0 + chunk_rows], xs, indexing="ij")
        d = plane.dirs(xx, yy)
        h[r0:r0 + chunk_rows] = reader.bicubic(d, level)
        lat, lon = (np.degrees(a) for a in cube.dir_to_lat_lon(d))
        w = model.weight(band, d, lat, lon, footprint_m(d, level, R))
        real[r0:r0 + chunk_rows] = w >= 1.0 - 1e-9
    return h, real


def crater_mask(h: np.ndarray, step: float, dmin: float) -> tuple[np.ndarray, list[dict]]:
    seed = np.copy(h)
    seed[1:-1, 1:-1] = h.max()
    filled = reconstruction(seed, h, method="erosion")
    depth = filled - h
    resid = h - ndimage.gaussian_filter(h, 20.0 / step)
    cand = (depth > 0.3) | (resid < -0.5)
    lab, n = ndimage.label(cand)
    if n == 0:
        return np.zeros(h.shape, bool), []
    idx = np.arange(1, n + 1)
    area = ndimage.sum(np.ones_like(h), lab, idx) * step * step
    dep = np.maximum(ndimage.maximum(depth, lab, idx), -ndimage.minimum(resid, lab, idx))
    deq = 2.0 * np.sqrt(area / math.pi)
    keep = (deq >= dmin) & (dep >= np.maximum(0.4, 0.03 * deq))
    mask = np.isin(lab, idx[keep])
    com = ndimage.center_of_mass(np.ones_like(h), lab, idx[keep])
    craters = [{"row": float(c[0]), "col": float(c[1]), "diameterM": float(dd), "depthM": float(pp)}
               for c, dd, pp in zip(com, deq[keep], dep[keep])]
    return mask, craters


def slope_fields(h: np.ndarray, step: float, baseline: float) -> tuple[np.ndarray, np.ndarray]:
    """(plane-fit slope over a disc of diameter `baseline`, steepest difference across `baseline`), degrees."""
    rad = int(round(baseline / 2 / step))
    yy, xx = np.mgrid[-rad:rad + 1, -rad:rad + 1].astype(np.float64)
    m = (xx ** 2 + yy ** 2) <= rad * rad
    kx = np.where(m, xx * step, 0.0)
    ky = np.where(m, yy * step, 0.0)
    kx /= np.sum(kx * xx * step)
    ky /= np.sum(ky * yy * step)
    gx = signal.fftconvolve(h, kx[::-1, ::-1], mode="same")
    gy = signal.fftconvolve(h, ky[::-1, ::-1], mode="same")
    plane = np.degrees(np.arctan(np.hypot(gx, gy)))
    steep = np.zeros_like(h)
    for ang in range(0, 180, 45):
        a = math.radians(ang)
        dx, dy = int(round(rad * math.cos(a))), int(round(rad * math.sin(a)))
        length = 2.0 * step * math.hypot(dx, dy)
        p = np.roll(np.roll(h, -dy, axis=0), -dx, axis=1)
        q = np.roll(np.roll(h, dy, axis=0), dx, axis=1)
        steep = np.maximum(steep, np.degrees(np.arctan(np.abs(p - q) / length)))
    border = rad + 1
    plane[:border] = plane[-border:] = 90.0
    plane[:, :border] = plane[:, -border:] = 90.0
    steep[:border] = steep[-border:] = 90.0
    steep[:, :border] = steep[:, -border:] = 90.0
    return plane, steep


def horizon_deg(reader: TileReader, plane: Plane, x0: float, y0: float, az_deg: float, rng: float, level: int) -> float:
    """Elevation of the terrain horizon seen from 2 m above the data surface at (x0, y0) toward azimuth az."""
    s = np.concatenate([np.arange(5.0, 500.0, 5.0), np.arange(500.0, 3000.0, 20.0), np.arange(3000.0, rng, 100.0)])
    a = math.radians(az_deg)
    xs = x0 + s * math.sin(a)
    ys = y0 + s * math.cos(a)
    d = plane.dirs(np.append(xs, x0), np.append(ys, y0))
    hh = reader.data_height(d, level)
    h0 = hh[-1] + 2.0
    elev = np.degrees(np.arctan2(hh[:-1] - h0 - s * s / (2 * R), s))
    return float(elev.max())


def lit_and_covered(reader: TileReader, plane: Plane, ts: dict, x0: float, y0: float, level: int):
    """(lit, horizon elevations, inside coverage, min coverage weight over discRadiusM) at (x0, y0)."""
    hz = {}
    lit = True
    for ox, oy in ((0, 0), (50, 0), (-50, 0), (0, 50), (0, -50)):
        for az in ts["sunAzimuthsDeg"]:
            e = horizon_deg(reader, plane, x0 + ox, y0 + oy, az, float(ts["horizonRangeM"]), level)
            hz[f"{ox},{oy},{az:g}"] = e
            if e >= ts["minSunElevationDeg"] - ts["horizonMarginDeg"]:
                lit = False
                break
        if not lit:
            break
    if not lit:
        return False, hz, False, 0.0
    # coverage: disc of discRadius + inset inside the level's coverage; weight 1 over discRadius
    rads = np.arange(0.0, ts["discRadiusM"] + ts["discInsetM"] + 1.0, 50.0)
    angs = np.radians(np.arange(0.0, 360.0, 5.0))
    RR, AA = np.meshgrid(rads, angs)
    d = plane.dirs(x0 + RR * np.sin(AA), y0 + RR * np.cos(AA)).reshape(-1, 3)
    f, tx, ty, _, _ = dirs_to_tiles(d, level)
    inside = all(reader.has(int(a_), level, int(b_), int(c_)) for a_, b_, c_ in set(zip(f, tx, ty)))
    if not inside:
        return True, hz, False, 0.0
    inner = RR.ravel() <= ts["discRadiusM"]
    return True, hz, True, float(reader.coverage_weight(d[inner], level).min())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("region")
    ap.add_argument("--keep", action="store_true", help="re-evaluate the existing recommendedTarget instead of searching")
    a = ap.parse_args()
    rt.check_python()
    rt.below_normal_priority()
    t0 = time.time()
    region = load_region(a.region)
    ts = region["targetSearch"]
    level = int(ts["level"])
    reader = TileReader(region["tileset"], cache_tiles=4096)
    model = RegionModel(region, reader)
    band = next(b.k for b in model.bands if b.source_id == ts["insideSource"])
    g = model.bands[band].grid
    # tangent plane at the centre of the source raster; grid over its valid footprint
    hgt, wid = g.valid.shape
    clat, clon = (float(v[0]) for v in g.pixel_to_latlon(np.array([hgt / 2.0]), np.array([wid / 2.0])))
    plane = Plane(clat, clon)
    rr, cc = np.nonzero(g.valid[::16, ::16])
    vl, vo = g.pixel_to_latlon(rr * 16.0, cc * 16.0)
    vx, vy = plane.xy(cube.lat_lon_to_dir(np.radians(vl), np.radians(vo)))
    step = float(ts["gridSpacingM"])
    xs = np.arange(math.floor(vx.min()), math.ceil(vx.max()) + step, step)
    ys = np.arange(math.floor(vy.min()), math.ceil(vy.max()) + step, step)
    rt.log(f"target search grid {len(xs)} x {len(ys)} at {step} m around ({clat:.4f}, {clon:.4f})")
    h, real = grid_heights(reader, model, plane, xs, ys, level, band)
    rt.log("heights sampled")
    plane_slope, steep = slope_fields(h, step, float(ts["slopeBaselineM"]))
    cmask, craters = crater_mask(h, step, float(ts["craterMinDiameterM"]))
    cdist = ndimage.distance_transform_edt(~cmask) * step if cmask.any() else np.full(h.shape, np.inf)
    rt.log(f"{len(craters)} craters >= {ts['craterMinDiameterM']} m detected")
    # mission-disc fraction of real data, via a disc convolution of the mask
    mr = int(round(float(ts["missionRadiusM"]) / step / 8))
    sub = real[::8, ::8].astype(np.float64)
    ky, kx = np.mgrid[-mr:mr + 1, -mr:mr + 1]
    disc = ((kx ** 2 + ky ** 2) <= mr * mr).astype(np.float64)
    frac = signal.fftconvolve(sub, disc, mode="same") / disc.sum()
    cs = max(1, int(round(float(ts["candidateSpacingM"]) / step)))
    ci, cj = np.mgrid[0:len(ys):cs, 0:len(xs):cs]
    ci, cj = ci.ravel(), cj.ravel()
    # selection uses the criteria tightened by the margins, so the target is not marginal on any of them
    smax = ts["maxSlopeDeg"] - ts["selectionSlopeMarginDeg"]
    cmin = ts["craterExclusionRadiusM"] + ts["selectionCraterMarginM"]
    ok = (real[ci, cj] & (plane_slope[ci, cj] < smax) & (steep[ci, cj] < smax) & (cdist[ci, cj] > cmin)
          & (frac[np.minimum(ci // 8, frac.shape[0] - 1), np.minimum(cj // 8, frac.shape[1] - 1)] >= ts["minMissionDiscSourceFraction"]))
    pn = ts["preferNear"]
    px, py = plane.xy(cube.lat_lon_to_dir(math.radians(pn["latDeg"]), math.radians(pn["lonDeg"])))
    dist = np.hypot(xs[cj] - px, ys[ci] - py)
    order = np.argsort(np.where(ok, dist, np.inf))
    rt.log(f"{int(ok.sum())} of {len(ok)} candidates pass slope, crater and data-fraction criteria")
    tried = 0
    if a.keep:
        old = region["recommendedTarget"]
        lat0, lon0 = float(old["latDeg"]), float(old["lonDeg"])
        tx, ty = plane.xy(cube.lat_lon_to_dir(math.radians(lat0), math.radians(lon0)))
        j, i = int(np.argmin(np.abs(xs - tx))), int(np.argmin(np.abs(ys - ty)))
        if math.hypot(float(xs[j] - tx), float(ys[i] - ty)) > 0.1:
            raise RuntimeError(f"recommendedTarget is not on a node of the search grid ({xs[j] - tx:.3f}, {ys[i] - ty:.3f} m)")
        x0, y0 = float(xs[j]), float(ys[i])
        lit, hz, inside, wmin = lit_and_covered(reader, plane, ts, x0, y0, level)
        fr = float(frac[min(i // 8, frac.shape[0] - 1), min(j // 8, frac.shape[1] - 1)])
        fails = [msg for bad, msg in (
            (not real[i, j], "not on real source data"),
            (plane_slope[i, j] >= ts["maxSlopeDeg"] or steep[i, j] >= ts["maxSlopeDeg"],
             f"slope {plane_slope[i, j]:.2f} / {steep[i, j]:.2f} deg"),
            (cdist[i, j] <= ts["craterExclusionRadiusM"], f"crater at {cdist[i, j]:.1f} m"),
            (fr < ts["minMissionDiscSourceFraction"], f"mission-disc source fraction {fr:.3f}"),
            (not lit, f"not lit (horizon {max(hz.values()):.2f} deg)"),
            (not inside or wmin < 1.0, f"coverage (inside {inside}, weight {wmin})")) if bad]
        if fails:
            raise RuntimeError("the recommended target no longer meets its criteria: " + "; ".join(fails)
                               + " - run target.py without --keep to choose a new one")
        d0 = cube.lat_lon_to_dir(math.radians(lat0), math.radians(lon0))[None]
        dist_pn = float(np.hypot(x0 - px, y0 - py))
    else:
        chosen = None
        for k in order:
            if not ok[k]:
                break
            tried += 1
            x0, y0 = float(xs[cj[k]]), float(ys[ci[k]])
            lit, hz, inside, wmin = lit_and_covered(reader, plane, ts, x0, y0, level)
            if lit and inside and wmin >= 1.0:
                chosen = (k, x0, y0, hz, wmin)
                break
        if chosen is None:
            raise RuntimeError("no candidate satisfies every criterion")
        k, x0, y0, hz, wmin = chosen
        d0 = plane.dirs(np.array([x0]), np.array([y0]))
        lat0, lon0 = (float(np.degrees(v[0])) for v in cube.dir_to_lat_lon(d0))
        i, j = ci[k], cj[k]
        dist_pn = float(dist[k])
    h0 = float(reader.data_height(d0, level)[0])
    near = [c for c in craters if math.hypot(xs[int(round(c["col"]))] - x0, ys[int(round(c["row"]))] - y0) < 600.0]
    near = sorted(({"distanceM": round(math.hypot(xs[int(round(c["col"]))] - x0, ys[int(round(c["row"]))] - y0), 1),
                    "diameterM": round(c["diameterM"], 1), "depthM": round(c["depthM"], 2)} for c in near),
                  key=lambda c: c["distanceM"])
    # local sanity: the detector on the historic landing site
    ax, ay = px, py
    hist = sorted(({"distanceM": round(math.hypot(xs[int(round(c["col"]))] - ax, ys[int(round(c["row"]))] - ay), 1),
                    "diameterM": round(c["diameterM"], 1), "depthM": round(c["depthM"], 2)}
                   for c in craters if math.hypot(xs[int(round(c["col"]))] - ax, ys[int(round(c["row"]))] - ay) < 500.0),
                  key=lambda c: c["distanceM"])
    rec = {
        "latDeg": round(lat0, 6), "lonDeg": round(lon0, 6), "heightM": round(h0, 2), "level": level,
        "criteria": {
            "planeSlopeDeg": round(float(plane_slope[i, j]), 3), "steepestBaselineSlopeDeg": round(float(steep[i, j]), 3),
            "slopeBaselineM": ts["slopeBaselineM"], "nearestCraterDistanceM": round(float(cdist[i, j]), 1),
            "craterMinDiameterM": ts["craterMinDiameterM"], "maxHorizonDeg": round(max(hz.values()), 3),
            "horizonAzimuthsDeg": ts["sunAzimuthsDeg"], "minSunElevationDeg": ts["minSunElevationDeg"],
            "missionDiscSourceFraction": round(float(frac[min(i // 8, frac.shape[0] - 1), min(j // 8, frac.shape[1] - 1)]), 3),
            "coverageDiscRadiusM": ts["discRadiusM"] + ts["discInsetM"], "minCoverageWeightInDisc": wmin,
            "distanceToPreferNearM": round(dist_pn, 1),
        },
        "cratersWithin600m": near,
        "detectorCheckAtPreferNear": hist,
        "candidatesPassingGridCriteria": int(ok.sum()),
        "candidatesTried": region["recommendedTarget"].get("candidatesTried", 0) if a.keep else tried,
    }
    if a.keep:
        rec["reEvaluatedOnRebake"] = True
    reg = json.loads(region_path(region["id"]).read_text(encoding="utf-8"))
    reg["recommendedTarget"] = rec
    with open(region_path(region["id"]), "w", encoding="utf-8", newline="\n") as fh:  # LF, as committed
        fh.write(json.dumps(reg, indent=2) + "\n")
    np.savez_compressed(rt.MOON_WORK / f"region-{region['id']}" / "target-grid.npz", xs=xs, ys=ys,
                        h=h.astype(np.float32), real=real, craters=cmask, x0=x0, y0=y0,
                        plane=np.array([clat, clon]))
    rt.log(f"recommended target {json.dumps(rec)}  ({time.time() - t0:.0f} s)")


if __name__ == "__main__":
    main()
