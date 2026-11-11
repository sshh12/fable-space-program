Status: open
From: sky-lighting
Owner path: src/render/atmosphere/** (cloud tops and atmosphere of the Earth seen from afar), src/render/terrain/** and src/render/ocean/** (the Earth's far field), data/defs/bodies/earth.json (`render.geometricAlbedo`, `render.meanColor`)
Blocking: no   (round-1 photo critic of the sky, minor finding 9: "measure flux and colour against the terrain and atmosphere renderers across the hand-over")

## Problem
A distant Earth is drawn by the sky's far image while its sunlit part is narrower than 4-7 px, as the brief
asks: the Lambert sphere of `BodyDef.render.geometricAlbedo` (0.434) and `meanColor` (0.2, 0.27, 0.4). Above
that the terrain, ocean, cloud and atmosphere renderers draw it. Measured in the integration lab, the Earth those
renderers draw integrates to about HALF of that law at ordinary phases and is less blue, so at the hand-over the
Earth changes by about one stop and in colour. The real Earth's geometric albedo is 0.37-0.43 in V (Bond albedo
0.30), so the far image's law is the physical one; the rendered Earth from afar reads as a sphere of geometric
albedo about 0.2.

## Evidence
`npx playwright test tests/browser/sky/integration.spec.ts --project=functional -g "Lambert law"` (integration lab,
`scene=translunar`, every package loaded, the sky's far image, stars, Milky Way and flare switched off, EV 12, 2 deg
field; HDR flux of the Earth's pixels against p E (R/d)^2 Phi(alpha) with the sun's colour and `meanColor`):

| diameter | phase 20 | phase 60 | phase 100 | phase 140 | chromaticity R/G, B/G (law: 0.77, 1.42) |
|---|---|---|---|---|---|
| 48 px | 0.52 | 0.47 | 0.48 | 1.07 | 0.94-0.99, 1.22-1.27 |
| 16 px | 0.46 | 0.42 | 0.43 | 0.77 | 0.90-0.93, 1.26-1.34 |

Pictures: `out/screens/sky/integration-earth-geometry-48px-phase60.png`, `-16px-phase60.png` (blue-grey ocean, cloud
fields that look light grey rather than white at this exposure; request map-view-6 describes the same clouds at
14,000-24,000 km as "mid-grey (about 200, 200, 200) instead of white").

## Requested change
Make the Earth that the renderers draw from afar and the body's definition describe the same planet, within 15 %
in flux and 0.05 in R/G and B/G across phases 0-120 deg:
1. Preferably the renderers: cloud tops of optical depth 10-30 reflect 0.6-0.8 of the light (white at the
   exposure of a sunlit scene), the ocean about 0.06 away from the glint, land 0.1-0.3; with the atmosphere's
   path radiance that integrates to p of about 0.37-0.43. The spec above is the check (it prints the table).
2. If the renderers are right as they are, change `render.geometricAlbedo` and `render.meanColor` of the Earth to
   what they integrate to (the core's planetshine uses the same two fields, so the light the Earth throws on a
   vessel would follow).
Must not change: nothing in `src/render/sky` needs to change for either; its far image follows the definition
(and its own spec `impostor.spec.ts` keeps the far image continuous with a Lambert backdrop of the same law).
