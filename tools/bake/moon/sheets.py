"""Contact sheets of the Moon bake for visual inspection (out/bake/moon/*.png).

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/moon/sheets.py [--region moon-tranquility]

  faces-albedo.png / faces-height.png  unfolded cube (equatorial faces west->east: -Y +X +Y -X; +Z above and
                                       -Z below +X), north up on the equatorial faces
  nearside.png / farside.png           orthographic views of the albedo (level 4) and hillshade (level 5)
  region-L{7..12}.png                  regional pyramid as hillshades, one level per sheet
  edge-L{7..12}.png                    run-time-blended surface across a coverage edge (left: hillshade of D_L,
                                       right: D_L - D_(L-1), +-2 m), the coverage boundary marked
  deshade-<crater>.png                 raw WAC | undeshaded detail x SVS | de-shaded detail x SVS | final level-7 albedo
  target.png                           level-12 hillshade around the recommended target with detected craters
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from common import cube, frt1, layout  # noqa: E402
from moon import imaging, rt  # noqa: E402
from moon.sampling import srgb_encode  # noqa: E402
from moon.tiles import TileReader  # noqa: E402
from moon.verify import AlbedoReader  # noqa: E402

OUT = rt.MOON_OUT


def face_raster(layer: str, face: int, level: int, size: int) -> np.ndarray:
    """Whole face at `level` as [row = v, col = u]: RGB (albedo) or heights (m), resampled to size x size."""
    n = 2 ** level
    if layer == "albedo":
        big = np.zeros((n * 256, n * 256, 3), np.uint8)
        for x in range(n):
            for y in range(n):
                with Image.open(layout.tile_file(rt.TILESET, "albedo", face, level, x, y, "webp")) as im:
                    big[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = np.asarray(im.convert("RGB"))
        return np.asarray(Image.fromarray(big).resize((size, size), Image.LANCZOS))
    big = np.zeros((n * 256, n * 256), np.float32)
    for x in range(n):
        for y in range(n):
            h = frt1.from_file_bytes(layout.tile_file(rt.TILESET, "height", face, level, x, y, "hgt").read_bytes())["heights"]
            big[y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = h[1:257, 1:257]
    spacing = math.pi / 2 * rt.MOON_RADIUS / (n * 256)
    hs = imaging.hillshade(big[::-1], spacing, az_deg=270.0, elev_deg=35.0)[::-1]
    return np.asarray(Image.fromarray(imaging.to_u8(hs, 0, 1)).resize((size, size), Image.LANCZOS))


def orient(img: np.ndarray, face: int) -> np.ndarray:
    """Face raster [v, u] -> its place in the unfolded-cube sheet (north up on equatorial faces)."""
    if face < 4:
        return img[::-1]
    if face == 4:
        return np.swapaxes(img, 0, 1)
    return np.swapaxes(img, 0, 1)[::-1, ::-1]


def faces_sheet(layer: str, level: int, size: int = 512) -> Path:
    slots = {3: (1, 0), 0: (1, 1), 2: (1, 2), 1: (1, 3), 4: (0, 1), 5: (2, 1)}
    ch = 3
    out = np.full((3 * size, 4 * size, ch), 20, np.uint8)
    for f, (r, c) in slots.items():
        im = orient(face_raster(layer, f, level, size), f)
        if im.ndim == 2:
            im = np.repeat(im[..., None], 3, axis=2)
        out[r * size:(r + 1) * size, c * size:(c + 1) * size] = im
    img = Image.fromarray(out)
    for f, (r, c) in slots.items():
        imaging.label(img, (c * size + 6, r * size + 6), ["+X lon 0", "-X lon 180", "+Y lon 90E", "-Y lon 90W", "+Z north", "-Z south"][f])
    p = OUT / f"faces-{layer}.png"
    img.save(p)
    return p


def ortho(lon0: float, fn, size: int = 900) -> np.ndarray:
    k = (np.arange(size) + 0.5) / size * 2 - 1
    X, Y = np.meshgrid(k, -k)
    rr = X * X + Y * Y
    inside = rr < 1.0
    z = np.sqrt(np.clip(1 - rr, 0, 1))
    lo = math.radians(lon0)
    # view from +direction (lat 0, lon0): east = +X screen, north = +Y screen
    c = np.array([math.cos(lo), math.sin(lo), 0.0])
    e = np.array([-math.sin(lo), math.cos(lo), 0.0])
    n = np.array([0.0, 0.0, 1.0])
    d = z[..., None] * c + X[..., None] * e + Y[..., None] * n
    d = d / np.linalg.norm(d, axis=-1, keepdims=True)
    out = np.zeros((size, size, 3), np.uint8)
    out[inside] = fn(d[inside])
    return out


def globes() -> list[Path]:
    alb = AlbedoReader(4)
    reader = TileReader(rt.TILESET, cache_tiles=8192)

    def albedo_fn(d):
        return (srgb_encode(alb.linear(d)) * 255 + 0.5).astype(np.uint8)

    def shade_fn(d):
        h = reader.bicubic(d, 5)
        # shade with the sun from the west at 25 deg: finite differences along east
        lat, lon = cube.dir_to_lat_lon(d)
        dl = 2000.0 / rt.MOON_RADIUS
        h2 = reader.bicubic(cube.lat_lon_to_dir(lat, lon + dl / np.maximum(np.cos(lat), 1e-3)), 5)
        g = (h2 - h) / 2000.0
        v = np.clip(0.5 - 4.0 * g, 0, 1)
        return np.repeat((v * 255).astype(np.uint8)[:, None], 3, axis=1)

    paths = []
    for name, lon0 in (("nearside", 0.0), ("farside", 180.0)):
        a = ortho(lon0, albedo_fn)
        s = ortho(lon0, shade_fn)
        img = Image.fromarray(np.concatenate([a, s], axis=1))
        imaging.label(img, (8, 8), f"{name}: albedo level 4 (left), east-west slope shading of level-5 heights (right); north up, east right")
        p = OUT / f"{name}.png"
        img.save(p)
        paths.append(p)
    return paths


def region_sheets(reader: TileReader) -> list[Path]:
    paths = []
    cov = reader.meta["coverage"]
    for Ls in sorted(cov, key=int):
        L = int(Ls)
        for r in cov[Ls]:
            nx, ny = r["x1"] - r["x0"] + 1, r["y1"] - r["y0"] + 1
            big = np.zeros((ny * 256, nx * 256), np.float32)
            for x in range(r["x0"], r["x1"] + 1):
                for y in range(r["y0"], r["y1"] + 1):
                    h = reader.get(r["face"], L, x, y)
                    big[(y - r["y0"]) * 256:(y - r["y0"] + 1) * 256, (x - r["x0"]) * 256:(x - r["x0"] + 1) * 256] = h[1:257, 1:257]
            spacing = cube.mean_tile_size(rt.MOON_RADIUS, L) / 256.0
            hs = imaging.hillshade(big[::-1], spacing, az_deg=90.0, elev_deg=20.0)
            u8 = imaging.to_u8(hs, 0, 1)
            scale = min(1.0, 2400.0 / max(u8.shape))
            img = Image.fromarray(u8).resize((max(1, int(u8.shape[1] * scale)), max(1, int(u8.shape[0] * scale))), Image.LANCZOS).convert("RGB")
            imaging.label(img, (6, 6), f"level {L}: {nx} x {ny} tiles, face {r['face']}, {spacing:.1f} m/sample, sun from east 20 deg, north up")
            p = OUT / f"region-L{L}.png"
            img.save(p)
            paths.append(p)
    return paths


def edge_crops(reader: TileReader) -> list[Path]:
    """Across the west edge of each level's coverage rectangle, at its middle row."""
    paths = []
    cov = reader.meta["coverage"]
    for Ls in sorted(cov, key=int):
        L = int(Ls)
        r = cov[Ls][0]
        ymid = (r["y0"] + r["y1"] + 1) / 2.0
        n = 2 ** L
        edge_dir = cube.face_st_to_dir(r["face"], -1 + 2 * r["x0"] / n, -1 + 2 * ymid / n)
        lat, lon = (float(v) for v in cube.dir_to_lat_lon(edge_dir))
        spacing = cube.mean_tile_size(rt.MOON_RADIUS, L) / 256.0
        half = 160
        e = np.array([-math.sin(lon), math.cos(lon), 0.0])
        nn = np.cross(edge_dir, e)
        k = (np.arange(-half, half) + 0.5) * spacing
        X, Y = np.meshgrid(k, -k)
        p = rt.MOON_RADIUS * edge_dir + X[..., None] * e + Y[..., None] * nn
        d = p / np.linalg.norm(p, axis=-1, keepdims=True)
        dl = reader.data_height(d, L)
        dp = reader.data_height(d, L - 1)
        hs = imaging.to_u8(imaging.hillshade(dl, spacing, az_deg=90.0, elev_deg=20.0), 0, 1)
        diff = np.clip((dl - dp) / 2.0, -1, 1)
        dimg = np.stack([np.clip(diff, 0, 1), np.zeros_like(diff), np.clip(-diff, 0, 1)], -1) * 255
        w = reader.coverage_weight(d, L)
        a = np.repeat(hs[..., None], 3, 2)
        a[(w > 0) & (np.roll(w, 1, 1) == 0)] = [255, 255, 0]
        img = Image.fromarray(np.concatenate([a, dimg.astype(np.uint8)], axis=1))
        imaging.label(img, (6, 6), f"level {L} coverage edge (yellow), D_L hillshade | D_L - D_{L - 1} (red +, blue -, full at 2 m)")
        out = OUT / f"edge-L{L}.png"
        img.save(out)
        paths.append(out)
    return paths


def source_edge_crops(reader: TileReader, region_id: str) -> list[Path]:
    """Across the source feathers inside the coverage: the SLDEM disc edge (level 9) and the NAC strip's
    west edge (level 12), both through the run-time data height D_L."""
    from moon.region import load_region

    region = load_region(region_id)
    c = region["centre"]
    z = np.load(rt.MOON_WORK / f"region-{region_id}" / "target-grid.npz")
    clat, clon = (float(v) for v in z["plane"])
    real = z["real"]
    i0 = real.shape[0] // 2
    c_west = int(np.nonzero(real[i0])[0].min())
    x_edge = float(z["xs"][c_west])
    y_mid = float(z["ys"][i0])
    disc_r = region["bands"][0]["area"]["radiusM"]
    out = []
    for name, lat0, lon0, x_off, y_off, level, step in (
            ("sldem-disc-edge-L9", c["latDeg"], c["lonDeg"], -disc_r, 0.0, 9, 20.0),
            ("nac-strip-edge-L12", clat, clon, x_edge, y_mid, 12, 2.0)):
        la, lo = math.radians(lat0), math.radians(lon0)
        cd = cube.lat_lon_to_dir(la, lo)
        e = np.array([-math.sin(lo), math.cos(lo), 0.0])
        n = np.cross(cd, e)
        k = (np.arange(-200, 200) + 0.5) * step
        X, Y = np.meshgrid(k + x_off, -k + y_off)
        p = rt.MOON_RADIUS * cd + X[..., None] * e + Y[..., None] * n
        d = p / np.linalg.norm(p, axis=-1, keepdims=True)
        h = reader.data_height(d, level)
        hs = imaging.to_u8(imaging.hillshade(h, step, az_deg=90.0, elev_deg=20.0), 0, 1)
        img = Image.fromarray(hs).convert("RGB")
        dr = ImageDraw.Draw(img)
        dr.line([200, 0, 200, 399], fill=(255, 255, 0))
        imaging.label(img, (6, 6), f"{name}: data height at level {level}, {step:g} m/px, source edge at the yellow line")
        pth = OUT / f"{name}.png"
        img.save(pth)
        out.append(pth)
    return out


def deshade_sheets(names=("Kepler", "Plinius", "Bullialdus", "Aristarchus")) -> list[Path]:
    from moon import albedo

    wins = {c["name"]: c for c in rt.read_json(rt.MOON_WORK / "crater_windows.json")}
    L7 = AlbedoReader(7)
    paths = []
    for nm in names:
        c = wins[nm]
        shape = (c["r1"] - c["r0"], c["c1"] - c["c0"])
        arr = {k: np.memmap(rt.MOON_WORK / "crater_crops" / f"{nm}.{k}.f32", dtype=np.float32, mode="r", shape=shape)
               for k in ("W", "D", "Draw", "S")}
        rows = np.arange(c["r0"], c["r1"])
        cols = np.arange(c["c0"], c["c1"])
        la = albedo.wac_row_lat(rows)
        lo = -180.0 + (np.mod(cols, albedo.WAC_W) + 0.5) * 360.0 / albedo.WAC_W
        LA, LO = np.meshgrid(la, lo, indexing="ij")
        d = cube.lat_lon_to_dir(np.radians(LA), np.radians(LO))
        # needs the albedo work files (svs_mip*.f16) of a bake that has not been cleaned up yet
        svs = albedo.svs_pyramid().sample(LA, LO, np.zeros_like(LA))[..., 0]
        fin = L7.linear(d)[..., 0]

        panels = [imaging.to_u8(np.asarray(arr["W"])), imaging.to_u8(svs * np.asarray(arr["Draw"]), 0, 0.3),
                  imaging.to_u8(svs * np.asarray(arr["D"]), 0, 0.3), imaging.to_u8(fin, 0, 0.3)]
        img = Image.fromarray(np.concatenate(panels, axis=1)).convert("RGB")
        imaging.label(img, (6, 6), f"{nm}: raw WAC | SVS x raw detail | SVS x de-shaded detail | final level 7 (red, linear 0-0.3)")
        p = OUT / f"deshade-{nm}.png"
        img.save(p)
        paths.append(p)
    return paths


def target_sheet(region_id: str) -> Path:
    z = np.load(rt.MOON_WORK / f"region-{region_id}" / "target-grid.npz")
    xs, ys, h, cr, x0, y0 = z["xs"], z["ys"], z["h"].astype(np.float64), z["craters"], float(z["x0"]), float(z["y0"])
    j0, i0 = int(np.argmin(np.abs(xs - x0))), int(np.argmin(np.abs(ys - y0)))
    half = 750
    sub = h[max(0, i0 - half):i0 + half, max(0, j0 - half):j0 + half][::-1]
    cm = cr[max(0, i0 - half):i0 + half, max(0, j0 - half):j0 + half][::-1]
    hs = imaging.hillshade(sub, 2.0, az_deg=90.0, elev_deg=15.0)
    rgb = np.repeat(imaging.to_u8(hs, 0, 1)[..., None], 3, axis=2)
    edge = cm & (~np.roll(cm, 1, 0) | ~np.roll(cm, 1, 1))
    rgb[edge] = [255, 60, 60]
    img = Image.fromarray(rgb)
    dr = ImageDraw.Draw(img)
    cy, cx = sub.shape[0] - 1 - min(half, i0), min(half, j0)
    for rad_m, col in ((50, (0, 255, 0)), (150, (255, 255, 0)), (750, (0, 200, 255))):
        rad = rad_m / 2.0
        dr.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], outline=col)
    imaging.label(img, (6, 6), "level-12 data, 2 m grid, sun from east 15 deg; green 100 m slope disc, yellow 150 m crater exclusion, "
                               "cyan 750 m; red outlines = detected craters >= 20 m")
    p = OUT / "target.png"
    img.save(p)
    return p


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="moon-tranquility")
    ap.add_argument("--only", default="faces,globes,region,edges,sources,deshade,target")
    a = ap.parse_args()
    rt.check_python()
    rt.below_normal_priority()
    OUT.mkdir(parents=True, exist_ok=True)
    reader = TileReader(rt.TILESET, cache_tiles=8192)
    todo = a.only.split(",")
    made = []
    if "faces" in todo:
        made += [faces_sheet("albedo", 3), faces_sheet("height", 4)]
    if "globes" in todo:
        made += globes()
    if "region" in todo:
        made += region_sheets(reader)
    if "edges" in todo:
        made += edge_crops(reader)
    if "sources" in todo:
        made += source_edge_crops(reader, a.region)
    if "deshade" in todo:
        made += deshade_sheets()
    if "target" in todo:
        made.append(target_sheet(a.region))
    for p in made:
        print(p)


if __name__ == "__main__":
    main()
