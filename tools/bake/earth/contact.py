"""Contact sheets for visual inspection (out/bake/earth/contact/*.png).

Everything is drawn NORTH UP / EAST RIGHT by going through the cube mapping (display pixel -> direction ->
tile, texel), so an orientation or registration error in the tiles shows up as discontinuities between tiles
or as misaligned layers. One sheet shows raw stored tiles (row 0 = low v: equatorial tiles look south-up).
"""
from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw

from common import cube
from earth import paths, region as regmod, tiles
from earth.hpyramid import locate
from earth.util import log

OUT = paths.OUT / "contact"
LC_PALETTE = np.array([[0, 0, 0], [30, 80, 170], [130, 120, 110], [230, 210, 140], [180, 160, 100], [150, 200, 90],
                       [110, 130, 60], [30, 100, 40], [230, 200, 60], [220, 40, 40], [245, 245, 250], [60, 150, 140]],
                      np.uint8)


class Sampler:
    """Nearest-texel lookups of a layer at one level for arbitrary directions."""

    def __init__(self, layer: str, level: int):
        self.layer, self.level = layer, level
        self.cache: dict = {}

    def tile(self, f, x, y):
        k = (f, x, y)
        if k not in self.cache:
            if self.layer == "height":
                h = tiles.read_height(f, self.level, x, y)
                self.cache[k] = None if h is None else h[1:258, 1:258]
            elif self.layer in ("albedo", "night"):
                self.cache[k] = tiles.read_webp(self.layer, f, self.level, x, y)
            else:
                self.cache[k] = tiles.read_u8(self.layer, f, self.level, x, y)
            if len(self.cache) > 3000:
                self.cache.pop(next(iter(self.cache)))
        return self.cache[k]

    def __call__(self, d: np.ndarray, fallback=None) -> np.ndarray:
        face, x, y, u, v = locate(d, self.level)
        n = 2 ** self.level
        key = (face * n + y) * n + x
        res = None
        for k in np.unique(key):
            f, yy, xx = int(k // (n * n)), int((k // n) % n), int(k % n)
            t = self.tile(f, xx, yy)
            sel = key == k
            if t is None:
                vals = fallback(d[sel]) if fallback is not None else None
                if vals is None:
                    continue
            else:
                size = t.shape[0]
                if self.layer == "height":       # vertex grid: bilinear
                    gi, gj = u[sel] * 256.0, v[sel] * 256.0
                    i0 = np.minimum(np.floor(gi).astype(int), 255)
                    j0 = np.minimum(np.floor(gj).astype(int), 255)
                    fx, fy = gi - i0, gj - j0
                    vals = (t[j0, i0] * (1 - fx) + t[j0, i0 + 1] * fx) * (1 - fy) + (t[j0 + 1, i0] * (1 - fx) + t[j0 + 1, i0 + 1] * fx) * fy
                else:
                    vals = t[np.minimum((v[sel] * size).astype(int), size - 1), np.minimum((u[sel] * size).astype(int), size - 1)]
            if res is None:
                res = np.zeros((d.shape[0],) + np.shape(vals)[1:], np.float64)
            res[sel] = vals
        return res


# ---------------------------------------------------------------------------------------------- rendering
def colour(layer: str, vals: np.ndarray, extra=None) -> np.ndarray:
    if layer in ("albedo", "night"):
        return np.clip(vals, 0, 255).astype(np.uint8)
    if layer == "watermask":
        m = vals / 255.0
        return np.stack([np.full_like(m, 40.0), 120 - 60 * m, 60 + 150 * m], -1).clip(0, 255).astype(np.uint8)
    if layer == "landcover":
        return LC_PALETTE[np.clip(vals.astype(int), 0, 11)]
    raise ValueError(layer)


def height_colour(h: np.ndarray, shade: np.ndarray) -> np.ndarray:
    """Hypsometric colours (blue below sea level) times a hillshade."""
    stops_h = np.array([-11000, -6000, -3000, -200, 0, 1, 200, 1000, 2500, 4500, 9000])
    stops_c = np.array([[10, 20, 60], [20, 40, 100], [40, 80, 150], [90, 150, 210], [140, 190, 230], [60, 120, 60],
                        [110, 150, 80], [190, 180, 110], [160, 120, 90], [230, 230, 230], [255, 255, 255]], np.float64)
    c = np.stack([np.interp(h, stops_h, stops_c[:, k]) for k in range(3)], -1)
    return np.clip(c * shade[..., None], 0, 255).astype(np.uint8)


def hillshade(h: np.ndarray, pixel_m: float, az=315.0, alt=45.0, exag=1.0) -> np.ndarray:
    gy, gx = np.gradient(h * exag, pixel_m)
    gy = -gy                                    # image rows go south
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    a, z = math.radians(az), math.radians(90 - alt)
    s = np.cos(z) * np.cos(slope) + np.sin(z) * np.sin(slope) * np.cos(a - aspect - math.pi)
    return np.clip(0.35 + 0.75 * s, 0.15, 1.25)


def cross_dirs(n: int) -> tuple[np.ndarray, np.ndarray]:
    """Directions of an unfolded cube (horizontal cross, equatorial faces -Y, +X, +Y, -X going east, the polar
    caps attached above/below +X), north up. Returns (dirs (3n, 4n, 3), valid mask)."""
    k = (np.arange(n) + 0.5) / n * 2.0 - 1.0
    A, B = np.meshgrid(k, -k)                   # A east, B north
    out = np.zeros((3 * n, 4 * n, 3))
    valid = np.zeros((3 * n, 4 * n), bool)
    for col, f in enumerate((3, 0, 2, 1)):
        out[n:2 * n, col * n:(col + 1) * n] = cube.face_st_to_dir(f, A, B)
        valid[n:2 * n, col * n:(col + 1) * n] = True
    top = np.stack([-B, A, np.ones_like(A)], -1)      # +Z cap above +X: point (-b, a, 1)
    bot = np.stack([B, A, -np.ones_like(A)], -1)      # -Z cap below +X: point (b, a, -1)
    out[0:n, n:2 * n] = top / np.linalg.norm(top, axis=-1, keepdims=True)
    out[2 * n:3 * n, n:2 * n] = bot / np.linalg.norm(bot, axis=-1, keepdims=True)
    valid[0:n, n:2 * n] = True
    valid[2 * n:3 * n, n:2 * n] = True
    return out, valid


def latlon_grid(lat0, lat1, lon0, lon1, w, h):
    lat = np.linspace(lat1, lat0, h)
    lon = np.linspace(lon0, lon1, w)
    LO, LA = np.meshgrid(lon, lat)
    return cube.lat_lon_to_dir(np.radians(LA), np.radians(LO)), LA, LO


def render(layer: str, level: int, d: np.ndarray, shape, pixel_m: float | None = None) -> np.ndarray:
    s = Sampler(layer, level)
    vals = s(d.reshape(-1, 3))
    if layer == "height":
        h = vals.reshape(shape)
        return height_colour(h, hillshade(h, pixel_m or 1000.0, exag=1.0 if (pixel_m or 1000) < 200 else 4.0))
    return colour(layer, vals).reshape(shape + (3,))


def save(img: np.ndarray, name: str, label: str | None = None) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    im = Image.fromarray(img)
    if label:
        dr = ImageDraw.Draw(im)
        dr.rectangle([0, 0, 8 + 7 * len(label), 16], fill=(0, 0, 0))
        dr.text((4, 3), label, fill=(255, 255, 0))
    im.save(OUT / name)


# ---------------------------------------------------------------------------------------------- sheets
def globe_sheets() -> None:
    n = 512
    d, valid = cross_dirs(n)
    for layer, level in (("albedo", 1), ("night", 1), ("watermask", 1), ("landcover", 3), ("height", 3)):
        img = np.zeros((3 * n, 4 * n, 3), np.uint8)
        px_m = math.pi * paths.RADIUS / 2 / n
        dd = d[valid]
        if layer == "height":
            # hillshade needs a grid: render per face block
            for (r0, c0) in [(n, 0), (n, n), (n, 2 * n), (n, 3 * n), (0, n), (2 * n, n)]:
                blk = d[r0:r0 + n, c0:c0 + n]
                img[r0:r0 + n, c0:c0 + n] = render("height", level, blk, (n, n), px_m)
        else:
            img[valid] = render(layer, level, dd, (int(valid.sum()),))
        save(img, f"globe-{layer}.png", f"{layer} level {level}, unfolded cube, north up")
    log("contact: globe sheets")


def face_sheets() -> None:
    """Per face, per layer: the whole face from level-2 tiles (1024 px), north up for equatorial faces."""
    n = 1024
    k = (np.arange(n) + 0.5) / n * 2.0 - 1.0
    for f in range(6):
        A, B = np.meshgrid(k, -k)
        d = cube.face_st_to_dir(f, A, B)
        for layer, level in (("albedo", 2), ("night", 2), ("watermask", 2), ("landcover", 2), ("height", 2)):
            img = render(layer, level, d, (n, n), math.pi * paths.RADIUS / 2 / n)
            save(img, f"face{f}-{layer}.png", f"face {f} {layer} level {level} (v up)")
    log("contact: face sheets")


PLACES = [("himalaya", 26.5, 30.5, 84.0, 90.0), ("netherlands", 51.3, 53.6, 3.5, 7.2), ("hawaii", 18.8, 20.4, -156.2, -154.7),
          ("nile-delta", 29.8, 31.7, 29.5, 32.6), ("alps", 45.0, 47.8, 6.0, 12.0), ("greenland-coast", 63.0, 66.5, -53.0, -45.0),
          ("caspian-north", 44.0, 47.5, 47.0, 54.0), ("great-lakes", 41.0, 47.5, -90.0, -79.0), ("antarctic-peninsula", -66.0, -62.0, -64.0, -56.0)]


def place_sheets() -> None:
    """Level-7 crops of characteristic places, all layers side by side with mask/height coastline overlay."""
    for name, la0, la1, lo0, lo1 in PLACES:
        h = 600
        w = int(h * (lo1 - lo0) * math.cos(math.radians(0.5 * (la0 + la1))) / (la1 - la0))
        d, LA, LO = latlon_grid(la0, la1, lo0, lo1, w, h)
        px = (la1 - la0) * 111_195.0 / h
        panels = []
        for layer in ("albedo", "height", "watermask", "landcover", "night"):
            panels.append(render(layer, 7, d, (h, w), px))
        # coastline overlay on albedo: mask 50 % (red) and height 0 (yellow)
        m = Sampler("watermask", 7)(d.reshape(-1, 3)).reshape(h, w) >= 128
        z = Sampler("height", 7)(d.reshape(-1, 3)).reshape(h, w) < 0
        ov = panels[0].copy()
        ov[m ^ np.roll(m, 1, 0) | m ^ np.roll(m, 1, 1)] = (255, 40, 40)
        ov[z ^ np.roll(z, 1, 0) | z ^ np.roll(z, 1, 1)] = (255, 230, 0)
        panels.insert(1, ov)
        sep = np.full((h, 6, 3), 255, np.uint8)
        row = np.concatenate(sum([[p, sep] for p in panels], [])[:-1], axis=1)
        save(row, f"place-{name}.png", f"{name} level 7: albedo | coast (red mask, yellow h=0) | height | mask | landcover | night")
    log("contact: place sheets")


def raw_tile_sheet() -> None:
    """Stored tiles as written (row 0 = low v): a 4 x 4 block of level-4 albedo tiles of face 0, no flips."""
    rows = []
    for y in range(4, 8):
        rows.append(np.concatenate([tiles.read_webp("albedo", 0, 4, x, y) for x in range(6, 10)], axis=1))
    save(np.concatenate(rows, axis=0), "raw-tiles-face0-level4.png", "stored rows (v up = image down): south-up as intended")


def regional_sheets(region_id: str) -> None:
    reg = regmod.load(region_id)
    for lv in regmod.levels(reg):
        rect = max(regmod.coverage_rects(reg, lv), key=lambda r: (r["x1"] - r["x0"] + 1) * (r["y1"] - r["y0"] + 1))
        f = rect["face"]
        nx, ny = rect["x1"] - rect["x0"] + 1, rect["y1"] - rect["y0"] + 1
        scale = max(1, int(math.ceil(max(nx, ny) * 256 / 2048)))
        W, H = nx * 256 // scale, ny * 256 // scale
        # display grid in the face's (s, t), north up
        ss = -1 + 2 * (rect["x0"] + (np.arange(W) + 0.5) * scale / 256) / 2 ** lv
        tt = -1 + 2 * (rect["y0"] + (np.arange(H) + 0.5) * scale / 256) / 2 ** lv
        S, T = np.meshgrid(ss, tt[::-1])
        d = cube.face_st_to_dir(f, S, T)
        px = 2 * math.pi * paths.RADIUS / 4 / 2 ** lv / 256 * scale * 0.8
        for layer in ("albedo", "height", "watermask", "landcover"):
            save(render(layer, lv, d, (H, W), px), f"region-{region_id}-l{lv}-{layer}.png",
                 f"{region_id} level {lv} {layer} (coverage {nx} x {ny} tiles, 1/{scale})")
    log(f"contact: regional pyramid sheets for {region_id}")


def regional_hillshade(region_id: str) -> None:
    from earth.site import destination
    reg = regmod.load(region_id)
    c = reg["shape"]["centre"]
    lv = regmod.levels(reg)[-1]
    for name, half, size in (("pad-20km", 10000.0, 2048), ("pad-3km", 1500.0, 1024)):
        k = np.linspace(-half, half, size)
        E, N = np.meshgrid(k, k[::-1])
        la, lo = destination(c["latDeg"], c["lonDeg"], E.ravel(), N.ravel())
        d = cube.lat_lon_to_dir(np.radians(la), np.radians(lo))
        h = Sampler("height", lv)(d).reshape(size, size)
        px = 2 * half / size
        shade = hillshade(h, px)
        img = np.clip(np.stack([shade * 200] * 3, -1), 0, 255).astype(np.uint8)
        img[np.abs(h) < 0.5 * px] = (0, 120, 255)
        im = Image.fromarray(img)
        dr = ImageDraw.Draw(im)
        r450 = 450.0 / px
        dr.ellipse([size / 2 - r450, size / 2 - r450, size / 2 + r450, size / 2 + r450], outline=(255, 0, 0))
        im.save(OUT / f"region-{region_id}-hillshade-{name}.png")
        alb = Sampler("albedo", lv)(d).reshape(size, size, 3).astype(np.uint8)
        im2 = Image.fromarray(alb)
        dr2 = ImageDraw.Draw(im2)
        dr2.ellipse([size / 2 - r450, size / 2 - r450, size / 2 + r450, size / 2 + r450], outline=(255, 0, 0))
        m = Sampler("watermask", lv)(d).reshape(size, size) >= 128
        a = np.asarray(im2).copy()
        a[m ^ np.roll(m, 1, 0) | m ^ np.roll(m, 1, 1)] = (0, 200, 255)
        Image.fromarray(a).save(OUT / f"region-{region_id}-albedo-{name}.png")
    log(f"contact: regional hillshade and pad sheets for {region_id}")


def _edge_window(r: dict, side: str, pos: float):
    """Global texel coordinates (GX east, GY north; display rows run north to south) of a window straddling
    one side of a coverage rect: 256 texels inside, 128 outside, 256 along the edge centred on `pos`."""
    a = np.arange(-128, 128) + 0.5
    if side in ("E", "W"):
        e = (r["x1"] + 1) * 256 if side == "E" else r["x0"] * 256
        gx = e + (np.arange(-256, 128) if side == "E" else np.arange(-128, 256)) + 0.5
        gy = pos - a                                            # north up
        GX, GY = np.meshgrid(gx, gy)
        inside = GX < e if side == "E" else GX > e
    else:
        e = (r["y1"] + 1) * 256 if side == "N" else r["y0"] * 256
        gy = e + (np.arange(128, -256, -1) if side == "N" else np.arange(256, -128, -1)) - 0.5
        GX, GY = np.meshgrid(pos + a, gy)
        inside = GY < e if side == "N" else GY > e
    return GX, GY, inside


def coverage_edge_crops(region_id: str) -> None:
    """For every regional level, a window of 384 x 256 texels straddling the coverage boundary where it crosses
    the most land (an all-ocean window would show nothing): inside from the level itself, outside from its
    parent (bilinear) -- the switch the renderer makes. North up (the region lies on an equatorial face)."""
    reg = regmod.load(region_id)
    for lv in regmod.levels(reg):
        r = max(regmod.coverage_rects(reg, lv), key=lambda q: (q["x1"] - q["x0"] + 1) * (q["y1"] - q["y0"] + 1))
        f = r["face"]
        n = 256 * 2 ** lv
        parent_mask = Sampler("watermask", lv - 1)
        best = None
        for side in ("E", "W", "N", "S"):
            lo, hi = ((r["y0"] * 256, (r["y1"] + 1) * 256) if side in ("E", "W") else (r["x0"] * 256, (r["x1"] + 1) * 256))
            for pos in np.arange(lo + 128, hi - 127, 64):
                GX, GY, _ = _edge_window(r, side, float(pos))
                g = cube.face_st_to_dir(f, -1 + 2 * GX[::16, ::16] / n, -1 + 2 * GY[::16, ::16] / n).reshape(-1, 3)
                land = float(np.mean(1.0 - parent_mask(g) / 255.0))
                if best is None or land > best[0]:
                    best = (land, side, float(pos))
        land, side, pos = best
        GX, GY, inside = _edge_window(r, side, pos)
        d = cube.face_st_to_dir(f, -1 + 2 * GX / n, -1 + 2 * GY / n)
        px = 2 * math.pi * paths.RADIUS / 4 / 2 ** lv / 256 * 0.8
        for layer in ("albedo", "height"):
            fine = Sampler(layer, lv)
            coarse = Sampler(layer, lv - 1)
            dd = d.reshape(-1, 3)
            if layer == "height":
                v = coarse(dd).reshape(GX.shape)
                vi = fine(dd[inside.ravel()])
                v[inside] = vi
                img = height_colour(v, hillshade(v, px))
            else:
                v = coarse(dd).reshape(GX.shape + (3,))
                v[inside] = fine(dd[inside.ravel()])
                img = np.clip(v, 0, 255).astype(np.uint8)
            img = np.kron(img, np.ones((2, 2, 1), np.uint8))
            where = {"E": "left | right, edge at x = 512", "W": "right | left, edge at x = 256",
                     "N": "bottom | top, edge at y = 256", "S": "top | bottom, edge at y = 512"}[side]
            save(img, f"region-{region_id}-edge-l{lv}-{layer}.png",
                 f"{side} edge, level {lv} | level {lv - 1}: {where} (land {land * 100:.0f} %)")
    log(f"contact: coverage edge crops for {region_id}")


def cloud_sheet() -> None:
    p = paths.TILES / "globals" / "cloudCoverage.png"
    if not p.is_file():
        return
    a = np.asarray(Image.open(p))
    cov = a[::4, ::4, 0]
    top = a[::4, ::4, 1]
    alb = paths.TILES / "globals" / "albedoLowRes.png"
    base = np.asarray(Image.open(alb).resize((2048, 1024), Image.BILINEAR)).astype(np.float64) if alb.is_file() \
        else np.zeros((1024, 2048, 3))
    comp = base * (1 - cov[..., None] / 255.0) + 255.0 * (cov[..., None] / 255.0)
    save(np.concatenate([np.stack([cov] * 3, -1), np.stack([top] * 3, -1), comp.astype(np.uint8)], axis=0),
         "clouds.png", "coverage | cloudTop (x50 m) | coverage over albedoLowRes")
    if alb.is_file():
        save(np.asarray(Image.open(alb)), "albedoLowRes.png", "albedoLowRes 1024 x 512")


def write_all(region_ids: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    globe_sheets()
    face_sheets()
    place_sheets()
    raw_tile_sheet()
    cloud_sheet()
    for r in region_ids:
        regional_sheets(r)
        regional_hillshade(r)
        coverage_edge_crops(r)
