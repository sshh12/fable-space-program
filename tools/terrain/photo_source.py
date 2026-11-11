"""Photographic source images of the detail material sets, generated with an image model.

    python -I tools/terrain/photo_source.py --list-models
    python -I tools/terrain/photo_source.py [--only <id>[,<id>...]] [--variants 1] [--force] [--model <id>]

Each entry of SOURCES is one square top-down photograph of ground at a stated size on the ground, lit
without direct sun (the renderer lights it). The images are written to data/cache/terrain/photo/<id>-<v>.png
(not committed: they are inputs of tools/terrain/gen_materials.py, which makes them tileable, removes the
residual shading and derives height, normal, roughness and occlusion).

The key is read from .env (OPENAI_API_KEY) and sent only in the Authorization header; it is never printed.
Prompts describe ground materials only.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_DIR = os.path.join(REPO, "data", "cache", "terrain", "photo")

COMMON = (
    "Orthographic top-down photograph taken straight down (nadir view), filling the whole square frame edge to edge with the same "
    "material at a constant scale. Flat, even, fully overcast lighting with no direct sun, no cast shadows, no highlights and no "
    "vignetting, like a calibrated photogrammetry albedo texture. Uniform density of features across the whole frame, no focal "
    "object, no horizon, no perspective, no border, no text, no people, no tools, no footprints, no tyre tracks. "
    "Sharp focus everywhere, natural muted colours, photorealistic, high detail."
)

# id -> description with the ground size of the frame. Four scales per material: near (2 m), mid (14 m), far (110 m), aerial (900 m).
SOURCES: dict[str, str] = {
    # ---- pahoehoe lava
    "pahoehoe-near": "Frame covers 2 m x 2 m of old weathered pahoehoe basalt lava: smooth billowy dark grey-brown rock skin with ropy wrinkles, fine hairline cracks, small vesicle pits, patches of grey lichen and a little brown dust in the hollows.",
    "pahoehoe-mid": "Frame covers 14 m x 14 m of an old pahoehoe basalt lava field seen from a drone at 15 m: overlapping smooth lobes and toes of dark grey-brown rock, ropy bands, cracks between lobes with tan dust and a few tufts of dry grass in the cracks.",
    "pahoehoe-aerial": "Frame covers 900 m x 900 m of an old weathered pahoehoe lava flow field seen from an aircraft at 1500 m: dark grey-brown basalt with broad lighter grey weathered areas, the faint outlines of overlapping flow lobes, crack networks, small collapse pits and scattered specks of dry vegetation in hollows. No roads, no buildings.",
    "pahoehoe-far": "Frame covers 110 m x 110 m of an old weathered pahoehoe lava plain seen from an aircraft at 150 m: dark grey-brown rock with mottled lighter weathered patches, a network of fine cracks and small tumuli, scattered tiny specks of dry vegetation in cracks.",
    # ---- a'a lava
    "aa-near": "Frame covers 2 m x 2 m of a'a basalt lava clinker: a rubble of rough, spiny, very dark brown-black vesicular lava fragments from 2 to 25 cm, tightly packed, with rusty brown oxidised faces.",
    "aa-mid": "Frame covers 14 m x 14 m of an a'a basalt lava flow seen from a drone at 15 m: a chaotic carpet of rough dark brown-black clinker rubble and blocks up to 60 cm, with subtle ridges and rusty brown oxidised patches.",
    "aa-aerial": "Frame covers 900 m x 900 m of a rough a'a basalt lava flow field seen from an aircraft at 1500 m: very dark brown-black rubble with long sinuous flow ridges, channels and levees, rusty brown oxidised streaks and a few islands of older lighter lava. No roads, no buildings.",
    "aa-far": "Frame covers 110 m x 110 m of an a'a basalt lava flow field seen from an aircraft at 150 m: rough dark brown-black rubble surface with flow ridges, levee lines and mottled rusty brown patches.",
    # ---- black sand
    "black-sand-near": "Frame covers 2 m x 2 m of a dry volcanic black sand beach: fine dark grey-black basalt sand with a few olive-green and tan grains, small scattered pebbles of grey basalt and tiny bits of white coral and shell, faint wind ripples.",
    "black-sand-mid": "Frame covers 14 m x 14 m of a volcanic black sand and pebble beach seen from a drone at 15 m: dark grey-black sand with drifts of rounded grey basalt pebbles and cobbles, a few bits of bleached coral rubble and dried seaweed lines.",
    "black-sand-aerial": "Frame covers 900 m x 900 m of a volcanic black sand and gravel coastal plain seen from an aircraft at 1500 m: dark grey sand with faint lighter and darker streaks, braided dry drainage rills, gravel bars and small patches of low dry vegetation. No water, no roads, no buildings.",
    "black-sand-far": "Frame covers 110 m x 110 m of a volcanic black sand flat seen from an aircraft at 150 m: dark grey sand with subtle lighter and darker streaks, patches of pebbles and cobbles, faint drainage rills.",
    # ---- dry scrub soil
    "scrub-soil-near": "Frame covers 2 m x 2 m of dry reddish-brown volcanic soil on a windswept coast: crumbly dry dirt with small clods, scattered small dark basalt pebbles, a few sparse tufts of short dry straw-coloured grass and dead grass litter.",
    "scrub-soil-mid": "Frame covers 14 m x 14 m of dry coastal scrubland seen from a drone at 15 m: reddish-brown bare volcanic soil with many clumps of dry straw-coloured bunch grass, a few low grey-green shrubs seen from above, scattered dark basalt stones.",
    "scrub-soil-aerial": "Frame covers 900 m x 900 m of dry windswept coastal scrubland seen from an aircraft at 1500 m: mottled reddish-brown bare soil and straw-coloured dry grass, clusters of small dark green shrubs, branching erosion gullies and patches of exposed dark rock. No roads, no buildings, no fields.",
    "scrub-soil-far": "Frame covers 110 m x 110 m of dry windswept coastal scrubland seen from an aircraft at 150 m: mottled reddish-brown soil and straw-coloured dry grass with scattered small dark green shrubs and patches of exposed dark rock.",
    # ---- pasture grass
    "pasture-near": "Frame covers 2 m x 2 m of short windswept pasture grass: dense mixed green and yellow-green grass blades about 5 to 10 cm long seen from directly above, with some dry straw-coloured blades and small gaps showing brown soil.",
    "pasture-mid": "Frame covers 14 m x 14 m of windswept cattle pasture seen from a drone at 15 m: short green and yellow-green grass with tussocks, small bare brown soil patches, a few low weeds and scattered small dark stones.",
    "pasture-aerial": "Frame covers 900 m x 900 m of rolling windswept coastal ranch grassland seen from an aircraft at 1500 m: green and yellow-green pasture with irregular mottling of drier straw-coloured areas, scattered dark green shrubs and small wind-bent trees, shallow drainage swales and small bare reddish-brown soil patches. No roads, no buildings, no fences, no field boundaries.",
    "pasture-far": "Frame covers 110 m x 110 m of rolling windswept coastal pasture seen from an aircraft at 150 m: green and yellow-green grassland with subtle mottling, faint cattle trails, small patches of darker shrubs and a few bare reddish-brown soil spots.",
    # ---- concrete apron
    "concrete-near": "Frame covers 2 m x 2 m of an old weathered outdoor concrete slab without any joints: light grey broom-finished concrete with exposed fine aggregate, small pits, faint hairline craze cracks, subtle darker water stains and specks of dirt.",
    "concrete-mid": "Frame covers 14 m x 14 m of an old weathered airport concrete apron without painted markings and without joints: light grey concrete with uneven weathering, faint darker water stains and streaks, a few dark oil drips, patches of slightly different grey, occasional fine cracks.",
    "concrete-aerial": "Frame covers 900 m x 900 m of an enormous old weathered concrete apron without painted markings seen from an aircraft at 1500 m: light grey concrete with very broad irregular areas of lighter and darker weathering, faint long rain streaks and pale stains.",
    "concrete-far": "Frame covers 110 m x 110 m of a huge old weathered concrete apron without painted markings and without joints seen from an aircraft at 150 m: light grey concrete with broad irregular patches of lighter and darker weathering, faint rain streaks and stains, subtle rubber and soot marks.",
}


def read_key() -> str:
    path = os.path.join(REPO, ".env")
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith("OPENAI_API_KEY="):
                value = line.split("=", 1)[1].strip().strip('"').strip("'")
                if value:
                    return value
    raise SystemExit("OPENAI_API_KEY is not set in .env")


def request(url: str, key: str, body: dict | None) -> dict:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="GET" if body is None else "POST")
    req.add_header("Authorization", "Bearer " + key)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=600) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list-models", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--variants", type=int, default=1)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--model", default="gpt-image-1")
    ap.add_argument("--quality", default="high")
    args = ap.parse_args()
    key = read_key()
    if args.list_models:
        models = request("https://api.openai.com/v1/models", key, None)
        for m in sorted(x["id"] for x in models.get("data", [])):
            if "image" in m or "dall" in m:
                print(m)
        return
    os.makedirs(OUT_DIR, exist_ok=True)
    wanted = [s for s in args.only.split(",") if s] or list(SOURCES)
    for name in wanted:
        if name not in SOURCES:
            raise SystemExit(f"unknown source {name}")
        for v in range(args.variants):
            out = os.path.join(OUT_DIR, f"{name}-{v}.png")
            if os.path.exists(out) and not args.force:
                continue
            prompt = SOURCES[name] + " " + COMMON
            t0 = time.time()
            for attempt in range(3):
                try:
                    res = request("https://api.openai.com/v1/images/generations", key, {"model": args.model, "prompt": prompt, "size": "1024x1024", "quality": args.quality, "n": 1})
                    break
                except RuntimeError as e:
                    print(f"{name}-{v}: attempt {attempt + 1} failed: {e}", file=sys.stderr)
                    if attempt == 2:
                        raise
                    time.sleep(5 * (attempt + 1))
            png = base64.b64decode(res["data"][0]["b64_json"])
            with open(out, "wb") as f:
                f.write(png)
            usage = res.get("usage", {})
            print(f"{name}-{v}: {len(png) // 1024} KiB in {time.time() - t0:.0f} s, tokens {usage.get('total_tokens', '?')}")


if __name__ == "__main__":
    main()
