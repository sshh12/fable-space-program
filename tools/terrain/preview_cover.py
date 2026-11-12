#!/usr/bin/env python3
"""
A picture of a ground-cover mesh without a GPU: a software rasteriser over the dump of
tools/terrain/dump-cover.ts, with the leaf atlas, the plant's tint and a sun. It shows what a mesh is (its
frame of wood, where its leaves are, how open the crown is) from the distance and height asked for; the
shading is a stand-in for the renderer's (Lambert, a sky term, light through the leaves), good enough to
judge shape and density by.

  python -I tools/terrain/preview_cover.py <mesh.bin> <out.png> [--radius 4] [--height 3.6] [--distance 9]
      [--eye 1.7] [--sun-az 220] [--sun-el 35] [--size 900] [--tint 0.04,0.053,0.024]
"""
from __future__ import annotations

import argparse
import math
import os
import sys

import numpy as np
from PIL import Image

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ATLAS = os.path.join(REPO, "public", "assets", "terrain", "earth-volcanic-coast", "foliage.webp")
SS = 3


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.clip(c, 0.0, None), 1 / 2.4) - 0.055)


def mips(img: np.ndarray) -> list[np.ndarray]:
    out = [img]
    while out[-1].shape[0] > 1:
        a = out[-1]
        out.append(a.reshape(a.shape[0] // 2, 2, a.shape[1] // 2, 2, a.shape[2]).mean(axis=(1, 3)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mesh")
    ap.add_argument("out")
    ap.add_argument("--radius", type=float, default=4.0)
    ap.add_argument("--height", type=float, default=3.6)
    ap.add_argument("--distance", type=float, default=9.0)
    ap.add_argument("--eye", type=float, default=1.7)
    ap.add_argument("--sun-az", type=float, default=220.0)
    ap.add_argument("--sun-el", type=float, default=35.0)
    ap.add_argument("--size", type=int, default=900)
    ap.add_argument("--fov", type=float, default=60.0)
    ap.add_argument("--tint", default="0.04,0.053,0.024")
    args = ap.parse_args()

    raw = open(args.mesh, "rb").read()
    nv, ni, floats, _ = np.frombuffer(raw[:16], np.uint32)
    v = np.frombuffer(raw[16:16 + nv * floats * 4], np.float32).reshape(nv, floats).astype(np.float64)
    idx = np.frombuffer(raw[16 + nv * floats * 4:16 + nv * floats * 4 + ni * 2], np.uint16).reshape(-1, 3)
    atlas = np.asarray(Image.open(ATLAS).convert("RGBA"), np.float64) / 255.0
    cell = atlas.shape[0] // 2
    cells = []
    for c in range(4):
        a = atlas[(c // 2) * cell:(c // 2 + 1) * cell, (c % 2) * cell:(c % 2 + 1) * cell].copy()
        a[..., :3] = srgb_to_linear(a[..., :3])
        cells.append(mips(a))
    tint = np.array([float(x) for x in args.tint.split(",")])

    scale = np.array([args.radius, args.radius, args.height])
    pos = v[:, 0:3] * scale
    nrm = v[:, 3:6] / scale
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    # Camera: at -y, looking along +y at the plant's middle height; x right, z up.
    W = H = args.size * SS
    f = 0.5 * H / math.tan(math.radians(args.fov) / 2)
    target = np.array([0.0, 0.0, 0.5 * args.height])
    eye = np.array([0.0, -args.distance, args.eye])
    fwd = target - eye
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 0, 1.0])
    right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    rel = pos - eye
    cam = np.stack([rel @ right, rel @ up, rel @ fwd], 1)
    sx = W / 2 + f * cam[:, 0] / cam[:, 2]
    sy = H / 2 - f * cam[:, 1] / cam[:, 2]
    az, el = math.radians(args.sun_az), math.radians(args.sun_el)
    sun = np.array([math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)])

    # Background: a sky gradient over lit ground (a plane at z = 0), with the plant's shadow left out.
    ys = (np.arange(H) + 0.5)[:, None] * np.ones((1, W))
    xs = (np.arange(W) + 0.5)[None, :] * np.ones((H, 1))
    ray = ((xs - W / 2)[..., None] * right + (H / 2 - ys)[..., None] * up + f * fwd)
    ray /= np.linalg.norm(ray, axis=2, keepdims=True)
    sky = np.array([0.25, 0.42, 0.75])[None, None, :] * (0.55 + 0.45 * np.clip(ray[..., 2:3], 0, 1)) + np.array([0.5, 0.55, 0.6]) * (1 - np.clip(ray[..., 2:3] * 3, 0, 1)) * 0.6
    ground = np.array([0.05, 0.048, 0.046]) * (math.sin(el) * 3.0 + 0.6)
    image = np.where(ray[..., 2:3] < 0, ground[None, None, :], sky)
    depth = np.full((H, W), np.inf)

    order = np.argsort(cam[idx].mean(axis=1)[:, 2])
    for tri in idx[order]:
        z = cam[tri, 2]
        if z.min() < 0.05:
            continue
        x, y = sx[tri], sy[tri]
        x0, x1 = int(max(0, math.floor(x.min()))), int(min(W - 1, math.ceil(x.max())))
        y0, y1 = int(max(0, math.floor(y.min()))), int(min(H - 1, math.ceil(y.max())))
        if x1 < x0 or y1 < y0:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        d = (y[1] - y[2]) * (x[0] - x[2]) + (x[2] - x[1]) * (y[0] - y[2])
        if abs(d) < 1e-9:
            continue
        w0 = ((y[1] - y[2]) * (gx - x[2]) + (x[2] - x[1]) * (gy - y[2])) / d
        w1 = ((y[2] - y[0]) * (gx - x[2]) + (x[0] - x[2]) * (gy - y[2])) / d
        w2 = 1 - w0 - w1
        inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        if not inside.any():
            continue
        # Perspective-correct weights.
        iz = w0 / z[0] + w1 / z[1] + w2 / z[2]
        zz = 1 / iz
        p0, p1, p2 = w0 / z[0] * zz, w1 / z[1] * zz, w2 / z[2] * zz
        a = v[tri]
        interp = lambda col: p0 * a[0, col] + p1 * a[1, col] + p2 * a[2, col]  # noqa: E731
        n = np.stack([p0 * nrm[tri[0], k] + p1 * nrm[tri[1], k] + p2 * nrm[tri[2], k] for k in range(3)], -1)
        n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-9
        part = a[0, 7]
        h = interp(6)
        mu = n @ sun
        if part > 1.5:
            albedo = np.array([0.085, 0.07, 0.055])[None, None, :] * np.ones(gx.shape + (1,))
            # Ridges of the bark: darker furrows.
            ridge = np.abs(np.sin(math.pi * interp(8)))
            albedo = albedo * (0.55 + 0.6 * ridge[..., None])
            lit = np.clip(mu, 0, None)[..., None] * 3.0 + 0.45
            keep = inside
        else:
            c = int(round(a[0, 10]))
            depth_in = interp(7)
            if c >= 0:
                u, t = interp(8), interp(9)
                # Texels per pixel of this triangle pick the mip level.
                du = abs((a[1, 8] - a[0, 8]) * (x[2] - x[0]) - (a[2, 8] - a[0, 8]) * (x[1] - x[0])) + abs((a[1, 9] - a[0, 9]) * (x[2] - x[0]) - (a[2, 9] - a[0, 9]) * (x[1] - x[0]))
                texels = cell * math.sqrt(max(abs((a[1, 8] - a[0, 8]) * (a[2, 9] - a[0, 9]) - (a[2, 8] - a[0, 8]) * (a[1, 9] - a[0, 9])) / (abs(d) + 1e-9), 1e-12))
                level = int(min(len(cells[c]) - 1, max(0, round(math.log2(max(texels, 1.0))))))
                tex = cells[c][level]
                m = tex.shape[0]
                tx = np.clip((u * m).astype(int), 0, m - 1)
                ty = np.clip(((1.0 - t) * m).astype(int), 0, m - 1)
                texel = tex[ty, tx]
                lod_gain = (1.0, 1.5, 2.2)[int(a[0, 11])]
                rnd = np.random.default_rng(int(tri[0])).uniform(0.02, 1.0, gx.shape) if level > 0 else 0.5
                keep = inside & (np.clip(texel[..., 3] * lod_gain, 0, 1) > rnd)
                albedo = tint[None, None, :] * texel[..., :3] * 4.0
            else:
                keep = inside
                albedo = tint[None, None, :] * np.ones(gx.shape + (1,))
            albedo = albedo * (0.6 + 0.5 * h)[..., None] * (0.6 + 0.4 * depth_in)[..., None]
            shade = 1.0 - 0.5 * (1.0 - depth_in)
            lit = (np.clip(mu, 0, None) * shade * 3.0 + np.clip(-mu, 0, None) * shade * 1.2 + 0.6 * (0.35 + 0.65 * h))[..., None]
        sub = depth[y0:y1 + 1, x0:x1 + 1]
        win = keep & (zz < sub)
        sub[win] = zz[win]
        image[y0:y1 + 1, x0:x1 + 1][win] = (albedo * lit)[win]
    small = image.reshape(args.size, SS, args.size, SS, 3).mean(axis=(1, 3))
    out = np.clip(np.round(linear_to_srgb(np.clip(small, 0, 1)) * 255.0), 0, 255).astype(np.uint8)
    Image.fromarray(out).save(args.out)
    print(f"{args.out}: {nv} vertices, {len(idx)} triangles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
