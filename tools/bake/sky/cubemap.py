"""WebGPU cube-map conventions and shared-exponent packing for the sky bake.

Face order (WebGPU = Vulkan = D3D = OpenGL): 0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z. For a direction r the face is
the axis of largest |r_i| and, with ma = that component (Vulkan spec, "Cube Map Face Selection"):
    +X: sc = -rz, tc = -ry      -X: sc = +rz, tc = -ry
    +Y: sc = +rx, tc = +rz      -Y: sc = +rx, tc = -rz
    +Z: sc = +rx, tc = -ry      -Z: sc = -rx, tc = -ry
    u = (sc / |ma| + 1) / 2,  v = (tc / |ma| + 1) / 2
Texel (i, j) of an N x N face has its centre at u = (i + 0.5) / N, v = (j + 0.5) / N; row j = 0 (v = 0) is the
first row of the face image. `textureSample(cube, s, dir)` with dir in ROOT axes therefore returns the texel
this module maps `dir` to, which is what the bake writes and the checker reads back.
"""
from __future__ import annotations

import numpy as np

FACE_NAMES = ("px", "nx", "py", "ny", "pz", "nz")


def face_uv_to_dir(face: int, u, v) -> np.ndarray:
    """Unit directions for face coordinates u, v in [0, 1] (arrays broadcast). Shape (..., 3)."""
    sc, tc = np.broadcast_arrays(2.0 * np.asarray(u, dtype=np.float64) - 1.0, 2.0 * np.asarray(v, dtype=np.float64) - 1.0)
    one = np.ones_like(sc)
    if face == 0:
        d = (one, -tc, -sc)
    elif face == 1:
        d = (-one, -tc, sc)
    elif face == 2:
        d = (sc, one, tc)
    elif face == 3:
        d = (sc, -one, -tc)
    elif face == 4:
        d = (sc, -tc, one)
    elif face == 5:
        d = (-sc, -tc, -one)
    else:
        raise ValueError(face)
    d = np.stack(d, axis=-1)
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def dir_to_face_uv(d) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """The CPU equivalent of the WebGPU cube lookup: (face, u, v) for directions (..., 3)."""
    d = np.asarray(d, dtype=np.float64)
    x, y, z = d[..., 0], d[..., 1], d[..., 2]
    ax, ay, az = np.abs(x), np.abs(y), np.abs(z)
    is_x = (ax >= ay) & (ax >= az)
    is_y = ~is_x & (ay >= az)
    face = np.where(is_x, np.where(x >= 0, 0, 1), np.where(is_y, np.where(y >= 0, 2, 3), np.where(z >= 0, 4, 5)))
    sc = np.select([face == 0, face == 1, face == 2, face == 3, face == 4, face == 5], [-z, z, x, x, x, -x])
    tc = np.select([face == 0, face == 1, face == 2, face == 3, face == 4, face == 5], [-y, -y, z, -z, -y, -y])
    ma = np.where(is_x, ax, np.where(is_y, ay, az))
    return face.astype(np.int64), 0.5 * (sc / ma + 1.0), 0.5 * (tc / ma + 1.0)


def texel_solid_angle(n: int) -> np.ndarray:
    """Solid angle (sr) of every texel of an n x n face, shape (n, n) [row j, column i] (same for every face)."""
    e = np.linspace(-1.0, 1.0, n + 1)
    def f(a, b):
        return np.arctan2(a * b, np.sqrt(a * a + b * b + 1.0))
    a0, b0 = np.meshgrid(e[:-1], e[:-1], indexing="xy")
    a1, b1 = np.meshgrid(e[1:], e[1:], indexing="xy")
    return f(a1, b1) - f(a0, b1) - f(a1, b0) + f(a0, b0)


def radec_to_dir(ra_rad, dec_rad) -> np.ndarray:
    ra, dec = np.broadcast_arrays(np.asarray(ra_rad, dtype=np.float64), np.asarray(dec_rad, dtype=np.float64))
    c = np.cos(dec)
    return np.stack([c * np.cos(ra), c * np.sin(ra), np.sin(dec)], axis=-1)


def dir_to_radec(d) -> tuple[np.ndarray, np.ndarray]:
    d = np.asarray(d, dtype=np.float64)
    return np.mod(np.arctan2(d[..., 1], d[..., 0]), 2 * np.pi), np.arctan2(d[..., 2], np.hypot(d[..., 0], d[..., 1]))


# -- rgb9e5ufloat (WebGPU; same bit layout as GL_EXT_texture_shared_exponent) -------------------------
RGB9E5_N = 9
RGB9E5_B = 15
RGB9E5_EMAX = 31
RGB9E5_MAX = (2 ** RGB9E5_N - 1) / 2 ** RGB9E5_N * 2.0 ** (RGB9E5_EMAX - RGB9E5_B)  # 65408


def pack_rgb9e5(rgb: np.ndarray) -> np.ndarray:
    """Pack (..., 3) non-negative floats into uint32: R bits 0-8, G 9-17, B 18-26, shared exponent 27-31."""
    c = np.clip(np.nan_to_num(np.asarray(rgb, dtype=np.float64), nan=0.0, posinf=RGB9E5_MAX), 0.0, RGB9E5_MAX)
    maxc = c.max(axis=-1)
    with np.errstate(divide="ignore"):
        e = np.maximum(-RGB9E5_B - 1, np.floor(np.log2(np.where(maxc > 0, maxc, 1e-300)))) + 1 + RGB9E5_B
    e = np.where(maxc > 0, e, 0)
    denom = np.exp2(e - RGB9E5_B - RGB9E5_N)
    max_s = np.floor(maxc / denom + 0.5)
    bump = max_s >= 2 ** RGB9E5_N
    e = np.where(bump, e + 1, e)
    denom = np.where(bump, denom * 2.0, denom)
    s = np.floor(c / denom[..., None] + 0.5).astype(np.uint32)
    s = np.minimum(s, 2 ** RGB9E5_N - 1)
    e = e.astype(np.uint32)
    return s[..., 0] | (s[..., 1] << 9) | (s[..., 2] << 18) | (e << 27)


def unpack_rgb9e5(p: np.ndarray) -> np.ndarray:
    p = np.asarray(p, dtype=np.uint32)
    e = (p >> 27).astype(np.int64)
    scale = np.exp2(e - RGB9E5_B - RGB9E5_N)
    r = (p & 0x1FF).astype(np.float64)
    g = ((p >> 9) & 0x1FF).astype(np.float64)
    b = ((p >> 18) & 0x1FF).astype(np.float64)
    return np.stack([r, g, b], axis=-1) * scale[..., None]


def mip_chain(face: np.ndarray) -> list[np.ndarray]:
    """Box-filtered mip chain of one (n, n, 3) face down to 1 x 1 (n a power of two)."""
    out = [face]
    while out[-1].shape[0] > 1:
        a = out[-1].astype(np.float64)
        out.append(((a[0::2, 0::2] + a[0::2, 1::2]) + (a[1::2, 0::2] + a[1::2, 1::2])) / 4.0)
    return out
