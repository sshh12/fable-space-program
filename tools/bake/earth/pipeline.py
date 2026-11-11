"""Step orchestration for bake.py (dependency order, manifest updates, cleanup)."""
from __future__ import annotations

from earth import paths, region as regmod
from earth.util import disk_report, log


def run(step: str, regions: list[str], region_given: bool = False) -> None:
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
    if step == "region":
        from earth import albedo, heights, landcover, watermask
        for r in regions:
            heights.bake_region(r)
            watermask.bake_region(r)
            albedo.bake_region(r)
            landcover.bake_region(r)
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
