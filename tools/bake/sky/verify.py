"""Acceptance checks of the sky bake (data/sky). Prints a report and exits non-zero on failure.

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/sky/verify.py

The cube-alignment checker performs the WebGPU cube lookup on the CPU (sky/cubemap.dir_to_face_uv, the Vulkan
face-selection table) for catalogue directions and requires the brightest texel near each test star to lie
within one texel of the looked-up texel in the cube built BEFORE star removal, and the star to be gone after.
Writes out/bake/sky/verify.json.
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from moon import rt  # noqa: E402
from sky import cubemap, stars  # noqa: E402

FAIL: list[str] = []
OUT: dict = {}
LUMA = np.array([0.2126, 0.7152, 0.0722])
TEST_SETS = {"Sirius": ["Sirius"], "Polaris": ["Polaris"], "Orion's belt": ["Alnitak", "Alnilam", "Mintaka"],
             "Southern Cross": ["Acrux", "Mimosa", "Gacrux", "Imai"]}


def check(ok: bool, msg: str) -> None:
    print(("PASS " if ok else "FAIL ") + msg, flush=True)
    if not ok:
        FAIL.append(msg)


def load_faces(m: dict) -> list[list[np.ndarray]]:
    n = m["milkyWay"]["faceSize"]
    faces = []
    for name in m["milkyWay"]["files"]:
        raw = np.fromfile(rt.SKY_ROOT / name, dtype="<u4")
        expect = sum((n >> k) ** 2 for k in range(m["milkyWay"]["mipLevels"]))
        check(raw.size == expect, f"{name}: {raw.size} texels = full mip chain of {n}^2 ({expect})")
        chain, o = [], 0
        for k in range(m["milkyWay"]["mipLevels"]):
            s = n >> k
            chain.append(cubemap.unpack_rgb9e5(raw[o:o + s * s]).reshape(s, s, 3))
            o += s * s
        faces.append(chain)
    return faces


def lookup_texel(d: np.ndarray, n: int) -> tuple[int, int, int]:
    f, u, v = cubemap.dir_to_face_uv(d)
    return int(f), min(int(v * n), n - 1), min(int(u * n), n - 1)


def alignment(before: np.ndarray, after: np.ndarray, rec: np.ndarray, named: dict) -> dict:
    n = before.shape[1]
    Yb = before.astype(np.float64) @ LUMA
    Ya = after @ LUMA
    out = {}
    for group, names in TEST_SETS.items():
        rows = []
        for nm in names:
            i = named[nm]
            f, j, k = lookup_texel(rec[i, :3].astype(np.float64), n)
            win = Yb[f, max(0, j - 3):j + 4, max(0, k - 3):k + 4]
            pj, pk = np.unravel_index(np.argmax(win), win.shape)
            dj, dk = pj + max(0, j - 3) - j, pk + max(0, k - 3) - k
            ring = np.concatenate([Ya[f, max(0, j - 8):j + 9, max(0, k - 8):k + 9].ravel()])
            bg = float(np.median(ring))
            peak_before = float(Yb[f, j - 1:j + 2, k - 1:k + 2].max())
            peak_after = float(Ya[f, j - 1:j + 2, k - 1:k + 2].max())
            gone = peak_after <= 3.0 * bg + 1e-6 and peak_after < 0.05 * peak_before
            rows.append({"star": nm, "V": float(rec[i, 7]), "face": f, "texel": [j, k], "peakOffset": [int(dj), int(dk)],
                         "peakBefore": peak_before, "peakAfter": peak_after, "localMedianAfter": bg, "removed": gone})
            check(max(abs(dj), abs(dk)) <= 1, f"cube alignment {group}/{nm}: catalogue texel {f}/{j},{k}, peak at offset ({dj},{dk}) before removal")
            check(gone, f"cube removal {group}/{nm}: 3x3 max {peak_before:.3g} -> {peak_after:.3g} (local median {bg:.3g})")
        out[group] = rows
    # statistics over the 300 brightest catalogue stars
    offs, gone = [], 0
    for i in range(300):
        f, j, k = lookup_texel(rec[i, :3].astype(np.float64), n)
        if j < 2 or k < 2 or j > n - 3 or k > n - 3:
            continue
        win = Yb[f, j - 2:j + 3, k - 2:k + 3]
        pj, pk = np.unravel_index(np.argmax(win), win.shape)
        offs.append(max(abs(pj - 2), abs(pk - 2)))
        pa = float(Ya[f, j - 1:j + 2, k - 1:k + 2].max())
        gone += pa < 0.05 * float(Yb[f, j - 1:j + 2, k - 1:k + 2].max())
    offs = np.array(offs)
    out["brightest300"] = {"checked": int(len(offs)), "peakWithinOneTexel": int(np.sum(offs <= 1)), "removed95pct": int(gone)}
    check(np.mean(offs <= 1) > 0.97, f"brightest 300 stars: {np.sum(offs <= 1)}/{len(offs)} cube peaks within one texel of the catalogue direction")
    check(gone / len(offs) > 0.97, f"brightest 300 stars: {gone}/{len(offs)} reduced by > 95 % after removal")
    return out


def main() -> None:
    rt.check_python()
    t0 = time.time()
    m = json.loads((rt.SKY_ROOT / "manifest.json").read_text(encoding="utf-8"))
    rep = json.loads((rt.SKY_WORK / "report.json").read_text(encoding="utf-8"))
    check(m["formatVersion"] == 1 and m["frame"] == "j2000-equatorial" and m["milkyWay"]["format"] == "rgb9e5ufloat",
          "manifest fields (formatVersion 1, j2000-equatorial, rgb9e5ufloat)")
    check(m["milkyWay"]["mipLevels"] == int(math.log2(m["milkyWay"]["faceSize"])) + 1, f"full mip chain: {m['milkyWay']['mipLevels']} levels")
    # rgb9e5 round trip
    rng = np.random.default_rng(1)
    v = np.exp(rng.uniform(-14, 9, (100000, 3)))
    back = cubemap.unpack_rgb9e5(cubemap.pack_rgb9e5(v))
    err = float(np.max(np.abs(back - v) / v.max(axis=1, keepdims=True)))
    check(err <= 2 ** -9 + 1e-12, f"rgb9e5 pack/unpack relative error {err:.2e} <= 2^-9 of the largest channel")
    one = cubemap.unpack_rgb9e5(np.array([cubemap.pack_rgb9e5(np.array([1.0, 0.5, 0.25]))]))[0]
    check(np.allclose(one, [1.0, 0.5, 0.25]), f"rgb9e5 exact for (1, 0.5, 0.25): {one}")
    # catalogue
    rec = np.fromfile(rt.SKY_ROOT / m["stars"]["file"], dtype="<f4").reshape(-1, m["stars"]["recordFloats"])
    named_list = json.loads((rt.SKY_ROOT / m["namedStars"]).read_text(encoding="utf-8"))
    named = {e["name"]: e["index"] for e in named_list}
    check(len(rec) == m["stars"]["count"], f"star count {len(rec)} = manifest")
    check(bool(np.all(np.diff(rec[:, 7]) >= 0)), "catalogue sorted brightest first")
    check(float(rec[:, 7].max()) <= m["stars"]["catalogCutoffMag"], f"all V <= {m['stars']['catalogCutoffMag']} (max {rec[:, 7].max():.2f})")
    check(np.allclose(np.linalg.norm(rec[:, :3], axis=1), 1, atol=1e-6), "directions are unit vectors")
    check(np.allclose(rec[:, 3], stars.MAG0_LUX * 10 ** (-0.4 * rec[:, 7].astype(np.float64)), rtol=1e-5), "illuminance = 2.54e-6 * 10^(-0.4 V) lux")
    check(np.allclose(rec[:, 4:7] @ LUMA, 1.0, atol=1e-4) and bool(np.all(rec[:, 4:7] >= 0)), "colours are linear sRGB with luminance 1")
    check("Sol" not in named and float(rec[0, 7]) > -2.0, "Sol excluded (brightest record is a star)")
    inv = {e["index"]: e["name"] for e in named_list}
    top10 = [{"index": i, "name": inv.get(i, "(unnamed)"), "V": round(float(rec[i, 7]), 2)} for i in range(10)]
    print("INFO brightest ten: " + ", ".join(f"{t['name']} {t['V']}" for t in top10))
    sirius = rec[named["Sirius"]]
    ra, dec = math.atan2(sirius[1], sirius[0]) % (2 * math.pi), math.asin(sirius[2])
    check(abs(math.degrees(ra) - 101.287) < 0.05 and abs(math.degrees(dec) + 16.716) < 0.05,
          f"Sirius at RA {math.degrees(ra):.3f} Dec {math.degrees(dec):.3f} (J2000 101.287, -16.716)")
    OUT["catalogue"] = {"count": int(len(rec)), "cutoff": m["stars"]["catalogCutoffMag"], "named": len(named_list), "brightest10": top10}
    # cube
    faces = load_faces(m)
    fin = all(bool(np.isfinite(lv).all()) for ch in faces for lv in ch)
    check(fin, "cube texels finite")
    for f, ch in enumerate(faces):
        a, b = ch[0].astype(np.float64), ch[1]
        box = ((a[0::2, 0::2] + a[0::2, 1::2]) + (a[1::2, 0::2] + a[1::2, 1::2])) / 4.0
        rel = float(np.max(np.abs(box - b) / np.maximum(box.max(axis=-1, keepdims=True), 1e-12)))
        check(rel < 2 ** -7, f"face {cubemap.FACE_NAMES[f]}: mip 1 = 2x2 box of mip 0 within rgb9e5 precision ({rel:.2e})")
    om = cubemap.texel_solid_angle(m["milkyWay"]["faceSize"])
    check(abs(6 * om.sum() - 4 * math.pi) < 1e-6, f"cube texel solid angles sum to 4 pi ({6 * om.sum():.9f})")
    before = np.load(rt.SKY_WORK / "cube_before_f16.npy")
    after = np.stack([ch[0] for ch in faces])
    OUT["alignment"] = alignment(before, after, rec, named)
    # photometry from the bake report
    ph = rep["photometry"]
    k = m["milkyWay"]["luminanceScale"]
    check(abs(k - ph["luminanceScaleStoredUnits"]) / k < 1e-9, f"luminanceScale {k:.4e} cd/m^2 per stored unit "
                                                              f"(fitted on {ph['stars']} isolated unsaturated stars V {ph['vRange']}, MAD {ph['madMag']:.3f} mag)")
    check(ph["stars"] >= 23, f"luminanceScale fit uses >= 23 stars ({ph['stars']})")
    gc = rep["galacticCentre"]
    check(1e-3 <= gc["meanLuminance10x10deg"] <= 1e-2, f"galactic-centre region mean luminance {gc['meanLuminance10x10deg']:.2e} cd/m^2 "
                                                       f"(10x10 deg; p90 {gc['p90Luminance10x10deg']:.2e}) within 1e-3..1e-2")
    OUT["photometry"] = {"luminanceScale": k, "fit": {kk: ph[kk] for kk in ("stars", "vRange", "madMag", "bins")},
                         "brightStars": [b for b in ph["brightStars"] if b["name"] in ("Sirius", "Vega", "Canopus")],
                         "galacticCentre": gc, "layerWeights": rep["layerWeights"], "orientation": rep["orientation"],
                         "removal": rep["removal"], "resampling": rep["resampling"]}
    sizes = {p.name: p.stat().st_size for p in sorted(rt.SKY_ROOT.iterdir())}
    OUT["sizes"] = sizes
    total = sum(sizes.values())
    print(f"INFO sky files {total / 1e6:.1f} MB: " + ", ".join(f"{k_} {v_ / 1e6:.2f} MB" for k_, v_ in sizes.items()))
    check(0.1e9 <= total <= 0.2e9, f"sky data size {total / 1e9:.3f} GB (expected about 0.15 GB)")
    OUT["failures"] = FAIL
    rt.write_json(rt.SKY_OUT / "verify.json", OUT)
    print(f"{'ALL CHECKS PASSED' if not FAIL else str(len(FAIL)) + ' CHECK(S) FAILED'} ({time.time() - t0:.0f} s)")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
