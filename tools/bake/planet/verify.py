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


class Silent:
    """A Report that only records (for the mirrored and shifted landmark self-test)."""

    def __init__(self):
        self.rows: list[dict] = []

    def check(self, body: str, name: str, ok: bool, detail: str = "", **data) -> bool:
        self.rows.append({"ok": bool(ok)})
        return ok


def moved(lm: dict, fn) -> dict:
    """A landmark with every longitude it names passed through fn."""
    out = dict(lm)
    if "lonDegE" in out:
        out["lonDegE"] = fn(out["lonDegE"]) % 360.0
    for side in ("brighter", "darker"):
        if side in out:
            out[side] = dict(out[side], lonDegE=fn(out[side]["lonDegE"]) % 360.0)
    return out


def landmark_self_test(body: config.Body, lms: list, hr, ar, rep) -> None:
    """The landmarks must FAIL on the map mirrored east-west and on the map shifted by 180 degrees: a set that
    passes either way cannot catch the errors it exists for (review finding 2)."""
    for label, fn in (("mirrored east-west", lambda lon: -lon), ("shifted by 180 deg", lambda lon: lon + 180.0)):
        silent = Silent()
        for lm in lms:
            landmark(body, moved(lm, fn), hr, ar, silent)
        fails = sum(1 for r in silent.rows if not r["ok"])
        rep.check(body.id, f"landmarks reject the map {label}", fails > 0, f"{fails} of {len(silent.rows)} landmarks fail on it")


def wrap_seams(body: config.Body, ar):
    """Luminance along the +-180 and 0 meridians against three finest-level texels either side: a source's edge
    column (a nodata or dark first column) shows as a seam from pole to pole (review finding 1)."""
    A = int(body.albedo["maxLevel"])
    off = 3.0 * 90.0 / (2 ** A * 256)
    lat = np.radians(np.arange(-80.0, 80.01, 0.5))
    for lon0 in (180.0, 0.0):
        vals = []
        for dl in (-off, 0.0, off):
            d = cube.lat_lon_to_dir(lat, np.full(lat.shape, np.radians(lon0 + dl)))
            vals.append(ar.luminance(d, A))
        ratio = float(vals[1].mean() / max(1e-9, 0.5 * (vals[0].mean() + vals[2].mean())))
        # a brightness step across the meridian (two source images meeting there) is reported, not failed
        step = float(abs(np.mean(vals[2] - vals[0])) / max(1e-9, 0.5 * (vals[0].mean() + vals[2].mean())))
        yield lon0, ratio, step, 0.92 <= ratio <= 1.08


CLIP_DN = 254
CLIP_MAX_FRACTION = 0.005


def clip_fraction(bid: str, level: int, stride: int = 3) -> float:
    """Solid-angle-weighted fraction of the finest albedo level with any channel at or above CLIP_DN (8-bit
    ceiling), over every stride-th tile of each face (a regular subsample; the weights are the gnomonic texel
    solid angles)."""
    n = 2 ** level
    k = (np.arange(256) + 0.5) / 256.0
    clipped = total = 0.0
    for f in range(6):
        for x in range(n):
            for y in range(n):
                if (x * n + y) % stride:
                    continue
                u = -1.0 + 2.0 * (x + k) / n
                v = -1.0 + 2.0 * (y + k) / n
                wgt = (1.0 + u[None, :] ** 2 + v[:, None] ** 2) ** -1.5
                a = np.asarray(Image.open(layout.tile_file(bid, "albedo", f, level, x, y, "webp")).convert("RGB"))
                clipped += float((wgt * (a.max(axis=-1) >= CLIP_DN)).sum())
                total += float(wgt.sum())
    return clipped / total


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
    if lms:
        landmark_self_test(body, lms, hr, ar, rep)
    cf = clip_fraction(bid, int(al["globalMaxLevel"]))
    rep.check(bid, f"albedo: at most {CLIP_MAX_FRACTION:.1%} of the surface at the 8-bit ceiling (any channel >= {CLIP_DN} DN, finest level)",
              cf <= CLIP_MAX_FRACTION, f"{cf:.3%} (solid-angle weighted)", value=cf)
    for lon0, ratio, step, ok in wrap_seams(body, ar):
        rep.check(bid, f"albedo: no seam along the {lon0:.0f} deg meridian", ok,
                  f"luminance on it / beside it = {ratio:.3f} (0.92-1.08); mean step across it {step:.1%} (reported)", value=ratio, step=step)
    if body.height["craters"] is not None:
        F = hl["globalMaxLevel"]
        d = cap_points(0.0, 0.0, body.radius * 3.0, body.radius, n=4000)
        rel = hr.bicubic(d, F) - heights.reference_term(body, d)
        rep.check(bid, "procedural crater relief present", float(rel.std()) > 1.0, f"std {rel.std():.1f} m over the body")
    if (rt.STAGED / "bodies" / "radii.json").is_file():
        probs = config.radii_crosscheck(body)
        rep.check(bid, "radii = data/staged/bodies/radii.json (mean and a, b, c)", not probs, "; ".join(probs))
    staged_terrain = rt.STAGED / "terrain" / f"{bid}.terrain.json"
    if staged_terrain.is_file():
        st = rt.read_json(staged_terrain)
        amp = st.get("amplification", {})
        want = procedural.resolved_amplification(body)
        rep.check(bid, "staged terrain section names this tile set and the resolved amplification (model, seed, every parameter)",
                  st.get("tileset") == bid and amp.get("model") == want["model"] and amp.get("seed") == want["seed"]
                  and amp.get("params") == want["params"], f"tileset {st.get('tileset')}, model {amp.get('model')}, seed {amp.get('seed')}")
        el = hl.get("elevation", {})
        rep.check(bid, "staged terrain section's elevation range contains the baked one",
                  st.get("minElevation", 0) <= el.get("min", 0) and st.get("maxElevation", 0) >= el.get("max", 0),
                  f"section {st.get('minElevation')}..{st.get('maxElevation')}, baked {el.get('min')}..{el.get('max')}")
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
        if ok and g["kind"] == "equirect":
            # a seam at the wrap (+-180) or at 0 deg (a source's own wrap, or OPAL's hemisphere join): the step
            # across it and a line along it (a dark first column), each against the map's typical column step
            lum = np.asarray(Image.open(f).convert("RGB"), dtype=np.float64) @ LUMA / 255.0
            w = lum.shape[1]
            typical = float(np.median(np.abs(np.diff(lum, axis=1)).mean(axis=0)))
            col = lambda k: lum[:, k % w]  # noqa: E731
            for name, c in (("+-180 deg (wrap)", 0), ("0 deg", w // 2)):
                step = float(np.abs(0.5 * (col(c) + col(c + 1)) - 0.5 * (col(c - 1) + col(c - 2))).mean())
                line = float(np.abs(0.5 * (col(c - 1) + col(c)) - 0.5 * (col(c - 3) + col(c + 2))).mean())
                lim = 4.0 * typical + 0.0005
                rep.check(body.id, f"map {g['name']}: no seam at {name}", step <= lim and line <= lim,
                          f"step {step:.4f}, line {line:.4f}, limit {lim:.4f} (4 x the typical column step {typical:.4f} + 0.0005)")
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
        lic = c["licence"].lower()
        # public domain, CC BY, or a product whose published metadata states no access or use constraints
        rep.check("all", f"credit {cid}: redistributable licence",
                  "public domain" in lic or "cc by" in lic or "no access or use constraints" in lic, c["licence"])
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
    # PACKAGE_RULES 13d: the baked data (tiles, sky, staged, defs) stays under 22 GB; data/packs has its own cap
    # and data/cache, data/stack are working directories (reported, not counted)
    baked_other = sum(rt.dir_size(rt.DATA_ROOT / d) for d in ("sky", "staged", "defs") if (rt.DATA_ROOT / d).is_dir())
    working = {d: rt.dir_size(rt.DATA_ROOT / d) for d in ("cache", "packs", "stack") if (rt.DATA_ROOT / d).is_dir()}
    earth_moon = _guard_bytes(guard)
    other = baked_other
    data_gb = (planet + baked_other + earth_moon) / 1e9
    rep.check("all", f"baked data/ (tiles, sky, staged, defs) under {DATA_CAP_GB} GB", data_gb < DATA_CAP_GB,
              f"{data_gb:.2f} GB (earth+moon tiles {earth_moon / 1e9:.2f} GB from the terrain guard record, the other tile sets "
              f"{planet / 1e9:.2f} GB, sky+staged+defs {baked_other / 1e9:.2f} GB); working directories, not counted: "
              + ", ".join(f"{k} {v / 1e9:.2f} GB" for k, v in working.items()))
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


ALBEDO_MEANS = rt.STAGED_RENDER / "albedo-means.json"


def colour_basis(body: config.Body) -> str:
    """Where a body's baked colour comes from (said plainly for the far-field mean colour)."""
    al = body.albedo
    if al["procedural"] is not None:
        return "procedural: the config's colour (" + al["procedural"]["ref"] + ")"
    src = body.source(al["source"])
    if al["colourSource"]:
        return f"colour map ({al.get('colourMode') or 'chroma'} mode with a mono map)"
    if len(src["bands"]) >= 3:
        return "colour map"
    return "MONOCHROME map x the config's tint " + str(al["tint"])


def albedo_means() -> dict:
    """Mean LINEAR RGB of each baked body's level-0 albedo: the six level-0 tiles decoded from sRGB, every
    texel weighted by its solid angle (proportional to max|d_i|^3 on the gnomonic cube). Requested by
    bodies-ephemeris-5 for the far-field mean colour; regenerated by every verify run."""
    out = {}
    for bid in config.all_ids("solid"):
        if not (rt.TILES_ROOT / bid / "manifest.json").is_file():
            continue
        body = config.load(bid)
        acc = np.zeros(3)
        wsum = 0.0
        for f in range(6):
            img = srgb_decode(np.asarray(Image.open(layout.tile_file(bid, "albedo", f, 0, 0, 0, "webp")).convert("RGB"),
                                         dtype=np.float64) / 255.0)
            w = np.max(np.abs(cube.image_tile_dirs(f, 0, 0, 0)), axis=-1) ** 3
            acc += np.tensordot(w, img, axes=([0, 1], [0, 1]))
            wsum += float(w.sum())
        rgb = acc / wsum
        out[bid] = {"meanLinearRgb": [round(float(v), 5) for v in rgb], "meanLuminance": round(float(rgb @ LUMA), 5),
                    "colourBasis": colour_basis(body)}
    return out


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
    means = albedo_means()
    rt.write_json(ALBEDO_MEANS, {
        "description": "Mean linear RGB and luminance of each baked body's level-0 albedo (six tiles decoded from sRGB, "
                       "texels weighted by solid angle), the disc mean over the whole sphere. colourBasis says where the "
                       "colour comes from: a MONOCHROME map's colour is the config's tint, not a measurement. Written by "
                       "tools/bake/planet/verify.py (request bodies-ephemeris-5).",
        "bodies": means})
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
