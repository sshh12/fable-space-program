"""Colour of the Magellanic Clouds in the Milky Way cube (request sky-lighting-4, the addendum).

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/sky/clouds_colour.py [--force]

The SVS Deep Star Maps 2020 Milky Way layer carries the two Clouds with an emission-line (H-alpha) tint:
mip 4 at the Large Cloud reads R/G 1.26 and B/G 1.42, a magenta that starlight never has (green below both
red and blue). The integrated colour of the Clouds is that of their stars, B-V about 0.5 (LMC) and 0.45
(SMC): a slightly warm white. Since the display's toe became hue-preserving (request sky-lighting-3) the screen
shows what the data holds, a purple cloud beside warm-grey star clouds.

This step keeps every texel's luminance and moves its chroma, inside each Cloud's footprint (a soft disc about
its centre, J2000), to the colour of a B-V 0.5 black body; outside the footprints nothing changes. It reads
the six faces' mip 0 from data/sky, rebuilds the mip chains and writes the faces back (same format, size and
orientation); `manifest.milkyWay.cloudsColour` records it, so a second run is a no-op unless --force.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from common import layout  # noqa: E402
from moon import rt  # noqa: E402
from sky import cubemap, stars  # noqa: E402

LUMA = np.array([0.2126, 0.7152, 0.0722])
# (name, RA deg, Dec deg, full-weight radius deg, fade-out radius deg), J2000; extents of the visible bodies.
CLOUDS = [("LMC", 80.9, -69.75, 4.5, 6.5), ("SMC", 13.2, -72.8, 2.0, 3.2)]
# The integrated colour of the Clouds' stars: B-V 0.5, through the star catalogue's own colour rule.
CLOUDS_BV = 0.5


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    rt.check_python()
    rt.below_normal_priority()
    mpath = rt.SKY_ROOT / "manifest.json"
    m = json.loads(mpath.read_text(encoding="utf-8"))
    mw = m["milkyWay"]
    if mw.get("cloudsColour") and not a.force:
        rt.log(f"clouds colour already applied ({mw['cloudsColour']}); nothing to do")
        return
    n = mw["faceSize"]
    rgb = np.asarray(stars.blackbody_srgb(stars.bv_to_temperature(np.array([CLOUDS_BV]))), dtype=np.float64).reshape(-1, 3)[0]
    target = rgb / (rgb @ LUMA)
    rt.log(f'target chroma (B-V {CLOUDS_BV}): {np.round(target, 4).tolist()}')
    centres = [(name, cubemap.radec_to_dir(np.radians(ra), np.radians(dec)), np.radians(r0), np.radians(r1)) for name, ra, dec, r0, r1 in CLOUDS]
    report = {}
    for f, name in enumerate(cubemap.FACE_NAMES):
        path = rt.SKY_ROOT / f"milkyway-{name}.rgb9e5"
        raw = np.frombuffer(path.read_bytes(), dtype="<u4")
        face = cubemap.unpack_rgb9e5(raw[: n * n].reshape(n, n))
        u = (np.arange(n) + 0.5) / n
        d = cubemap.face_uv_to_dir(f, u[None, :], u[:, None])
        w = np.zeros((n, n))
        for cname, c, r0, r1 in centres:
            ang = np.arccos(np.clip(d @ c, -1.0, 1.0))
            t = np.clip((r1 - ang) / (r1 - r0), 0.0, 1.0)
            wc = t * t * (3.0 - 2.0 * t)
            if wc.max() > 0:
                y = face @ LUMA
                sel = wc > 0.99
                if sel.any():
                    mean = face[sel].sum(0) / max(y[sel].sum(), 1e-30)
                    report[f"{cname} on {name} before"] = [round(float(v), 3) for v in mean / mean[1]]
            w = np.maximum(w, wc)
        if w.max() <= 0:
            continue
        y = face @ LUMA
        chroma = face / np.maximum(y, 1e-30)[..., None]
        new = (chroma + (target - chroma) * w[..., None]) * y[..., None]
        face = np.where(y[..., None] > 0, new, face)
        packed = b"".join(cubemap.pack_rgb9e5(mip).astype("<u4").tobytes() for mip in cubemap.mip_chain(face))
        layout.write_atomic(path, packed)
        rt.log(f"face {name}: {int((w > 0).sum())} texels recoloured")
    mw["cloudsColour"] = {"target": [round(float(v), 4) for v in target], "clouds": [c[0] for c in CLOUDS], "rule": "luminance kept, chroma to a B-V 0.5 black body inside each footprint"}
    layout.write_atomic(mpath, json.dumps(m, indent=1).encode("utf-8"))
    rt.log(f"clouds colour: {report}")


if __name__ == "__main__":
    main()
