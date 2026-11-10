"""Sentinel-2 cloudless (EOX) source for a region: download, multi-year median composite.

z14 (about 9 m per pixel at Hawai'i) is fetched for every tile within LAND_BUFFER_KM of land, z12 (about 36 m)
over the whole regional bounding box (open ocean has no detail finer than that). Each zoom is composited as
the per-pixel, per-channel median over the configured years, which removes the cloud remnants and seams that
any single annual mosaic keeps, and is cached as a uint8 TileStack.
CC BY-NC-SA 4.0: recorded as swappable in tools/bake/earth/sources.json and the region file.
"""
from __future__ import annotations

import math

import numpy as np
from scipy import ndimage

from earth import merc, paths, region as regmod
from earth.tilestack import TileStack
from earth.util import log

LAND_BUFFER_KM = 10.0
OCEAN_ZOOM = 12


def tile_sets(region: dict) -> tuple[list[tuple[int, int]], list[tuple[int, int]], int]:
    """(z14 tiles, z12 tiles, z14) for a region: computed from the Terrarium survey mosaic."""
    z_land = int(region["sources"]["albedo"]["zoom"])
    lat0, lat1, lon0, lon1 = regmod.source_bbox(region, 2.0)
    zs = OCEAN_ZOOM
    x0, y0, x1, y1 = merc.tile_range(lat0, lat1, lon0, lon1, zs)
    ocean = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]
    merc.fetch_terrarium([(zs, x, y) for x, y in ocean])
    survey = merc.MercMosaic.build(zs, x0, y0, x1, y1, merc.terrarium_loader)
    px_m = 2 * math.pi * paths.RADIUS / (256 * 2 ** zs) * math.cos(math.radians(0.5 * (lat0 + lat1)))
    near = ndimage.distance_transform_edt(~(survey.data > 0.0)) * px_m <= LAND_BUFFER_KM * 1000.0
    f = 2 ** (z_land - zs)
    block = 256 // f
    h, w = near.shape
    nb = near.reshape(h // block, block, w // block, block).any(axis=(1, 3))
    ty, tx = np.nonzero(nb)
    land = [(int(x0 * f + i), int(y0 * f + j)) for j, i in zip(ty, tx)]
    return land, ocean, z_land


def fetch(region: dict) -> None:
    land, ocean, z = tile_sets(region)
    years = region["sources"]["albedo"]["years"]
    log(f"s2: {len(land)} z{z} tiles near land, {len(ocean)} z{OCEAN_ZOOM} tiles, years {years}")
    for yr in years:
        c = merc.fetch_s2(yr, [(OCEAN_ZOOM, x, y) for x, y in ocean])
        c2 = merc.fetch_s2(yr, [(z, x, y) for x, y in land])
        log(f"s2 {yr}: z{OCEAN_ZOOM} {c}, z{z} {c2}")


def _median_loader(years: list[int]):
    def load(z: int, x: int, y: int):
        arrs = []
        for yr in years:
            p = merc.s2_path(yr, z, x, y)
            if p.is_file():
                arrs.append(merc.s2_loader(yr)(z, x, y))
        if not arrs:
            return None
        if len(arrs) == 1:
            return arrs[0]
        return np.median(np.stack(arrs), axis=0).round().astype(np.uint8)
    return load


def composites(region: dict) -> tuple[TileStack, TileStack]:
    """(z14 near-land stack, z12 stack) of the multi-year median."""
    land, ocean, z = tile_sets(region)
    years = list(region["sources"]["albedo"]["years"])
    loader = _median_loader(years)
    fine = TileStack.build(f"s2med-{'-'.join(map(str, years))}", z, land, loader, channels=3, dtype=np.uint8)
    coarse = TileStack.build(f"s2med-{'-'.join(map(str, years))}", OCEAN_ZOOM, ocean, loader, channels=3, dtype=np.uint8)
    return fine, coarse
