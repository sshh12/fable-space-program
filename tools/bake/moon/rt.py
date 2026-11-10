"""Runtime helpers shared by the Moon and sky bakes: paths, process priority, worker pools, logging.

Every entry-point script runs as `python -I tools/bake/<area>/<script>.py` from the repository root with the
venv interpreter at data/cache/moon/venv. `-I` does not put the script directory on sys.path, so each entry
point inserts tools/bake itself before importing `common` (lead-owned, imported read-only) and `moon`.
"""
from __future__ import annotations

import ctypes
import json
import multiprocessing as mp
import os
import sys
import time
from pathlib import Path

from common import layout

REPO_ROOT = layout.REPO_ROOT
DATA_ROOT = layout.DATA_ROOT
TILES_ROOT = layout.TILES_ROOT
SKY_ROOT = layout.SKY_ROOT
MOON_CACHE = layout.CACHE_ROOT / "moon"
SKY_CACHE = layout.CACHE_ROOT / "sky"
MOON_DL = MOON_CACHE / "dl"
SKY_DL = SKY_CACHE / "dl"
MOON_WORK = MOON_CACHE / "work"
SKY_WORK = SKY_CACHE / "work"
MOON_OUT = REPO_ROOT / "out" / "bake" / "moon"
SKY_OUT = REPO_ROOT / "out" / "bake" / "sky"
REGIONS_DIR = DATA_ROOT / "defs" / "regions"

MOON_RADIUS = 1_737_400.0
TILESET = "moon"

# The package rules allow at most 8 worker processes per bake, at below-normal priority.
MAX_WORKERS = 8
_BELOW_NORMAL_PRIORITY_CLASS = 0x00004000
_THREAD_ENV = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "NUMEXPR_NUM_THREADS")

_T0 = time.time()


def log(*args) -> None:
    print(f"[{time.time() - _T0:8.1f}s]", *args, flush=True)


def below_normal_priority() -> None:
    """Lower this process to BELOW_NORMAL priority (Windows; children inherit it). Raises if it fails."""
    if os.name == "nt":
        k = ctypes.windll.kernel32
        k.GetCurrentProcess.restype = ctypes.c_void_p
        k.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        k.SetPriorityClass.restype = ctypes.c_int
        if not k.SetPriorityClass(k.GetCurrentProcess(), _BELOW_NORMAL_PRIORITY_CLASS):
            raise OSError(f"SetPriorityClass failed (error {ctypes.GetLastError()})")
    else:
        os.nice(5)


def _worker_init() -> None:
    for k in _THREAD_ENV:
        os.environ[k] = "1"
    below_normal_priority()


def pool(workers: int = MAX_WORKERS) -> mp.pool.Pool:
    """Process pool of at most MAX_WORKERS single-threaded, below-normal-priority workers."""
    for k in _THREAD_ENV:
        os.environ[k] = "1"
    return mp.get_context("spawn").Pool(min(workers, MAX_WORKERS), initializer=_worker_init)


def write_json(path: Path, obj) -> None:
    layout.write_atomic(Path(path), json.dumps(obj, indent=1).encode("utf-8"))


def read_json(path: Path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def dir_size(path: Path) -> int:
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def check_python() -> None:
    if sys.version_info[:2] != (3, 10):
        raise RuntimeError(f"bake expects the Python 3.10 venv at data/cache/moon/venv, got {sys.version}")
