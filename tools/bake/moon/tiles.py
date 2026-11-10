"""Reading baked tiles back: decoded-tile cache, run-time-equivalent Catmull-Rom height lookups, and the
coverage-weighted data height D_L of src/core/contracts/terrain.ts (COVERAGE_BLEND_TILES) for checks."""
from __future__ import annotations

from collections import OrderedDict

import numpy as np

from common import cube, frt1, layout
from moon.sampling import dirs_to_tiles, tile_bicubic

COVERAGE_BLEND_TILES = 0.25  # src/core/contracts/terrain.ts


class TileReader:
    """Decoded height tiles of one tile set with an LRU cache."""

    def __init__(self, tileset: str, layer: str = "height", cache_tiles: int = 512):
        self.tileset = tileset
        self.layer = layer
        self.manifest = layout.read_manifest(tileset)
        self.meta = self.manifest["layers"][layer]
        self.cache: OrderedDict = OrderedDict()
        self.cache_tiles = cache_tiles

    def has(self, face: int, level: int, x: int, y: int) -> bool:
        return layout.layer_has_tile(self.meta, face, level, x, y)

    def get(self, face: int, level: int, x: int, y: int) -> np.ndarray:
        key = (face, level, x, y)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        path = layout.tile_file(self.tileset, self.layer, face, level, x, y, self.meta["ext"])
        t = frt1.from_file_bytes(path.read_bytes())
        h = t["heights"]
        self.cache[key] = h
        if len(self.cache) > self.cache_tiles:
            self.cache.popitem(last=False)
        return h

    def bicubic(self, dirs: np.ndarray, level: int) -> np.ndarray:
        """Catmull-Rom of the level-`level` tiles at unit directions (..., 3). Every tile must exist."""
        shp = dirs.shape[:-1]
        d = dirs.reshape(-1, 3)
        f, x, y, u, v = dirs_to_tiles(d, level)
        out = np.empty(d.shape[0], dtype=np.float64)
        key = (f * (1 << 26) + x) * (1 << 26) + y
        order = np.argsort(key, kind="stable")
        ks = key[order]
        _, starts = np.unique(ks, return_index=True)
        ends = np.append(starts[1:], len(ks))
        for s0, s1 in zip(starts, ends):
            sel = order[s0:s1]
            ff, xx, yy = int(f[sel[0]]), int(x[sel[0]]), int(y[sel[0]])
            if not self.has(ff, level, xx, yy):
                raise KeyError(f"tile {ff}/{level}/{xx}/{yy} not in manifest")
            out[sel] = tile_bicubic(self.get(ff, level, xx, yy), u[sel], v[sel])
        return out.reshape(shp)

    # -- coverage weights (pure function of the manifest) ---------------------------------------------
    def coverage_weight(self, dirs: np.ndarray, level: int) -> np.ndarray:
        """w_L of terrain.ts: 0 on the coverage boundary, smootherstep to 1 a quarter tile inside."""
        shp = dirs.shape[:-1]
        d = dirs.reshape(-1, 3)
        if level <= self.meta["globalMaxLevel"]:
            return np.ones(shp)
        f, x, y, u, v = dirs_to_tiles(d, level)
        w = np.zeros(d.shape[0])
        key = (f * (1 << 26) + x) * (1 << 26) + y
        order = np.argsort(key, kind="stable")
        ks = key[order]
        _, starts = np.unique(ks, return_index=True)
        ends = np.append(starts[1:], len(ks))
        for s0, s1 in zip(starts, ends):
            sel = order[s0:s1]
            fi, xi, yi = int(f[sel[0]]), int(x[sel[0]]), int(y[sel[0]])
            if not self.has(fi, level, xi, yi):
                continue
            dist = np.full(len(sel), np.inf)
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    # neighbour position: map a point just beyond the tile edge / corner through dir_to_tile
                    p = cube.tile_uv_to_dir(fi, level, xi, yi, 0.5 + dx * (0.5 + 1e-9), 0.5 + dy * (0.5 + 1e-9))
                    nf, nx, ny, _, _ = cube.dir_to_tile(p, level)
                    if self.has(nf, level, nx, ny):
                        continue
                    # distance from (u, v) to the unit square [dx, dx + 1] x [dy, dy + 1] of that neighbour
                    gx = u[sel] if dx < 0 else (1.0 - u[sel] if dx > 0 else 0.0)
                    gy = v[sel] if dy < 0 else (1.0 - v[sel] if dy > 0 else 0.0)
                    dist = np.minimum(dist, np.hypot(gx, gy))
            t = np.minimum(1.0, dist / COVERAGE_BLEND_TILES)
            w[sel] = t * t * t * (t * (6.0 * t - 15.0) + 10.0)
        return w.reshape(shp)

    def data_height(self, dirs: np.ndarray, max_level: int) -> np.ndarray:
        """D_L of terrain.ts up to `max_level`: global bicubic, then each sparse level blended in by w_L."""
        g = self.meta["globalMaxLevel"]
        dd = self.bicubic(dirs, min(g, max_level))
        for L in range(g + 1, max_level + 1):
            w = self.coverage_weight(dirs, L)
            if not np.any(w > 0):
                break
            b = np.array(dd, copy=True)
            sel = w > 0
            b[sel] = self.bicubic(dirs[sel], L)
            dd = dd + w * (b - dd)
        return dd
