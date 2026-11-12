"""data/tiles/earth/manifest.json: written through layout.merge_layer from what has actually been baked.

A layer enters the manifest once its global levels are complete (marker state/layer-<name>-global.done);
a region's coverage rectangles are added once that region's part of the layer is complete
(state/layer-<name>-<region>.done). Globals enter once their files exist.
"""
from __future__ import annotations

import hashlib
import json

from common import layout
from earth import paths, region as regmod

LAYERS = ["height", "albedo", "watermask", "night", "landcover"]
REGIONAL_LAYERS = ["height", "albedo", "watermask", "landcover"]

ATTRIBUTION = {
    "height": ["Elevation: NOAA NCEI ETOPO 2022 (public domain)",
               "Regional elevation: AWS Terrain Tiles / Mapzen Terrarium (USGS 3DEP)"],
    "albedo": ["Imagery: NASA Earth Observatory Blue Marble Next Generation (Reto Stockli, NASA GSFC)",
               "Regional imagery: Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH "
               "(Contains modified Copernicus Sentinel data 2020-2025), CC BY-NC-SA 4.0"],
    "watermask": ["Water: MODIS MOD44W water mask via NASA GIBS", "Regional water and land cover: ESA WorldCover 2021 v200, CC BY 4.0"],
    "night": ["Night lights: NASA Earth Observatory Black Marble 2016 (Suomi NPP VIIRS)"],
    "landcover": ["Regional land cover: ESA WorldCover 2021 v200 (ESA WorldCover project / Contains modified "
                  "Copernicus Sentinel data (2021) processed by ESA WorldCover consortium), CC BY 4.0"],
    "clouds": ["Clouds: global cloud composite by Matt Eason (clouds.matteason.co.uk), derived from EUMETSAT/NOAA "
               "geostationary imagery; licence unstated, bake-time snapshot, swappable",
               "Polar clouds: Solar System Scope 8k cloud map (solarsystemscope.com, based on NASA imagery), CC BY 4.0"],
}


def marker(layer: str, scope: str):
    return paths.STATE / f"layer-{layer}-{scope}.done"


def mark(layer: str, scope: str, config_hash: str = "ok") -> None:
    marker(layer, scope).write_text(config_hash, encoding="utf-8")


def is_marked(layer: str, scope: str) -> bool:
    return marker(layer, scope).is_file()


def layer_status() -> dict[str, bool]:
    out = {f"{L} (global)": is_marked(L, "global") for L in LAYERS}
    for r in regmod.list_regions():
        for L in REGIONAL_LAYERS:
            out[f"{L} ({r})"] = is_marked(L, r)
    out["cloudCoverage"] = (paths.TILES / "globals" / "cloudCoverage.png").is_file()
    out["albedoLowRes"] = (paths.TILES / "globals" / "albedoLowRes.png").is_file()
    return out


def region_attribution(region: dict, layer: str | None = None) -> list[str]:
    """Attribution lines a region adds for its own sources (`sources.<layer>.attribution` in the region file),
    for one layer or for all of them."""
    out = []
    for name, src in region.get("sources", {}).items():
        if layer is None or name == layer:
            out += [a for a in src.get("attribution", []) if a not in out]
    return out


def layer_dict(layer: str, regions: list[dict]) -> dict:
    return _layer_dict(layer, regions)


def _layer_dict(layer: str, regions: list[dict]) -> dict:
    if layer == "height":
        from earth import heights
        return heights.layer_manifest(regions)
    if layer == "albedo":
        from earth import albedo
        return albedo.layer_manifest(regions)
    if layer == "watermask":
        from earth import watermask
        return watermask.layer_manifest(regions)
    if layer == "night":
        from earth import night
        return night.layer_manifest()
    if layer == "landcover":
        from earth import landcover
        return landcover.layer_manifest(regions)
    raise ValueError(layer)


def globals_dict() -> dict:
    g = {}
    if (paths.TILES / "globals" / "cloudCoverage.png").is_file():
        g["cloudCoverage"] = {"path": "globals/cloudCoverage.png", "width": 8192, "height": 4096,
                              "channels": ["coverage", "cloudTop"], "format": "png"}
    if (paths.TILES / "globals" / "albedoLowRes.png").is_file():
        g["albedoLowRes"] = {"path": "globals/albedoLowRes.png", "width": 1024, "height": 512,
                             "channels": ["r", "g", "b"], "format": "png"}
    return g


def build_hash(layer: str, scope: str | None = None, include: set[str] | frozenset = frozenset()) -> str:
    """Hash of the resumability records of a layer (unit markers hold the hash of the configuration they
    were baked with, plus the per-layer .cfg / .done markers). It changes whenever tiles of the layer are
    re-baked with a different configuration; stored as the layer's `build` field, it makes the manifest's
    contentHash (computed from the manifest body by layout.write_manifest) change too, as the contract's
    cache busting requires. Dependent steps put it into their own configuration so that they re-run when an
    input layer was re-baked. scope: None = all records, "global" = the global levels only, or a region id.
    With scope None the records of regions that are staged or half swapped (stage.py) are left out, except those
    in `include`: they are not part of the live tile set until the swap writes the manifest."""
    from earth import stage
    h = hashlib.sha256()
    prefix = f"{paths.TILESET}-"
    hidden = [r for r in stage.hidden_regions() if r not in include] if scope is None else []
    for p in sorted(paths.STATE.rglob("*")):
        rel = p.relative_to(paths.STATE).as_posix()
        top = rel.split("/")[0]
        if not p.is_file() or not (top.startswith(f"{layer}-") or top.startswith(f"layer-{layer}-")):
            continue
        if p.name == "accepted.json":                 # bake.py accept: no tile changed, the build stays
            continue
        if scope == "global" and f"-{prefix}" in top:
            continue
        if scope not in (None, "global") and f"-{scope}" not in top:
            continue
        if any(f"-{r}" in top for r in hidden):
            continue
        h.update(rel.encode("utf-8"))
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def unchanged(region_ids: list[str], layers: tuple = ("height", "watermask", "albedo", "landcover")) -> list[str]:
    """For a dry run: the regional layers whose manifest entry (coverage, sources, build hash, ...) a write would
    change. Empty: write_all would leave manifest.json byte-identical (same contentHash)."""
    live = layout.read_manifest(paths.TILESET)
    out = []
    for layer in layers:
        regs = [regmod.load(r) for r in region_ids if is_marked(layer, r)]
        entry = _layer_dict(layer, regs)
        entry["build"] = build_hash(layer)
        cur = live["layers"].get(layer, {})
        diff = [k for k, v in entry.items() if json.loads(json.dumps(v)) != cur.get(k)]
        if diff:
            out.append(f"{layer}: {', '.join(diff)}")
    return out


def write_all(region_ids: list[str], only: str | None = None) -> None:
    for layer in LAYERS:
        if only and layer != only:
            continue
        if not is_marked(layer, "global"):
            continue
        regs = [regmod.load(r) for r in region_ids if layer in REGIONAL_LAYERS and is_marked(layer, r)]
        attribution = list(ATTRIBUTION[layer])
        if layer == "watermask":
            attribution = attribution[:1] + (attribution[1:] if regs else [])
        for reg in regs:
            attribution += [a for a in region_attribution(reg, layer) if a not in attribution]
        entry = _layer_dict(layer, regs)
        entry["build"] = build_hash(layer)
        layout.merge_layer(paths.TILESET, paths.RADIUS, layer, entry,
                           attribution=attribution, resident_height_level=paths.RESIDENT_HEIGHT_LEVEL)
    g = globals_dict()
    if g and only is None:
        if (paths.TILES / "manifest.json").is_file():
            m = layout.read_manifest(paths.TILESET)
        else:
            m = {"formatVersion": 1, "tileset": paths.TILESET, "radius": paths.RADIUS, "mapping": "gnomonic-cube",
                 "layers": {}, "globals": {}, "residentHeightLevel": paths.RESIDENT_HEIGHT_LEVEL, "attribution": []}
        m["globals"].update(g)
        for a in (ATTRIBUTION["clouds"] if "cloudCoverage" in g else []):
            if a not in m["attribution"]:
                m["attribution"].append(a)
        layout.write_manifest(m)
