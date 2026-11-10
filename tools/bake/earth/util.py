"""Process priority, worker pools, resumability markers, logging and small I/O helpers."""
from __future__ import annotations

import concurrent.futures as cf
import hashlib
import json
import multiprocessing as mp
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Callable

import psutil

from earth import paths

# docs/PACKAGE_RULES.md 13c (after the 2026-11-10 crash): at most 6 worker processes per bake
MAX_WORKERS = min(6, int(os.environ.get("EARTH_BAKE_WORKERS", "6")))


def set_below_normal() -> None:
    p = psutil.Process()
    if sys.platform == "win32":
        p.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
    else:
        p.nice(10)


def _init_worker() -> None:
    set_below_normal()
    paths.WORK.mkdir(parents=True, exist_ok=True)


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def pool(workers: int = MAX_WORKERS) -> cf.ProcessPoolExecutor:
    return cf.ProcessPoolExecutor(max_workers=min(workers, MAX_WORKERS), mp_context=mp.get_context("spawn"),
                                  initializer=_init_worker)


def run_units(name: str, fn: Callable, units: list, *, key: Callable[[object], str], config: dict,
              workers: int = MAX_WORKERS, chunks: int = 1) -> list:
    """Run fn(unit) for every unit not yet marked done for this config; resumable and idempotent.

    A unit is done when data/cache/earth/state/<name>/<key>.done holds the same config hash. Returns the
    results of the units run in this call (None for skipped ones is not returned).
    """
    cfg = config_hash(config)
    sdir = paths.STATE / name
    sdir.mkdir(parents=True, exist_ok=True)
    todo = [u for u in units if not _is_done(sdir / f"{key(u)}.done", cfg)]
    log(f"{name}: {len(units) - len(todo)} of {len(units)} units already done, {len(todo)} to run")
    if not todo:
        return []
    results = []
    t0 = time.time()
    with pool(workers) as ex:
        futs = {ex.submit(fn, u): u for u in todo}
        n = 0
        for f in cf.as_completed(futs):
            u = futs[f]
            r = f.result()   # re-raise worker errors: a failed unit must stop the bake
            (sdir / f"{key(u)}.done").write_text(cfg, encoding="utf-8")
            results.append(r)
            n += 1
            if n % max(1, len(todo) // 20) == 0 or n == len(todo):
                el = time.time() - t0
                log(f"{name}: {n}/{len(todo)} units, {el:.0f} s elapsed, ~{el / n * (len(todo) - n):.0f} s left")
    return results


def units_done(name: str, units: list, key: Callable[[object], str], config: dict) -> bool:
    cfg = config_hash(config)
    return all(_is_done(paths.STATE / name / f"{key(u)}.done", cfg) for u in units)


def _is_done(p: Path, cfg: str) -> bool:
    try:
        return p.read_text(encoding="utf-8") == cfg
    except OSError:
        return False


def config_hash(config: dict) -> str:
    return hashlib.sha256(json.dumps(config, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def read_json(p: Path):
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(p: Path, obj, indent: int = 2) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=indent)
        f.write("\n")
    os.replace(tmp, p)


def dir_size(p: Path) -> tuple[int, int]:
    """(bytes, files) under a directory."""
    total = 0
    files = 0
    if not p.exists():
        return 0, 0
    for root, _dirs, fs in os.walk(p):
        for f in fs:
            try:
                total += os.path.getsize(os.path.join(root, f))
                files += 1
            except OSError:
                pass
    return total, files


def disk_report() -> str:
    t, tf = dir_size(paths.TILES)
    c, cf_ = dir_size(paths.CACHE)
    v, _ = dir_size(paths.VENV)
    free = shutil.disk_usage(paths.REPO).free
    return (f"tiles {t / 1e9:.2f} GB ({tf} files), cache {c / 1e9:.2f} GB (venv {v / 1e9:.2f} GB), "
            f"disk free {free / 1e9:.1f} GB")
