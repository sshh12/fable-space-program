"""globals/albedoLowRes.png: 1024 x 512 equirectangular RGB (row 0 = north, column 0 = lon -180), the area
average of the global albedo layer (level-3 linear colour kept by the albedo bake, 8 x 8 sub-samples per pixel,
averaged in linear light). Used for far-body impostors and lighting estimates."""
from __future__ import annotations

import numpy as np
from PIL import Image

from common import cube
from earth import albedo, paths, tiles
from earth.hpyramid import locate
from earth.util import log

W, H = 1024, 512
SUB = 8
OUT = paths.TILES / "globals" / "albedoLowRes.png"


def bake_albedo_lowres() -> None:
    stack = np.zeros((6, 8, 8, 256, 256, 3), np.float32)
    for f in range(6):
        for x in range(8):
            for y in range(8):
                stack[f, x, y] = np.load(albedo.L3_DIR / f"{f}-{x}-{y}.npy")
    out = np.zeros((H, W, 3))
    k = (np.arange(SUB) + 0.5) / SUB
    for r0 in range(0, H, 32):
        rows = np.arange(r0, r0 + 32)
        lat = 90.0 - (rows[:, None, None, None] + k[None, :, None, None]) / H * 180.0
        lon = -180.0 + (np.arange(W)[None, None, :, None] + k[None, None, None, :]) / W * 360.0
        lat, lon = np.broadcast_arrays(lat, lon)
        d = cube.lat_lon_to_dir(np.radians(lat.ravel()), np.radians(lon.ravel()))
        face, x, y, u, v = locate(d, 3)
        c = np.minimum((u * 256).astype(np.int64), 255)
        r = np.minimum((v * 256).astype(np.int64), 255)
        val = stack[face, x, y, r, c].astype(np.float64)
        out[r0:r0 + 32] = val.reshape(32, SUB, W, SUB, 3).mean(axis=(1, 3))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_name("albedoLowRes.partial.png")
    Image.fromarray(tiles.linear_to_srgb8(out), "RGB").save(tmp, optimize=True)
    tmp.replace(OUT)
    log("globals: albedoLowRes.png written")
