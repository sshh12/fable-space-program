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
    if unit_mode() == "dry":
        DRY_TODO.append((name, len(todo)))
        log(f"{name}: DRY RUN: {len(todo)} units would run")
        return []
    if unit_mode() == "accept":
        rid = os.environ.get("EARTH_ACCEPT_REGION", "")
        if not rid or f"-{rid}-l" not in name:
            raise RuntimeError(f"accept: {name} is not a regional unit of {rid!r}: refusing")
        olds = set()
        for u in todo:
            p = sdir / f"{key(u)}.done"
            if not p.is_file():
                raise RuntimeError(f"accept: {name}/{p.name} was never baked: refusing (bake it)")
            olds.add(p.read_text(encoding="utf-8"))
        if len(olds) != 1:
            raise RuntimeError(f"accept: {name} holds records of {len(olds)} configurations: refusing")
        acc = dict(_accepted(sdir))
        acc[cfg] = olds.pop()
        write_json(sdir / "accepted.json", acc)
        _ACCEPTED[str(sdir)] = acc
        log(f"{name}: {len(todo)} units baked with configuration {acc[cfg]} accepted for the present {cfg} "
            f"(no tile touched)")
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


# Region-file fields that cannot change a tile: kept out of a unit's configuration hash, so that a rename, a note,
# a credit line or a verify waiver is not a re-bake (lead-4). Top level of the region dict, and at any depth.
NOT_HASHED_TOP = ("site", "name", "title", "description", "verifyWaivers", "siteResolution")
NOT_HASHED_ANY = ("note", "notes", "credit", "attribution", "landSurvey")


def _bake_view(v, top: bool = True):
    if isinstance(v, dict):
        return {k: _bake_view(x, False) for k, x in v.items()
                if k not in NOT_HASHED_ANY and not (top and k in NOT_HASHED_TOP)}
    if isinstance(v, list):
        return [_bake_view(x, False) for x in v]
    return v


_ACCEPTED: dict[str, dict] = {}


def _accepted(sdir: Path) -> dict:
    """data/cache/earth/state/<name>/accepted.json: {present configuration hash: recorded hash} written by
    `bake.py accept` for units whose tiles were baked with a configuration that differs only in fields that do not
    reach a tile (or in the hashing itself). Kept out of the manifest's build hash."""
    k = str(sdir)
    if k not in _ACCEPTED:
        p = sdir / "accepted.json"
        _ACCEPTED[k] = read_json(p) if p.is_file() else {}
    return _ACCEPTED[k]


def unit_mode() -> str | None:
    """EARTH_UNIT_MODE: "accept" (record the present configuration for baked units, run nothing), "dry" (count what
    would run, run nothing) or unset (bake)."""
    return os.environ.get("EARTH_UNIT_MODE") or None


DRY_TODO: list[tuple[str, int]] = []


def _is_done(p: Path, cfg: str) -> bool:
    try:
        c = p.read_text(encoding="utf-8")
    except OSError:
        return False
    return c == cfg or _accepted(p.parent).get(cfg) == c


def config_hash(config: dict) -> str:
    if isinstance(config, dict) and isinstance(config.get("region"), dict):
        config = {**config, "region": _bake_view(config["region"])}
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
