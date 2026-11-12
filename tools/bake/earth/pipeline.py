"""Step orchestration for bake.py (dependency order, manifest updates, cleanup)."""
from __future__ import annotations

from earth import paths, region as regmod
from earth.util import disk_report, log


def run(step: str, regions: list[str], region_given: bool = False, args=None) -> None:
    if step in ("stage", "swap", "pads", "quality") and not region_given:
        raise ValueError(f"bake.py {step} needs --region")
    if step == "stage":
        # a new region baked away from the live tile set (stage.py); the manifest is not touched
        from earth import albedo, heights, landcover, stage, watermask
        from earth.util import dir_size
        for r in regions:
            stage.begin(r, replace=bool(getattr(args, "replace", False)))
            heights.bake_region(r)
            watermask.bake_region(r)
            albedo.bake_region(r)
            landcover.bake_region(r)
            b, n = dir_size(stage.tiles_root(r))
            log(f"stage {r}: {n} tiles, {b / 1e9:.2f} GB under {stage.tiles_root(r)}")
        return
    if step == "swap":
        from earth import stage
        for r in regions:
            log(f"swap {r}: {stage.swap(r)}")
        return
    if step == "pads":
        from earth import padresolve
        for r in regions:
            padresolve.run(r, args)
        return
    if step == "quality":
        from earth import groundquality
        for r in regions:
            groundquality.run(r, args)
        return
    if step == "site":
        from earth import site
        for r in regions:
            site.resolve_site(r)
        return
    if step == "heights":
        from earth import heights
        heights.bake_global()
        for r in regions:
            heights.bake_region(r)
        _manifest("height", regions)
        return
    if step == "albedo":
        from earth import albedo
        albedo.bake_global()
        for r in regions:
            albedo.bake_region(r)
        _manifest("albedo", regions)
        return
    if step == "watermask":
        from earth import watermask
        watermask.bake_global()
        for r in regions:
            watermask.bake_region(r)
        _manifest("watermask", regions)
        return
    if step == "night":
        from earth import night
        night.bake_global()
        _manifest("night", regions)
        return
    if step == "landcover":
        from earth import landcover
        landcover.bake_global()
        for r in regions:
            landcover.bake_region(r)
        _manifest("landcover", regions)
        return
    if step == "clouds":
        from earth import clouds
        clouds.bake()
        _manifest(None, regions)
        return
    if step == "globals":
        from earth import clouds, globals_
        if clouds.OUT.is_file():         # the composite is a live service: only `clouds` takes a new snapshot
            log("globals: cloudCoverage.png kept (bake.py clouds takes a new snapshot)")
        else:
            clouds.bake()
        globals_.bake_albedo_lowres()
        _manifest(None, regions)
        return
    if step == "accept":
        # lead-4: record the present configuration for every unit of --region baked with an earlier one, without
        # baking; refuses unless every tile of the region is present in the live tile set
        if not region_given or len(regions) != 1:
            raise ValueError("bake.py accept needs --region <id>")
        import os
        from earth import stage
        missing = [p for p in sorted(stage._region_paths(regions[0])) if not (paths.TILES / p).is_file()]
        if missing:
            raise RuntimeError(f"accept: {len(missing)} tiles of {regions[0]} are missing (e.g. {missing[0]}): refusing")
        os.environ["EARTH_UNIT_MODE"], os.environ["EARTH_ACCEPT_REGION"] = "accept", regions[0]
        try:
            run("region", regions, region_given=True, args=args)
        finally:
            os.environ.pop("EARTH_UNIT_MODE", None)
            os.environ.pop("EARTH_ACCEPT_REGION", None)
        return
    if step == "region":
        import os
        from earth import albedo, heights, landcover, manifest, watermask
        from earth.util import DRY_TODO, unit_mode
        if args is not None and getattr(args, "dry_run", False):
            os.environ["EARTH_UNIT_MODE"] = "dry"
        for r in regions:
            heights.bake_region(r)
            watermask.bake_region(r)
            albedo.bake_region(r)
            landcover.bake_region(r)
        if unit_mode() is not None:              # accept / dry run: the manifest is not written, only compared
            diff = manifest.unchanged(regmod.list_regions())
            log(f"region ({unit_mode()}): units that would run: {DRY_TODO or 'none'}; manifest entries a write would "
                f"change: {diff or 'none'} (manifest.json and its contentHash stay as they are)")
            if unit_mode() == "dry" and (DRY_TODO or diff):
                raise RuntimeError("dry run: the region step would re-bake or rewrite the manifest")
            return
        for layer in ("height", "watermask", "albedo", "landcover"):
            _manifest(layer, regions if region_given else regmod.list_regions())
        return
    if step == "all":
        for s in ("heights", "watermask", "albedo", "night", "landcover", "globals"):
            run(s, regions)
            log(disk_report())
        run("manifest", regions)
        run("contact", regions)
        run("recovery", regions)
        import subprocess
        import sys
        rc = subprocess.call([sys.executable, "-I", str(paths.HERE / "verify.py")])
        if rc == 0:
            run("cleanup", regions)
        else:
            log("verify.py failed: raw downloads are kept for the fix-up re-run (cleanup skipped)")
        return
    if step == "manifest":
        from earth import manifest
        manifest.write_all(regmod.list_regions())
        return
    if step == "contact":
        from earth import contact
        if region_given:
            contact.write_regions(regions)          # the regional sheets of the named region only (staged or live)
        else:
            contact.write_all(regmod.list_regions())
        return
    if step == "recovery":
        from earth import recovery
        recovery.report(regmod.list_regions())
        return
    if step == "cleanup":
        from earth import cleanup
        cleanup.run()
        return
    if step == "despike":
        import json
        from earth import heights
        out = paths.REPO / "out" / "bake" / "earth"
        out.mkdir(parents=True, exist_ok=True)
        for r in regions:
            report = heights.repair_spikes(r)
            (out / f"despike-{r}.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
            log(f"despike {r}: {report['vertices']} vertices at level {report['finest']}; tiles changed per level {report['tiles']}")
        _manifest("height", regions if region_given else regmod.list_regions())
        return
    raise ValueError(step)


def _manifest(layer: str | None, regions: list[str]) -> None:
    from earth import manifest
    manifest.write_all(regmod.list_regions(), only=layer)


def status() -> None:
    from earth import manifest
    log(disk_report())
    for name, ok in manifest.layer_status().items():
        log(f"{name}: {'baked' if ok else 'not baked'}")
    log(f"tiles at {paths.TILES}")
