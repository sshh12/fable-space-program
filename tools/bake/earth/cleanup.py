"""Delete raw downloads and intermediates once nothing left to bake needs them (final cache < 1 GB).

Kept: the venv, the reference samples for verify.py (data/cache/earth/verify), small fit/listing files, the
resumability markers. Everything deleted here is re-downloaded or re-derived automatically by a re-run of
the step that needs it.
"""
from __future__ import annotations

import shutil

from earth import manifest, paths, region as regmod
from earth.util import dir_size, log


def _rm(p) -> int:
    if not p.exists():
        return 0
    n, _ = dir_size(p) if p.is_dir() else (p.stat().st_size, 1)
    if p.is_dir():
        shutil.rmtree(p)
    else:
        p.unlink()
    log(f"cleanup: removed {p.relative_to(paths.CACHE)} ({n / 1e6:.0f} MB)")
    return n


def run() -> None:
    g = lambda layer: manifest.is_marked(layer, "global")   # noqa: E731
    regions = regmod.list_regions()
    reg_done = lambda layer: all(manifest.is_marked(layer, r) for r in regions)   # noqa: E731
    freed = 0
    work, src = paths.WORK, paths.CACHE / "src"
    if g("height"):
        freed += _rm(work / "etopo15s_int16_halfm.npy")
        freed += _rm(src / "etopo2022-15s")
    if g("albedo") and g("night") and (paths.TILES / "globals" / "albedoLowRes.png").is_file():
        freed += _rm(src / "bmng-200408")
        freed += _rm(work / "albedo-l3")
        for p in work.glob("deshade-acc*"):
            freed += _rm(p)
        for p in work.glob("crop-*"):
            freed += _rm(p)
    if g("night"):
        freed += _rm(src / "blackmarble-2016")
        freed += _rm(work / "night-quads")
        freed += _rm(work / "night-l3")
    if g("watermask"):
        freed += _rm(src / "gibs-modis-water")
        freed += _rm(work / "watermask-l3")
        freed += _rm(work / "watermask-cc")
    if g("landcover"):
        freed += _rm(work / "landcover-l3")
    if (paths.TILES / "globals" / "cloudCoverage.png").is_file():
        freed += _rm(src / "clouds-matteason")
        freed += _rm(src / "clouds-solarsystemscope")
    if regions and reg_done("height") and reg_done("watermask") and reg_done("albedo") and reg_done("landcover"):
        freed += _rm(src / "terrarium")
        freed += _rm(src / "worldcover")
        for p in list(src.glob("s2cloudless-*")):
            freed += _rm(p)
        for p in list(work.glob("stack-*")) + list(work.glob("coastdist-*")) + list(work.glob("worldcover-*")):
            freed += _rm(p)
        freed += _rm(work / "regmask-base")
    log(f"cleanup: freed {freed / 1e9:.2f} GB")
