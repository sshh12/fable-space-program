#!/usr/bin/env python3
"""
Leaf-spray atlas of the ground cover (src/render/terrain/cover.ts): what a leaf card of a tree or a shrub
shows. One RGBA image of 2 x 2 cells; every cell is one spray seen flat, its foot at the middle of the lower
edge, growing upwards:

  cell 0, 1  kiawe (Prosopis pallida): a zigzag twig with side twigs and bipinnate leaves, every leaf two to
             four pinnae of ten to fourteen pairs of oblong leaflets a centimetre long; two builds (full, thin)
  cell 2, 3  coastal scrub: a woody twig with alternate, lance-shaped leaves of four to six centimetres; two
             builds (leafy, half bare)

rgb = colour RELATIVE to the plant's tint (sRGB-encoded; linear 0.25 = the tint itself, so leaflets differ
from each other and from the twigs, and the mean over what is opaque is the tint exactly); a = coverage. The
colour of transparent texels is the mean, so that no mip level darkens or tints the edges. Drawn at four
times the resolution and reduced with coverage as weight.

  python -I tools/terrain/gen_foliage.py [--preview]

Writes public/assets/terrain/earth-volcanic-coast/foliage.webp (lossless) and prints the mean coverage of
every cell (set.json `cover.foliage.coverage`, kept in tools/terrain/gen_materials.py). --preview also writes
out/terrain/materials/foliage.png (the atlas over grey and over black, as the renderer tints it).
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(REPO, "public", "assets", "terrain", "earth-volcanic-coast", "foliage.webp")
CELL = 512
SUPER = 4
CELLS = 2
# Share of the cell a spray is drawn in.
FIT = 0.86


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.clip(c, 0.0, None), 1 / 2.4) - 0.055)


def srgb8(lin: tuple[float, float, float]) -> tuple[int, int, int, int]:
    s = linear_to_srgb(np.clip(np.array(lin), 0.0, 1.0))
    return (int(round(s[0] * 255)), int(round(s[1] * 255)), int(round(s[2] * 255)), 255)


class Spray:
    """Draws into one cell: coordinates 0..1, x to the right, y UP from the foot of the spray."""

    def __init__(self, image: Image.Image, cx: int, cy: int, rng: np.random.Generator):
        self.draw = ImageDraw.Draw(image)
        self.n = CELL * SUPER
        self.ox = cx * self.n
        self.oy = cy * self.n
        self.rng = rng

    def px(self, p: tuple[float, float]) -> tuple[float, float]:
        # The spray keeps clear of the cell's sides and top (a leaf cut off by the edge of its card is a
        # straight line in a crown); its foot stays on the lower edge.
        x = 0.5 + (p[0] - 0.5) * FIT
        y = p[1] * FIT
        return (self.ox + x * self.n, self.oy + (1.0 - y) * self.n)

    def inside(self, p: tuple[float, float], margin: float = 0.012) -> bool:
        return margin < p[0] < 1.0 - margin and margin < p[1] < 1.0 - margin

    def line(self, a, b, width: float, colour) -> None:
        self.draw.line([self.px(a), self.px(b)], fill=srgb8(colour), width=max(1, int(round(width * FIT * self.n))))

    def ellipse(self, c, direction: float, length: float, width: float, colour, pointed: float = 0.0) -> None:
        """A leaf blade: foot at c, pointing along `direction` (rad), widest a little before the middle."""
        pts = []
        k = 14
        for i in range(k + 1):
            t = i / k
            w = 0.5 * width * math.sin(math.pi * t ** (0.85 - 0.25 * pointed)) ** (1.0 + 0.6 * pointed)
            pts.append((t * length, w))
        outline = pts + [(x, -y) for x, y in reversed(pts)]
        ca, sa = math.cos(direction), math.sin(direction)
        self.draw.polygon([self.px((c[0] + x * ca - y * sa, c[1] + x * sa + y * ca)) for x, y in outline], fill=srgb8(colour))


def vary(rng: np.random.Generator, base: tuple[float, float, float], amount: float, dry: float = 0.0) -> tuple[float, float, float]:
    """A leaf's colour: brightness varies by `amount`; `dry` of them are yellowed."""
    g = float(np.exp(rng.normal(0.0, amount)))
    c = np.array(base) * g
    if rng.uniform() < dry:
        c = c * np.array([1.9, 1.45, 0.75])
    return (float(c[0]), float(c[1]), float(c[2]))


LEAFLET = (0.060, 0.092, 0.034)
RACHIS = (0.085, 0.100, 0.045)
TWIG = (0.070, 0.052, 0.040)
TWIG_YOUNG = (0.085, 0.075, 0.045)
SHRUB_LEAF = (0.070, 0.098, 0.040)
SHRUB_BACK = (0.115, 0.135, 0.075)


def pinna(s: Spray, foot, direction: float, length: float, pairs: int, leaflet: float) -> None:
    rng = s.rng
    tip = (foot[0] + length * math.cos(direction), foot[1] + length * math.sin(direction))
    s.line(foot, tip, 0.0016, RACHIS)
    spread = rng.uniform(1.05, 1.35)
    for i in range(pairs):
        t = (i + 0.7) / (pairs + 0.4)
        c = (foot[0] + t * length * math.cos(direction), foot[1] + t * length * math.sin(direction))
        if not s.inside(c):
            continue
        # Leaflets shorten towards the tip; a few are missing.
        ln = leaflet * (1.0 - 0.35 * t * t) * rng.uniform(0.85, 1.15)
        for side in (-1.0, 1.0):
            if rng.uniform() < 0.06:
                continue
            s.ellipse(c, direction + side * spread * rng.uniform(0.9, 1.1), ln, 0.36 * ln, vary(rng, LEAFLET, 0.22, 0.05))


def kiawe_leaf(s: Spray, foot, direction: float, size: float) -> None:
    """A bipinnate leaf: a short stalk, then one or two pairs of pinnae."""
    rng = s.rng
    stalk = 0.03 * size * rng.uniform(0.7, 1.3)
    p = (foot[0] + stalk * math.cos(direction), foot[1] + stalk * math.sin(direction))
    s.line(foot, p, 0.002, RACHIS)
    pairs = 1 if rng.uniform() < 0.55 else 2
    for k in range(pairs):
        for side in (-1.0, 1.0):
            a = direction + side * rng.uniform(0.38, 0.7) * (1.0 if k == 0 else 0.6)
            pinna(s, p, a, size * rng.uniform(0.085, 0.13), int(rng.integers(9, 14)), 0.024 * size * rng.uniform(0.9, 1.15))
        if k + 1 < pairs:
            q = (p[0] + 0.03 * size * math.cos(direction), p[1] + 0.03 * size * math.sin(direction))
            s.line(p, q, 0.0018, RACHIS)
            p = q


def kiawe_twig(s: Spray, foot, direction: float, length: float, width: float, depth: int, leafiness: float) -> None:
    """A zigzag twig: a leaf (often two) at every node, alternating sides; side twigs low on it."""
    rng = s.rng
    nodes = max(3, int(round(length / 0.085)))
    p = foot
    a = direction
    for i in range(nodes):
        step = length / nodes * rng.uniform(0.85, 1.15)
        side = 1.0 if i % 2 == 0 else -1.0
        a += side * rng.uniform(0.12, 0.3) + 0.25 * (math.pi / 2 - a) * (0.3 if depth == 0 else 0.1)
        q = (p[0] + step * math.cos(a), p[1] + step * math.sin(a))
        if not s.inside(q, 0.03):
            break
        w = width * (1.0 - 0.6 * i / nodes)
        s.line(p, q, w, TWIG if depth == 0 and i < nodes // 2 else TWIG_YOUNG)
        if i > 0 or depth > 0:
            if rng.uniform() < leafiness:
                kiawe_leaf(s, q, a + side * rng.uniform(0.75, 1.25), rng.uniform(0.85, 1.2))
            if rng.uniform() < 0.55 * leafiness:
                kiawe_leaf(s, q, a - side * rng.uniform(0.6, 1.1), rng.uniform(0.7, 1.0))
            # A thorn at the node.
            th = a - side * 1.3
            s.line(q, (q[0] + 0.012 * math.cos(th), q[1] + 0.012 * math.sin(th)), 0.0016, TWIG_YOUNG)
        if depth < 2 and 0 < i < nodes - 2 and rng.uniform() < (0.75 if depth == 0 else 0.3):
            kiawe_twig(s, q, a - side * rng.uniform(0.6, 1.0), length * rng.uniform(0.38, 0.6) * (1.0 - 0.5 * i / nodes), 0.6 * w, depth + 1, leafiness)
        p = q
    kiawe_leaf(s, p, a, 1.0)


def shrub_twig(s: Spray, foot, direction: float, length: float, width: float, depth: int, leafiness: float) -> None:
    """A woody twig with alternate lance-shaped leaves; the lower part of an old twig is bare."""
    rng = s.rng
    nodes = max(4, int(round(length / 0.05)))
    p = foot
    a = direction
    for i in range(nodes):
        step = length / nodes * rng.uniform(0.85, 1.15)
        a += rng.uniform(-0.12, 0.12) + 0.2 * (math.pi / 2 - a) * 0.15
        q = (p[0] + step * math.cos(a), p[1] + step * math.sin(a))
        if not s.inside(q, 0.04):
            break
        w = width * (1.0 - 0.65 * i / nodes)
        s.line(p, q, w, TWIG if depth == 0 else TWIG_YOUNG)
        side = 1.0 if i % 2 == 0 else -1.0
        bare = depth == 0 and i < nodes * (0.45 - 0.3 * leafiness)
        if not bare and rng.uniform() < 0.55 + 0.45 * leafiness:
            ln = rng.uniform(0.085, 0.13) * (1.0 - 0.3 * i / nodes)
            colour = vary(rng, SHRUB_BACK if rng.uniform() < 0.18 else SHRUB_LEAF, 0.2, 0.07)
            la = a + side * rng.uniform(0.55, 1.0)
            s.ellipse(q, la, ln, rng.uniform(0.27, 0.4) * ln, colour, 0.7)
            # The midrib, a little paler.
            s.line(q, (q[0] + 0.8 * ln * math.cos(la), q[1] + 0.8 * ln * math.sin(la)), 0.0014, (colour[0] * 1.5, colour[1] * 1.4, colour[2] * 1.3))
        if depth < 2 and 1 < i < nodes - 2 and rng.uniform() < (0.5 if depth == 0 else 0.2):
            shrub_twig(s, q, a - side * rng.uniform(0.5, 0.9), length * rng.uniform(0.35, 0.6) * (1.0 - 0.5 * i / nodes), 0.6 * w, depth + 1, leafiness)
        p = q
    for side in (-0.5, 0.0, 0.5):
        ln = rng.uniform(0.07, 0.1)
        s.ellipse(p, a + side, ln, 0.33 * ln, vary(rng, SHRUB_LEAF, 0.2, 0.05), 0.7)


def build() -> tuple[np.ndarray, list[float]]:
    n = CELL * SUPER
    image = Image.new("RGBA", (CELLS * n, CELLS * n), (0, 0, 0, 0))
    plans = [
        (0, 0, "kiawe", 0.95, 11),
        (1, 0, "kiawe", 0.7, 23),
        (0, 1, "shrub", 1.0, 37),
        (1, 1, "shrub", 0.45, 41),
    ]
    for cx, cy, kind, leafiness, seed in plans:
        rng = np.random.default_rng(seed)
        s = Spray(image, cx, cy, rng)
        foot = (0.5, 0.015)
        if kind == "kiawe":
            kiawe_twig(s, foot, math.pi / 2 + rng.uniform(-0.08, 0.08), 0.9, 0.007, 0, leafiness)
            # Two more twigs from the foot fill the lower corners of the card.
            kiawe_twig(s, (0.5, 0.05), math.pi / 2 + 0.75, 0.5, 0.004, 1, leafiness)
            kiawe_twig(s, (0.5, 0.08), math.pi / 2 - 0.8, 0.5, 0.004, 1, leafiness)
        else:
            shrub_twig(s, foot, math.pi / 2 + rng.uniform(-0.08, 0.08), 0.88, 0.009, 0, leafiness)
            shrub_twig(s, (0.5, 0.06), math.pi / 2 + 0.7, 0.5, 0.005, 1, leafiness)
            shrub_twig(s, (0.5, 0.1), math.pi / 2 - 0.75, 0.5, 0.005, 1, leafiness)
    big = np.asarray(image, np.float64) / 255.0
    # Reduce with coverage as the weight (colour of a texel = mean colour of what covers it).
    a = big[..., 3]
    lin = np.where(big[..., :3] <= 0.04045, big[..., :3] / 12.92, ((big[..., :3] + 0.055) / 1.055) ** 2.4)
    m = CELLS * CELL
    box = lambda x: x.reshape(m, SUPER, m, SUPER, *x.shape[2:]).mean(axis=(1, 3))  # noqa: E731
    cov = box(a)
    col = box(lin * a[..., None]) / np.maximum(cov, 1e-6)[..., None]
    out = np.zeros((m, m, 4))
    coverage = []
    for cy in range(CELLS):
        for cx in range(CELLS):
            sl = (slice(cy * CELL, (cy + 1) * CELL), slice(cx * CELL, (cx + 1) * CELL))
            c = col[sl]
            w = cov[sl]
            mean = (c * w[..., None]).sum(axis=(0, 1)) / w.sum()
            # Relative to the mean of what is opaque: linear 0.25 = the plant's tint; the same under no coverage.
            rel = np.where(w[..., None] > 0.0, 0.25 * c / mean[None, None, :], 0.25)
            out[sl][..., :3] = rel
            out[sl][..., 3] = w
            coverage.append(round(float(w.mean()), 4))
    rgba = np.zeros((m, m, 4), np.uint8)
    rgba[..., :3] = np.clip(np.round(linear_to_srgb(np.clip(out[..., :3], 0.0, 1.0)) * 255.0), 0, 255)
    rgba[..., 3] = np.clip(np.round(out[..., 3] * 255.0), 0, 255)
    return rgba, coverage


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", action="store_true")
    args = ap.parse_args()
    rgba, coverage = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(OUT, "WEBP", lossless=True, quality=100, method=6, exact=True)
    back = np.asarray(Image.open(OUT).convert("RGBA"))
    if not np.array_equal(back, rgba):
        raise SystemExit("foliage.webp: lossless round trip failed")
    print(f"foliage.webp: {rgba.shape[1]} x {rgba.shape[0]}, {os.path.getsize(OUT) // 1024} KB, coverage per cell {coverage}")
    if args.preview:
        # As the renderer shows it: tint x colour / 0.25, over mid grey and over black.
        lin = np.where(rgba[..., :3] / 255.0 <= 0.04045, rgba[..., :3] / 255.0 / 12.92, ((rgba[..., :3] / 255.0 + 0.055) / 1.055) ** 2.4)
        a = rgba[..., 3:4] / 255.0
        tint = np.array([0.055, 0.073, 0.033]) * 4.0
        sheets = []
        for bg in (0.35, 0.0):
            shown = np.clip(lin * 4.0 * tint[None, None, :] * a + bg * (1.0 - a), 0.0, 1.0)
            sheets.append(np.clip(np.round(linear_to_srgb(shown) * 255.0), 0, 255).astype(np.uint8))
        prev_dir = os.path.join(REPO, "out", "terrain", "materials")
        os.makedirs(prev_dir, exist_ok=True)
        Image.fromarray(np.concatenate(sheets, 1)).save(os.path.join(prev_dir, "foliage.png"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
