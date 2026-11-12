"""Additive, atomic swap of a staged tile tree into a live tile set (work package site-bake).

Standard library only, so that the unit test (tests/unit/site-bake/swap.test.ts) can run it with any Python 3 on a
synthetic tile set while it reads the manifest concurrently; the bake's own swap (stage.py) calls swap_tree() and
write_manifest_atomic().

    python -I tools/bake/earth/swaptree.py --stage <dir> --live <dir> --manifest <new manifest.json> [--delay-ms N]

1. Pre-flight: a staged file whose live counterpart exists must be byte-identical to it (it is then left where it
   is); any other collision stops the swap before anything is moved (exit 2): the swap never replaces or changes
   a live file, it only adds.
2. Tiles: the stage tree is walked top-down. A directory that has no live counterpart is moved with ONE rename
   (atomic on one volume) and its subtree is not entered; a directory that exists live is entered and its files
   are moved one by one onto free names.
3. Manifest, last: the new manifest is written to a temporary file next to the live one and moved over it with
   os.replace (atomic). A reader that loads the manifest at any moment gets the old one, whose promises are
   untouched, or the new one, every tile of which is already in place.
"""
from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
from pathlib import Path

RETRIES = 10


def _retry(fn, *args) -> None:
    """os.rename / os.replace, retried while Windows reports the path as in use (a virus scanner or an indexer
    holding a freshly written file for a moment)."""
    for k in range(RETRIES):
        try:
            fn(*args)
            return
        except PermissionError:
            if k == RETRIES - 1:
                raise
            time.sleep(0.05 * 2 ** k)


def collisions(stage: Path, live: Path) -> tuple[list[str], int]:
    """(staged files whose live counterpart exists with different bytes, number of identical ones)."""
    differ, same = [], 0
    for root, _dirs, files in os.walk(stage):
        rel = Path(root).relative_to(stage)
        if not (live / rel).is_dir():
            continue
        for name in files:
            dst = live / rel / name
            if dst.exists():
                if dst.is_file() and dst.read_bytes() == (Path(root) / name).read_bytes():
                    same += 1
                else:
                    differ.append((rel / name).as_posix())
    return differ, same


def swap_tree(stage: Path, live: Path, *, delay_s: float = 0.0, log=print) -> dict:
    """Move every file of `stage` into `live` (same relative paths), additively. Returns counts."""
    stage, live = Path(stage), Path(live)
    differ, same = collisions(stage, live)
    if differ:
        raise FileExistsError(f"{len(differ)} staged files would replace different live files, e.g. {differ[:5]}")
    moved_dirs = moved_files = 0
    pending = [Path(".")]
    while pending:
        rel = pending.pop()
        src_dir = stage / rel
        for entry in sorted(os.scandir(src_dir), key=lambda e: e.name):
            r = rel / entry.name
            dst = live / r
            if entry.is_dir():
                if dst.exists():
                    pending.append(r)
                else:
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    _retry(os.rename, stage / r, dst)
                    moved_dirs += 1
                    if delay_s:
                        time.sleep(delay_s)
            elif not dst.exists():
                _retry(os.rename, stage / r, dst)
                moved_files += 1
    log(f"swap: {moved_dirs} directories moved whole, {moved_files} files moved one by one, {same} identical files left")
    return {"dirs": moved_dirs, "files": moved_files, "identical": same}


def write_manifest_atomic(live: Path, data: bytes) -> Path:
    """Write live/manifest.json through a temporary file in the same directory and os.replace."""
    live = Path(live)
    fd, tmp = tempfile.mkstemp(dir=str(live), suffix=".partial")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        _retry(os.replace, tmp, live / "manifest.json")
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return live / "manifest.json"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", required=True)
    ap.add_argument("--live", required=True)
    ap.add_argument("--manifest", required=True, help="file holding the new manifest (written last)")
    ap.add_argument("--delay-ms", type=float, default=0.0, help="pause after each directory moved (tests)")
    a = ap.parse_args(argv)
    data = Path(a.manifest).read_bytes()
    try:
        swap_tree(Path(a.stage), Path(a.live), delay_s=a.delay_ms / 1000.0)
    except FileExistsError as e:
        print(f"swap refused: {e}", file=sys.stderr, flush=True)
        return 2
    write_manifest_atomic(Path(a.live), data)
    print("swap: manifest written", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
