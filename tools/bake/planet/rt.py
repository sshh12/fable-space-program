"""Paths, process priority, worker pools and logging for the planet bake.

Every entry point runs as `python -I tools/bake/planet/<script>.py` from the repository root with the venv
interpreter at data/cache/earth/venv (numba, rasterio, Pillow, scipy). `-I` keeps the script directory off
sys.path, so each entry point inserts tools/bake before importing `common` (lead-owned, read-only), `moon`
and `earth` (read-only reuse of their resampling and pyramid code) and `planet`.

Layout per body (all git-ignored):
  data/cache/planets/<id>/dl/<source>/<file>   raw downloads (untrusted data; never executed or imported)
  data/cache/planets/<id>/work/                intermediates (memory-mapped mips, procedural fields, state)
  data/tiles/<id>/                             the tile set (TileManifest)
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path

from common import layout
from moon import rt as moon_rt

REPO_ROOT = layout.REPO_ROOT
DATA_ROOT = layout.DATA_ROOT
TILES_ROOT = layout.TILES_ROOT
PLANET_CACHE = layout.CACHE_ROOT / "planets"
STAGED = DATA_ROOT / "staged"
STAGED_RENDER = STAGED / "render"
STAGED_CREDITS = STAGED / "credits.json"
BODIES_DIR = Path(__file__).resolve().parent / "bodies"
CREDITS_FILE = Path(__file__).resolve().parent / "credits.json"
OUT = REPO_ROOT / "out" / "bake" / "planet"

# docs/PACKAGE_RULES.md 13c: at most 6 worker processes per bake, below-normal priority (moon.rt.pool).
MAX_WORKERS = moon_rt.MAX_WORKERS
log = moon_rt.log
below_normal_priority = moon_rt.below_normal_priority
pool = moon_rt.pool
write_tile = moon_rt.write_tile
dir_size = moon_rt.dir_size

# Bodies that are not Earth or the Moon may never be written by this tool (terrain guard).
FORBIDDEN_TILESETS = frozenset({"earth", "moon"})


def check_python() -> None:
    if sys.version_info[:2] != (3, 10):
        raise RuntimeError(f"planet bake expects the Python 3.10 venv at data/cache/earth/venv, got {sys.version}")


def dl_dir(body: str, source: str) -> Path:
    return PLANET_CACHE / body / "dl" / source


def work_dir(body: str) -> Path:
    return PLANET_CACHE / body / "work"


def tileset_dir(body: str) -> Path:
    if body in FORBIDDEN_TILESETS:
        raise RuntimeError(f"the planet bake never writes the {body} tile set")
    return TILES_ROOT / body


def read_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, obj) -> None:
    layout.write_atomic(Path(path), (json.dumps(obj, indent=1) + "\n").encode("utf-8"))


def state_path(body: str) -> Path:
    return work_dir(body) / "state.json"


def load_state(body: str) -> dict:
    p = state_path(body)
    return read_json(p) if p.is_file() else {}


def mark_done(body: str, step: str, fingerprint: str, info: dict | None = None) -> None:
    """Record a finished step with the fingerprint of everything it depended on (resume point)."""
    s = load_state(body)
    s[step] = {"fingerprint": fingerprint, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), **(info or {})}
    write_json(state_path(body), s)


def is_done(body: str, step: str, fingerprint: str) -> bool:
    e = load_state(body).get(step)
    return bool(e) and e.get("fingerprint") == fingerprint


def clear_step(body: str, step: str) -> None:
    s = load_state(body)
    if step in s:
        del s[step]
        write_json(state_path(body), s)


def remove_tree(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)


def disk_free_gb() -> float:
    return shutil.disk_usage(str(REPO_ROOT)).free / 1e9


DISK_FLOOR_GB = 25.0


def check_disk(extra_bytes: int = 0) -> None:
    """Refuse to start a download or intermediate that would take the disk below the 25 GB floor (rule 13d)."""
    free = disk_free_gb() - extra_bytes / 1e9
    if free < DISK_FLOOR_GB:
        raise RuntimeError(f"disk would have {free:.1f} GB free after this step; the floor is {DISK_FLOOR_GB} GB")


def env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    return int(v) if v else default
