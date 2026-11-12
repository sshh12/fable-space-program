"""The highest level-0 mean albedo a body's map can hold under the calibration's ceiling rule (albedo.py:
at most 0.4 % of the surface within 4 DN of the 8-bit ceiling, highlights through the knee), for setting a
reachable `albedo.calibration.meanAlbedo`. Prepares the albedo sources if needed (run it through the bake
gate) and prints the calibration; `--clean` deletes the prepared sources afterwards.

  python -I tools/bake/planet/reach.py <id> [...] [--clean]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from planet import albedo, bake, config, fetch, rt, source  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ids", nargs="+")
    ap.add_argument("--clean", action="store_true")
    a = ap.parse_args()
    for bid in a.ids:
        body = config.load(bid)
        for key in bake.source_keys(body, ["albedo"]):
            if not source.is_prepared(body, key):
                if body.source(key).get("decimate", 1) > 1:
                    source.prepare_streamed(body, key)
                else:
                    fetch.ensure(body, key)
                    bake.step_prepare_one(body, key)
        c = albedo.calibration(body, recompute=True)
        print(f"{bid}: target {c['target']}, highest reachable mean {c['maxReachableMean']:.4f} (knee from "
              f"{c['maxReachableKnee']}); calibrated gain {c['gain']:.4f}, knee from {c['kneeStart']}, mean "
              f"{c['achievedSampled']:.4f}, within 4 DN of the ceiling {c['ceilingShareSampled']:.3%}", flush=True)
        if a.clean:
            bake.release(body)
            bake.clean(body)


if __name__ == "__main__":
    main()
