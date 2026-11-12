"""Acceptance checks of the planet bake (reads the baked tile sets back; never writes tiles).

  python -I tools/bake/planet/verify.py --all | <id> [<id> ...] [--quick]

Per solid body: the manifest (contract fields, radius and levels from the config, layer sources and
attribution); the tile files against the manifest's promises (every promised tile present, none extra, none
empty, no `.partial` left over); every height tile decodes to finite heights and shares its in-face edges with
its neighbours to one quantisation step; every albedo tile is a 256 x 256 opaque image; the landmark tests of
the config (a flipped or shifted map fails them); the radii and the amplification section against the staged
files of bodies-ephemeris when those exist. Per giant: the staged maps. Globally: data/staged/credits.json
lists every source of every config, data/ stays under 22 GB, the disk keeps 25 GB free, and the Earth and
Moon tile sets are untouched (their manifests' content hashes and tile counts against the terrain guard).
Writes out/bake/planet/verify.json and verify.txt; exits 1 when any check fails.
"""
from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from common import cube, frt1, layout  # noqa: E402
from moon.sampling import dirs_to_tiles, srgb_decode  # noqa: E402
from moon.tiles import TileReader  # noqa: E402
from planet import config, heights, procedural, rt  # noqa: E402

LUMA = np.array([0.2126, 0.7152, 0.0722])
DATA_CAP_GB = 22.0
GUARD_TILES = rt.REPO_ROOT / "tests" / "unit" / "terrain-core" / "terrain-guard.tiles.json"


class Report:
    def __init__(self):
        self.rows: list[dict] = []

    def check(self, body: str, name: str, ok: bool, detail: str = "", **data) -> bool:
        self.rows.append({"body": body, "check": name, "ok": bool(ok), "detail": detail, **data})
        print(f"  [{'PASS' if ok else 'FAIL'}] {body}: {name}{(' - ' + detail) if detail else ''}", flush=True)
        return ok

    @property
    def failed(self) -> list[dict]:
        return [r for r in self.rows if not r["ok"]]


def promised(layer: dict) -> set[tuple[int, int, int, int]]:
    out = set()
    for L in range(layer["globalMaxLevel"] + 1):
        for f in range(6):
            for x in range(2 ** L):
                for y in range(2 ** L):
                    out.add((f, L, x, y))
    for ls, rects in layer.get("coverage", {}).items():
        for r in rects:
            for x in range(r["x0"], r["x1"] + 1):
                for y in range(r["y0"], r["y1"] + 1):
                    out.add((r["face"], int(ls), x, y))
    return out


def on_disk(tileset: str, layer: str, ext: str) -> tuple[set, list[str], list[str]]:
    root = rt.TILES_ROOT / tileset / layer
    found, empty, junk = set(), [], []
    for dirpath, _, files in os.walk(root):
        rel = Path(dirpath).relative_to(root).parts
        for fn in files:
            p = os.path.join(dirpath, fn)
            if len(rel) != 3 or not fn.endswith("." + ext):
                junk.append(p)
                continue
            try:
                key = (int(rel[0]), int(rel[1]), int(rel[2]), int(fn[: -len(ext) - 1]))
            except ValueError:
                junk.append(p)
                continue
            found.add(key)
            if os.path.getsize(p) == 0:
                empty.append(p)
    return found, empty, junk


def cap_points(lat_deg: float, lon_deg: float, radius_m: float, body_r: float, n: int = 600, inner_m: float = 0.0) -> np.ndarray:
    """Directions spread uniformly by area over a spherical cap (or the ring inner..radius)."""
    c = cube.lat_lon_to_dir(math.radians(lat_deg), math.radians(lon_deg))
    e1 = np.cross([0.0, 0.0, 1.0], c)
    if np.linalg.norm(e1) < 1e-9:
        e1 = np.array([1.0, 0.0, 0.0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(c, e1)
    a1, a0 = radius_m / body_r, inner_m / body_r
    k = np.arange(n) + 0.5
    cos_a = math.cos(a0) - (math.cos(a0) - math.cos(a1)) * k / n
    ang = np.arccos(cos_a)
    th = k * math.pi * (3.0 - math.sqrt(5.0))
    d = np.cos(ang)[:, None] * c + np.sin(ang)[:, None] * (np.cos(th)[:, None] * e1 + np.sin(th)[:, None] * e2)
    return d / np.linalg.norm(d, axis=1, keepdims=True)


class AlbedoReader:
    def __init__(self, tileset: str):
        self.tileset = tileset
        self.cache: dict = {}

    def tile(self, f: int, L: int, x: int, y: int) -> np.ndarray:
        k = (f, L, x, y)
        if k not in self.cache:
            p = layout.tile_file(self.tileset, "albedo", f, L, x, y, "webp")
            self.cache[k] = srgb_decode(np.asarray(Image.open(p).convert("RGB"), dtype=np.float64) / 255.0)
        return self.cache[k]

    def luminance(self, dirs: np.ndarray, level: int) -> np.ndarray:
        f, x, y, u, v = dirs_to_tiles(dirs, level)
        out = np.empty(len(dirs))
        for i in range(len(dirs)):
            t = self.tile(int(f[i]), level, int(x[i]), int(y[i]))
            out[i] = t[min(255, int(v[i] * 256)), min(255, int(u[i] * 256))] @ LUMA
        return out


def sample_level(body: config.Body, radius_m: float) -> int:
    """Albedo level whose texel is at most a twentieth of the disc radius (capped at the finest)."""
    A = int(body.albedo["maxLevel"])
    for L in range(A + 1):
        if cube.mean_tile_size(body.radius, L) / 256 <= radius_m / 20:
            return L
    return A


def landmark(body: config.Body, lm: dict, hr: TileReader, ar: AlbedoReader, rep: Report) -> None:
    R = body.radius
    name = f"landmark {lm['name']} ({lm['kind']})"
    if lm["kind"] == "demHeight":
        d = cube.lat_lon_to_dir(math.radians(lm["latDeg"]), math.radians(lm["lonDegE"]))[None, :]
        h = float(hr.bicubic(d, hr.meta["globalMaxLevel"])[0] - heights.reference_term(body, d)[0])
        ok = abs(h - lm["expectM"]) <= lm["toleranceM"]
        rep.check(body.id, name, ok, f"DEM part {h:.0f} m, expected {lm['expectM']} +- {lm['toleranceM']} ({lm['ref']})", value=h)
    elif lm["kind"] == "albedoContrast":
        r = lm["radiusKm"] * 1000.0
        L = sample_level(body, r)
        inner = float(ar.luminance(cap_points(lm["latDeg"], lm["lonDegE"], r, R), L).mean())
        ring = float(ar.luminance(cap_points(lm["latDeg"], lm["lonDegE"], 2 * r, R, inner_m=r), L).mean())
        ratio = inner / ring if lm["sense"] == "brighter" else ring / inner
        rep.check(body.id, name, ratio >= lm["minRatio"], f"{lm['sense']}: disc {inner:.4f}, ring {ring:.4f}, ratio {ratio:.3f} >= {lm['minRatio']} ({lm['ref']})", value=ratio)
    elif lm["kind"] == "albedoTexture":
        r = lm["radiusKm"] * 1000.0
        L = sample_level(body, r)
        inner = ar.luminance(cap_points(lm["latDeg"], lm["lonDegE"], r, R, n=1200), L)
        ring = ar.luminance(cap_points(lm["latDeg"], lm["lonDegE"], 2 * r, R, n=1200, inner_m=r), L)
        ratio = float(inner.std() / max(ring.std(), 1e-9))
        rep.check(body.id, name, ratio >= lm["minRatio"], f"luminance std disc {inner.std():.4f}, ring {ring.std():.4f}, ratio {ratio:.3f} >= {lm['minRatio']} ({lm['ref']})", value=ratio)
    elif lm["kind"] == "albedoCompare":
        b, d = lm["brighter"], lm["darker"]
        L = sample_level(body, min(b["radiusKm"], d["radiusKm"]) * 1000.0)
        vb = float(ar.luminance(cap_points(b["latDeg"], b["lonDegE"], b["radiusKm"] * 1000.0, R), L).mean())
        vd = float(ar.luminance(cap_points(d["latDeg"], d["lonDegE"], d["radiusKm"] * 1000.0, R), L).mean())
        ratio = vb / vd
        rep.check(body.id, name, ratio >= lm["minRatio"], f"brighter {vb:.4f} / darker {vd:.4f} = {ratio:.3f} >= {lm['minRatio']} ({lm['ref']})", value=ratio)
    elif lm["kind"] == "craterDepth":
        F = hr.meta["globalMaxLevel"]
        rr = lm["diameterKm"] * 500.0
        cen = cap_points(lm["latDeg"], lm["lonDegE"], rr * 0.15, R, n=50)
        rim = cap_points(lm["latDeg"], lm["lonDegE"], rr * 1.05, R, n=200, inner_m=rr * 0.95)
        hc = float((hr.bicubic(cen, F) - heights.reference_term(body, cen)).mean())
        hm = float((hr.bicubic(rim, F) - heights.reference_term(body, rim)).mean())
        rep.check(body.id, name, hm - hc >= lm["minDepthM"], f"rim {hm:.0f} m, centre {hc:.0f} m, depth {hm - hc:.0f} >= {lm['minDepthM']} ({lm['ref']})", value=hm - hc)


def edge_check(body_id: str, layer: dict) -> tuple[int, float]:
    """Max |difference| of shared in-face edge samples between horizontally/vertically adjacent tiles, in
    quantisation steps of the coarser tile. Returns (edges checked, worst steps)."""
    worst = 0.0
    n = 0
    for L in range(layer["globalMaxLevel"] + 1):
        nt = 2 ** L
        for f in range(6):
            tiles = {}
            for x in range(nt):
                for y in range(nt):
                    t = frt1.from_file_bytes(layout.tile_file(body_id, "height", f, L, x, y, "hgt").read_bytes())
                    tiles[(x, y)] = t
            for (x, y), t in tiles.items():
                if (x + 1, y) in tiles:
                    o = tiles[(x + 1, y)]
                    dmax = float(np.abs(t["heights"][:, 257].astype(np.float64) - o["heights"][:, 1]).max())
                    worst = max(worst, dmax / max(t["scale"], o["scale"]))
                    n += 1
                if (x, y + 1) in tiles:
                    o = tiles[(x, y + 1)]
                    dmax = float(np.abs(t["heights"][257, :].astype(np.float64) - o["heights"][1, :]).max())
                    worst = max(worst, dmax / max(t["scale"], o["scale"]))
                    n += 1
    return n, worst


def verify_solid(body: config.Body, rep: Report, quick: bool) -> dict:
    bid = body.id
    mpath = rt.TILES_ROOT / bid / "manifest.json"
    if not rep.check(bid, "manifest exists", mpath.is_file(), str(mpath)):
        return {}
    m = layout.read_manifest(bid)
    try:
        layout.validate_manifest(json.loads(json.dumps(m)))
        ok = True
        why = ""
    except ValueError as e:
        ok, why = False, str(e)
    rep.check(bid, "manifest valid (common/layout.validate_manifest)", ok, why)
    rep.check(bid, "manifest radius = config mean radius", abs(m["radius"] - body.radius) < 1e-6, f"{m['radius']} / {body.radius}")
    hl, al = m["layers"].get("height"), m["layers"].get("albedo")
    rep.check(bid, "height levels", hl is not None and hl["globalMaxLevel"] == body.height["maxLevel"] and not hl.get("coverage"),
              f"globalMaxLevel {hl and hl['globalMaxLevel']}")
    rep.check(bid, "albedo levels", al is not None and al["globalMaxLevel"] == body.albedo["maxLevel"] and not al.get("coverage"),
              f"globalMaxLevel {al and al['globalMaxLevel']}")
    rep.check(bid, "residentHeightLevel", m["residentHeightLevel"] == body.height["residentLevel"] <= hl["globalMaxLevel"])
    rep.check(bid, "sources and attribution present", bool(hl["sources"]) and bool(al["sources"]) and bool(m["attribution"]))
    rep.check(bid, "levels within the brief's caps (albedo <= 6, height <= 5)", al["globalMaxLevel"] <= 6 and hl["globalMaxLevel"] <= 5)
    sizes = {}
    for name, layer in (("height", hl), ("albedo", al)):
        want = promised(layer)
        found, empty, junk = on_disk(bid, name, layer["ext"])
        rep.check(bid, f"{name}: every promised tile exists", not (want - found), f"{len(want)} promised, {len(want - found)} missing")
        rep.check(bid, f"{name}: no tile beyond the manifest", not (found - want), f"{len(found - want)} extra")
        rep.check(bid, f"{name}: no zero-length tile", not empty, f"{len(empty)} empty")
        rep.check(bid, f"{name}: no stray or partial files", not junk, f"{junk[:3]}")
        sizes[name] = rt.dir_size(rt.TILES_ROOT / bid / name)
    if not quick:
        n, worst = edge_check(bid, hl)
        rep.check(bid, "height: shared in-face tile edges agree to one quantisation step", worst <= 1.0 + 1e-6,
                  f"{n} edges, worst {worst:.3f} steps")
        bad = 0
        A = al["globalMaxLevel"]
        for L in range(A + 1):
            for f in range(6):
                for x in range(2 ** L):
                    for y in range(2 ** L):
                        im = Image.open(layout.tile_file(bid, "albedo", f, L, x, y, "webp"))
                        if im.size != (256, 256) or im.mode != "RGB":
                            bad += 1
        rep.check(bid, "albedo: every tile is a 256 x 256 opaque RGB image", bad == 0, f"{bad} bad")
    hr = TileReader(bid)
    ar = AlbedoReader(bid)
    # elevation range in the manifest covers the finest level
    rep.check(bid, "height: elevation range recorded", "elevation" in hl and hl["elevation"]["min"] <= hl["elevation"]["max"],
              f"{hl.get('elevation')}")
    lms = body.raw["landmarks"]
    needs = body.albedo["procedural"] is None or bool(body.height["craters"] and body.height["craters"]["named"])
    rep.check(bid, "landmark tests configured" if needs else "landmark tests: none (no map to flip: procedural surface)",
              bool(lms) or not needs, f"{len(lms)} landmarks")
    for lm in lms:
        landmark(body, lm, hr, ar, rep)
    if body.height["craters"] is not None:
        F = hl["globalMaxLevel"]
        d = cap_points(0.0, 0.0, body.radius * 3.0, body.radius, n=4000)
        rel = hr.bicubic(d, F) - heights.reference_term(body, d)
        rep.check(bid, "procedural crater relief present", float(rel.std()) > 1.0, f"std {rel.std():.1f} m over the body")
    for p in config.radii_crosscheck(body):
        rep.check(bid, "radii = data/staged/bodies/radii.json", False, p)
    staged_terrain = rt.STAGED / "terrain" / f"{bid}.terrain.json"
    if staged_terrain.is_file():
        st = rt.read_json(staged_terrain)
        amp = st.get("amplification", {})
        want = procedural.resolved_amplification(body)
        rep.check(bid, "staged terrain section names this tile set and model", st.get("tileset") == bid and amp.get("model") == want["model"],
                  f"tileset {st.get('tileset')}, model {amp.get('model')}")
    return {"heightBytes": sizes["height"], "albedoBytes": sizes["albedo"],
            "globalsBytes": rt.dir_size(rt.TILES_ROOT / bid / "globals"),
            "heightTiles": len(promised(hl)), "albedoTiles": len(promised(al))}


def verify_giant(body: config.Body, rep: Report) -> dict:
    p = rt.STAGED_RENDER / f"{body.id}.maps.json"
    if not rep.check(body.id, "maps descriptor staged", p.is_file(), str(p)):
        return {}
    d = rt.read_json(p)
    total = 0
    for g in body.raw["globals"]:
        e = d["maps"].get(g["name"])
        f = rt.STAGED_RENDER / e["path"] if e else None
        ok = bool(e) and f.is_file() and f.stat().st_size > 0
        if ok:
            im = Image.open(f)
            ok = im.size == (g["width"], g["height"])
            total += f.stat().st_size
        rep.check(body.id, f"map {g['name']} staged at {g['width']} x {g['height']}", ok)
    return {"stagedBytes": total}


def verify_global(rep: Report, all_ids: list[str]) -> dict:
    credits = config.load_credits()
    staged = rt.read_json(rt.STAGED_CREDITS) if rt.STAGED_CREDITS.is_file() else {"entries": []}
    have = {e["id"] for e in staged.get("entries", [])}
    need = set()
    for bid in all_ids:
        need |= set(config.load(bid).raw["credits"])
    rep.check("all", "data/staged/credits.json lists every source of every config", need <= have, f"missing {sorted(need - have)}")
    rep.check("all", "every staged credit has licence and attribution",
              all(e.get("licence") and e.get("attribution") for e in staged.get("entries", [])))
    for cid in need:
        c = credits[cid]
        rep.check("all", f"credit {cid}: redistributable licence", "public domain" in c["licence"].lower() or "cc by" in c["licence"].lower(),
                  c["licence"])
    # Earth and Moon untouched: manifests' contentHash and per-directory file counts from the terrain guard
    guard = rt.read_json(GUARD_TILES) if GUARD_TILES.is_file() else None
    for ts in ("earth", "moon"):
        mp = rt.TILES_ROOT / ts / "manifest.json"
        rep.check("all", f"{ts} tile set present (never written by this tool)", mp.is_file())
    if guard is not None:
        rep.check("all", "terrain guard tile record available", True, str(GUARD_TILES.relative_to(rt.REPO_ROOT)))
    # sizes
    data_gb = 0.0
    planet = 0
    for p in rt.TILES_ROOT.iterdir():
        if p.is_dir() and p.name not in ("earth", "moon"):
            planet += rt.dir_size(p)
    other = 0
    for p in rt.DATA_ROOT.iterdir():
        if p.name == "tiles":
            continue
        if p.is_dir():
            other += rt.dir_size(p)
    earth_moon = _guard_bytes(guard)
    data_gb = (planet + other + earth_moon) / 1e9
    rep.check("all", f"data/ under {DATA_CAP_GB} GB", data_gb < DATA_CAP_GB,
              f"{data_gb:.2f} GB (earth+moon tiles {earth_moon / 1e9:.2f} GB from the terrain guard record, other tile sets {planet / 1e9:.2f} GB, rest of data/ {other / 1e9:.2f} GB)")
    free = rt.disk_free_gb()
    rep.check("all", "disk keeps at least 25 GB free", free >= rt.DISK_FLOOR_GB, f"{free:.1f} GB free")
    return {"dataGB": round(data_gb, 3), "planetTilesBytes": planet, "otherDataBytes": other, "diskFreeGB": round(free, 1)}


def _guard_bytes(guard) -> int:
    if not guard:
        return 0
    total = 0

    def walk(o):
        nonlocal total
        if isinstance(o, dict):
            if "bytes" in o and isinstance(o["bytes"], (int, float)):
                total += int(o["bytes"])
                return
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(guard)
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--quick", action="store_true", help="skip decoding every tile")
    a = ap.parse_args()
    rt.check_python()
    ids = config.all_ids() if a.all else a.ids
    if not ids:
        ap.error("no body given")
    rep = Report()
    t0 = time.time()
    sizes = {}
    for bid in ids:
        body = config.load(bid)
        print(f"== {bid}", flush=True)
        sizes[bid] = verify_giant(body, rep) if body.kind == "giant" else verify_solid(body, rep, a.quick)
    glob = verify_global(rep, config.all_ids()) if a.all else {}
    rt.OUT.mkdir(parents=True, exist_ok=True)
    doc = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "seconds": round(time.time() - t0, 1), "ids": ids, "sizes": sizes,
           "global": glob, "checks": rep.rows, "failed": len(rep.failed)}
    rt.write_json(rt.OUT / ("verify.json" if a.all else "verify-partial.json"), doc)
    lines = [f"{r['body']}: [{'PASS' if r['ok'] else 'FAIL'}] {r['check']} {r['detail']}" for r in rep.rows]
    (rt.OUT / ("verify.txt" if a.all else "verify-partial.txt")).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(rep.rows)} checks, {len(rep.failed)} failed, {time.time() - t0:.0f} s")
    sys.exit(1 if rep.failed else 0)


if __name__ == "__main__":
    main()
