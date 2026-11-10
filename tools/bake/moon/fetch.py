"""Resumable HTTP downloads and range reads for the Moon and sky bakes (build time only).

Downloads are untrusted data: every source lands in its own directory under data/cache/<area>/dl/<name>/,
and nothing in those directories is ever executed or imported. Files are fetched in parallel byte ranges
into a `.partial` file whose completed ranges are journalled, so an interrupted download resumes.

CLI:  python -I tools/bake/moon/fetch.py <url> <dest-file> [--connections N] [--expect-bytes N]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

USER_AGENT = "fable-bake/1.0 (build-time data bake)"
CHUNK = 64 * 1024 * 1024


def _request(url: str, headers: dict | None = None, method: str = "GET"):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})}, method=method)
    return urllib.request.urlopen(req, timeout=120)


def content_length(url: str) -> int:
    """Final URL size in bytes (follows redirects)."""
    with _request(url, method="HEAD") as r:
        n = r.headers.get("Content-Length")
        if n is None:
            raise RuntimeError(f"no Content-Length for {url}")
        return int(n)


def read_range(url: str, start: int, length: int, retries: int = 6) -> bytes:
    """Bytes [start, start + length) of a remote file via an HTTP Range request."""
    last: Exception | None = None
    for attempt in range(retries):
        try:
            with _request(url, {"Range": f"bytes={start}-{start + length - 1}"}) as r:
                if r.status != 206:
                    raise RuntimeError(f"range request not honoured ({r.status}) for {url}")
                data = r.read()
            if len(data) != length:
                raise RuntimeError(f"short range read {len(data)} != {length}")
            return data
        except Exception as e:  # network errors are retried with back-off
            last = e
            time.sleep(2.0 * (attempt + 1))
    raise RuntimeError(f"range read failed after {retries} attempts: {url} [{start}+{length}]") from last


def download(url: str, dest: Path, connections: int = 6, expect_bytes: int | None = None, quiet: bool = False) -> Path:
    """Download `url` to `dest` with parallel range requests; resumes from a journal; verifies the size."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = content_length(url)
    if expect_bytes is not None and total != expect_bytes:
        raise RuntimeError(f"{url}: server reports {total} bytes, expected {expect_bytes}")
    if dest.is_file() and dest.stat().st_size == total:
        return dest
    part = dest.with_name(dest.name + ".partial")
    journal = dest.with_name(dest.name + ".journal.json")
    done: set[int] = set()
    if part.is_file() and journal.is_file() and part.stat().st_size == total:
        done = set(json.loads(journal.read_text(encoding="utf-8")).get("done", []))
    else:
        with open(part, "wb") as f:
            f.truncate(total)
    chunks = [(i, s, min(CHUNK, total - s)) for i, s in enumerate(range(0, total, CHUNK))]
    todo = [c for c in chunks if c[0] not in done]
    lock = threading.Lock()
    t0 = time.time()
    got = [0]

    def work(c):
        i, s, n = c
        data = read_range(url, s, n)
        with lock:
            with open(part, "r+b") as f:
                f.seek(s)
                f.write(data)
            done.add(i)
            got[0] += n
            journal.write_text(json.dumps({"url": url, "total": total, "done": sorted(done)}), encoding="utf-8")
            if not quiet:
                el = time.time() - t0
                print(f"  {dest.name}: {len(done)}/{len(chunks)} chunks, {got[0] / max(el, 1e-3) / 1e6:.1f} MB/s", flush=True)

    with ThreadPoolExecutor(max_workers=connections) as ex:
        for _ in ex.map(work, todo):
            pass
    if len(done) != len(chunks):
        raise RuntimeError(f"incomplete download of {url}")
    if part.stat().st_size != total:
        raise RuntimeError(f"size mismatch for {dest}")
    os.replace(part, dest)
    journal.unlink(missing_ok=True)
    return dest


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("dest")
    ap.add_argument("--connections", type=int, default=6)
    ap.add_argument("--expect-bytes", type=int, default=None)
    a = ap.parse_args()
    t0 = time.time()
    p = download(a.url, Path(a.dest), a.connections, a.expect_bytes)
    print(f"downloaded {p} ({p.stat().st_size} B) in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    sys.exit(main())
