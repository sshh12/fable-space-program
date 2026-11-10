"""Locations and constants of the Earth bake. Everything generated lives in git-ignored directories."""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent            # tools/bake/earth
BAKE_ROOT = HERE.parent                            # tools/bake
REPO = HERE.parents[2]

if str(BAKE_ROOT) not in sys.path:                 # `common` (lead-owned) and `earth` packages
    sys.path.insert(0, str(BAKE_ROOT))

from common import layout  # noqa: E402

TILESET = "earth"
TILES = layout.TILES_ROOT / TILESET                # data/tiles/earth
CACHE = layout.CACHE_ROOT / "earth"                # data/cache/earth
OUT = REPO / "out" / "bake" / "earth"              # contact sheets, reports
VENV = CACHE / "venv"
WORK = CACHE / "work"                              # intermediates (memmaps, state files)
STATE = CACHE / "state"                            # resumability markers
REFS = CACHE / "verify"                            # reference samples kept for verify.py after raw data is deleted
DEFS = REPO / "data" / "defs"
REGIONS_DIR = DEFS / "regions"
SITES_DIR = DEFS / "sites"

RADIUS = 6_371_000.0                               # BodyDef.radius of Earth (data/defs/bodies/earth.json)
GLOBAL_MAX_LEVEL = 7
RESIDENT_HEIGHT_LEVEL = 3

USER_AGENT = "fable-space-game-bake/1.0 (offline tile bake; polite, cached, resumable)"

for _d in (CACHE, WORK, STATE, REFS, OUT):
    _d.mkdir(parents=True, exist_ok=True)


def src_dir(name: str) -> Path:
    """Own directory for every downloaded source (downloads are untrusted data)."""
    d = CACHE / "src" / name
    d.mkdir(parents=True, exist_ok=True)
    return d
