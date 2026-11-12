"""Body configs (tools/bake/planet/bodies/<id>.json): loading, strict validation, derived values.

A config is pure data; the bake is a pure function of it plus the downloaded sources. Unknown keys are an
error, so a typo cannot silently change a bake. Schema (every key required unless marked optional):

  id, name                    tile set id (= body id) and display name
  kind                        "solid" (a tile set) | "giant" (global maps under data/staged/render only)
  radii                       { mean, a, b, c, source }: metres. a along +X (prime meridian), b along +Y, c along
                              +Z (spin axis). Mean = the datum sphere (manifest.radius, BodyDef.radius).
  credits                     ids into tools/bake/planet/credits.json
  sources                     { key: Source } (below); may be empty
  -- solid only --
  amplification               { model, seed, params }: the run-time model (registry key) and the overrides of
                              data/defs/terrain/<model>.amplification.json params this body uses
  height                      { maxLevel, preferredScale, residentLevel, reference, dem, craters }
                                reference: "ellipsoid" (the radii) | { "sphere": R } (a DEM's own datum)
                                dem: null | { source, scale, offset }   metres = DN * scale + offset
                                craters: null | { maxDiameterRadii, named: [...] } procedural relief from the
                                         body's amplification model (bodies with no DEM and no map)
  albedo                      { maxLevel, source, colourSource, transfer, tint, calibration, procedural }
  landmarks                   [ Landmark ]
  -- giant only --
  globals                     [ { name, source, width, height, channels, transfer } ]

Source: { url, bytes, md5, sha256, format: "geotiff" | "image", latitude: "planetocentric" | "planetographic",
          lonPositive: "east" | "west", lonLeftEdgeDeg, width, height, bands, nodata, credit }
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from planet import rt

AMPLIFICATION_MODELS = ("rocky-generic", "icy-generic")


class ConfigError(ValueError):
    pass


def _keys(obj: dict, where: str, required: tuple, optional: tuple = ()) -> None:
    if not isinstance(obj, dict):
        raise ConfigError(f"{where}: expected an object")
    missing = [k for k in required if k not in obj]
    extra = [k for k in obj if k not in required and k not in optional]
    if missing:
        raise ConfigError(f"{where}: missing {missing}")
    if extra:
        raise ConfigError(f"{where}: unknown keys {extra}")


def _num(v, where: str, lo: float | None = None, hi: float | None = None) -> float:
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        raise ConfigError(f"{where}: expected a number")
    if lo is not None and v < lo or hi is not None and v > hi:
        raise ConfigError(f"{where}: {v} outside [{lo}, {hi}]")
    return float(v)


SOURCE_KEYS = ("url", "bytes", "md5", "sha256", "format", "latitude", "lonPositive", "lonLeftEdgeDeg", "width",
               "height", "bands", "nodata", "credit")


SOURCE_OPTIONAL = ("registration", "table", "validLatDeg", "decimate")


def _check_source(key: str, s: dict, where: str) -> None:
    _keys(s, f"{where}.sources.{key}", SOURCE_KEYS, SOURCE_OPTIONAL)
    if s["format"] not in ("geotiff", "image", "fits", "table"):
        raise ConfigError(f"{where}.sources.{key}.format: geotiff | image | fits | table")
    if s.get("registration", "cell") not in ("cell", "point"):
        raise ConfigError(f"{where}.sources.{key}.registration: cell (pixel areas) | point (pixel centres on the edges)")
    if s["format"] == "table":
        _keys(s.get("table"), f"{where}.sources.{key}.table", ("radiusColumn", "tauColumn", "opaqueValue"))
    if s["latitude"] not in ("planetocentric", "planetographic"):
        raise ConfigError(f"{where}.sources.{key}.latitude: planetocentric | planetographic")
    if s["lonPositive"] not in ("east", "west"):
        raise ConfigError(f"{where}.sources.{key}.lonPositive: east | west")
    if not s["url"].startswith("https://"):
        raise ConfigError(f"{where}.sources.{key}.url must be https")
    if not isinstance(s["bands"], list) or not s["bands"] or not all(isinstance(b, int) and b >= 1 for b in s["bands"]):
        raise ConfigError(f"{where}.sources.{key}.bands: non-empty list of 1-based band numbers")
    if len(s["bands"]) not in (1, 3, 4):
        raise ConfigError(f"{where}.sources.{key}.bands: 1 (mono), 3 (RGB) or 4 (RGBA) bands")
    for k in ("width", "height", "bytes"):
        _num(s[k], f"{where}.sources.{key}.{k}", 1)
    _num(s["lonLeftEdgeDeg"], f"{where}.sources.{key}.lonLeftEdgeDeg", -360, 360)
    if s["md5"] is not None and (not isinstance(s["md5"], str) or len(s["md5"]) != 32):
        raise ConfigError(f"{where}.sources.{key}.md5: 32 hex digits or null (null: the provider publishes none; sha256 pins the file)")
    if s["sha256"] is not None and (not isinstance(s["sha256"], str) or len(s["sha256"]) != 64):
        raise ConfigError(f"{where}.sources.{key}.sha256: 64 hex digits or null (filled by --record-checksums)")


LANDMARK_KINDS = {
    # the DEM part of the baked height (height minus the reference-surface term) at a point
    "demHeight": ("name", "kind", "latDeg", "lonDegE", "expectM", "toleranceM", "ref"),
    # mean albedo luminance of a disc against the ring [r, 2r] around it
    "albedoContrast": ("name", "kind", "latDeg", "lonDegE", "radiusKm", "sense", "minRatio", "ref"),
    # mean albedo luminance of disc A against disc B
    "albedoCompare": ("name", "kind", "brighter", "darker", "minRatio", "ref"),
    # a procedural named crater: centre at least depthFraction * depth below the rim ring
    "craterDepth": ("name", "kind", "latDeg", "lonDegE", "diameterKm", "minDepthM", "ref"),
    # luminance standard deviation of a disc against the ring [r, 2r]: a crater or basin in a map that
    # carries the mosaic's shading (Phobos, Tethys, the high-pass-filtered Enceladus) where the mean is no help
    "albedoTexture": ("name", "kind", "latDeg", "lonDegE", "radiusKm", "minRatio", "ref"),
}


def _check_landmark(lm: dict, where: str) -> None:
    kind = lm.get("kind")
    if kind not in LANDMARK_KINDS:
        raise ConfigError(f"{where}: landmark kind must be one of {sorted(LANDMARK_KINDS)}")
    _keys(lm, where, LANDMARK_KINDS[kind])
    if kind == "albedoContrast" and lm["sense"] not in ("brighter", "darker"):
        raise ConfigError(f"{where}.sense: brighter | darker")
    if kind == "albedoCompare":
        for side in ("brighter", "darker"):
            _keys(lm[side], f"{where}.{side}", ("latDeg", "lonDegE", "radiusKm"))


@dataclass(frozen=True)
class Body:
    raw: dict
    path: Path

    @property
    def id(self) -> str:
        return self.raw["id"]

    @property
    def kind(self) -> str:
        return self.raw["kind"]

    @property
    def radius(self) -> float:
        return float(self.raw["radii"]["mean"])

    @property
    def abc(self) -> tuple[float, float, float]:
        r = self.raw["radii"]
        return float(r["a"]), float(r["b"]), float(r["c"])

    def source(self, key: str) -> dict:
        return self.raw["sources"][key]

    @property
    def height(self) -> dict:
        return self.raw["height"]

    @property
    def albedo(self) -> dict:
        return self.raw["albedo"]


def validate(raw: dict, where: str) -> None:
    kind = raw.get("kind")
    if kind == "solid":
        _keys(raw, where, ("id", "name", "kind", "radii", "credits", "sources", "amplification", "height", "albedo", "landmarks"))
    elif kind == "giant":
        _keys(raw, where, ("id", "name", "kind", "radii", "credits", "sources", "globals"))
    else:
        raise ConfigError(f"{where}.kind: solid | giant")
    if not isinstance(raw["id"], str) or not raw["id"].isidentifier() or raw["id"] != raw["id"].lower():
        raise ConfigError(f"{where}.id: lower-case identifier")
    if raw["id"] in rt.FORBIDDEN_TILESETS:
        raise ConfigError(f"{where}: Earth and the Moon are not baked by this tool")
    _keys(raw["radii"], f"{where}.radii", ("mean", "a", "b", "c", "source"))
    for k in ("mean", "a", "b", "c"):
        _num(raw["radii"][k], f"{where}.radii.{k}", 1000.0, 1e8)
    if not isinstance(raw["credits"], list) or not raw["credits"]:
        raise ConfigError(f"{where}.credits: non-empty list of credit ids")
    if not isinstance(raw["sources"], dict):
        raise ConfigError(f"{where}.sources: object")
    for key, s in raw["sources"].items():
        _check_source(key, s, where)
    used = set()
    if kind == "giant":
        for i, g in enumerate(raw["globals"]):
            gw = f"{where}.globals[{i}]"
            _keys(g, gw, ("name", "source", "kind", "width", "height", "channels", "format", "note"), ("innerKm", "outerKm", "albedoRegions"))
            if g["kind"] not in ("equirect", "radial"):
                raise ConfigError(f"{gw}.kind: equirect | radial")
            if g["kind"] == "radial":
                if "innerKm" not in g or "outerKm" not in g or "albedoRegions" not in g:
                    raise ConfigError(f"{gw}: a radial map needs innerKm, outerKm and albedoRegions")
                if raw["sources"][g["source"]]["format"] != "table":
                    raise ConfigError(f"{gw}: a radial map is made from a table source")
                for k, r in enumerate(g["albedoRegions"]):
                    _keys(r, f"{gw}.albedoRegions[{k}]", ("name", "innerKm", "outerKm", "albedo", "tint"))
            if g["format"] not in ("png", "webp"):
                raise ConfigError(f"{gw}.format: png | webp")
            used.add(g["source"])
    else:
        a = raw["amplification"]
        _keys(a, f"{where}.amplification", ("model", "seed", "params"))
        if a["model"] not in AMPLIFICATION_MODELS:
            raise ConfigError(f"{where}.amplification.model: one of {AMPLIFICATION_MODELS}")
        if not isinstance(a["seed"], int) or not 0 <= a["seed"] < 2 ** 32:
            raise ConfigError(f"{where}.amplification.seed: uint32")
        h = raw["height"]
        _keys(h, f"{where}.height", ("maxLevel", "preferredScale", "residentLevel", "reference", "dem", "craters"))
        _num(h["maxLevel"], f"{where}.height.maxLevel", 0, 5)
        _num(h["residentLevel"], f"{where}.height.residentLevel", 0, h["maxLevel"])
        if h["reference"] != "ellipsoid":
            _keys(h["reference"], f"{where}.height.reference", ("sphere",))
        if h["dem"] is not None:
            _keys(h["dem"], f"{where}.height.dem", ("source", "scale", "offset"))
            used.add(h["dem"]["source"])
        if h["craters"] is not None:
            _keys(h["craters"], f"{where}.height.craters", ("maxDiameterRadii", "named"), ("complex",))
            if h["craters"].get("complex") is not None:
                _keys(h["craters"]["complex"], f"{where}.height.craters.complex", ("transitionDiameterKm", "depthKm", "exponent", "ref"))
            for i, c in enumerate(h["craters"]["named"]):
                _keys(c, f"{where}.height.craters.named[{i}]", ("name", "latDeg", "lonDegE", "diameterKm", "depthKm", "rimKm", "ref"))
        if h["dem"] is not None and h["craters"] is not None:
            raise ConfigError(f"{where}.height: a DEM and procedural craters exclude each other")
        al = raw["albedo"]
        _keys(al, f"{where}.albedo", ("maxLevel", "source", "colourSource", "transfer", "tint", "calibration", "procedural"),
              ("lowFrequency", "colourMode"))
        if al.get("colourMode") not in (None, "chroma", "detail"):
            raise ConfigError(f"{where}.albedo.colourMode: chroma (mono luminance x colour chroma) | detail (colour x mono detail)")
        if al.get("lowFrequency") is not None:
            lf = al["lowFrequency"]
            _keys(lf, f"{where}.albedo.lowFrequency", ("sigmaKm", "percentileToAlbedo", "ref"))
            ks = lf["percentileToAlbedo"]
            if len(ks) < 2 or [k[0] for k in ks] != sorted(k[0] for k in ks) or ks[0][0] != 0 or ks[-1][0] != 100:
                raise ConfigError(f"{where}.albedo.lowFrequency.percentileToAlbedo: increasing percentiles from 0 to 100")
        _num(al["maxLevel"], f"{where}.albedo.maxLevel", 0, 6)
        if (al["source"] is None) == (al["procedural"] is None):
            raise ConfigError(f"{where}.albedo: exactly one of source and procedural")
        if al["procedural"] is not None:
            _keys(al["procedural"], f"{where}.albedo.procedural", ("color", "freshBrightening", "ref"))
            if h["craters"] is None:
                raise ConfigError(f"{where}: a procedural albedo needs height.craters (the crater population)")
        else:
            used.add(al["source"])
            if al["transfer"] not in ("srgb", "linear"):
                raise ConfigError(f"{where}.albedo.transfer: srgb | linear")
            if al["colourSource"] is not None:
                used.add(al["colourSource"])
        cal = al["calibration"]
        _keys(cal, f"{where}.albedo.calibration", ("meanAlbedo", "region", "ref"))
        _num(cal["meanAlbedo"], f"{where}.albedo.calibration.meanAlbedo", 0.005, 1.0)
        if cal["region"] is not None:
            _keys(cal["region"], f"{where}.albedo.calibration.region", ("latDeg", "lonDegE", "radiusKm"))
        if al["tint"] is not None and (len(al["tint"]) != 3 or min(al["tint"]) <= 0):
            raise ConfigError(f"{where}.albedo.tint: three positive numbers")
        for i, lm in enumerate(raw["landmarks"]):
            _check_landmark(lm, f"{where}.landmarks[{i}]")
    unused = set(raw["sources"]) - used
    if unused:
        raise ConfigError(f"{where}.sources: unused {sorted(unused)}")
    missing = used - set(raw["sources"])
    if missing:
        raise ConfigError(f"{where}: references undefined sources {sorted(missing)}")


def load(body_id: str) -> Body:
    path = rt.BODIES_DIR / f"{body_id}.json"
    if not path.is_file():
        raise ConfigError(f"no config {path}")
    raw = rt.read_json(path)
    validate(raw, f"bodies/{body_id}.json")
    if raw["id"] != body_id:
        raise ConfigError(f"bodies/{body_id}.json: id is {raw['id']!r}")
    credits = load_credits()
    for c in raw["credits"]:
        if c not in credits:
            raise ConfigError(f"bodies/{body_id}.json: unknown credit {c!r}")
    for k, s in raw["sources"].items():
        if s["credit"] not in raw["credits"]:
            raise ConfigError(f"bodies/{body_id}.json: source {k} credit {s['credit']!r} is not in the body's credits")
    return Body(raw, path)


def all_ids(kind: str | None = None) -> list[str]:
    out = []
    for p in sorted(rt.BODIES_DIR.glob("*.json")):
        raw = rt.read_json(p)
        if kind is None or raw.get("kind") == kind:
            out.append(p.stem)
    return out


CREDIT_KEYS = ("title", "author", "url", "licence", "licenceUrl", "attribution")


def load_credits() -> dict:
    c = rt.read_json(rt.CREDITS_FILE)
    for k, e in c.items():
        _keys(e, f"credits.json.{k}", CREDIT_KEYS)
    return c


def radii_crosscheck(body: Body) -> list[str]:
    """Compare with data/staged/bodies/radii.json (bodies-ephemeris) when it exists. Returns problems."""
    p = rt.STAGED / "bodies" / "radii.json"
    if not p.is_file():
        return []
    table = rt.read_json(p)
    rows = table if isinstance(table, list) else table.get("bodies", table)
    row = None
    if isinstance(rows, dict):
        row = rows.get(body.id)
    else:
        row = next((r for r in rows if r.get("id") == body.id), None)
    if row is None:
        return [f"{body.id}: not in {p}"]
    problems = []
    mean = row.get("mean", row.get("meanRadius"))
    if mean is None or abs(float(mean) - body.radius) > 0.5:
        problems.append(f"{body.id}: mean radius {body.radius} m, radii.json {mean}")
    abc = row.get("radiiAbc")
    if abc is not None and any(abs(float(x) - y) > 0.5 for x, y in zip(abc, body.abc)):
        problems.append(f"{body.id}: radii {body.abc} m, radii.json radiiAbc {abc}")
    return problems
