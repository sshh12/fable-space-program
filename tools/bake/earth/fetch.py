"""Polite, resumable downloads.

- Large files: HTTP Range resume from a `.partial` file, size check against Content-Length, sha256 recorded
  next to the file (`<file>.sha256`). A finished file is never fetched again.
- Tile services: many small requests through a shared token bucket (default 15 requests/s across all
  threads, the 10-20 req/s the brief allows), exponential back-off on 429/5xx, 404 recorded as `<file>.missing`
  so it is not asked again.
Downloads are untrusted data: each source lives in its own directory (paths.src_dir) and is only decoded by
image/raster libraries, never executed or imported.
"""
from __future__ import annotations

import hashlib
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

from earth import paths
from earth.util import log

_session_local = threading.local()


def _session() -> requests.Session:
    s = getattr(_session_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = paths.USER_AGENT
        _session_local.s = s
    return s


class RateLimiter:
    def __init__(self, rate: float):
        self.interval = 1.0 / rate
        self.lock = threading.Lock()
        self.next_t = time.monotonic()

    def wait(self) -> None:
        with self.lock:
            now = time.monotonic()
            t = max(now, self.next_t)
            self.next_t = t + self.interval
        d = t - time.monotonic()
        if d > 0:
            time.sleep(d)


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def download(url: str, dest: Path, *, retries: int = 8, chunk: int = 1 << 20, quiet: bool = False) -> Path:
    """Resumable download of one (large) file. Returns dest. Raises after `retries` failures."""
    dest = Path(dest)
    if dest.is_file():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".partial")
    attempt = 0
    while True:
        have = part.stat().st_size if part.exists() else 0
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            with _session().get(url, headers=headers, stream=True, timeout=(30, 120)) as r:
                if r.status_code == 416:      # already complete
                    break
                if r.status_code in (403, 404):
                    raise FileNotFoundError(f"HTTP {r.status_code} for {url}")
                if r.status_code not in (200, 206):
                    raise requests.HTTPError(f"HTTP {r.status_code} for {url}")
                if have and r.status_code == 200:   # server ignored Range: restart
                    have = 0
                total = None
                cr = r.headers.get("Content-Range")
                if cr and "/" in cr:
                    total = int(cr.split("/")[1])
                elif r.headers.get("Content-Length"):
                    total = have + int(r.headers["Content-Length"])
                mode = "ab" if have else "wb"
                t0 = time.time()
                got = 0
                with open(part, mode) as f:
                    for b in r.iter_content(chunk):
                        f.write(b)
                        got += len(b)
                size = part.stat().st_size
                if total is not None and size != total:
                    raise IOError(f"short read {size}/{total} for {url}")
                if not quiet:
                    el = max(time.time() - t0, 1e-3)
                    log(f"downloaded {dest.name} ({size / 1e6:.1f} MB, {got / el / 1e6:.1f} MB/s)")
                break
        except FileNotFoundError:
            raise
        except (requests.RequestException, IOError) as e:
            attempt += 1
            if attempt > retries:
                raise
            wait = min(120, 2 ** attempt) + random.random()
            log(f"retry {attempt}/{retries} for {dest.name} in {wait:.0f} s: {e}")
            time.sleep(wait)
    os.replace(part, dest)
    dest.with_name(dest.name + ".sha256").write_text(sha256_file(dest), encoding="utf-8")
    return dest


def _fetch_small(url: str, dest: Path, limiter: RateLimiter, retries: int) -> str:
    if dest.is_file():
        return "cached"
    miss = dest.with_name(dest.name + ".missing")
    if miss.is_file():
        return "missing"
    attempt = 0
    while True:
        limiter.wait()
        try:
            r = _session().get(url, timeout=(20, 60))
            if r.status_code == 200:
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_name(dest.name + ".partial")
                tmp.write_bytes(r.content)
                os.replace(tmp, dest)
                return "ok"
            if r.status_code in (404, 400):
                dest.parent.mkdir(parents=True, exist_ok=True)
                miss.write_text(str(r.status_code), encoding="utf-8")
                return "missing"
            raise requests.HTTPError(f"HTTP {r.status_code}")
        except requests.RequestException as e:
            attempt += 1
            if attempt > retries:
                raise RuntimeError(f"giving up on {url}: {e}") from e
            time.sleep(min(60, 2 ** attempt) + random.random())


def fetch_many(items: list[tuple[str, Path]], *, rate: float = 15.0, threads: int = 8, label: str = "tiles",
               retries: int = 6) -> dict:
    """Fetch many small files politely. Returns counts per outcome."""
    limiter = RateLimiter(rate)
    todo = [(u, Path(d)) for u, d in items
            if not Path(d).is_file() and not Path(str(d) + ".missing").is_file()]
    counts = {"cached": len(items) - len(todo), "ok": 0, "missing": 0}
    if not todo:
        log(f"{label}: all {len(items)} cached")
        return counts
    log(f"{label}: fetching {len(todo)} of {len(items)} at <= {rate:g} req/s")
    t0 = time.time()
    with ThreadPoolExecutor(threads) as ex:
        futs = [ex.submit(_fetch_small, u, d, limiter, retries) for u, d in todo]
        for i, f in enumerate(as_completed(futs), 1):
            counts[f.result()] += 1
            if i % 1000 == 0 or i == len(futs):
                log(f"{label}: {i}/{len(futs)} ({time.time() - t0:.0f} s)")
    return counts
