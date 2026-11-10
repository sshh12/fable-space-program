"""Contact sheets of the sky bake (out/bake/sky/*.png).

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/sky/sheets.py

  cube-cross.png      the six final faces (mip 0 downsampled), log-luminance tone map, horizontal cross
                      [-X +Z +X -Z] with +Y above and -Y below +Z, constellation figures and bright catalogue
                      stars (circles) drawn through the CPU WebGPU cube lookup
  cube-before.png     same layout for the cube BEFORE catalogue-star removal (stars must sit in the circles)
  equirect.png        the final cube re-projected to RA/Dec (RA 0 at the centre, increasing to the left)
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from moon import imaging, rt  # noqa: E402
from sky import cubemap  # noqa: E402
from sky.verify import load_faces  # noqa: E402

LUMA = np.array([0.2126, 0.7152, 0.0722])
SLOTS = {1: (1, 0), 4: (1, 1), 0: (1, 2), 5: (1, 3), 2: (0, 1), 3: (2, 1)}
FIGURES = [
    ["Betelgeuse", "Bellatrix"], ["Bellatrix", "Mintaka"], ["Mintaka", "Alnilam", "Alnitak"], ["Alnitak", "Saiph", "Rigel", "Mintaka"],
    ["Betelgeuse", "Alnitak"], ["Acrux", "Gacrux"], ["Mimosa", "Imai"], ["Dubhe", "Merak", "Phecda", "Megrez", "Dubhe"],
    ["Megrez", "Alioth", "Mizar", "Alkaid"], ["Caph", "Schedar", "Navi", "Ruchbah", "Segin"], ["Deneb", "Sadr", "Albireo"],
    ["Fawaris", "Sadr", "Aljanah"], ["Vega", "Deneb", "Altair", "Vega"], ["Antares", "Acrab"], ["Antares", "Dschubba"],
    ["Antares", "Larawag", "Shaula"], ["Regulus", "Algieba", "Zosma", "Denebola"], ["Castor", "Pollux"], ["Aldebaran", "Elnath"],
]
LABELS = ["Sirius", "Canopus", "Polaris", "Vega", "Rigel", "Betelgeuse", "Acrux", "Antares", "Deneb", "Achernar", "Arcturus", "Capella"]


def tone(Y: np.ndarray, k: float) -> np.ndarray:
    L = np.log10(np.maximum(Y * k, 1e-9))
    return np.clip((L + 5.5) / 3.5, 0, 1)


def cross(faces: np.ndarray, k: float, size: int) -> tuple[Image.Image, int]:
    n = faces.shape[1]
    f = n // size
    out = np.zeros((3 * size, 4 * size, 3), np.uint8)
    for face, (r, c) in SLOTS.items():
        a = faces[face].astype(np.float64).reshape(size, f, size, f, 3).mean(axis=(1, 3))
        t = tone(a @ LUMA, k)
        col = a / np.maximum((a @ LUMA)[..., None], 1e-12)
        rgb = np.clip(t[..., None] * (0.6 + 0.4 * col / np.maximum(col.max(-1, keepdims=True), 1e-9)), 0, 1)
        out[r * size:(r + 1) * size, c * size:(c + 1) * size] = (rgb * 255).astype(np.uint8)
    return Image.fromarray(out), size


def to_sheet(d: np.ndarray, size: int):
    face, u, v = cubemap.dir_to_face_uv(d)
    r, c = SLOTS[int(face)]
    return c * size + u * size, r * size + v * size, int(face)


def overlay(img: Image.Image, size: int, rec: np.ndarray, named: dict) -> None:
    dr = ImageDraw.Draw(img)
    for fig in FIGURES:
        pts = [named.get(n) for n in fig]
        for a, b in zip(pts, pts[1:]):
            if a is None or b is None:
                continue
            da, db = rec[a, :3].astype(np.float64), rec[b, :3].astype(np.float64)
            prev = None
            for t in np.linspace(0, 1, 60):
                d = (1 - t) * da + t * db
                d /= np.linalg.norm(d)
                x, y, f = to_sheet(d, size)
                if prev is not None and prev[2] == f:
                    dr.line([prev[0], prev[1], x, y], fill=(80, 200, 255), width=1)
                prev = (x, y, f)
    for i in range(len(rec)):
        if rec[i, 7] > 3.0:
            break
        x, y, _ = to_sheet(rec[i, :3].astype(np.float64), size)
        r = 2 + (3.0 - rec[i, 7]) * 1.2
        dr.ellipse([x - r, y - r, x + r, y + r], outline=(255, 210, 80))
    for nm in LABELS:
        if nm in named:
            x, y, _ = to_sheet(rec[named[nm], :3].astype(np.float64), size)
            imaging.label(img, (x + 6, y - 6), nm, fill=(255, 255, 255))
    for face, (r, c) in SLOTS.items():
        imaging.label(img, (c * size + 4, r * size + 4), ["+X", "-X", "+Y", "-Y", "+Z (N pole)", "-Z (S pole)"][face], fill=(160, 160, 160))


def main() -> None:
    rt.check_python()
    m = json.loads((rt.SKY_ROOT / "manifest.json").read_text(encoding="utf-8"))
    k = m["milkyWay"]["luminanceScale"]
    rec = np.fromfile(rt.SKY_ROOT / m["stars"]["file"], dtype="<f4").reshape(-1, 8)
    named = {e["name"]: e["index"] for e in json.loads((rt.SKY_ROOT / m["namedStars"]).read_text(encoding="utf-8"))}
    faces = np.stack([ch[0] for ch in load_faces(m)])
    size = 512
    rt.SKY_OUT.mkdir(parents=True, exist_ok=True)
    img, _ = cross(faces, k, size)
    overlay(img, size, rec, named)
    img.save(rt.SKY_OUT / "cube-cross.png")
    before = np.load(rt.SKY_WORK / "cube_before_f16.npy")
    img, _ = cross(before, k, size)
    overlay(img, size, rec, named)
    img.save(rt.SKY_OUT / "cube-before.png")
    # re-projection to RA/Dec through the cube lookup (nearest texel of mip 0)
    w, h = 2048, 1024
    ra = np.radians(np.mod(180.0 - (np.arange(w) + 0.5) * 360.0 / w, 360.0))
    dec = np.radians(90.0 - (np.arange(h) + 0.5) * 180.0 / h)
    D = cubemap.radec_to_dir(ra[None, :], dec[:, None])
    f, u, v = cubemap.dir_to_face_uv(D)
    n = faces.shape[1]
    vals = faces[f, np.minimum((v * n).astype(int), n - 1), np.minimum((u * n).astype(int), n - 1)]
    t = tone(vals.astype(np.float64) @ LUMA, k)
    Image.fromarray((t * 255).astype(np.uint8)).convert("RGB").save(rt.SKY_OUT / "equirect.png")
    for p in ("cube-cross.png", "cube-before.png", "equirect.png"):
        print(rt.SKY_OUT / p)


if __name__ == "__main__":
    main()
