"""Global cloud map: globals/cloudCoverage.png, 8192 x 4096 equirectangular (row 0 = north, column 0 = lon -180),
two 8-bit channels (PNG grey+alpha): [coverage, cloudTop].

Source (primary, swappable, see sources.json): the real-time global cloud composite of clouds.matteason.co.uk
(geostationary + polar infrared, alpha = IR opacity), snapshot taken at bake time. Licence unstated: recorded
as a caveat; the CC BY 4.0 Solar System Scope 8k cloud map is the documented fallback. The composite has no
real data poleward of about 62 deg (it repeats mirrored lower-latitude imagery there), so the fallback map
supplies |lat| > 62 deg, blended over 55-62 deg (smoothstep in latitude).

Infrared opacity also rises over cold clear ground (night deserts, winter continents, ice sheets). A clear-sky
baseline B is therefore estimated as the 5th percentile of the opacity A in a window of +-4 deg latitude by
+-8 deg longitude (computed on a 1/8-resolution grid, smoothed), and
    c        = clamp((A - B) / max(0.15, 0.97 - B), 0, 1)       cloud contrast against the local clear sky
    coverage = smoothstep(0.06, 0.80, c)
    cloudTop = 1.5 km + c^0.8 (min(T(lat), 12.5 km) - 1.5 km),   T(lat) = 9 km + 7 km cos^2(lat) (tropopause)
cloudTop is stored in units of 50 m (byte 30 = 1.5 km, 250 = 12.5 km). Colder (more opaque) tops are higher
(IR brightness temperature); the type follows from the pair (rendering-design.md section 6): low tops =
stratus / shallow cumulus (1.5-3 km), high tops with high coverage = deep convection, high tops with low
coverage = thin cirrus.
"""
from __future__ import annotations

import numpy as np
from PIL import Image
from scipy import ndimage

from earth import fetch, paths
from earth.util import log, write_json

URL = "https://clouds.matteason.co.uk/images/8192x4096/clouds-alpha.png"
FALLBACK_URL = "https://www.solarsystemscope.com/textures/download/8k_earth_clouds.jpg"
W, H = 8192, 4096
TOP_UNIT_M = 50.0
OUT = paths.TILES / "globals" / "cloudCoverage.png"


def source_path():
    return paths.src_dir("clouds-matteason") / "clouds-alpha-8192x4096.png"


def opacity() -> np.ndarray:
    p = source_path()
    if not p.is_file():
        fetch.download(URL, p)
    im = Image.open(p)
    a = np.asarray(im)
    if im.mode != "LA" or a.shape != (H, W, 2):
        raise ValueError(f"unexpected cloud composite format {im.mode} {a.shape}")
    return a[..., 1].astype(np.float64) / 255.0


def baseline(A: np.ndarray) -> np.ndarray:
    small = A.reshape(H // 8, 8, W // 8, 8).mean(axis=(1, 3))          # 0.35 deg cells
    ry = int(round(4.0 / (180.0 / (H // 8))))
    rx = int(round(8.0 / (360.0 / (W // 8))))
    padded = np.concatenate([small[:, -rx:], small, small[:, :rx]], axis=1)   # wrap in longitude
    b = ndimage.percentile_filter(padded, 5, size=(2 * ry + 1, 2 * rx + 1), mode="nearest")[:, rx:-rx]
    b = ndimage.gaussian_filter(np.concatenate([b[:, -rx:], b, b[:, :rx]], axis=1), (ry / 2, rx / 2), mode="nearest")[:, rx:-rx]
    return ndimage.zoom(b, 8, order=1, mode="grid-wrap", grid_mode=True)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def fallback_brightness() -> np.ndarray:
    p = paths.src_dir("clouds-solarsystemscope") / "8k_earth_clouds.jpg"
    if not p.is_file():
        fetch.download(FALLBACK_URL, p)
    a = np.asarray(Image.open(p).convert("L"), dtype=np.float64) / 255.0
    if a.shape != (H, W):
        raise ValueError(f"unexpected fallback cloud map size {a.shape}")
    return a


def contrast(A: np.ndarray) -> np.ndarray:
    B = baseline(A)
    return np.clip((A - B) / np.maximum(0.15, 0.97 - B), 0.0, 1.0)


def bake() -> None:
    lat = 90.0 - (np.arange(H) + 0.5) / H * 180.0
    c = contrast(opacity())
    # the composite fills |lat| > ~62 deg with mirrored copies of lower latitudes: use the fallback map there
    w = smoothstep(55.0, 62.0, np.abs(lat))[:, None]
    c = (1.0 - w) * c + w * contrast(fallback_brightness())
    cov = smoothstep(0.06, 0.80, c)
    tropo = 9000.0 + 7000.0 * np.cos(np.radians(lat)) ** 2
    top = 1500.0 + c ** 0.8 * (np.minimum(tropo, 12500.0)[:, None] - 1500.0)
    out = np.stack([np.clip(np.floor(cov * 255 + 0.5), 0, 255), np.clip(np.floor(top / TOP_UNIT_M + 0.5), 0, 255)],
                   axis=-1).astype(np.uint8)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_name("cloudCoverage.partial.png")
    Image.fromarray(out, "LA").save(tmp, optimize=True)
    tmp.replace(OUT)
    stats = {"meanCoverage": float(cov.mean()), "areaWeightedCoverage": float((cov * np.cos(np.radians(lat))[:, None]).sum()
                                                                            / (np.cos(np.radians(lat)).sum() * W)),
             "topUnitM": TOP_UNIT_M, "source": URL, "polarSource": FALLBACK_URL,
             "sha256": (source_path().with_name(source_path().name + ".sha256").read_text(encoding="utf-8")
                        if source_path().with_name(source_path().name + ".sha256").is_file() else None)}
    write_json(paths.OUT / "clouds-stats.json", stats)
    log(f"clouds: area-weighted coverage {stats['areaWeightedCoverage']:.3f}")
