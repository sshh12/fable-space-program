"""Staged regional bakes (work package site-bake): a new region is baked away from the live tile set, which other
packages render while it is being baked, and swapped in at the end in one step.

A region is STAGED from `begin()` until `swap()` has finished; its state lives in
data/cache/earth/stage/<region>/stage.json:
  "staging"  its tiles are read and written under data/cache/earth/stage/<region>/tiles/{layer}/{face}/{level}/...
             (tiles.tile_file routes every tile of its coverage at its regional levels there);
  "moved"    the swap has moved its tiles into data/tiles/earth but has not yet written the manifest;
  "swapped"  done: an ordinary live region.
While "staging" or "moved" the region is HIDDEN: region.list_regions() leaves it out (so bake.py without --region,
the manifest, the contact sheets and verify.py do not see it), manifest.build_hash() leaves its records out, and no
manifest written meanwhile promises one of its tiles.

swap(region): the prospective manifest (the live one with the region added) is built and checked to be purely
additive; the staged tiles are moved into data/tiles/earth (swaptree.swap_tree: new directories by one rename each,
never replacing a live file); then the manifest is written ONCE, atomically (swaptree.write_manifest_atomic). Every
step is idempotent, so an interrupted swap is finished by running it again.
"""
from __future__ import annotations

import copy
import json
import shutil
import time
from pathlib import Path

from common import layout
from earth import paths
from earth.util import log, write_json

STAGE = paths.CACHE / "stage"
HIDDEN_STATES = ("staging", "moved")


def marker(region_id: str) -> Path:
    return STAGE / region_id / "stage.json"


def tiles_root(region_id: str) -> Path:
    return STAGE / region_id / "tiles"


def state(region_id: str) -> str | None:
    p = marker(region_id)
    if not p.is_file():
        return None
    return json.loads(p.read_text(encoding="utf-8"))["state"]


def _set_state(region_id: str, st: str) -> None:
    write_json(marker(region_id), {"region": region_id, "state": st, "at": time.strftime("%Y-%m-%dT%H:%M:%S")})
    reset()


_HIDDEN: set[str] | None = None
_ROUTES: dict | None = None


def reset() -> None:
    global _HIDDEN, _ROUTES
    _HIDDEN = None
    _ROUTES = None


def hidden_regions() -> set[str]:
    """Regions that are staged or half swapped (not yet in the live manifest)."""
    global _HIDDEN
    if _HIDDEN is None:
        out = set()
        if STAGE.is_dir():
            for d in STAGE.iterdir():
                if d.is_dir() and state(d.name) in HIDDEN_STATES:
                    out.add(d.name)
        _HIDDEN = out
    return _HIDDEN


def _routes() -> dict:
    """level -> [(rect, tiles root)] of every region in state "staging"."""
    global _ROUTES
    if _ROUTES is None:
        from earth import region as regmod
        out: dict = {}
        for r in sorted(hidden_regions()):
            if state(r) != "staging":
                continue
            reg = regmod.load(r)
            for lv in regmod.levels(reg):
                for rect in regmod.coverage_rects(reg, lv):
                    out.setdefault(lv, []).append((rect, tiles_root(r)))
        _ROUTES = out
    return _ROUTES


def route(face: int, level: int, x: int, y: int) -> Path | None:
    """Tiles root holding (face, level, x, y) when that tile belongs to a staged region, else None (live)."""
    if level <= paths.GLOBAL_MAX_LEVEL:
        return None
    for r, root in _routes().get(level, ()):
        if r["face"] == face and r["x0"] <= x <= r["x1"] and r["y0"] <= y <= r["y1"]:
            return root
    return None


def _live_rects(level: int) -> list[dict]:
    m = layout.read_manifest(paths.TILESET)
    out = []
    for L in m["layers"].values():
        out += L.get("coverage", {}).get(str(level), [])
    return out


def _overlap(a: dict, b: dict) -> bool:
    return a["face"] == b["face"] and a["x0"] <= b["x1"] and b["x0"] <= a["x1"] and a["y0"] <= b["y1"] and b["y0"] <= a["y1"]


def begin(region_id: str) -> None:
    """Mark a region as staged before anything of it is baked. Refuses a region whose coverage overlaps the live
    coverage (regions must not overlap, and a staged tile must never shadow a live one)."""
    from earth import region as regmod
    st = state(region_id)
    if st == "swapped":
        raise RuntimeError(f"{region_id} is already swapped into the live tile set")
    if st == "moved":
        return
    reg = regmod.load(region_id)
    for lv in regmod.levels(reg):
        live = _live_rects(lv)
        for r in regmod.coverage_rects(reg, lv):
            hit = [q for q in live if _overlap(q, r)]
            if hit:
                raise RuntimeError(f"{region_id} level {lv}: coverage {r} overlaps live coverage {hit[0]}")
    tiles_root(region_id).mkdir(parents=True, exist_ok=True)
    if st != "staging":
        _set_state(region_id, "staging")
    log(f"stage: {region_id} is staged under {tiles_root(region_id)} (no overlap with the live coverage)")


# -- the manifest with the region added ------------------------------------------------------------------------
def prospective_manifest(region_id: str) -> dict:
    """The live manifest with `region_id` added, built by the same layer functions as manifest.write_all, and
    checked to be purely additive: every live layer entry, coverage rectangle, sourceCoverage rectangle, height
    scale, source and attribution line is kept as it is and in its order; only the region's rectangles, its new
    source and attribution lines and the layers' `build` hashes are added or updated. Raises otherwise."""
    from earth import manifest, region as regmod
    live = layout.read_manifest(paths.TILESET)
    reg = regmod.load(region_id)
    in_live = all(_contains(live["layers"][L].get("coverage", {}), regmod.coverage_rects(reg, lv), lv)
                  for L in reg["layers"] for lv in regmod.levels(reg))
    m = copy.deepcopy(live)
    m.pop("contentHash", None)
    others = [r for r in regmod.list_regions() if r != region_id]
    for layer in manifest.REGIONAL_LAYERS:
        if layer not in reg["layers"]:
            continue
        if not manifest.is_marked(layer, region_id):
            raise RuntimeError(f"{region_id}: the {layer} layer is not baked")
        regs = [regmod.load(r) for r in others if manifest.is_marked(layer, r)] + [reg]
        entry = manifest.layer_dict(layer, regs)
        entry["build"] = manifest.build_hash(layer, include={region_id})
        _check_additive(layer, live["layers"][layer], entry, reg, in_live)
        m["layers"][layer] = entry
    for a in manifest.region_attribution(reg):
        if a not in m["attribution"]:
            m["attribution"].append(a)
    return m


def _contains(cov: dict, rects: list[dict], lv: int) -> bool:
    return all(r in cov.get(str(lv), []) for r in rects)


def _inside(r: dict, q: dict) -> bool:
    return r["face"] == q["face"] and q["x0"] <= r["x0"] <= r["x1"] <= q["x1"] and q["y0"] <= r["y0"] <= r["y1"] <= q["y1"]


def _check_additive(layer: str, old: dict, new: dict, reg: dict, in_live: bool) -> None:
    from earth import region as regmod
    problems = []
    for k in set(old) | set(new):
        if k in ("coverage", "sourceCoverage", "sources", "build"):
            continue
        if old.get(k) != new.get(k):
            problems.append(f"{k}: {old.get(k)} -> {new.get(k)}")
    for key in ("coverage", "sourceCoverage"):
        if key not in old and key not in new:
            continue
        o, n = old.get(key, {}), new.get(key, {})
        for lv in set(o) | set(n):
            a, b = o.get(lv, []), n.get(lv, [])
            if b[:len(a)] != a:
                problems.append(f"{key} level {lv}: live rectangles changed")
                continue
            added = b[len(a):]
            own = regmod.coverage_rects(reg, int(lv)) if str(lv) in reg["levels"] else []
            if key == "coverage" and added != ([] if in_live else own):
                problems.append(f"coverage level {lv}: added rectangles are not exactly the region's")
            if key == "sourceCoverage" and not all(any(_inside(r, q) for q in own) for r in added):
                problems.append(f"sourceCoverage level {lv}: an added rectangle lies outside the region's coverage")
    if new.get("sources", [])[:len(old.get("sources", []))] != old.get("sources", []):
        problems.append("sources: live entries changed")
    if problems:
        raise RuntimeError(f"manifest layer {layer} would not be purely additive: {problems[:6]}")


# -- the swap ---------------------------------------------------------------------------------------------------
def swap(region_id: str) -> dict:
    """Move the staged tiles of `region_id` into the live tile set, then write the manifest once, atomically."""
    from earth import swaptree
    st = state(region_id)
    if st == "swapped":
        log(f"stage: {region_id} is already swapped")
        return {"state": st}
    if st not in HIDDEN_STATES:
        raise RuntimeError(f"{region_id} is not staged")
    m = prospective_manifest(region_id)         # built and checked while the tiles are still routed to the stage
    layout.validate_manifest(json.loads(json.dumps(m)))
    root = tiles_root(region_id)
    res: dict = {}
    if st == "staging":
        res = swaptree.swap_tree(root, paths.TILES, log=log)
        _set_state(region_id, "moved")
    missing = layout.verify_files_exist(m)          # every tile the new manifest promises is now live
    body = {k: v for k, v in m.items() if k != "contentHash"}
    import hashlib
    m["contentHash"] = hashlib.sha256(json.dumps(body, sort_keys=True).encode("utf-8")).hexdigest()[:16]
    swaptree.write_manifest_atomic(paths.TILES, json.dumps(m, indent=1).encode("utf-8"))
    _set_state(region_id, "swapped")
    left = [p for p in root.rglob("*") if p.is_file()] if root.is_dir() else []
    if left:
        raise RuntimeError(f"stage: {len(left)} files left under {root} after the swap, e.g. {left[:3]}")
    if root.is_dir():
        shutil.rmtree(root)
    log(f"stage: {region_id} swapped in; {missing} promised tiles checked present; manifest contentHash {m['contentHash']}")
    res.update({"state": "swapped", "contentHash": m["contentHash"], "promisedTilesChecked": missing})
    return res
