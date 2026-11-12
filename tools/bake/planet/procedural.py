"""Driver of procedural.ts: the crater relief and freshness of bodies with no global map.

The run-time amplification definition of a body is its model's parameter file
(data/defs/terrain/<model>.amplification.json) with the config's `amplification.params` overrides and seed
(`resolved_amplification`); the body's terrain section (bodies-ephemeris) must carry exactly this, which
verify.py checks once data/staged/terrain/<id>.terrain.json exists.
"""
from __future__ import annotations

import os
import subprocess
import time

from planet import config, rt

DEFS_TERRAIN = rt.DATA_ROOT / "defs" / "terrain"


def resolved_amplification(body: config.Body) -> dict:
    a = body.raw["amplification"]
    base = rt.read_json(DEFS_TERRAIN / f"{a['model']}.amplification.json")
    if base["model"] != a["model"]:
        raise ValueError(f"{a['model']}.amplification.json names model {base['model']}")
    unknown = sorted(set(a["params"]) - set(base["params"]))
    if unknown:
        raise ValueError(f"{body.id}: amplification overrides {unknown} are not parameters of {a['model']}")
    return {"model": a["model"], "seed": a["seed"], "params": {**base["params"], **a["params"]}}


def run(body: config.Body) -> dict:
    """Write work/proc/{h,a}/*.f32 for every finest-level height and albedo tile. Resumable per tile."""
    F = int(body.height["maxLevel"])
    A = int(body.albedo["maxLevel"])
    out = rt.work_dir(body.id) / "proc"
    out.mkdir(parents=True, exist_ok=True)
    keys_h = [[f, x, y] for f in range(6) for y in range(2 ** F) for x in range(2 ** F)
              if not (out / "h" / f"{f}_{x}_{y}.f32").is_file()]
    keys_a = [[f, x, y] for f in range(6) for y in range(2 ** A) for x in range(2 ** A)
              if not (out / "a" / f"{f}_{x}_{y}.f32").is_file()]
    if not keys_h and not keys_a:
        return {"tiles": 0}
    cr = body.height["craters"]
    job = {"radius": body.radius, "heightLevel": F, "albedoLevel": A, "amplification": resolved_amplification(body),
           "maxDiameter": cr["maxDiameterRadii"] * body.radius,
           "named": [{k: c[k] for k in ("name", "latDeg", "lonDegE", "diameterKm", "depthKm", "rimKm")} for c in cr["named"]],
           "outDir": str(out), "height": keys_h, "albedo": keys_a,
           "complex": ({k: cr["complex"][k] for k in ("transitionDiameterKm", "depthKm", "exponent")} if cr.get("complex") else None)}
    job_path = out / "job.json"
    rt.write_json(job_path, job)
    parts = max(1, min(rt.MAX_WORKERS, (len(keys_h) + len(keys_a) + 15) // 16))
    t0 = time.time()
    script = str(rt.REPO_ROOT / "tools" / "bake" / "planet" / "procedural.ts")
    env = dict(os.environ)
    procs = [subprocess.Popen(["npx", "tsx", script, str(job_path), str(i), str(parts)], cwd=str(rt.REPO_ROOT),
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, shell=(os.name == "nt"), env=env)
             for i in range(parts)]
    failed = []
    for i, p in enumerate(procs):
        text = p.communicate()[0].decode("utf-8", "replace").strip()
        rt.log(f"{body.id}: {text.splitlines()[-1] if text else '(no output)'}")
        if p.returncode != 0:
            failed.append((i, text[-2000:]))
    if failed:
        raise RuntimeError(f"{body.id}: procedural parts failed: {failed}")
    return {"tiles": len(keys_h) + len(keys_a), "seconds": time.time() - t0, "parts": parts}
