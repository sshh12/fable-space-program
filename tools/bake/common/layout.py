"""Tile-set layout and manifest helpers shared by the bake pipelines (lead-owned contract code).

Disk layout (git-ignored):
  data/tiles/{tileset}/manifest.json
  data/tiles/{tileset}/{layer}/{face}/{level}/{x}/{y}.{ext}
  data/tiles/{tileset}/globals/...          whole-body maps listed in manifest["globals"]
  data/sky/...                              star maps and catalogues (sky manifest: data/sky/manifest.json)
  data/cache/...                            raw downloads and intermediates; safe to delete after a bake

The manifest schema is `TileManifest` in src/core/contracts/terrain.ts. write_manifest() validates the parts
that other teams rely on.
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DATA_ROOT = REPO_ROOT / "data"
TILES_ROOT = DATA_ROOT / "tiles"
SKY_ROOT = DATA_ROOT / "sky"
CACHE_ROOT = DATA_ROOT / "cache"

ENCODING_EXT = {"frt1-height": "hgt", "frt1-u8": "u8", "webp": "webp"}


def tile_file(tileset: str, layer: str, face: int, level: int, x: int, y: int, ext: str) -> Path:
    return TILES_ROOT / tileset / layer / str(face) / str(level) / str(x) / f"{y}.{ext}"


def write_atomic(path: Path, data: bytes) -> None:
    """Write via a temp file + rename so an interrupted bake never leaves a truncated tile."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".partial")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def layer_has_tile(layer: dict, face: int, level: int, x: int, y: int) -> bool:
    if level <= layer["globalMaxLevel"]:
        return True
    for r in layer.get("coverage", {}).get(str(level), []):
        if r["face"] == face and r["x0"] <= x <= r["x1"] and r["y0"] <= y <= r["y1"]:
            return True
    return False


def validate_manifest(m: dict) -> None:
    if m.get("formatVersion") != 1:
        raise ValueError("manifest.formatVersion must be 1")
    if m.get("mapping") != "gnomonic-cube":
        raise ValueError("manifest.mapping must be 'gnomonic-cube'")
    for key in ("tileset", "radius", "layers", "globals", "residentHeightLevel", "attribution"):
        if key not in m:
            raise ValueError(f"manifest.{key} missing")
    for name, layer in m["layers"].items():
        enc = layer.get("encoding")
        if enc not in ENCODING_EXT:
            raise ValueError(f"layer {name}: unknown encoding {enc}")
        if layer.get("ext") != ENCODING_EXT[enc]:
            raise ValueError(f"layer {name}: ext must be {ENCODING_EXT[enc]}")
        if not isinstance(layer.get("globalMaxLevel"), int):
            raise ValueError(f"layer {name}: globalMaxLevel missing")
        coverage = layer.setdefault("coverage", {})
        for level_s, rects in coverage.items():
            level = int(level_s)
            if level <= layer["globalMaxLevel"]:
                raise ValueError(f"layer {name}: coverage level {level} is not above globalMaxLevel")
            for r in rects:
                # pyramid completeness: the parent rectangle must exist
                px0, py0, px1, py1 = r["x0"] >> 1, r["y0"] >> 1, r["x1"] >> 1, r["y1"] >> 1
                for (px, py) in ((px0, py0), (px1, py0), (px0, py1), (px1, py1)):
                    if not layer_has_tile(layer, r["face"], level - 1, px, py):
                        raise ValueError(f"layer {name}: level {level} rect {r} has no parent coverage at level {level - 1}")
        if enc == "frt1-height" and "heightScales" not in layer:
            raise ValueError(f"layer {name}: heightScales missing")
        layer.setdefault("sources", [])


def verify_files_exist(m: dict, sample_every: int = 1) -> int:
    """Check that every tile promised by the manifest exists on disk. Returns the number of tiles checked."""
    checked = 0
    for name, layer in m["layers"].items():
        ext = layer["ext"]
        for level in range(layer["globalMaxLevel"] + 1):
            n = 2 ** level
            for face in range(6):
                for x in range(0, n, sample_every):
                    for y in range(0, n, sample_every):
                        if not tile_file(m["tileset"], name, face, level, x, y, ext).is_file():
                            raise FileNotFoundError(f"missing tile {name}/{face}/{level}/{x}/{y}.{ext}")
                        checked += 1
        for level_s, rects in layer.get("coverage", {}).items():
            for r in rects:
                for x in range(r["x0"], r["x1"] + 1, sample_every):
                    for y in range(r["y0"], r["y1"] + 1, sample_every):
                        if not tile_file(m["tileset"], name, r["face"], int(level_s), x, y, ext).is_file():
                            raise FileNotFoundError(f"missing tile {name}/{r['face']}/{level_s}/{x}/{y}.{ext}")
                        checked += 1
    return checked


def write_manifest(m: dict) -> Path:
    """Validate, stamp a content hash and write data/tiles/{tileset}/manifest.json."""
    validate_manifest(m)
    body = {k: v for k, v in m.items() if k != "contentHash"}
    m["contentHash"] = hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    path = TILES_ROOT / m["tileset"] / "manifest.json"
    write_atomic(path, json.dumps(m, indent=1).encode("utf-8"))
    return path


def read_manifest(tileset: str) -> dict:
    with open(TILES_ROOT / tileset / "manifest.json", "r", encoding="utf-8") as f:
        return json.load(f)


def merge_layer(tileset: str, radius: float, layer_name: str, layer: dict, *, globals_: dict | None = None,
                attribution: list[str] | None = None, resident_height_level: int = 3) -> Path:
    """Add or replace one layer (and optional globals/attribution) in a tile set's manifest.

    Lets independent bake steps (height, albedo, night lights, regions) each update the manifest safely
    when run one after another. Not safe for concurrent writers of the SAME tile set.
    """
    path = TILES_ROOT / tileset / "manifest.json"
    if path.is_file():
        m = read_manifest(tileset)
    else:
        m = {"formatVersion": 1, "tileset": tileset, "radius": radius, "mapping": "gnomonic-cube", "layers": {},
             "globals": {}, "residentHeightLevel": resident_height_level, "attribution": []}
    m["layers"][layer_name] = layer
    if globals_:
        m["globals"].update(globals_)
    for a in attribution or []:
        if a not in m["attribution"]:
            m["attribution"].append(a)
    return write_manifest(m)
