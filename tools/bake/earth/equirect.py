"""Global 15 arc-second RGB sources delivered as 8 JPEG quadrant tiles of 21600 x 21600 (A1..D2):
NASA Blue Marble Next Generation (albedo) and NASA Black Marble 2016 (night lights).

Tile letters A..D = longitude bands from -180 in 90 deg steps, digit 1 = north (90..0), 2 = south (0..-90).
Pixel (r, c) of the global 86400 x 43200 grid has its centre at lat 90 - (r + 0.5) / 240,
lon -180 + (c + 0.5) / 240.

Cube faces are processed one at a time from a per-face crop (uint8 .npy memmap in data/cache/earth/work):
equatorial faces need lat -45..45 over their 90 deg of longitude (1.4 GB), polar faces lat 35..90 (or the
south equivalent) over all longitudes (3.4 GB). Rows poleward of ~61 deg are low-passed along longitude.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image

from earth import fetch, paths
from earth.util import log

Image.MAX_IMAGE_PIXELS = None
PX_PER_DEG = 240
W, H = 360 * PX_PER_DEG, 180 * PX_PER_DEG
QUADS = [f"{a}{b}" for b in "12" for a in "ABCD"]
LON_PREFILTER_RATIO = 0.6
MARGIN_DEG = 0.25

SOURCES = {
    "bmng": {
        "url": "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base/{month_name}/"
               "world.2004{month:02d}.3x21600x21600.{quad}.jpg",
        "dir": "bmng-2004{month:02d}",
    },
    "blackmarble": {
        "url": "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/"
               "BlackMarble_2016_{quad}.jpg",
        "dir": "blackmarble-2016",
    },
}
MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
          "november", "december"]


def quad_path(src: str, quad: str, month: int = 8) -> Path:
    if src == "nightemission":          # derived quadrants (night.py), lossless PNG
        return paths.WORK / "night-quads" / f"emission_{quad}.png"
    s = SOURCES[src]
    return paths.src_dir(s["dir"].format(month=month)) / Path(s["url"]).name.format(
        month=month, quad=quad, month_name=MONTHS[month - 1])


def download(src: str, month: int = 8) -> None:
    s = SOURCES[src]
    for q in QUADS:
        url = s["url"].format(month=month, month_name=MONTHS[month - 1], quad=q)
        fetch.download(url, quad_path(src, q, month))


def quad_origin(quad: str) -> tuple[int, int]:
    """(row0, col0) of a quadrant in the global grid."""
    return (0 if quad[1] == "1" else 21600), "ABCD".index(quad[0]) * 21600


def face_window(face: int) -> tuple[float, float, float, float]:
    """(lat0, lat1, lon_west, lon_east) needed for a cube face (lon_east may exceed 180: wraps)."""
    if face < 4:
        centre = [0.0, 180.0, 90.0, -90.0][face]
        return -45.0 - MARGIN_DEG, 45.0 + MARGIN_DEG, centre - 45.0 - MARGIN_DEG, centre + 45.0 + MARGIN_DEG
    lim = math.degrees(math.atan(1.0 / math.sqrt(2.0))) - MARGIN_DEG
    if face == 4:
        return lim, 90.0, -180.0, 180.0
    return -90.0, -lim, -180.0, 180.0


class FaceCrop:
    """uint8 (rows, cols, 3) crop of a global 15" RGB source with lat/lon georeference."""

    def __init__(self, data: np.ndarray, row0: int, col0: int, wrap: bool):
        self.data, self.row0, self.col0, self.wrap = data, row0, col0, wrap

    def px(self, lat, lon):
        cy = (90.0 - np.asarray(lat, np.float64)) * PX_PER_DEG - 0.5 - self.row0
        cx = (np.asarray(lon, np.float64) + 180.0) * PX_PER_DEG - 0.5 - self.col0
        if not self.wrap:   # crop of < 360 deg that may straddle the antimeridian: map into [-slack, W - slack)
            slack = 1000.0
            cx = np.mod(cx + slack, W) - slack
        return cx, cy


def crop_path(src: str, face: int, month: int) -> Path:
    return paths.WORK / f"crop-{src}-{month:02d}-face{face}.npy"


def build_face_crop(src: str, face: int, month: int = 8, transform=None) -> Path:
    """Decode the quadrants a face needs into a uint8 memmap (cached until deleted). transform(quad, img)
    may replace each decoded quadrant image before it is copied (night-light background removal)."""
    out = crop_path(src, face, month)
    meta = out.with_suffix(".json")
    if out.is_file() and meta.is_file():
        return out
    lat0, lat1, lonw, lone = face_window(face)
    r0 = max(0, int(math.floor((90.0 - lat1) * PX_PER_DEG)))
    r1 = min(H, int(math.ceil((90.0 - lat0) * PX_PER_DEG)))
    if face < 4:
        c0 = int(math.floor((lonw + 180.0) * PX_PER_DEG))
        c1 = int(math.ceil((lone + 180.0) * PX_PER_DEG))
    else:
        c0, c1 = 0, W
    rows, cols = r1 - r0, c1 - c0
    tmp = out.with_name(out.stem + ".partial.npy")
    a = np.lib.format.open_memmap(tmp, mode="w+", dtype=np.uint8, shape=(rows, cols, 3))
    for q in QUADS:
        qr0, qc0 = quad_origin(q)
        if qr0 >= r1 or qr0 + 21600 <= r0:
            continue
        # global columns c0..c1 may wrap around 0/W
        spans = []
        for shift in (-W, 0, W):
            g0, g1 = max(c0, qc0 + shift), min(c1, qc0 + shift + 21600)
            if g0 < g1:
                spans.append((g0, g1, shift))
        if not spans:
            continue
        p = quad_path(src, q, month)
        log(f"{src}: decoding {p.name} for face {face}")
        img = np.asarray(Image.open(p).convert("RGB"))
        if img.shape != (21600, 21600, 3):
            raise ValueError(f"{p.name}: unexpected size {img.shape}")
        if transform is not None:
            img = transform(q, img)
        rr0, rr1 = max(r0, qr0), min(r1, qr0 + 21600)
        for g0, g1, shift in spans:
            a[rr0 - r0:rr1 - r0, g0 - c0:g1 - c0] = img[rr0 - qr0:rr1 - qr0, g0 - qc0 - shift:g1 - qc0 - shift]
        del img
    if face >= 4:
        _prefilter(a, r0)
    a.flush()
    del a
    tmp.replace(out)
    meta.write_text(f'{{"row0": {r0}, "col0": {c0}, "wrap": {"true" if face >= 4 else "false"}}}', encoding="utf-8")
    return out


def _prefilter(a: np.ndarray, r0: int) -> None:
    from earth.sample import lon_prefilter_rows
    lim = math.degrees(math.acos(LON_PREFILTER_RATIO / 1.25))
    lat = 90.0 - (np.arange(a.shape[0]) + r0 + 0.5) / PX_PER_DEG
    rows = np.nonzero(np.abs(lat) > lim)[0]
    for run in np.split(rows, np.nonzero(np.diff(rows) != 1)[0] + 1):
        for k in range(0, run.size, 256):
            rr = run[k:k + 256]
            for ch in range(3):
                block = a[rr[0]:rr[-1] + 1, :, ch].astype(np.float64)
                lon_prefilter_rows(block, lat[rr], LON_PREFILTER_RATIO)
                a[rr[0]:rr[-1] + 1, :, ch] = np.clip(np.floor(block + 0.5), 0, 255).astype(np.uint8)


def open_face_crop(src: str, face: int, month: int = 8) -> FaceCrop:
    import json
    p = crop_path(src, face, month)
    meta = json.loads(p.with_suffix(".json").read_text(encoding="utf-8"))
    return FaceCrop(np.load(p, mmap_mode="r"), meta["row0"], meta["col0"], meta["wrap"])


def delete_face_crop(src: str, face: int, month: int = 8) -> None:
    p = crop_path(src, face, month)
    for q in (p, p.with_suffix(".json")):
        if q.exists():
            q.unlink()
