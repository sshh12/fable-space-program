"""`watermask` layer: frt1-u8 256 x 256, classes { land: 0, water: 255 }, anti-aliased shorelines.

Global level 7, per texel:
  f_h  = fraction of 4 x 4 sub-samples of the texel where the bilinear height surface of the baked level-7
         height tile is below sea level (the elevation sign, exactly the surface the height authority uses);
  f_m  = fraction of 2 x 2 sub-samples that the independent MODIS MOD44W 250 m water mask calls water.
  default                          mask = f_h
  land below sea level             mask = f_m   where f_h > 0, f_m < 0.5, MODIS water is more than
                                                CORRECT_TEXELS away AND the texel is not connected to the
                                                world ocean (Caspian depression, Qattara, Dead Sea shore,
                                                Death Valley, polders behind dykes ...)
  inland water above sea level     mask = max(f_h, f_m)  where f_m >= 0.5, f_h < 0.5 and the sea (f_h >= 0.5)
                                                is more than CORRECT_TEXELS away (lakes, wide rivers)
Coastlines therefore follow the height sign (what physics calls water); the independent source only adds
inland water and removes dry ground that is not part of the ocean.

Ocean connectivity (texel level, global): the PASSABLE texels are those below sea level (f_h > 0) that MODIS
calls water OR that lie within NEAR_DEEP_TEXELS of ground deeper than DEEP_M. The OCEAN is the 8-connected
component of passable texels (across tiles and cube faces) that holds the open Pacific. So
  - a fjord or inlet that MODIS misses (narrow, ice-filled) but whose floor is deeper than DEEP_M is ocean:
    the mask follows the height sign there;
  - shallow below-sea-level ground that MODIS calls land and that has no deep water next to it does not conduct
    the connection: dykes are far narrower than a level-7 texel (300 m) and ETOPO 15" cannot resolve them, so
    the Dutch polders (-2..-7 m) would otherwise join the sea through the IJsselmeer;
  - an enclosed basin (Caspian Sea and lowland, Dead Sea, Qattara, Turfan, Danakil) is passable but not
    connected to the ocean.
Pass 1 labels the passable texels of every level-7 tile and records the labels along the tile edges; the
components are joined across tile and cube-face edges with a sparse graph (scipy.sparse.csgraph); pass 2 bakes
the mask with the per-label ocean flags. The texels below sea level that are NOT ocean are written per tile to
data/cache/earth/verify/watermask-inland (class 1: an enclosed passable basin, class 2: shallow MODIS land)
for verify.py's coastline check, which counts a disagreement between mask and height sign as deliberate only
there or at inland water above sea level.
Levels 6..0 are 2 x 2 means of the level below. Regional levels: regmask.py.
"""
from __future__ import annotations

import hashlib
import io
import math

import numpy as np
from scipy import ndimage

from common import cube
from earth import hpyramid, manifest, paths, tiles
from earth.util import log, run_units, units_done

CORRECT_TEXELS = 2
PAD = 8
SUB = 4
SUB_MODIS = 2
DEEP_M = 10.0
NEAR_DEEP_TEXELS = 3
OCEAN_SEED = (0.0, -160.0)          # open Pacific
L3_DIR = paths.WORK / "watermask-l3"
CC_DIR = paths.WORK / "watermask-cc"
INLAND_DIR = paths.REFS / "watermask-inland"
EIGHT = np.ones((3, 3), int)
SOURCES_GLOBAL = ["Sign of the baked height (ETOPO 2022)",
                  "MODIS MOD44W 250 m water mask via NASA GIBS (MODIS_Water_Mask; public domain): inland water and "
                  "dry ground below sea level that is not connected to the ocean"]


def subsample_uv(n: int = 256, sub: int = SUB) -> np.ndarray:
    k = (np.arange(n * sub) + 0.5) / (n * sub)
    return k


def height_fraction(h259: np.ndarray, sub: int = SUB) -> np.ndarray:
    """Fraction of sub x sub bilinear sub-samples per texel below 0 (texel (c, r) spans vertices c..c+1)."""
    g = h259[1:258, 1:258].astype(np.float64)            # 257 x 257 vertices
    f = (np.arange(sub) + 0.5) / sub
    acc = np.zeros((256, 256))
    a00, a10, a01, a11 = g[:-1, :-1], g[:-1, 1:], g[1:, :-1], g[1:, 1:]
    for fy in f:
        for fx in f:
            v = (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy
            acc += v < 0.0
    return acc / (sub * sub)


def _texel_centres(h259: np.ndarray) -> np.ndarray:
    g = h259[1:258, 1:258].astype(np.float64)
    return 0.25 * (g[:-1, :-1] + g[:-1, 1:] + g[1:, :-1] + g[1:, 1:])


def _modis_fraction(face: int, x: int, y: int, modis) -> np.ndarray:
    """MODIS water fraction from 2 x 2 sub-samples per texel (the source is 250 m, the texels 150-305 m)."""
    k = (np.arange(256 * SUB_MODIS) + 0.5) / (256 * SUB_MODIS)
    uu, vv = np.meshgrid(k, k)
    d = cube.tile_uv_to_dir(face, 7, x, y, uu, vv).reshape(-1, 3)
    lat, lon = tiles.dirs_latlon(d)
    return modis.water(lat, lon).reshape(256, SUB_MODIS, 256, SUB_MODIS).mean(axis=(1, 3))


def _padded(face: int, x: int, y: int, cache: hpyramid.TileCache):
    """Texel-centre heights on the tile padded by PAD texels (true neighbouring directions), and the
    directions' lat/lon."""
    kp = (np.arange(-PAD, 256 + PAD) + 0.5) / 256
    up, vp = np.meshgrid(kp, kp)
    dp = cube.tile_uv_to_dir(face, 7, x, y, up, vp).reshape(-1, 3)
    hp = hpyramid.bilinear_from_tiles(dp, cache).reshape(up.shape)
    la, lo = tiles.dirs_latlon(dp)
    return hp, la, lo


def _edt_inner(mask: np.ndarray) -> np.ndarray:
    if not mask.any():
        return np.full((256, 256), np.inf)
    return ndimage.distance_transform_edt(~mask)[PAD:-PAD, PAD:-PAD]


def passable(f_h: np.ndarray, f_m: np.ndarray, hc: np.ndarray, hp: np.ndarray) -> np.ndarray:
    """Texels that conduct ocean connectivity: below sea level, and MODIS water or near deep ground."""
    deep = hp < -DEEP_M
    deep[PAD:-PAD, PAD:-PAD] = hc < -DEEP_M
    return (f_h > 0.0) & ((f_m >= 0.5) | (_edt_inner(deep) <= NEAR_DEEP_TEXELS))


def tile_labels(face: int, x: int, y: int, cache: hpyramid.TileCache, modis):
    """(labels, n, f_h, f_m, hc, hp, la, lo) of one level-7 tile; labels: 8-connected components of the
    passable texels (0 = not passable). f_m etc. are None where the tile needs no MODIS (no texel below sea
    level, or every texel deeper than DEEP_M)."""
    h = cache.get(face, x, y)
    f_h = height_fraction(h)
    hc = _texel_centres(h)
    if not (f_h > 0.0).any():
        return np.zeros((256, 256), np.int32), 0, f_h, None, hc, None, None, None
    if (hc < -DEEP_M).all():
        return np.ones((256, 256), np.int32), 1, f_h, None, hc, None, None, None
    f_m = _modis_fraction(face, x, y, modis)
    hp, la, lo = _padded(face, x, y, cache)
    lab, n = ndimage.label(passable(f_h, f_m, hc, hp), structure=EIGHT)
    return lab.astype(np.int32), int(n), f_h, f_m, hc, hp, la, lo


# -- pass 1: per-tile components and their edge labels -------------------------------------------------------
def _cc_unit(u: tuple[int, int, int]) -> int:
    from earth.gibs import WaterMask
    face, x3, y3 = u
    cache = hpyramid.TileCache(7, tiles.read_height)
    modis = WaterMask()
    keys, ns, edges = [], [], []
    for dx in range(16):
        for dy in range(16):
            x, y = x3 * 16 + dx, y3 * 16 + dy
            lab, n = tile_labels(face, x, y, cache, modis)[:2]
            keys.append((x, y))
            ns.append(n)
            edges.append(np.stack([lab[:, 0], lab[:, 255], lab[0, :], lab[255, :]]) if n else np.zeros((4, 256), np.int32))
            cache.trim(300)
    CC_DIR.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    np.savez_compressed(buf, keys=np.array(keys, np.int32), n=np.array(ns, np.int32), edges=np.array(edges, np.int32))
    (CC_DIR / f"{face}-{x3}-{y3}.npz").write_bytes(buf.getvalue())
    return len(keys)


SIDES = {"left": 0, "right": 1, "top": 2, "bottom": 3}   # rows of the stored edge array: u=0, u=1, v=0, v=1


def _across_face(face: int, x: int, y: int, side: int):
    """For the 256 edge texels of a level-7 tile on a cube-face edge: the (face, x, y, edge row, index) of the
    texel across the edge (half a texel beyond it, mapped through the cube)."""
    k = (np.arange(256) + 0.5) / 256
    o = 0.5 / 256
    u, v = {0: (np.full(256, -o), k), 1: (np.full(256, 1 + o), k), 2: (k, np.full(256, -o)), 3: (k, np.full(256, 1 + o))}[side]
    d = cube.tile_uv_to_dir(face, 7, x, y, u, v).reshape(-1, 3)
    f2, x2, y2, u2, v2 = hpyramid.locate(d, 7)
    c2 = np.minimum((u2 * 256).astype(np.int64), 255)
    r2 = np.minimum((v2 * 256).astype(np.int64), 255)
    row = np.where(c2 == 0, 0, np.where(c2 == 255, 1, np.where(r2 == 0, 2, 3)))
    idx = np.where(row < 2, r2, c2)
    return f2, x2, y2, row, idx


def _join() -> None:
    """Union of the per-tile components across tile and cube-face edges; writes the per-label ocean flags."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    N = 128
    n_t = np.zeros((6, N, N), np.int64)
    edges = {}
    for f in range(6):
        for x3 in range(8):
            for y3 in range(8):
                z = np.load(CC_DIR / f"{f}-{x3}-{y3}.npz")
                for (x, y), n, e in zip(z["keys"], z["n"], z["edges"]):
                    n_t[f, x, y] = n
                    if n:
                        edges[(f, int(x), int(y))] = e
    off = np.zeros(6 * N * N + 1, np.int64)
    off[1:] = np.cumsum(n_t.reshape(-1))
    total = int(off[-1])

    def node(f, x, y):
        return off[(f * N + x) * N + y]

    us, vs = [], []

    def link(a_lab, a_base, b_lab, b_base, diag: bool):
        pairs = [(a_lab, b_lab)]
        if diag:
            pairs += [(a_lab[:-1], b_lab[1:]), (a_lab[1:], b_lab[:-1])]
        for p, q in pairs:
            m = (p > 0) & (q > 0)
            if m.any():
                uv = np.unique(np.stack([p[m], q[m]], 1), axis=0)
                us.append(a_base + uv[:, 0] - 1)
                vs.append(b_base + uv[:, 1] - 1)

    for (f, x, y), e in edges.items():
        base = node(f, x, y)
        if x + 1 < N and (f, x + 1, y) in edges:
            link(e[1], base, edges[(f, x + 1, y)][0], node(f, x + 1, y), True)
        if y + 1 < N and (f, x, y + 1) in edges:
            link(e[3], base, edges[(f, x, y + 1)][2], node(f, x, y + 1), True)
        for side, on_edge in ((0, x == 0), (1, x == N - 1), (2, y == 0), (3, y == N - 1)):
            if not on_edge:
                continue
            f2, x2, y2, row, idx = _across_face(f, x, y, side)
            b = np.array([edges[(int(a), int(b_), int(c))][r, i] if (int(a), int(b_), int(c)) in edges else 0
                          for a, b_, c, r, i in zip(f2, x2, y2, row, idx)], np.int64)
            a = e[side].astype(np.int64)
            m = (a > 0) & (b > 0)
            if m.any():
                bases = np.array([node(int(a_), int(b_), int(c)) for a_, b_, c in zip(f2[m], x2[m], y2[m])], np.int64)
                us.append(base + a[m] - 1)
                vs.append(bases + b[m] - 1)
    u = np.concatenate(us) if us else np.zeros(0, np.int64)
    v = np.concatenate(vs) if vs else np.zeros(0, np.int64)
    g = coo_matrix((np.ones(u.size, np.int8), (u, v)), shape=(total, total))
    ncomp, comp = connected_components(g, directed=False)
    sd = cube.lat_lon_to_dir(math.radians(OCEAN_SEED[0]), math.radians(OCEAN_SEED[1]))
    sf, sx, sy, _, _ = cube.dir_to_tile(sd, 7)
    if n_t[sf, sx, sy] != 1 or (sf, sx, sy) not in edges:
        raise ValueError("watermask: the ocean seed tile is not a single passable component")
    ocean = comp == comp[node(sf, sx, sy)]
    np.savez_compressed(CC_DIR / "ocean.npz", offsets=off, ocean=ocean)
    log(f"watermask: {total} passable components in {len(edges)} tiles joined into {ncomp}; the ocean holds "
        f"{int(ocean.sum())} of them")


class OceanFlags:
    def __init__(self):
        z = np.load(CC_DIR / "ocean.npz")
        self.off, self.ocean = z["offsets"], z["ocean"]

    def tile(self, face: int, x: int, y: int) -> np.ndarray:
        """Ocean flag per label of a tile, index 0 = label 1."""
        i = (face * 128 + x) * 128 + y
        return self.ocean[self.off[i]:self.off[i + 1]]


# -- pass 2: the mask ----------------------------------------------------------------------------------------
def level7_mask(face: int, x: int, y: int, cache: hpyramid.TileCache, modis, flags: OceanFlags):
    """(mask, inland class map or None) of one level-7 tile."""
    lab, n, f_h, f_m, hc, hp, la, lo = tile_labels(face, x, y, cache, modis)
    if f_m is None:
        f_m = _modis_fraction(face, x, y, modis)
        hp, la, lo = _padded(face, x, y, cache)
    mp = modis.water(la, lo).reshape(hp.shape).astype(np.float64)
    sea = hp < 0.0
    sea[PAD:-PAD, PAD:-PAD] = f_h >= 0.5
    mw = mp >= 0.5
    mw[PAD:-PAD, PAD:-PAD] = f_m >= 0.5
    d_mw = _edt_inner(mw)
    d_sea = _edt_inner(sea)
    ocean = np.zeros((256, 256), bool)
    if n:
        fl = flags.tile(face, x, y)
        if fl.size != n:
            raise ValueError(f"watermask: tile {face}/7/{x}/{y} has {n} components, pass 1 recorded {fl.size}")
        ocean = np.concatenate([[False], fl])[lab]
    below = f_h > 0.0
    mask = f_h.copy()
    dry = below & (f_m < 0.5) & (d_mw > CORRECT_TEXELS) & ~ocean
    mask[dry] = f_m[dry]
    lake = (f_m >= 0.5) & (f_h < 0.5) & (d_sea > CORRECT_TEXELS)
    mask[lake] = np.maximum(f_h[lake], f_m[lake])
    inland = None
    if (below & ~ocean).any():
        inland = np.zeros((256, 256), np.uint8)
        inland[below & ~ocean & (lab > 0)] = 1          # enclosed passable basin
        inland[below & ~ocean & (lab == 0)] = 2         # shallow, MODIS land, no deep ground next to it
    return mask, inland


def to_u8(m: np.ndarray) -> np.ndarray:
    return np.clip(np.floor(m * 255.0 + 0.5), 0, 255).astype(np.uint8)


def _subtree_unit(u: tuple[int, int, int]) -> int:
    from earth.gibs import WaterMask
    face, x3, y3 = u
    cache = hpyramid.TileCache(7, tiles.read_height)
    modis = WaterMask()
    flags = OceanFlags()
    cur = {}
    inland = {}
    n = 0
    for dx in range(16):
        for dy in range(16):
            x, y = x3 * 16 + dx, y3 * 16 + dy
            m, cls = level7_mask(face, x, y, cache, modis, flags)
            n += tiles.write_u8("watermask", face, 7, x, y, to_u8(m))
            cur[(x, y)] = m
            if cls is not None:
                inland[f"{x}-{y}"] = cls
            cache.trim(300)
    INLAND_DIR.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    np.savez_compressed(buf, **inland)
    (INLAND_DIR / f"{face}-{x3}-{y3}.npz").write_bytes(buf.getvalue())
    for level in range(6, 2, -1):
        k = 2 ** (level - 3)
        nxt = {}
        for dx in range(k):
            for dy in range(k):
                x, y = x3 * k + dx, y3 * k + dy
                t = tiles.box2(tiles.assemble_children([cur[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]))
                n += tiles.write_u8("watermask", face, level, x, y, to_u8(t))
                nxt[(x, y)] = t
        cur = nxt
    L3_DIR.mkdir(parents=True, exist_ok=True)
    np.save(L3_DIR / f"{face}-{x3}-{y3}.npy", cur[(x3, y3)].astype(np.float32))
    return n


def inland_class(face: int, x: int, y: int) -> np.ndarray:
    """Per-texel class of a level-7 tile written by the bake: 0 = above sea level or part of the ocean,
    1 = below sea level in an enclosed basin, 2 = below sea level, MODIS land, no deep ground next to it."""
    with np.load(INLAND_DIR / f"{face}-{x // 16}-{y // 16}.npz") as z:
        k = f"{x}-{y}"
        return z[k] if k in z.files else np.zeros((256, 256), np.uint8)


def _top_levels() -> None:
    for face in range(6):
        cur = {(x, y): np.load(L3_DIR / f"{face}-{x}-{y}.npy").astype(np.float64) for x in range(8) for y in range(8)}
        for level in (2, 1, 0):
            k = 2 ** level
            nxt = {}
            for x in range(k):
                for y in range(k):
                    t = tiles.box2(tiles.assemble_children([cur[(cx, cy)] for _, _, cx, cy in tiles.children(face, level, x, y)]))
                    tiles.write_u8("watermask", face, level, x, y, to_u8(t))
                    nxt[(x, y)] = t
            cur = nxt


def bake_global() -> None:
    from earth import gibs
    listing = gibs.fetch_list()          # cached after the first call; which MODIS tiles exist is an input
    cfg = {"v": 4, "correct": CORRECT_TEXELS, "sub": SUB, "subModis": SUB_MODIS, "deepM": DEEP_M,
           "nearDeep": NEAR_DEEP_TEXELS, "seed": OCEAN_SEED,
           "modisTiles": hashlib.sha256(repr(listing).encode("utf-8")).hexdigest()[:16]}
    if manifest.is_marked("watermask", "global") and (paths.STATE / "watermask-global.cfg").is_file() \
            and (paths.STATE / "watermask-global.cfg").read_text(encoding="utf-8") == str(cfg):
        log("watermask: global levels already baked")
        return
    units = [(f, x, y) for f in range(6) for x in range(8) for y in range(8)]
    key = lambda u: "%d-%d-%d" % u   # noqa: E731
    gibs.fetch_all()
    cc_done = units_done("watermask-cc", units, key, cfg) and (CC_DIR / "ocean.npz").is_file()
    if not cc_done:
        run_units("watermask-cc", _cc_unit, units, key=key, config=cfg)
        _join()
    run_units("watermask-global", _subtree_unit, units, key=key, config=cfg)
    _top_levels()
    (paths.STATE / "watermask-global.cfg").write_text(str(cfg), encoding="utf-8")
    manifest.mark("watermask", "global")


def bake_region(region_id: str) -> None:
    from earth import regmask
    regmask.bake(region_id)


def layer_manifest(regions: list[dict]) -> dict:
    from earth import region as regmod
    coverage: dict[str, list] = {}
    sources = list(SOURCES_GLOBAL)
    for reg in regions:
        for L in regmod.levels(reg):
            coverage.setdefault(str(L), []).extend(regmod.coverage_rects(reg, L))
        land = reg["sources"]["height"].get("landSurvey", "3DEP")
        s = (f"ESA WorldCover 2021 v200 inland water (CC BY 4.0) and the regional height sign ({land} land, sea floor "
             "on the WorldCover coastline of the ocean)")
        if s not in sources:
            sources.append(s)
    return {"encoding": "frt1-u8", "ext": "u8", "globalMaxLevel": paths.GLOBAL_MAX_LEVEL, "coverage": coverage,
            "classes": {"land": 0, "water": 255}, "sources": sources}
