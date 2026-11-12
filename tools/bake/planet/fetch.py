"""Resumable, checksummed downloads of a body's sources (build time only).

Each source lands in its own directory data/cache/planets/<body>/dl/<source key>/ (untrusted data: nothing in
it is ever executed or imported). The transfer is moon/fetch.py's: parallel byte ranges into a `.partial`
file with a journal of finished ranges, so an interrupted download resumes. After the transfer the file is
checked against the provider's MD5 (USGS publishes `<file>.md5` beside every mosaic) and against the sha256
recorded in the body config. `--record-checksums` fills a missing md5/sha256 into the config after the MD5
sidecar has confirmed the file.
"""
from __future__ import annotations

import hashlib
import re
import urllib.request
from pathlib import Path

from moon import fetch as moon_fetch
from planet import config, rt

_HASH_CHUNK = 16 * 1024 * 1024


def file_name(src: dict) -> str:
    return src["url"].rsplit("/", 1)[-1]


def local_path(body: config.Body, key: str) -> Path:
    return rt.dl_dir(body.id, key) / file_name(body.source(key))


def hashes(path: Path) -> tuple[str, str]:
    md5 = hashlib.md5()
    sha = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(_HASH_CHUNK)
            if not b:
                break
            md5.update(b)
            sha.update(b)
    return md5.hexdigest(), sha.hexdigest()


def provider_md5(url: str) -> str | None:
    """The MD5 the provider publishes beside the file (`<url>.md5`), or None when there is none."""
    req = urllib.request.Request(url + ".md5", headers={"User-Agent": moon_fetch.USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            text = r.read(4096).decode("ascii", "replace")
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            return None
        raise
    m = re.match(r"\s*([0-9a-fA-F]{32})\b", text)
    return m.group(1).lower() if m else None


def ensure(body: config.Body, key: str, record: bool = False) -> Path:
    """Download (or reuse) one source and verify it. Returns the local path."""
    src = body.source(key)
    dest = local_path(body, key)
    if not (dest.is_file() and dest.stat().st_size == src["bytes"]):
        rt.check_disk(src["bytes"])
        rt.log(f"{body.id}: downloading {key} ({src['bytes'] / 1e6:.1f} MB) {src['url']}")
        moon_fetch.download(src["url"], dest, connections=6, expect_bytes=src["bytes"], quiet=True)
    verified = dest.with_name(dest.name + ".verified")
    stamp = f"{src['bytes']}:{src['md5']}:{src['sha256']}"
    if verified.is_file() and verified.read_text(encoding="ascii") == stamp and src["sha256"]:
        return dest
    md5, sha = hashes(dest)
    want_md5 = src["md5"]
    if want_md5 is None:
        if not record:
            raise RuntimeError(f"{body.id}.{key}: no md5 in the config (run with --record-checksums once)")
        want_md5 = provider_md5(src["url"])
        if want_md5 is None:
            # No provider checksum (NASA Photojournal, MAST, PDS): the first verified download pins the file by
            # its sha256 from here on (the size was already checked against the config).
            rt.log(f"{body.id}.{key}: the provider publishes no .md5; pinning the download by its own hashes")
            want_md5 = md5
    if md5 != want_md5:
        dest.unlink()
        raise RuntimeError(f"{body.id}.{key}: md5 {md5} != {want_md5}; download deleted")
    if src["sha256"] is None:
        if not record:
            raise RuntimeError(f"{body.id}.{key}: no sha256 in the config (run with --record-checksums once)")
        _record(body, key, md5, sha)
        src = config.load(body.id).source(key)
    elif sha != src["sha256"]:
        dest.unlink()
        raise RuntimeError(f"{body.id}.{key}: sha256 {sha} != config {src['sha256']}; download deleted")
    verified.write_text(f"{src['bytes']}:{src['md5']}:{src['sha256']}", encoding="ascii")
    rt.log(f"{body.id}: {key} verified (md5 {md5}, sha256 {sha[:16]}...)")
    return dest


def _record(body: config.Body, key: str, md5: str, sha: str) -> None:
    import json
    raw = json.loads(body.path.read_text(encoding="utf-8"))
    s = raw["sources"][key]
    if s["md5"] not in (None, md5) or s["sha256"] not in (None, sha):
        raise RuntimeError(f"{body.id}.{key}: config checksums differ from the download")
    s["md5"] = md5
    s["sha256"] = sha
    body.path.write_text(json.dumps(raw, indent=1) + "\n", encoding="utf-8", newline="\n")
    rt.log(f"{body.id}: recorded md5/sha256 of {key} in {body.path.name}")


def delete_downloads(body: config.Body) -> int:
    """Remove every raw download of a body (after its bake is verified). Returns the bytes freed."""
    d = rt.PLANET_CACHE / body.id / "dl"
    n = rt.dir_size(d) if d.exists() else 0
    rt.remove_tree(d)
    return n
