"""Planet bake driver: one body (or all) from its config, resumable step by step.

  python -I tools/bake/planet/bake.py <id> [<id> ...] | --all | --kind solid|giant
        [--steps fetch,prepare,procedural,height,albedo,manifest] [--record-checksums] [--force]
  python -I tools/bake/planet/bake.py --credits          write data/staged/credits.json from every config
  python -I tools/bake/planet/bake.py <id> --clean       delete the body's downloads and intermediates

Run it through the machine's gate (docs/PACKAGE_RULES.md 13a):
  node tools/dev/heavy.mjs --class=bake --label=planet -- data\\cache\\earth\\venv\\Scripts\\python.exe -I tools/bake/planet/bake.py mars

Each step records a fingerprint (config + code version) in data/cache/planets/<id>/work/state.json; a
finished step with the same fingerprint is skipped, so an interrupted bake resumes where it stopped.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from common import layout  # noqa: E402
from planet import albedo, config, fetch, giants, heights, procedural, rt, source  # noqa: E402

# Bump when the output of a step changes for the same config.
CODE_VERSION = {"prepare": 1, "procedural": 1, "height": 1, "albedo": 2, "manifest": 2}
SOLID_STEPS = ("fetch", "prepare", "procedural", "height", "albedo", "manifest")


def fingerprint(body: config.Body, step: str, with_landmarks: bool = False) -> str:
    """What a step's output depends on: the config (its landmark tests excepted: they only read the tiles), the
    step's code version and, for the procedural relief and the manifest, the resolved amplification."""
    h = hashlib.sha256()
    raw = body.raw if with_landmarks else {k: v for k, v in body.raw.items() if k != "landmarks"}
    h.update(json.dumps(raw, sort_keys=True).encode("utf-8"))
    h.update(f"{step}:{CODE_VERSION.get(step, 1)}".encode("ascii"))
    if step in ("procedural", "manifest"):
        h.update(json.dumps(procedural.resolved_amplification(body), sort_keys=True).encode("utf-8"))
    return h.hexdigest()[:16]


def step_done(body: config.Body, step: str) -> bool:
    """Done with the current fingerprint; a state written before landmarks left the fingerprint (it then
    matches the old form on the same config) is accepted and rewritten."""
    fp = fingerprint(body, step)
    if rt.is_done(body.id, step, fp):
        return True
    if rt.is_done(body.id, step, fingerprint(body, step, with_landmarks=True)):
        st = rt.load_state(body.id)
        st[step]["fingerprint"] = fp
        rt.write_json(rt.state_path(body.id), st)
        return True
    return False


def source_keys(body: config.Body, steps: list[str] | None = None) -> list[str]:
    """Sources the given steps read (all when steps is None): the height step its DEM, the albedo step its
    luminance and colour maps. Lets a body with big sources be baked in passes that each hold only theirs."""
    if steps is None:
        return sorted(body.raw["sources"])
    keys = set()
    if "height" in steps and body.height["dem"]:
        keys.add(body.height["dem"]["source"])
    if "albedo" in steps:
        keys |= {k for k in (body.albedo["source"], body.albedo["colourSource"]) if k}
    return sorted(keys)


def step_fetch(body: config.Body, record: bool, steps: list[str] | None = None) -> None:
    for key in source_keys(body, steps):
        if source.is_prepared(body, key):
            continue
        fetch.ensure(body, key, record=record)


def step_prepare(body: config.Body, steps: list[str] | None = None) -> None:
    for key in source_keys(body, steps):
        if source.is_prepared(body, key):
            continue
        t0 = time.time()
        meta = source.prepare(body, key, fetch.local_path(body, key))
        if body.source(key).get("decimate", 1) > 1:
            rt.remove_tree(rt.dl_dir(body.id, key))
            rt.log(f"{body.id}: deleted the full-resolution {key} download (decimated copy written)")
        rt.log(f"{body.id}: prepared {key} in {time.time() - t0:.0f} s (valid {meta.get('validFraction', 1.0):.4f})")


def credit_lines(body: config.Body, keys) -> list[str]:
    credits = config.load_credits()
    out = []
    for k in keys:
        c = credits[body.source(k)["credit"]]
        line = f"{c['title']} ({c['author']}; {c['licence']})"
        if line not in out:
            out.append(line)
    return out


def step_manifest(body: config.Body, hstats: dict, astats: dict) -> Path:
    h_src = [body.height["dem"]["source"]] if body.height["dem"] else []
    a_src = [k for k in (body.albedo["source"], body.albedo["colourSource"]) if k]
    h_lines = credit_lines(body, h_src) or [f"{body.raw['radii']['source']} (reference surface)"]
    if body.height["craters"]:
        h_lines.append("procedural crater population of the body's amplification model (no global DEM exists)")
    a_lines = credit_lines(body, a_src) or ["procedural: mean albedo and the crater population of the body's amplification model (no global map exists)"]
    hl = heights.layer(body, hstats, h_lines)
    hl["build"] = albedo.build_hash(body.id, "height", "hgt", int(body.height["maxLevel"]))
    al = albedo.layer(body, astats, a_lines)
    al["build"] = albedo.build_hash(body.id, "albedo", "webp", int(body.albedo["maxLevel"]))
    img = albedo.lowres(body)
    buf = io.BytesIO()
    Image.fromarray(img, "RGB").save(buf, "PNG", optimize=True)
    layout.write_atomic(rt.tileset_dir(body.id) / "globals" / "albedo-lowres.png", buf.getvalue())
    credits = config.load_credits()
    m = {
        "formatVersion": 1, "tileset": body.id, "radius": body.radius, "mapping": "gnomonic-cube",
        "layers": {"height": hl, "albedo": al},
        "globals": {"albedoLowRes": {"path": "globals/albedo-lowres.png", "width": img.shape[1], "height": img.shape[0],
                                     "channels": ["r", "g", "b"], "format": "png"}},
        "residentHeightLevel": int(body.height["residentLevel"]),
        "attribution": [credits[c]["attribution"] for c in body.raw["credits"]],
        "body": {"name": body.raw["name"], "radii": {k: body.raw["radii"][k] for k in ("mean", "a", "b", "c")},
                 "reference": body.height["reference"], "amplification": procedural.resolved_amplification(body),
                 "bakeConfig": f"tools/bake/planet/bodies/{body.id}.json"},
    }
    return layout.write_manifest(m)


def bake_solid(body: config.Body, steps: list[str], record: bool, force: bool) -> None:
    rt.work_dir(body.id).mkdir(parents=True, exist_ok=True)
    t_all = time.time()
    compute = [s for s in steps if s not in ("fetch", "prepare")]
    pending = [s for s in compute if force or not step_done(body, s)]
    # sources: those the pending compute steps read (all of them for an explicit fetch/prepare-only run)
    need = pending if compute else None
    if "fetch" in steps or pending:
        step_fetch(body, record, need)
    if "prepare" in steps or pending:
        step_prepare(body, need)
    for step in compute:
        fp = fingerprint(body, step)
        if step not in pending:
            rt.log(f"{body.id}: {step} already done")
            continue
        t0 = time.time()
        info: dict = {}
        if step == "procedural":
            if body.height["craters"] is None:
                continue
            info = procedural.run(body)
        elif step == "height":
            s = heights.bake(body)
            info = {k: (float(v) if isinstance(v, (float, np.floating)) else v) for k, v in s.items()}
        elif step == "albedo":
            info = albedo.bake(body)
        elif step == "manifest":
            st = rt.load_state(body.id)
            path = step_manifest(body, st["height"], st["albedo"])
            info = {"manifest": str(path)}
        info["seconds"] = round(time.time() - t0, 1)
        rt.mark_done(body.id, step, fp, info)
        rt.log(f"{body.id}: {step} done in {info['seconds']} s")
    rt.log(f"{body.id}: bake finished in {time.time() - t_all:.0f} s; tile set {rt.dir_size(rt.tileset_dir(body.id)) / 1e6:.1f} MB")


def write_credits() -> Path:
    credits = config.load_credits()
    by_id: dict = {}
    for bid in config.all_ids():
        body = config.load(bid)
        for c in body.raw["credits"]:
            by_id.setdefault(c, []).append(body.raw["name"])
    entries = []
    for cid in sorted(by_id):
        e = credits[cid]
        entries.append({"id": cid, **e, "bodies": sorted(set(by_id[cid]))})
    unused = sorted(set(credits) - set(by_id))
    if unused:
        raise ValueError(f"credits.json has entries no body uses: {unused}")
    doc = {"formatVersion": 1, "generatedBy": "tools/bake/planet/bake.py --credits",
           "note": "Every source of the simple bodies' tile sets and the giants' global maps (planet-bake). Merged into data/defs/visuals/credits.json at activation; rendered by the Credits screen.",
           "entries": entries}
    rt.write_json(rt.STAGED_CREDITS, doc)
    return rt.STAGED_CREDITS


def release(body: config.Body) -> None:
    """Drop this process' memory maps of the body's prepared sources (Windows refuses to delete mapped files)."""
    import gc
    for cache in (albedo._RASTER, heights._RASTER):
        for k in [k for k in cache if k[0] == body.id]:
            del cache[k]
    albedo._GAIN.pop(body.id, None)
    albedo._LOWF.pop(body.id, None)
    gc.collect()


def clean(body: config.Body) -> None:
    release(body)
    n = fetch.delete_downloads(body)
    w = rt.work_dir(body.id)
    m = rt.dir_size(w) if w.exists() else 0
    # keep the state file (resume marks) and nothing else
    st = rt.load_state(body.id)
    rt.remove_tree(w)
    if st:
        w.mkdir(parents=True, exist_ok=True)
        rt.write_json(rt.state_path(body.id), st)
    rt.log(f"{body.id}: deleted {n / 1e6:.1f} MB of downloads and {m / 1e6:.1f} MB of intermediates")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ids", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--kind", choices=("solid", "giant"))
    ap.add_argument("--steps", default=None)
    ap.add_argument("--record-checksums", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--credits", action="store_true")
    ap.add_argument("--clean", action="store_true")
    ap.add_argument("--keep-going", action="store_true", help="bake the remaining bodies when one fails (exit 1 at the end)")
    ap.add_argument("--clean-after", action="store_true",
                    help="delete a body's downloads and intermediates as soon as its bake has finished (disk floor)")
    a = ap.parse_args()
    rt.check_python()
    rt.below_normal_priority()
    if a.credits:
        rt.log(f"wrote {write_credits()}")
        return
    ids = config.all_ids(a.kind) if (a.all or a.kind) else a.ids
    if not ids:
        ap.error("no body given")
    failed = []
    for bid in ids:
        body = config.load(bid)
        if a.clean:
            clean(body)
            continue
        try:
            if body.kind == "giant":
                giants.bake(body, record=a.record_checksums)
                continue
            steps = a.steps.split(",") if a.steps else list(SOLID_STEPS)
            bad = [s for s in steps if s not in SOLID_STEPS]
            if bad:
                ap.error(f"unknown steps {bad}")
            bake_solid(body, steps, a.record_checksums, a.force)
            if a.clean_after:
                clean(body)
        except Exception:
            if not a.keep_going:
                raise
            import traceback
            traceback.print_exc()
            failed.append(bid)
            rt.log(f"{bid}: FAILED (continuing with the next body)")
    if failed:
        rt.log(f"failed: {failed}")
        sys.exit(1)


if __name__ == "__main__":
    main()
