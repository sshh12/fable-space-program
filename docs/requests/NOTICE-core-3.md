Status: resolved (notice, nothing to answer)
From: core-support
Owner path: src/render/vehicle (vehicle-pad), src/render/sky (sky-lighting), src/render/terrain (terrain-render), src/render/cockpit (cockpit)
Blocking: no

## Problem
Changes of the shared code and the baked data in the visual close-out (after NOTICE-core-1 and -2) that change
pictures in your packages or give you something to use.

## Evidence
RENDER_API section 18; the resolutions of the requests named below.

## Requested change
- vehicle-pad: `LocalLight.castShadow` on a spot (vehicle-pad-2 part 2): the two brightest such spots at the
  camera get a shadow map each from every mesh batch's casters. Give it to the lamps that matter (the bank
  nearest the pad, the landing lamp). `PbrMaterialDef.alphaCutoff` (vehicle-pad-4) and the frost veil
  (vehicle-pad-6) are in; the integration lab's landed lander stands on its legs (vehicle-pad-5).
- sky-lighting, terrain-render: the Moon's albedo colour is constrained (sky-lighting-6: luminance kept, chroma
  x 0.2 about the mean, red >= green >= blue everywhere; tile set contentHash 597c5d666b132450) and the Moon's
  `render.meanColor` is the near-side mean of the corrected map (0.1332, 0.1263, 0.1221). The Magellanic
  Clouds in the sky cube have their stars' colour (sky-lighting-4). Re-shoot lunar views; terrain-render may
  raise the Moon's `imagerySaturation` again.
- terrain-render: shaped launch sites (terrain-render-6): `data/defs/sites/ka-lae-lc1.json` now has
  `pad.shape` (exactly flat core of 115 m and five areas, a quarter of the relief elsewhere inside 450 m,
  ragged blends); `site.pad.shape.areas` are there for your ground plan. RT4.a of terrain pixels is a shadow
  filter radius (terrain-render-4).
- cockpit: interior metering brings bright areas of 1-8 % of the frame into the shoulder (cockpit-12); the
  shadow kernel no longer turns per pixel at arm's length (cockpit-10).
- everyone looking at the sun from space: the meter uses the sun's light after the air on the way, and a frame
  with the disc in it is exposed at least for that light (sky-lighting-10).

## Resolution
Notice only.
