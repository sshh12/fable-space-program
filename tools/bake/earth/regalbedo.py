"""Regional `albedo` levels from Sentinel-2 cloudless (multi-year median, s2.py).

Every regional level is the area average of the composite over each texel footprint (box filter over the
z14 mosaic near land, z12 offshore), then
  1. de-shaded with the regional DEM (the stored height tile of the same key) using alpha/beta fitted on the
     region at level 10 (deshade.py) against the brightness relative to a 600 m neighbourhood, on ground above
     1500 m (sparse vegetation): at larger scales the windward / leeward vegetation pattern of the volcanoes
     correlates with aspect and would masquerade as shading;
  2. colour-matched to the global base: per-channel gain (ratio of the means in linear light, so contrast is
     kept), separately for land and water, between coarsest-regional-level texels and the stored level-7 tiles
     (bilinear), blended by the water mask; water further than 1.5-6 km from the coast fades to the global
     base itself (the S2 open ocean carries granule edges and sun glint);
  3. feathered over the outer 64 texels of the level's coverage into the bilinear upsample of the stored
     parent level (regional.py). Albedo tiles are lossless WebP (opaque RGB, tiles.LOSSLESS_LAYERS), so the
     outermost texels equal that upsample exactly.
Levels are written coarse to fine because each feather reads its stored parent.
"""
from __future__ import annotations

import math

import numpy as np

from earth import albedo, deshade, manifest, paths, region as regmod, regional, s2, tiles
from earth.util import log, read_json, run_units, write_json

FIT_LEVEL = 10
FIT_SIGMA_M = 600.0             # de-shading fit: brightness relative to this neighbourhood
FIT_MIN_HEIGHT_M = 1500.0       # ... on sparsely vegetated ground only
OFFSHORE_M = (1500.0, 6000.0)   # water colour: S2 near the coast, the global base beyond (smootherstep)


def _sources(region_id: str):
    reg = regmod.load(region_id)
    return reg, s2.composites(reg)


_CACHE: dict = {}


def _get(region_id: str):
    if region_id not in _CACHE:
        _CACHE[region_id] = _sources(region_id)
    return _CACHE[region_id]


def raw_tile(region_id: str, face: int, level: int, x: int, y: int) -> np.ndarray:
    """Linear RGB (256, 256, 3) area average of the S2 composite over the texel footprints."""
    reg, (fine, coarse) = _get(region_id)
    lat, lon = regional.texel_latlon(face, level, x, y)
    tm = regional.texel_metres(face, level, x, y)
    latc = float(np.mean(lat))
    out = np.full((lat.size, 3), np.nan)
    for st in (fine, coarse):
        miss = np.isnan(out[:, 0])
        if not miss.any():
            break
        half = 0.5 * tm / regional.merc_px_m(latc, st.z)
        if half < 0.75:
            v = st.bilinear_rgb(lat[miss], lon[miss])
        else:
            v = st.box_rgb(lat[miss], lon[miss], np.full(int(miss.sum()), half))
        out[miss] = v
    if np.isnan(out).any():
        raise ValueError(f"s2 composite does not cover tile {face}/{level}/{x}/{y}")
    return tiles.srgb_to_linear(out.reshape(256, 256, 3))


# -- fits ---------------------------------------------------------------------------------------------------
def _fit_path(region_id: str):
    return paths.WORK / f"regalbedo-fit-{region_id}.json"


def _inputs(region_id: str) -> dict:
    """Build hashes of the layers the regional albedo reads: the regional height (de-shading normals), the
    regional water mask (land/water colour match) and the global albedo (colour target, coverage feather)."""
    return {"height": manifest.build_hash("height", region_id), "watermask": manifest.build_hash("watermask", region_id),
            "albedoGlobal": manifest.build_hash("albedo", "global")}


def fit(region_id: str, cached_only: bool = False, accept_stored: bool = False) -> dict | None:
    p = _fit_path(region_id)
    reg = regmod.load(region_id)
    inp = _inputs(region_id)
    # sparsely vegetated ground: above the vegetation on the Hawaiian volcanoes; every height on a desert coast
    # (region file `sources.albedo.deshadeFitMinHeightM`)
    min_h = float(reg["sources"]["albedo"].get("deshadeFitMinHeightM", FIT_MIN_HEIGHT_M))
    # slopes the fit uses (default 2 deg); where the elevation source is coarser than the imagery (30 m SRTM against
    # 10 m Sentinel-2) the gentle slopes are mostly survey noise and wadi banks, which dilute the fit towards zero and
    # even flip its sign (Madrakah: alpha -0.05 from 2 deg, converging to +0.22..+0.26 from 8 deg up)
    min_s = float(reg["sources"]["albedo"].get("deshadeFitMinSlopeDeg", 2.0))
    key = str({"centre": reg["shape"], "years": reg["sources"]["albedo"]["years"], "v": 4,
               "sigma": FIT_SIGMA_M, "minHeight": min_h, **({"minSlope": min_s} if min_s != 2.0 else {}),
               "inputs": {"height": inp["height"], "albedoGlobal": inp["albedoGlobal"]}})
    if p.is_file():
        f = read_json(p)
        if f.get("key") == key:
            return f
        if accept_stored:
            # bake.py accept (lead-4): the stored fit is the one the tiles were baked with; its key is stale only
            # because an input's build hash moved without those tiles changing: adopt it for the present inputs
            from earth.util import write_json
            f = {**f, "key": key, "acceptedFromKey": f.get("key")}
            write_json(p, f)
            return f
    if cached_only:
        return None
    # 1. de-shading on a level-FIT_LEVEL mosaic
    tl = regional.level_tiles(reg, FIT_LEVEL)
    faces = [t[0] for t in tl]
    face = max(set(faces), key=faces.count)             # fit on the face holding most of the region
    tl = [t for t in tl if t[0] == face]
    xs = sorted({t[1] for t in tl})
    ys = sorted({t[2] for t in tl})
    W, H = len(xs) * 256, len(ys) * 256
    Y = np.zeros((H, W))
    NE = np.zeros((H, W))
    NN = np.zeros((H, W))
    HC = np.zeros((H, W))
    for _, x, y in tl:
        lin = raw_tile(region_id, face, FIT_LEVEL, x, y)
        ne, nn, hc = albedo.tile_normals(tiles.read_height(face, FIT_LEVEL, x, y), face, FIT_LEVEL, x, y)
        j, i = (y - ys[0]) * 256, (x - xs[0]) * 256
        Y[j:j + 256, i:i + 256] = lin @ albedo.LUMA
        NE[j:j + 256, i:i + 256] = ne
        NN[j:j + 256, i:i + 256] = nn
        HC[j:j + 256, i:i + 256] = hc
    land = (HC > 5.0) & (Y > 0.003)
    tm = regional.texel_metres(face, FIT_LEVEL, xs[len(xs) // 2], ys[len(ys) // 2])
    lr = deshade.local_log_ratio(Y, land, sigma_px=FIT_SIGMA_M / tm)
    sel = land & (HC > min_h) & (np.hypot(NE, NN) > math.sin(math.radians(min_s))) & (Y < 0.6)
    if int(sel.sum()) < 1000:
        raise RuntimeError(f"regalbedo {region_id}: only {int(sel.sum())} texels to fit the de-shading on (need 1000); "
                           "set sources.albedo.deshadeFitMinHeightM in the region file")
    acc = deshade.Accumulator(1)
    acc.add(0, NE[sel], NN[sel], lr[sel])
    a, b = acc.solve(min_n=1000)[0]
    log(f"regalbedo: de-shading alpha {a:+.3f} (east) beta {b:+.3f} (north) from {int(sel.sum())} texels")
    # 2. colour match of the coarsest regional level against the stored global level-7 albedo
    src_l, dst_l, src_w, dst_w = [], [], [], []
    l0 = regmod.levels(reg)[0]
    for face, x, y in regional.level_tiles(reg, l0):
        lin = raw_tile(region_id, face, l0, x, y)
        ne, nn, hc = albedo.tile_normals(tiles.read_height(face, l0, x, y), face, l0, x, y)
        lin = lin / np.where(hc > 0, deshade.factor(ne, nn, a, b), 1.0)[..., None]
        par = tiles.srgb_to_linear(regional.parent_upsample("albedo", face, l0, x, y,
                                                            lambda f_, l_, x_, y_: tiles.read_webp("albedo", f_, l_, x_, y_).astype(np.float64)))
        lnd = hc > 1.0
        wat = hc < -20.0
        src_l.append(lin[lnd])
        dst_l.append(par[lnd])
        src_w.append(lin[wat])
        dst_w.append(par[wat])

    def gains(s, d):
        """Per-channel ratio of the means (gain, offset 0): matches the mean colour, keeps the contrast
        (a regression would be diluted towards zero gain by the resolution mismatch)."""
        s = np.concatenate(s)
        d = np.concatenate(d)
        return [[float(d[:, c].mean() / max(s[:, c].mean(), 1e-6)), 0.0] for c in range(3)], int(s.shape[0])

    land_fit, nl = gains(src_l, dst_l)
    water_fit, nw = gains(src_w, dst_w)
    log(f"regalbedo: colour match land {land_fit} ({nl} texels), water {water_fit} ({nw} texels)")
    out = {"key": key, "alpha": float(a), "beta": float(b), "land": land_fit, "water": water_fit,
           "fitLevel": FIT_LEVEL, "samplesLand": nl, "samplesWater": nw}
    write_json(p, out)
    return out


def finish(lin: np.ndarray, region_id: str, face: int, level: int, x: int, y: int, f: dict) -> np.ndarray:
    """De-shade and colour-match one raw tile (linear)."""
    ne, nn, hc = albedo.tile_normals(tiles.read_height(face, level, x, y), face, level, x, y)
    lin = lin / np.where(hc > 0, deshade.factor(ne, nn, f["alpha"], f["beta"]), 1.0)[..., None]
    wm = tiles.read_u8("watermask", face, level, x, y)
    water = (wm.astype(np.float64) / 255.0)[..., None]
    gl = np.array(f["land"])
    gw = np.array(f["water"])
    land_c = lin * gl[:, 0] + gl[:, 1]
    water_c = lin * gw[:, 0] + gw[:, 1]
    # open ocean: the S2 mosaic shows granule edges and sun glint offshore; fade to the global base there
    from earth.heights import _regional_height
    lat, lon = regional.texel_latlon(face, level, x, y)
    dist = _regional_height(region_id).coast_distance(lat, lon).reshape(256, 256, 1)
    w_s2 = 1.0 - regmod.smootherstep((dist - OFFSHORE_M[0]) / (OFFSHORE_M[1] - OFFSHORE_M[0]))
    if (w_s2 < 1.0).any():
        base = tiles.srgb_to_linear(regional.parent_upsample(
            "albedo", face, level, x, y, lambda f_, l_, x_, y_: tiles.read_webp("albedo", f_, l_, x_, y_).astype(np.float64),
            ancestor=7))
        water_c = w_s2 * water_c + (1.0 - w_s2) * base
    return np.clip(water * water_c + (1.0 - water) * land_c, 0.0, 1.0)


def _unit(u: tuple) -> int:
    region_id, level, tl = u
    reg = regmod.load(region_id)
    f = fit(region_id)
    rects = regmod.coverage_rects(reg, level)
    n = 0
    for face, x, y in tl:
        lin = finish(raw_tile(region_id, face, level, x, y), region_id, face, level, x, y, f)
        srgb = tiles.linear_to_srgb8(lin).astype(np.float64)
        d = regional.boundary_distance(rects, face, level, x, y)
        if d.min() < regional.FEATHER_TEXELS:
            w = regional.feather_weight(d)[..., None]
            par = regional.parent_upsample("albedo", face, level, x, y,
                                           lambda f_, l_, x_, y_: tiles.read_webp("albedo", f_, l_, x_, y_).astype(np.float64))
            srgb = w * srgb + (1.0 - w) * par
        out = np.clip(np.floor(srgb + 0.5), 0, 255).astype(np.uint8)
        n += tiles.write_webp("albedo", face, level, x, y, out)       # lossless: outer texels = parent upsample
    return n


def bake(region_id: str) -> None:
    reg = regmod.load(region_id)
    for layer, scope in (("albedo", "global"), ("height", region_id), ("watermask", region_id)):
        if not manifest.is_marked(layer, scope):
            raise RuntimeError(f"regional albedo needs the {layer} layer ({scope}) baked first")
    from earth.heights import _regional_height
    from earth.util import unit_mode, units_done
    f = fit(region_id, cached_only=True, accept_stored=unit_mode() == "accept")
    k = lambda u: f"{u[2][0][1]}-{u[2][0][2]}-{len(u[2])}"   # noqa: E731
    plan = [(f"albedo-{region_id}-l{level}", [(region_id, level, tuple(tl[i:i + 32])) for tl in
             [regional.level_tiles(reg, level)] for i in range(0, len(tl), 32)]) for level in regmod.levels(reg)]
    done = f is not None and all(units_done(n, us, k, {"v": 5, "region": reg, "fit": f, "offshore": OFFSHORE_M,
                                                       "lossless": True, "inputs": _inputs(region_id)}) for n, us in plan)
    if not done and unit_mode() is None:     # the sources only when a unit will run (lead-4)
        _regional_height(region_id)       # builds the coast grid here (if needed), so workers only memory-map it
        s2.fetch(reg)
        _get(region_id)
        f = fit(region_id)
    if f is None:
        raise RuntimeError(f"albedo {region_id}: no cached de-shading fit for the present inputs: cannot accept or "
                           f"check without baking")
    cfg = {"v": 5, "region": reg, "fit": f, "offshore": OFFSHORE_M, "lossless": True, "inputs": _inputs(region_id)}
    for level in regmod.levels(reg):                      # coarse to fine: feathers read stored parents
        tl = regional.level_tiles(reg, level)
        units = [(region_id, level, tuple(tl[i:i + 32])) for i in range(0, len(tl), 32)]
        run_units(f"albedo-{region_id}-l{level}", _unit, units, key=lambda u: f"{u[2][0][1]}-{u[2][0][2]}-{len(u[2])}",
                  config=cfg)
    manifest.mark("albedo", region_id)
