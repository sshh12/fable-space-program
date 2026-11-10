"""Sky bake: star catalogue + Milky Way cube -> data/sky (SkyManifest of src/core/contracts/sky.ts).

    data/cache/moon/venv/Scripts/python.exe -I tools/bake/sky/bake.py

Outputs (data/sky, served at /sky/):
  manifest.json            SkyManifest
  stars.f32                catalogue records (sky/stars.py)
  named-stars.json         [{name, index}]
  milkyway-{px,nx,py,ny,pz,nz}.rgb9e5   2048^2 faces, full mip chain each, WebGPU cube order
Verification artefacts (data/cache/sky/work): the before-removal cube (mip 0, float16), the report.
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402

from common import layout  # noqa: E402
from moon import fetch, rt  # noqa: E402
from sky import cubemap, milkyway, stars  # noqa: E402

FACE_SIZE = 2048
FIT_V_RANGE = (8.5, 11.0)
REPORT = rt.SKY_WORK / "report.json"
BEFORE = rt.SKY_WORK / "cube_before_f16.npy"
GALACTIC_CENTRE = (math.radians(266.40499), math.radians(-28.93617))
CHECK_STARS = {"Sirius": ["Sirius"], "Polaris": ["Polaris"], "Orion's belt": ["Alnitak", "Alnilam", "Mintaka"],
               "Southern Cross": ["Acrux", "Mimosa", "Gacrux", "Imai"], "named bright": ["Vega", "Canopus"]}


def dl(name: str, url: str, nbytes: int) -> Path:
    return fetch.download(url, rt.SKY_DL / name.split(".")[0] / name, connections=3, expect_bytes=nbytes)


def write_faces(cube: np.ndarray) -> tuple[list[str], int]:
    files = []
    mips = 0
    for f in range(6):
        chain = cubemap.mip_chain(cube[f])
        mips = len(chain)
        packed = b"".join(cubemap.pack_rgb9e5(m).astype("<u4").tobytes() for m in chain)
        name = f"milkyway-{cubemap.FACE_NAMES[f]}.rgb9e5"
        layout.write_atomic(rt.SKY_ROOT / name, packed)
        files.append(name)
    return files, mips


def main() -> None:
    rt.check_python()
    rt.below_normal_priority()
    t0 = time.time()
    rt.SKY_WORK.mkdir(parents=True, exist_ok=True)
    rep: dict = {}
    hyg = dl("hygdata_v41.csv", stars.HYG_URL, stars.HYG_BYTES)
    paths = {n: dl(n, milkyway.SVS_BASE + n, b) for n, b in milkyway.FILES.items()}

    # 1. star catalogue
    cat = stars.build_catalogue(hyg)
    rec = cat["records"]
    layout.write_atomic(rt.SKY_ROOT / "stars.f32", rec.tobytes())
    layout.write_atomic(rt.SKY_ROOT / "named-stars.json", json.dumps(cat["named"], indent=0).encode("utf-8"))
    name_of = {e["index"]: e["name"] for e in cat["named"]}
    rep["catalogue"] = {"count": int(len(rec)), "cutoffMag": stars.CUTOFF_MAG, "named": len(cat["named"]),
                        "bvFromSpectrum": cat["bvFromSpectrum"], "bvDefaulted0.65": cat["bvDefaulted"],
                        "brightest10": [{"index": i, "name": name_of.get(i, ""), "V": float(rec[i, 7]),
                                         "lux": float(rec[i, 3]), "rgb": [round(float(v), 3) for v in rec[i, 4:7]]}
                                        for i in range(10)]}
    rt.log(f"catalogue: {rep['catalogue']['count']} stars V <= {stars.CUTOFF_MAG}")

    # 2. layer weights of the SVS combined map (4k triple)
    lw = milkyway.layer_weights(milkyway.load_exr(paths["starmap_2020_4k.exr"]), milkyway.load_exr(paths["milkyway_2020_4k.exr"]),
                                milkyway.load_exr(paths["hiptyc_2020_4k.exr"]))
    a_mw = float(np.mean([lw[c]["a"] for c in "RGB"]))
    b_ht = float(np.mean([lw[c]["b"] for c in "RGB"]))
    rep["layerWeights"] = {"perChannel": lw, "milkyway": a_mw, "hiptyc": b_ht}
    rt.log(f"starmap = {a_mw:.4f} * milkyway + {b_ht:.4f} * hiptyc")

    # 3. orientation and photometric calibration from the hiptyc layer
    ht = milkyway.load_exr(paths["hiptyc_2020_16k.exr"])
    Y = (ht @ milkyway.LUMA.astype(np.float32))
    rep["orientation"] = milkyway.orientation_scores(Y, cat["ra"][:300], cat["dec"][:300])
    best = max(rep["orientation"], key=rep["orientation"].get)
    if best != "raAtLeft=180 sign=-1 decFlip=False":
        raise RuntimeError(f"unexpected SVS orientation {best}")
    faint = stars.faint_stars(hyg, stars.CUTOFF_MAG, 12.0)
    all_ra = np.concatenate([cat["ra"], faint["ra"]])
    all_dec = np.concatenate([cat["dec"], faint["dec"]])
    all_mag = np.concatenate([cat["mag"], faint["mag"]])
    fit = milkyway.fit_luminance_scale(Y, faint, all_ra, all_dec, all_mag, FIT_V_RANGE[0], FIT_V_RANGE[1], stars.MAG0_LUX)
    k = fit["luminanceScale"] / b_ht
    bright = []
    for idx in range(len(rec)):
        nm = name_of.get(idx, "")
        if idx < 60 or nm in ("Sirius", "Vega", "Canopus"):
            f, bg, peak = milkyway.integrated_flux(Y, cat["ra"][idx], cat["dec"][idx], radius_px=12.0)
            bright.append({"index": idx, "name": nm, "V": float(cat["mag"][idx]), "mapFluxUnitSr": f, "peak": peak,
                           "catalogueLux": float(rec[idx, 3]), "luxPerUnitSr": float(rec[idx, 3] / f) if f > 0 else None,
                           "deficitMag": float(2.5 * math.log10((rec[idx, 3] / f) / fit["luminanceScale"])) if f > 0 else None})
    rep["photometry"] = {**fit, "luminanceScaleStoredUnits": k, "brightStars": bright,
                         "note": "hiptyc pixels clip at 1.0: stars brighter than V~5.5 are saturated, so the scale is fitted on "
                                 f"isolated unsaturated Tycho-range stars V {FIT_V_RANGE[0]}-{FIT_V_RANGE[1]}; the bright stars are listed "
                                 "with the flux deficit (mag) their saturation causes."}
    rt.log(f"luminanceScale {k:.4e} cd/m^2 per stored unit from {fit['stars']} stars (MAD {fit['madMag']:.3f} mag)")

    # 4. remove catalogue stars from the hiptyc layer; combine; resample to the cube
    mw = milkyway.load_exr(paths["milkyway_2020_16k.exr"])
    sky_before = a_mw * mw + b_ht * ht
    cube_before = milkyway.equirect_to_cube(sky_before, FACE_SIZE)
    del sky_before
    np.save(BEFORE, cube_before.astype(np.float16))
    rem = milkyway.remove_stars(ht, cat["ra"], cat["dec"], cat["mag"])
    rep["removal"] = {"stars": int(len(rem["radii"])), "radiusPxMedian": float(np.median(rem["radii"])),
                      "radiusPxMax": int(rem["radii"].max()), "removedFluxUnitSr": rem["removedFluxUnitSr"],
                      "radiusForBrightest10": [int(r) for r in rem["radii"][:10]]}
    sky = a_mw * mw + b_ht * ht
    del mw, ht
    cube = milkyway.equirect_to_cube(sky, FACE_SIZE)
    omega_px = milkyway.pixel_solid_angle(sky.shape[0], sky.shape[1], milkyway.pixel_radec(sky.shape[0], sky.shape[1], np.arange(sky.shape[0], dtype=np.float64))[1])
    flux_eq = float(((sky @ milkyway.LUMA) * omega_px[:, None]).sum())
    del sky
    om = cubemap.texel_solid_angle(FACE_SIZE)
    flux_cube = float(sum(((cube[f] @ milkyway.LUMA) * om).sum() for f in range(6)))
    rep["resampling"] = {"fluxEquirectUnitSr": flux_eq, "fluxCubeUnitSr": flux_cube, "ratio": flux_cube / flux_eq}

    # 5. galactic centre sanity check (luminance cd/m^2)
    gc = cubemap.radec_to_dir(*GALACTIC_CENTRE)
    face, u, v = cubemap.dir_to_face_uv(gc)
    lum = (cube @ milkyway.LUMA) * k
    box = []
    for dra in np.linspace(-5, 5, 41):
        for ddec in np.linspace(-5, 5, 41):
            d = cubemap.radec_to_dir(GALACTIC_CENTRE[0] + math.radians(dra) / math.cos(GALACTIC_CENTRE[1]), GALACTIC_CENTRE[1] + math.radians(ddec))
            f2, u2, v2 = cubemap.dir_to_face_uv(d)
            box.append(lum[int(f2), min(int(v2 * FACE_SIZE), FACE_SIZE - 1), min(int(u2 * FACE_SIZE), FACE_SIZE - 1)])
    rep["galacticCentre"] = {"meanLuminance10x10deg": float(np.mean(box)), "medianLuminance10x10deg": float(np.median(box)),
                             "p90Luminance10x10deg": float(np.percentile(box, 90)),
                             "texelAtCentre": float(lum[int(face), int(v * FACE_SIZE), int(u * FACE_SIZE)]),
                             "allSkyMedianLuminance": float(np.median(lum)), "allSkyMaxLuminance": float(lum.max())}
    rt.log(f"galactic centre {rep['galacticCentre']}")

    # 6. write faces + manifest
    files, mips = write_faces(cube)
    manifest = {
        "formatVersion": 1, "frame": "j2000-equatorial",
        "milkyWay": {"faceSize": FACE_SIZE, "mipLevels": mips, "format": "rgb9e5ufloat", "files": files,
                     "luminanceScale": k},
        "stars": {"file": "stars.f32", "count": int(len(rec)), "recordFloats": stars.RECORD_FLOATS,
                  "catalogCutoffMag": stars.CUTOFF_MAG},
        "namedStars": "named-stars.json",
        "attribution": [stars.CREDIT, milkyway.CREDIT],
    }
    layout.write_atomic(rt.SKY_ROOT / "manifest.json", json.dumps(manifest, indent=1).encode("utf-8"))
    rep["seconds"] = time.time() - t0
    rep["bytes"] = rt.dir_size(rt.SKY_ROOT)
    rt.write_json(REPORT, rep)
    rt.log(f"sky bake done in {rep['seconds']:.0f} s, {rep['bytes'] / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
