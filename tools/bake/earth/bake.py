"""Earth tile-set bake CLI (work package bake-earth).

    python -I tools/bake/earth/bake.py <step> [--region <id>]

Steps (each resumable and idempotent: finished work units are recorded under data/cache/earth/state and
skipped on a re-run with the same configuration):
    site        resolve the launch-site coordinates of a region (writes data/defs/sites/<site>.location.json)
    heights     height layer: global levels 0-7 (ETOPO 2022) + regional levels of every region
    albedo      albedo layer: global (Blue Marble NG) + regional (Sentinel-2 cloudless)
    watermask   watermask layer: global + regional
    night       night-lights layer: global (Black Marble 2016)
    landcover   landcover layer: global classifier + regional (ESA WorldCover)
    clouds      global cloud coverage map (globals/cloudCoverage.png; a new snapshot of the live composite)
    globals     clouds (only if cloudCoverage.png is missing) + albedoLowRes
    region      every regional layer of --region (or of every region): heights, albedo, watermask, landcover
    all         everything, in dependency order, then the manifest, contact sheets, recovery report, verify.py
                and (only if verify passes) the raw-data cleanup
    manifest    (re)write data/tiles/earth/manifest.json from what has been baked
    contact     contact sheets into out/bake/earth
    recovery    recovery-zone report (out/bake/earth/recovery-zones.json)
    cleanup     delete raw downloads and intermediates that are no longer needed
    status      print what is baked and the disk use
    despike     remove needle samples from the stored regional heights of --region (or every region) without
                their sources, re-derive the coarser regional tiles they reach, rewrite the manifest
    stage       bake every regional layer of a NEW --region away from the live tile set (stage.py): its tiles go
                to data/cache/earth/stage/<region>/tiles, the manifest is not touched, and no default step sees
                the region until it is swapped in
    swap        move the staged tiles of --region into data/tiles/earth (new directories only), then write the
                manifest once, atomically
    pads        resolve the pads of a launch site on the baked tiles of --region (padresolve.py): --site,
                --nominal, --fixed, --azimuth, --classes; writes data/staged/sites/<site>.pads.json
    quality     ground-quality material at the pads of --region (groundquality.py): resolution, slope histograms,
                top-down renders (out/bake/earth/site-bake/)

Runs under the bake venv (data/cache/earth/venv), creating it from requirements.txt when missing.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
VENV = REPO / "data" / "cache" / "earth" / "venv"
VENV_PY = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def ensure_venv() -> None:
    """Re-run this script under the bake venv (create it first if needed)."""
    if Path(sys.prefix).resolve() == VENV.resolve():
        return
    if not VENV_PY.is_file():
        print(f"creating bake venv at {VENV}", flush=True)
        subprocess.check_call([sys.executable, "-m", "venv", str(VENV)])
        subprocess.check_call([str(VENV_PY), "-m", "pip", "install", "--upgrade", "pip"])
        subprocess.check_call([str(VENV_PY), "-m", "pip", "install", "-r", str(HERE / "requirements.txt")])
    sys.exit(subprocess.call([str(VENV_PY), "-I", str(Path(__file__).resolve()), *sys.argv[1:]]))


def main(argv: list[str]) -> int:
    import argparse

    sys.path.insert(0, str(HERE.parent))
    from earth import paths, region as regmod
    from earth.util import disk_report, log, set_below_normal

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["site", "heights", "albedo", "watermask", "night", "landcover", "clouds",
                                     "globals", "region", "all", "manifest", "contact", "recovery", "cleanup",
                                     "status", "despike", "stage", "swap", "pads", "quality"])
    ap.add_argument("--region", help="region id (data/defs/regions/<id>.json); default: every earth-* region that "
                                     "is not staged")
    # pads / quality (padresolve.py, groundquality.py): the site is named here, no site file is read
    ap.add_argument("--site", help="pads: site id (output data/staged/sites/<site>.pads.json)")
    ap.add_argument("--nominal", help="pads: nominal location 'latDeg,lonDeg' the complex is resolved around")
    ap.add_argument("--fixed", action="append", default=[],
                    help="pads: a pad that stays where it is, 'id:class:latDeg:lonDeg:elevationM' (repeatable)")
    ap.add_argument("--azimuth", type=float, default=90.0, help="pads: pad azimuth, deg (LC-1: 90)")
    ap.add_argument("--search-km", type=float, help="pads: search radius (default: the region's siteResolution)")
    ap.add_argument("--classes", default="heavy=4:2500,medium=6:1500,light=6:1000",
                    help="pads: class=count:spacingM,... (ARCHITECTURE 9.3)")
    ap.add_argument("--strict", action="store_true",
                    help="pads: the FULL rule that placed LC-1, the open-ocean sector gated too (Madrakah)")
    ap.add_argument("--exclude", action="append", default=[],
                    help="pads: 'latDeg:lonDeg:radiusM:reason' - ground rejected after LOOKING at the imagery (a wadi "
                         "bed, a road, a borrow pit); repeatable, recorded in the pads file")
    ap.add_argument("--dry-run", action="store_true",
                    help="pads: write the result to out/bake/earth/site-bake only (e.g. the Q8 fall-back trial)")
    ap.add_argument("--allow-partial", action="store_true",
                    help="pads: place as many pads as fit and report the rest (an incomplete layout is written to out/ only)")
    ap.add_argument("--dry-any-land", action="store_true",
                    help="pads: a measurement (out/ only): 'dry' as any land cover but water, wetland and built-up "
                         "instead of bare ground")
    ap.add_argument("--replace", action="store_true",
                    help="stage: bake a region that is already live again (REPLACE mode, stage.py)")
    a = ap.parse_args(argv)
    set_below_normal()
    regions = [a.region] if a.region else regmod.list_regions()
    for r in regions:
        regmod.load(r)

    from earth import pipeline
    if a.step == "status":
        pipeline.status()
        return 0
    log(f"bake {a.step} (regions: {', '.join(regions) or 'none'}); {disk_report()}")
    pipeline.run(a.step, regions, region_given=bool(a.region), args=a)
    log(f"bake {a.step} done; {disk_report()}")
    return 0


if __name__ == "__main__":
    ensure_venv()
    sys.exit(main(sys.argv[1:]))
