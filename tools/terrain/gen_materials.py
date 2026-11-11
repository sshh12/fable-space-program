"""Generate the tileable detail material sets of the terrain renderer.

    python -I tools/terrain/gen_materials.py [--set earth-volcanic-coast|lunar-regolith] [--size 512] [--preview]

Writes public/assets/terrain/<set>/set.json and two lossless RGBA WebP layers per material:
  <id>.ah.webp    rgb = sRGB albedo, a = height (0..1)
  <id>.nra.webp   rg = tangent-space normal xy (0.5 = flat), b = perceptual roughness, a = ambient occlusion
and, with --preview, contact sheets under out/terrain/materials/ (lit previews for review).

Everything is synthesised from periodic fields (spectral noise with random phases, cellular noise on a
torus), so every layer tiles exactly. No external data and no API keys are used. Albedos are physically
plausible linear reflectances (basalt 0.04-0.08, dry soil 0.12-0.2, weathered concrete about 0.3, lunar
regolith about 0.12); the renderer multiplies the imagery by albedo / mean albedo, so only the structure
and relative colour of a layer reach the screen.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


# ----------------------------------------------------------------------------------------------- fields

def spectral(n: int, seed: int, beta: float, lo: float = 1.0, hi: float | None = None, aniso: tuple[float, float] = (1.0, 1.0)) -> np.ndarray:
    """Periodic random field with power spectrum f^-beta between `lo` and `hi` cycles per tile; zero mean, unit std."""
    rng = np.random.default_rng(seed)
    fx = np.fft.fftfreq(n, 1.0 / n)[None, :] * aniso[0]
    fy = np.fft.fftfreq(n, 1.0 / n)[:, None] * aniso[1]
    f = np.sqrt(fx * fx + fy * fy)
    amp = np.zeros_like(f)
    band = f >= lo
    if hi is not None:
        band &= f <= hi
    amp[band] = f[band] ** (-beta / 2.0)
    phase = rng.uniform(0.0, 2.0 * np.pi, (n, n))
    field = np.fft.ifft2(amp * np.exp(1j * phase)).real
    field -= field.mean()
    return field / (field.std() + 1e-12)


def gauss(a: np.ndarray, sigma: float) -> np.ndarray:
    """Periodic Gaussian blur (sigma in pixels)."""
    n = a.shape[0]
    fx = np.fft.fftfreq(n)[None, :]
    fy = np.fft.fftfreq(n)[:, None]
    k = np.exp(-2.0 * (np.pi * sigma) ** 2 * (fx * fx + fy * fy))
    return np.fft.ifft2(np.fft.fft2(a) * k).real


def worley(n: int, count: int, seed: int, jitter: float = 1.0) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Cellular noise on a torus: F1, F2 (in units of the mean point spacing), cell index, and the points."""
    rng = np.random.default_rng(seed)
    g = int(np.ceil(np.sqrt(count)))
    cells = np.stack(np.meshgrid(np.arange(g), np.arange(g), indexing="xy"), -1).reshape(-1, 2).astype(np.float64)
    pts = (cells + 0.5 + (rng.uniform(-0.5, 0.5, cells.shape)) * jitter) / g
    tiled = np.concatenate([pts + np.array([dx, dy]) for dx in (-1, 0, 1) for dy in (-1, 0, 1)])
    tree = cKDTree(tiled)
    ys, xs = np.mgrid[0:n, 0:n]
    q = np.stack([(xs + 0.5) / n, (ys + 0.5) / n], -1).reshape(-1, 2)
    d, idx = tree.query(q, k=2)
    spacing = 1.0 / g
    f1 = (d[:, 0] / spacing).reshape(n, n)
    f2 = (d[:, 1] / spacing).reshape(n, n)
    ids = (idx[:, 0] % len(pts)).reshape(n, n)
    return f1, f2, ids, pts


def smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def unit(a: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.5)
    return np.clip((a - lo) / (hi - lo + 1e-12), 0.0, 1.0)


def cell_random(ids: np.ndarray, seed: int) -> np.ndarray:
    """One uniform random number per cell of a cellular field."""
    rng = np.random.default_rng(seed)
    return rng.uniform(0.0, 1.0, int(ids.max()) + 1)[ids]


def warp_ids(ids: np.ndarray, dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
    """Cell indices at positions displaced by (dx, dy) pixels (nearest: indices cannot be interpolated)."""
    n = ids.shape[0]
    ys, xs = np.mgrid[0:n, 0:n]
    return ids[np.round(ys + dy).astype(int) % n, np.round(xs + dx).astype(int) % n]


def warp(a: np.ndarray, dx: np.ndarray, dy: np.ndarray) -> np.ndarray:
    """Sample a periodic field at positions displaced by (dx, dy) pixels (bilinear)."""
    n = a.shape[0]
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float64)
    x = (xs + dx) % n
    y = (ys + dy) % n
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    tx = x - x0
    ty = y - y0
    x1 = (x0 + 1) % n
    y1 = (y0 + 1) % n
    return (a[y0, x0] * (1 - tx) + a[y0, x1] * tx) * (1 - ty) + (a[y1, x0] * (1 - tx) + a[y1, x1] * tx) * ty


# -------------------------------------------------------------------------------------------- materials

class Layer:
    """A finished material: height 0..1, linear albedo (n, n, 3), roughness, and its RMS slope."""

    def __init__(self, height: np.ndarray, albedo: np.ndarray, roughness: np.ndarray, rms_slope: float, ao_gain: float = 1.0):
        self.height = unit(height)
        self.albedo = np.clip(albedo, 0.0, 1.0)
        self.roughness = np.clip(roughness, 0.05, 1.0)
        n = self.height.shape[0]
        gx = (np.roll(self.height, -1, 1) - np.roll(self.height, 1, 1)) * 0.5 * n
        gy = (np.roll(self.height, -1, 0) - np.roll(self.height, 1, 0)) * 0.5 * n
        # Peak-to-peak relief as a fraction of the tiling length, chosen so the surface has the stated RMS
        # slope (slopes are the same at every tiling scale; the relief in metres scales with the tiling).
        self.relief = rms_slope / float(np.sqrt((gx * gx + gy * gy).mean()))
        self.ao_gain = ao_gain


def tint(base: tuple[float, float, float], n: int) -> np.ndarray:
    return np.ones((n, n, 3)) * np.array(base)[None, None, :]


def pahoehoe(n: int) -> Layer:
    """Smooth billowy lava: overlapping lobes with ropy folds, hairline cracks along the lobe edges, a glassy skin."""
    f1, f2, ids, _ = worley(n, 14, 11, jitter=0.9)
    wx = spectral(n, 12, 2.6, 1, 6) * n * 0.035
    wy = spectral(n, 13, 2.6, 1, 6) * n * 0.035
    f1w = warp(f1, wx, wy)
    f2w = warp(f2, wx, wy)
    idw = warp_ids(ids, wx, wy)
    lobes = 1.0 - smoothstep(0.0, 0.95, f1w) ** 1.6
    edge = f2w - f1w
    # Ropes: folds perpendicular to the flow direction of each lobe, bunched towards the lobe front.
    ang = cell_random(idw, 14) * np.pi
    ys, xs = np.mgrid[0:n, 0:n] / n
    k = 2 * np.pi * np.round(18 + 14 * cell_random(idw, 15))
    along = np.cos(ang) * xs + np.sin(ang) * ys
    bend = spectral(n, 16, 3.0, 1, 5) * 0.035
    ropes = np.sin(k * (along + bend)) * 0.5 + 0.5
    ropes = ropes ** 1.5 * smoothstep(0.05, 0.5, edge) * smoothstep(0.15, 0.8, 1.0 - lobes + 0.25 * spectral(n, 17, 2, 2, 12))
    micro = spectral(n, 18, 1.6, 24, 256)
    height = lobes * 1.0 + ropes * 0.16 + micro * 0.012 - (1.0 - smoothstep(0.0, 0.05, edge)) * 0.3
    crack = 1.0 - smoothstep(0.0, 0.035, edge)
    patches = smoothstep(-0.2, 0.9, spectral(n, 19, 2.4, 1, 10))
    albedo = tint((0.052, 0.050, 0.050), n)
    # Glassy skin (silvery grey) where the crust is intact, rusty oxidation in patches, dark cracks.
    albedo = albedo * (1.0 + 0.55 * patches[..., None]) + np.array([0.022, 0.010, 0.002]) * smoothstep(0.3, 1.2, spectral(n, 20, 2.2, 2, 14))[..., None]
    albedo *= (1.0 - 0.6 * crack)[..., None] * (0.9 + 0.2 * unit(micro))[..., None]
    rough = 0.84 - 0.14 * patches + 0.12 * crack + 0.04 * unit(micro)
    return Layer(height, albedo, rough, rms_slope=0.28)


def aa(n: int) -> Layer:
    """Clinkery rubble: jagged fragments of two sizes, deep shadowed gaps, rusty brown-black."""
    f1a, f2a, idsa, _ = worley(n, 90, 21, jitter=1.0)
    f1b, f2b, idsb, _ = worley(n, 700, 22, jitter=1.0)
    ra = cell_random(idsa, 23)
    rb = cell_random(idsb, 24)
    spiky = np.abs(spectral(n, 25, 1.7, 6, 200))
    # Each fragment: a tilted, rough-topped block; gaps between fragments are deep.
    blocks_a = (0.35 + 0.65 * ra) * smoothstep(0.0, 0.22, f2a - f1a) * (1.0 - 0.5 * f1a)
    blocks_b = (0.3 + 0.7 * rb) * smoothstep(0.0, 0.25, f2b - f1b) * (1.0 - 0.5 * f1b)
    height = 0.62 * blocks_a + 0.3 * blocks_b + 0.16 * spiky + 0.05 * spectral(n, 26, 2.5, 1, 6)
    gap = 1.0 - smoothstep(0.0, 0.3, np.minimum(f2a - f1a, (f2b - f1b) * 1.5))
    albedo = tint((0.040, 0.036, 0.034), n) * (0.7 + 0.6 * ra[..., None] * 0.6 + 0.4 * rb[..., None] * 0.6)
    rust = smoothstep(0.4, 1.4, spectral(n, 27, 2.0, 2, 20) + 0.8 * (rb - 0.5))
    albedo += np.array([0.030, 0.012, 0.004]) * rust[..., None]
    albedo *= (1.0 - 0.55 * gap)[..., None]
    rough = 0.9 + 0.08 * spiky / (spiky.max() + 1e-9)
    return Layer(height, albedo, rough, rms_slope=0.75, ao_gain=1.6)


def black_sand(n: int) -> Layer:
    """Fine basalt sand: grains, faint wind ripples, sparse pale shell and olivine grains."""
    grains = spectral(n, 31, 0.4, 60, 256)
    ripple_phase = (np.mgrid[0:n, 0:n][1] / n) * 2 * np.pi * 7 + spectral(n, 32, 3.0, 1, 4) * 1.3
    ripples = np.sin(ripple_phase)
    height = 0.55 * ripples + 0.3 * spectral(n, 33, 2.4, 1, 10) + 0.12 * grains
    rng = np.random.default_rng(34)
    speck = rng.uniform(0, 1, (n, n))
    pale = gauss((speck > 0.9965).astype(np.float64), 0.7) * 6.0
    green = gauss((speck < 0.004).astype(np.float64), 0.7) * 6.0
    albedo = tint((0.050, 0.048, 0.047), n) * (0.86 + 0.28 * unit(grains))[..., None]
    albedo = albedo * (1.0 + 0.1 * ripples[..., None]) + np.clip(pale, 0, 1)[..., None] * np.array([0.30, 0.27, 0.22]) + np.clip(green, 0, 1)[..., None] * np.array([0.10, 0.14, 0.05])
    rough = 0.86 + 0.06 * unit(grains)
    return Layer(height, albedo, rough, rms_slope=0.12)


def scrub_soil(n: int) -> Layer:
    """Dry volcanic soil: reddish-brown dust, pebbles and cinders, straw-coloured litter of dry grass."""
    base = spectral(n, 41, 2.3, 1, 30)
    fine = spectral(n, 42, 1.0, 30, 256)
    f1, f2, ids, _ = worley(n, 420, 43, jitter=1.0)
    r = cell_random(ids, 44)
    # Pebbles: a third of the cells hold a rounded stone of random size.
    stone = (r > 0.66) * np.clip(1.0 - (f1 / (0.25 + 0.3 * cell_random(ids, 45))) ** 2, 0.0, 1.0) ** 0.5
    height = 0.5 * base + 0.1 * fine + 0.9 * stone
    albedo = tint((0.150, 0.100, 0.066), n) * (0.82 + 0.36 * unit(base))[..., None] * (0.9 + 0.2 * unit(fine))[..., None]
    stone_col = np.where((cell_random(ids, 46) > 0.5)[..., None], np.array([0.055, 0.050, 0.048]), np.array([0.19, 0.15, 0.12]))
    m = smoothstep(0.02, 0.2, stone)[..., None]
    albedo = albedo * (1 - m) + stone_col * m
    # Litter: short straight straws at random angles, drawn as thin periodic line segments.
    rng = np.random.default_rng(47)
    straw = np.zeros((n, n))
    ys, xs = np.mgrid[0:n, 0:n].astype(np.float64)
    for _ in range(int(260 * (n / 512) ** 2)):
        cx, cy, ang = rng.uniform(0, n), rng.uniform(0, n), rng.uniform(0, np.pi)
        length, width = rng.uniform(10, 34) * n / 512, rng.uniform(0.5, 1.0) * n / 512
        dx = (xs - cx + n / 2) % n - n / 2
        dy = (ys - cy + n / 2) % n - n / 2
        t = dx * np.cos(ang) + dy * np.sin(ang)
        s = -dx * np.sin(ang) + dy * np.cos(ang)
        straw = np.maximum(straw, np.exp(-0.5 * (s / width) ** 2) * (np.abs(t) < length / 2))
    albedo = albedo * (1 - 0.8 * straw[..., None]) + 0.8 * straw[..., None] * np.array([0.33, 0.27, 0.15])
    height = height + 0.18 * straw
    rough = 0.9 + 0.05 * unit(fine) - 0.1 * straw
    return Layer(height, albedo, rough, rms_slope=0.26)


def concrete_apron(n: int) -> Layer:
    """Weathered concrete: broom finish, exposed aggregate, hairline cracks, tyre and rust stains."""
    fine = spectral(n, 51, 0.6, 50, 256)
    broom = spectral(n, 52, 1.2, 40, 256, aniso=(0.12, 1.0))
    f1, f2, ids, _ = worley(n, 9, 53, jitter=1.0)
    wx = spectral(n, 54, 2.2, 2, 30) * n * 0.012
    wy = spectral(n, 55, 2.2, 2, 30) * n * 0.012
    crack = 1.0 - smoothstep(0.0, 0.012, warp(f2 - f1, wx, wy))
    crack *= smoothstep(-0.4, 0.6, spectral(n, 56, 2.5, 1, 4))
    rng = np.random.default_rng(57)
    agg = gauss((rng.uniform(0, 1, (n, n)) > 0.992).astype(np.float64), 1.2) * 14.0
    height = 0.25 * fine + 0.35 * broom + 0.3 * spectral(n, 58, 2.6, 1, 8) - 3.0 * crack + 0.5 * np.clip(agg, 0, 1)
    stains = smoothstep(0.2, 1.6, spectral(n, 59, 2.8, 1, 9))
    streak = smoothstep(0.6, 1.8, spectral(n, 60, 2.4, 1, 20, aniso=(1.0, 0.2)))
    albedo = tint((0.31, 0.30, 0.285), n) * (0.9 + 0.2 * unit(fine))[..., None]
    albedo *= (1.0 - 0.3 * stains)[..., None] * (1.0 - 0.25 * streak)[..., None] * (1.0 - 0.7 * crack)[..., None]
    albedo = albedo * (1 - 0.5 * np.clip(agg, 0, 1)[..., None]) + 0.5 * np.clip(agg, 0, 1)[..., None] * np.array([0.20, 0.19, 0.18])
    albedo += np.array([0.030, 0.012, 0.0]) * smoothstep(1.0, 2.2, spectral(n, 61, 2.6, 2, 12))[..., None]
    rough = 0.9 - 0.06 * stains + 0.06 * crack
    return Layer(height, albedo, rough, rms_slope=0.06)


def fine_regolith(n: int) -> Layer:
    """Lunar soil: cohesive powder with small clods, sub-centimetre pits and scattered pebbles."""
    base = spectral(n, 71, 2.5, 1, 40)
    clumps = spectral(n, 72, 1.3, 20, 256)
    f1, f2, ids, _ = worley(n, 240, 73, jitter=1.0)
    r = cell_random(ids, 74)
    size = 0.12 + 0.22 * cell_random(ids, 75)
    # Micro-craters (a quarter of the cells): a bowl with a low raised rim.
    x = f1 / size
    pit = (r < 0.25) * (-(1.0 - np.clip(x, 0, 1) ** 2) * 0.9 + 0.35 * np.exp(-((x - 1.0) / 0.25) ** 2))
    pebble = (r > 0.8) * np.clip(1.0 - (f1 / (0.5 * size)) ** 2, 0.0, 1.0) ** 0.5
    height = 0.55 * base + 0.2 * clumps + 0.5 * pit + 0.6 * pebble
    albedo = tint((0.118, 0.115, 0.108), n) * (0.94 + 0.12 * unit(clumps))[..., None] * (0.96 + 0.08 * unit(base))[..., None]
    albedo *= (1.0 + 0.2 * smoothstep(0.1, 0.6, pebble))[..., None]
    rough = 0.95 - 0.04 * smoothstep(0.1, 0.6, pebble) + 0.0 * base
    return Layer(height, albedo, rough, rms_slope=0.14)


def blocky_ejecta(n: int) -> Layer:
    """Fresh ejecta: angular rock fragments of many sizes half-buried in soil, brighter than the mature soil."""
    soil = spectral(n, 81, 2.3, 1, 60)
    grit = spectral(n, 82, 1.0, 40, 256)
    height = 0.3 * soil + 0.08 * grit
    albedo = tint((0.125, 0.122, 0.115), n) * (0.93 + 0.14 * unit(grit))[..., None]
    rough = np.full((n, n), 0.94)
    for i, (count, share, lift) in enumerate(((70, 0.3, 1.0), (420, 0.32, 0.6), (1800, 0.3, 0.3))):
        f1, f2, ids, _ = worley(n, count, 83 + i * 5, jitter=1.0)
        r = cell_random(ids, 84 + i * 5)
        tilt_a = cell_random(ids, 85 + i * 5) * 2 * np.pi
        ys, xs = np.mgrid[0:n, 0:n] / n
        # A fragment fills the middle of its cell with straight (Voronoi) sides and a flat, tilted top.
        inside = smoothstep(0.12, 0.2, f2 - f1) * (r < share)
        top = 0.75 + 0.25 * np.sin(2 * np.pi * (np.cos(tilt_a) * xs + np.sin(tilt_a) * ys) * np.sqrt(count) * 0.35)
        block = inside * top * (0.6 + 0.4 * cell_random(ids, 86 + i * 5))
        height = np.maximum(height, height * (1 - inside) + lift * block + 0.03 * grit * inside)
        shade = 1.12 + 0.3 * cell_random(ids, 87 + i * 5)
        albedo = albedo * (1 - inside[..., None]) + inside[..., None] * tint((0.128, 0.126, 0.122), n) * shade[..., None]
        rough = rough * (1 - inside) + inside * 0.86
    return Layer(height, albedo, rough, rms_slope=0.42, ao_gain=1.4)


def compacted_soil(n: int) -> Layer:
    """Compacted, cloddy soil: a firm, lumpy crust of clods of many sizes, slightly darker than loose soil."""
    height = 0.45 * spectral(n, 96, 2.4, 1, 14)
    albedo_mod = np.zeros((n, n))
    for i, (count, share, lift) in enumerate(((160, 0.45, 0.5), (900, 0.5, 0.3), (3600, 0.5, 0.16))):
        f1, f2, ids, _ = worley(n, count, 91 + i * 4, jitter=1.0)
        r = cell_random(ids, 92 + i * 4)
        # A clod: a rounded lump that fills part of its cell.
        size = 0.35 + 0.35 * cell_random(ids, 93 + i * 4)
        lump = (r < share) * np.clip(1.0 - (f1 / size) ** 2, 0.0, 1.0) ** 0.7
        height = height + lift * lump
        albedo_mod += (0.5 - cell_random(ids, 94 + i * 4)) * 0.1 * (lump > 0.05)
    fine = spectral(n, 95, 1.2, 24, 256)
    height = height + 0.07 * fine
    albedo = tint((0.108, 0.105, 0.099), n) * (0.93 + 0.14 * unit(fine))[..., None] * (1.0 + albedo_mod)[..., None]
    rough = 0.92 + 0.04 * unit(fine)
    return Layer(height, albedo, rough, rms_slope=0.22)


# ------------------------------------------------------------------------------------------------- sets

SETS = {
    "earth-volcanic-coast": {
        "materials": [("pahoehoe", pahoehoe), ("aa", aa), ("black-sand", black_sand), ("scrub-soil", scrub_soil), ("concrete-apron", concrete_apron)],
        "classWeights": {
            "unknown": {"scrub-soil": 1.0},
            "water": {"black-sand": 1.0},
            "bareRock": {"pahoehoe": 0.6, "aa": 0.4},
            "sand": {"black-sand": 1.0},
            "sparseScrub": {"scrub-soil": 0.65, "pahoehoe": 0.35},
            "grass": {"scrub-soil": 1.0},
            "shrub": {"scrub-soil": 1.0},
            "trees": {"scrub-soil": 1.0},
            "crop": {"scrub-soil": 1.0},
            "builtUp": {"concrete-apron": 0.6, "scrub-soil": 0.4},
            "snowIce": {"scrub-soil": 1.0},
            "wetland": {"scrub-soil": 1.0},
        },
        "classOrbital": {
            "unknown": [0.06, 0.02],
            "water": [0.0, 0.0],
            "bareRock": [0.10, 0.05],
            "sand": [0.05, 0.03],
            "sparseScrub": [0.10, 0.03],
            "grass": [0.07, 0.02],
            "shrub": [0.10, 0.03],
            "trees": [0.12, 0.04],
            "crop": [0.08, 0.01],
            "builtUp": [0.12, 0.02],
            "snowIce": [0.02, 0.03],
            "wetland": [0.08, 0.01],
        },
        "channelGain": {"aa": 0.6, "scrub-soil": -0.4, "black-sand": -0.3},
        "slopeGain": {"aa": 0.8, "pahoehoe": 0.2, "black-sand": -1.0, "scrub-soil": -0.5},
        "noiseGain": {"aa": 0.5, "pahoehoe": -0.5},
        "apronMaterial": "concrete-apron",
        "rockMaterial": "aa",
    },
    "lunar-regolith": {
        "materials": [("fine-regolith", fine_regolith), ("blocky-ejecta", blocky_ejecta), ("compacted-soil", compacted_soil)],
        # Ejecta shows only where the bake's freshness channel is well above half (fresh craters and their
        # blankets), not on every faint trace of it.
        "classWeights": {"unknown": {"fine-regolith": 1.0, "blocky-ejecta": -1.0}},
        "classOrbital": {"unknown": [0.035, 0.01]},
        "channelGain": {"blocky-ejecta": 2.6, "fine-regolith": -0.6},
        "slopeGain": {"compacted-soil": 0.9, "fine-regolith": -0.6},
        "noiseGain": {"compacted-soil": 0.25},
        "apronMaterial": None,
        "rockMaterial": "blocky-ejecta",
    },
}


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 1e-9), 1.0 / 2.4) - 0.055)


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def bake(layer: Layer) -> tuple[np.ndarray, np.ndarray, dict]:
    """8-bit textures of a layer: albedo+height, normal+roughness+AO, and the statistics the renderer needs."""
    n = layer.height.shape[0]
    h = layer.height
    # Slopes in real units: relief (fraction of the tiling length) x d(height)/d(uv).
    gx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * n * layer.relief
    gy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * n * layer.relief
    inv = 1.0 / np.sqrt(1.0 + gx * gx + gy * gy)
    nx, ny = -gx * inv, -gy * inv
    # Ambient occlusion from concavity at three scales (a point lower than its surroundings sees less sky).
    cav = np.zeros_like(h)
    for sigma, w in ((n / 256, 0.5), (n / 64, 0.3), (n / 20, 0.2)):
        cav += w * np.clip(gauss(h, sigma) - h, 0.0, None)
    ao = np.clip(1.0 - layer.ao_gain * 4.0 * cav / (cav.std() * 6.0 + 1e-9), 0.25, 1.0)
    srgb = linear_to_srgb(layer.albedo)
    ah = np.zeros((n, n, 4), np.uint8)
    ah[..., :3] = np.clip(np.round(srgb * 255.0), 0, 255)
    # Height never stores 0, so no encoder may treat a texel as fully transparent.
    ah[..., 3] = np.clip(np.round(h * 254.0) + 1, 1, 255)
    nra = np.zeros((n, n, 4), np.uint8)
    nra[..., 0] = np.clip(np.round((nx * 0.5 + 0.5) * 255.0), 0, 255)
    nra[..., 1] = np.clip(np.round((ny * 0.5 + 0.5) * 255.0), 0, 255)
    nra[..., 2] = np.clip(np.round(layer.roughness * 255.0), 0, 255)
    nra[..., 3] = np.clip(np.round(ao * 255.0), 1, 255)
    mean = srgb_to_linear(ah[..., :3].astype(np.float64) / 255.0).reshape(-1, 3).mean(0)
    stats = {
        "meanAlbedo": [round(float(v), 5) for v in mean],
        "meanRoughness": round(float(nra[..., 2].mean() / 255.0), 4),
        "heightGain": round(layer.relief / 0.05, 4),
        "relief": round(layer.relief, 5),
        "rmsSlope": round(float(np.sqrt((gx * gx + gy * gy).mean())), 4),
    }
    return ah, nra, stats


def preview(layer: Layer, ah: np.ndarray, nra: np.ndarray) -> np.ndarray:
    """Lit preview, tiled 2 x 2: Lambert under a sun at 35 degrees elevation plus ambient, AO applied."""
    nx = nra[..., 0] / 255.0 * 2 - 1
    ny = nra[..., 1] / 255.0 * 2 - 1
    nz = np.sqrt(np.clip(1 - nx * nx - ny * ny, 0.04, 1))
    sun = np.array([0.62, 0.53, 0.57])
    lambert = np.clip(nx * sun[0] + ny * sun[1] + nz * sun[2], 0, None)
    lin = srgb_to_linear(ah[..., :3] / 255.0)
    lit = lin * (lambert[..., None] * 3.2 + 0.5 * (nra[..., 3] / 255.0)[..., None]) / lin.reshape(-1, 3).mean() * 0.16
    img = np.clip(linear_to_srgb(np.clip(lit, 0, 1)) * 255, 0, 255).astype(np.uint8)
    return np.tile(img, (2, 2, 1))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", choices=sorted(SETS), action="append")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()
    n = args.size
    for set_id in args.set or sorted(SETS):
        spec = SETS[set_id]
        out_dir = os.path.join(REPO, "public", "assets", "terrain", set_id)
        os.makedirs(out_dir, exist_ok=True)
        materials = []
        sheets = []
        for mat_id, make in spec["materials"]:
            layer = make(n)
            ah, nra, stats = bake(layer)
            ah_name, nra_name = f"{mat_id}.ah.webp", f"{mat_id}.nra.webp"
            Image.fromarray(ah, "RGBA").save(os.path.join(out_dir, ah_name), "WEBP", lossless=True, quality=100, method=6, exact=True)
            Image.fromarray(nra, "RGBA").save(os.path.join(out_dir, nra_name), "WEBP", lossless=True, quality=100, method=6, exact=True)
            # The files must decode to exactly what was computed (lossless with colour under alpha kept).
            back = np.asarray(Image.open(os.path.join(out_dir, ah_name)).convert("RGBA"))
            if not np.array_equal(back, ah):
                raise SystemExit(f"{ah_name}: lossless round trip failed")
            materials.append({"id": mat_id, "albedoHeight": ah_name, "normalRoughAo": nra_name, "meanAlbedo": stats["meanAlbedo"], "meanRoughness": stats["meanRoughness"], "heightGain": stats["heightGain"]})
            print(f"{set_id}/{mat_id}: mean albedo {stats['meanAlbedo']}, roughness {stats['meanRoughness']}, rms slope {stats['rmsSlope']}, "
                  f"{os.path.getsize(os.path.join(out_dir, ah_name)) // 1024} + {os.path.getsize(os.path.join(out_dir, nra_name)) // 1024} KB")
            if args.preview:
                sheets.append(preview(layer, ah, nra))
        manifest = {"formatVersion": 1, "id": set_id, "size": n, "materials": materials}
        for key in ("classWeights", "classOrbital", "channelGain", "slopeGain", "noiseGain", "apronMaterial", "rockMaterial"):
            manifest[key] = spec[key]
        with open(os.path.join(out_dir, "set.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        if args.preview:
            prev_dir = os.path.join(REPO, "out", "terrain", "materials")
            os.makedirs(prev_dir, exist_ok=True)
            Image.fromarray(np.concatenate(sheets, 1)).save(os.path.join(prev_dir, f"{set_id}.png"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
