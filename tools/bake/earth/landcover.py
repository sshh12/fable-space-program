"""`landcover` layer: frt1-u8 256 x 256 class ids = LANDCOVER_CLASS in src/core/contracts/terrain.ts.

Global levels 0-7: a documented heuristic classifier on level-7 texels (classify()):
  inputs: stored albedo (linear RGB, luminance Y, greenness g = (G - R) / (G + R), yellowness
  y = (R + G - 2B) / (R + G + B), saturation s), stored night lights (linear luminance N), stored water
  mask, height (texel centre of the level-7 height tile) and latitude;
  rules, first match wins:
    water        mask >= 128
    snowIce      Y > 0.30 and s < 0.20, or Y > 0.20 and s < 0.15 and (|lat| > 55 or h > 3500 m)
    builtUp      N > 0.08 (bright night lights: dense settlement)
    bareRock     h > 4500 m
    trees        g > 0.06 and Y < 0.06 (dark green)
    crop         g > 0.0 and 0.04 <= Y < 0.12 and 20 <= |lat| <= 60 and h < 800 m (green mid-latitude lowland)
    grass        g > 0.03 (remaining green)
    sand         y > 0.35 and Y > 0.15 and g < 0 (bright yellow-orange desert)
    shrub        g > -0.02 and Y < 0.10 (dark olive)
    sparseScrub  g > -0.07 and 0.06 <= Y <= 0.28 (tan, partly vegetated)
    bareRock     everything else on land (grey or dark rock, lava, stony desert)
  wetland is not separable from colour at 300 m and is never assigned globally.
Coarser levels: majority of the 2 x 2 children (ties to the lower id).
Regional levels: ESA WorldCover 2021 majority per texel (sub-sampled at about 10 m), mapped to the ids
(WORLDCOVER_MAP); class 60 (bare / sparse vegetation) is split into sand / sparseScrub / bareRock by the
regional albedo of the same texel; the regional water mask decides water. Classes are not feathered.
"""
from __future__ import annotations

import numpy as np

from common import cube
from earth import manifest, paths, region as regmod, regional, tiles
from earth.util import run_units

CLASS = {"unknown": 0, "water": 1, "bareRock": 2, "sand": 3, "sparseScrub": 4, "grass": 5, "shrub": 6, "trees": 7,
         "crop": 8, "builtUp": 9, "snowIce": 10, "wetland": 11}
WORLDCOVER_MAP = {10: CLASS["trees"], 20: CLASS["shrub"], 30: CLASS["grass"], 40: CLASS["crop"],
                  50: CLASS["builtUp"], 60: -1, 70: CLASS["snowIce"], 80: CLASS["water"], 90: CLASS["wetland"],
                  95: CLASS["wetland"], 100: CLASS["sparseScrub"]}
L3_DIR = paths.WORK / "landcover-l3"
SOURCES_GLOBAL = ["Heuristic classifier (tools/bake/earth/landcover.py) on Blue Marble NG colour, Black Marble lights, "
                  "the water mask, ETOPO 2022 height and latitude"]


def features(rgb_lin: np.ndarray):
    R, G, B = rgb_lin[..., 0], rgb_lin[..., 1], rgb_lin[..., 2]
    Y = rgb_lin @ np.array([0.2126, 0.7152, 0.0722])
    g = (G - R) / (G + R + 1e-4)
    yel = (R + G - 2 * B) / (R + G + B + 1e-4)
    mx = rgb_lin.max(axis=-1)
    s = (mx - rgb_lin.min(axis=-1)) / (mx + 1e-4)
    return Y, g, yel, s


def classify(rgb_lin, night_lum, wm, h, lat) -> np.ndarray:
    Y, g, yel, s = features(rgb_lin)
    alat = np.abs(lat)
    out = np.full(Y.shape, CLASS["bareRock"], np.uint8)
    done = np.zeros(Y.shape, bool)

    def put(cond, cls):
        nonlocal done
        m = cond & ~done
        out[m] = cls
        done |= m

    put(wm >= 128, CLASS["water"])
    put(((Y > 0.30) & (s < 0.20)) | ((Y > 0.20) & (s < 0.15) & ((alat > 55) | (h > 3500))), CLASS["snowIce"])
    put(night_lum > 0.08, CLASS["builtUp"])
    put(h > 4500, CLASS["bareRock"])
    put((g > 0.06) & (Y < 0.06), CLASS["trees"])
    put((g > 0.0) & (Y >= 0.04) & (Y < 0.12) & (alat >= 20) & (alat <= 60) & (h < 800), CLASS["crop"])
    put(g > 0.03, CLASS["grass"])
    put((yel > 0.35) & (Y > 0.15) & (g < 0), CLASS["sand"])
    put((g > -0.02) & (Y < 0.10), CLASS["shrub"])
    put((g > -0.07) & (Y >= 0.06) & (Y <= 0.28), CLASS["sparseScrub"])
    return out


def majority2(children: list[np.ndarray]) -> np.ndarray:
    a = tiles.assemble_children(children)
    q = np.stack([a[0::2, 0::2], a[1::2, 0::2], a[0::2, 1::2], a[1::2, 1::2]])
    counts = np.stack([(q == c).sum(axis=0) for c in range(12)])
    return counts.argmax(axis=0).astype(np.uint8)


def _texel_heights(face, level, x, y):
    h = tiles.read_height(face, level, x, y)[1:258, 1:258].astype(np.float64)
    return 0.25 * (h[:-1, :-1] + h[:-1, 1:] + h[1:, :-1] + h[1:, 1:])


def _l7(face, x, y) -> np.ndarray:
    alb = tiles.srgb_to_linear(tiles.read_webp("albedo", face, 7, x, y))
    nl = tiles.srgb_to_linear(tiles.read_webp("night", face, 7, x, y)) @ np.array([0.2126, 0.7152, 0.0722])
    wm = tiles.read_u8("watermask", face, 7, x, y)
    lat, _ = tiles.dirs_latlon(cube.image_tile_dirs(face, 7, x, y))
    return classify(alb, nl, wm, _texel_heights(face, 7, x, y), lat)


def _subtree_unit(u):
    face, x3, y3 = u
    cur = {}
    n = 0
    for dx in range(16):
        for dy in range(16):
            x, y = x3 * 16 + dx, y3 * 16 + dy
            c = _l7(face, x, y)
            n += tiles.write_u8("landcover", face, 7, x, y, c)
            cur[(x, y)] = c
    for level in range(6, 2, -1):
        k = 2 ** (level - 3)
        nxt = {}
        for dx in range(k):
            for dy in range(k):
                x, y = x3 * k + dx, y3 * k + dy
                c = majority2([cur[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)])
                n += tiles.write_u8("landcover", face, level, x, y, c)
                nxt[(x, y)] = c
        cur = nxt
    L3_DIR.mkdir(parents=True, exist_ok=True)
    np.save(L3_DIR / f"{face}-{x3}-{y3}.npy", cur[(x3, y3)])
    return n


def _top_levels():
    for face in range(6):
        cur = {(x, y): np.load(L3_DIR / f"{face}-{x}-{y}.npy") for x in range(8) for y in range(8)}
        for level in (2, 1, 0):
            k = 2 ** level
            nxt = {}
            for x in range(k):
                for y in range(k):
                    c = majority2([cur[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)])
                    tiles.write_u8("landcover", face, level, x, y, c)
                    nxt[(x, y)] = c
            cur = nxt


def bake_global() -> None:
    for layer in ("albedo", "night", "watermask", "height"):
        if not manifest.is_marked(layer, "global"):
            raise RuntimeError(f"global landcover needs the {layer} layer first")
    cfg = {"v": 2}
    units = [(f, x, y) for f in range(6) for x in range(8) for y in range(8)]
    run_units("landcover-global", _subtree_unit, units, key=lambda u: "%d-%d-%d" % u, config=cfg)
    _top_levels()
    manifest.mark("landcover", "global")


# -- regional ----------------------------------------------------------------------------------------------
def _reg_unit(u):
    from earth import regmask
    region_id, level, tl = u
    reg = regmod.load(region_id)
    wc = regmask.worldcover(reg)
    n = 0
    for face, x, y in tl:
        tm = regional.texel_metres(face, level, x, y)
        sub = int(np.clip(round(tm / 10.0), 1, 16))
        k = (np.arange(256 * sub) + 0.5) / (256 * sub)
        uu, vv = np.meshgrid(k, k)
        lat, lon = tiles.dirs_latlon(cube.tile_uv_to_dir(face, level, x, y, uu, vv).reshape(-1, 3))
        c = wc.nearest(lat, lon).reshape(256, sub, 256, sub).transpose(0, 2, 1, 3).reshape(256, 256, sub * sub)
        codes = np.array([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100])
        counts = np.stack([(c == v).sum(axis=-1) for v in codes])
        maj = codes[counts.argmax(axis=0)]
        alb = tiles.srgb_to_linear(tiles.read_webp("albedo", face, level, x, y))
        wm = tiles.read_u8("watermask", face, level, x, y)
        tlat, _ = regional.texel_latlon(face, level, x, y)
        fallback = classify(alb, np.zeros((256, 256)), wm, _texel_heights(face, level, x, y), tlat.reshape(256, 256))
        Y, g, yel, s = features(alb)
        out = fallback.copy()
        for code, cls in WORLDCOVER_MAP.items():
            if cls >= 0:
                out[maj == code] = cls
        bare = maj == 60
        out[bare] = CLASS["bareRock"]
        out[bare & (g > 0.02)] = CLASS["sparseScrub"]
        out[bare & (yel > 0.30) & (Y > 0.15)] = CLASS["sand"]
        water = wm >= 128
        out[water] = CLASS["water"]
        land_wc_water = ~water & (out == CLASS["water"])      # WorldCover water where the height says land
        out[land_wc_water] = fallback[land_wc_water]           # (fallback is never water where wm < 128)
        n += tiles.write_u8("landcover", face, level, x, y, out)
    return n


def bake_region(region_id: str) -> None:
    reg = regmod.load(region_id)
    for layer, scope in (("albedo", region_id), ("watermask", region_id), ("height", region_id)):
        if not manifest.is_marked(layer, scope):
            raise RuntimeError(f"regional landcover needs the {layer} layer ({scope}) first")
    cfg = {"v": 2, "region": reg}
    for level in regmod.levels(reg):
        tl = regional.level_tiles(reg, level)
        units = [(region_id, level, tuple(tl[i:i + 32])) for i in range(0, len(tl), 32)]
        run_units(f"landcover-{region_id}-l{level}", _reg_unit, units,
                  key=lambda u: f"{u[2][0][1]}-{u[2][0][2]}-{len(u[2])}", config=cfg)
    manifest.mark("landcover", region_id)


def layer_manifest(regions: list[dict]) -> dict:
    coverage: dict[str, list] = {}
    sources = list(SOURCES_GLOBAL)
    for reg in regions:
        for L in regmod.levels(reg):
            coverage.setdefault(str(L), []).extend(regmod.coverage_rects(reg, L))
        s = "ESA WorldCover 2021 v200 (CC BY 4.0), class 60 split by Sentinel-2 colour"
        if s not in sources:
            sources.append(s)
    return {"encoding": "frt1-u8", "ext": "u8", "globalMaxLevel": paths.GLOBAL_MAX_LEVEL, "coverage": coverage,
            "classes": dict(CLASS), "sources": sources}
