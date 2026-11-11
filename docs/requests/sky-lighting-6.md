Status: open
From: sky-lighting
Owner path: tools/bake/moon (`albedo.py`: colour of the Moon's albedo tiles and of `globals/albedo-lowres.png`), data/defs/bodies/moon.json (`render.meanColor`)
Blocking: no

## Problem
Two things about the Moon's albedo colour show in the sky's probe and in its far image of the Moon.
(1) At the mission's landing site (Mare Tranquillitatis, 0.67 N, 23.47 E) the low-resolution albedo map decodes
to linear (0.060, 0.063, 0.070): blue above red. No lunar soil reflects more at 450 nm than at 640 nm; the mare
is "blue" only relative to other maria in ratio images. The SVS colour map carries a stretched colour, and the
bake kept it. A chrome surface on the Moon therefore reflects a cold grey ground (item 11 of
`out/qa/wave2/sky-lighting.md`), and so does the terrain itself.
(2) The body's `meanColor` (0.12, 0.115, 0.105) is not the mean of the map: the map's area-weighted mean is
(0.149, 0.141, 0.137), the near side alone (0.133, 0.126, 0.122). The sky's far image of the Moon is its Hapke
sphere with `meanColor` (the data's "far impostor" colour), so at the hand-over to the terrain it is 14 %
dimmer and 6 % less blue than the geometry it turns into (measured: `impostor.spec.ts`, "crescent Moon").

## Evidence
- `node -e` over `data/tiles/moon/globals/albedo-lowres.png` (sRGB decoded): site (0.0595, 0.0630, 0.0704),
  Imbrium (0.078, 0.070, 0.063), highland (0.168, 0.162, 0.162), Tycho (0.227, 0.238, 0.250); global mean
  (0.1485, 0.1413, 0.1369).
- `npx playwright test tests/browser/sky/impostor.spec.ts --project=functional -g "crescent Moon"`: "far image /
  geometry (HDR flux) 0.862" at phase 30 deg, colour (1.076, 0.991, 0.869) against (1.075, 0.985, 0.925).
- `out/screens/sky/pbr-spheres-lunar-surface.png`: the ground cap (now with the map's albedo at the site) and
  its reflection in the chrome sphere are a cold blue-grey.

## Requested change
(1) In the albedo bake, constrain the colour so that red >= green >= blue everywhere (for example by scaling
the map's chroma about the lunar mean colour until the bluest mare is neutral, or by fitting the colour ratio
to literature values: mare 415 / 750 nm ratios lie between 0.55 and 0.70), tiles and `albedo-lowres.png`
alike; luminance unchanged.
(2) Set `render.meanColor` of the Moon to the near-side mean of the map after (1) (the face seen from the
Earth-Moon system's inner part, where the far image is used), about (0.133, 0.126, 0.12).
Must not change: the albedo's luminance and normalisation (30 deg incidence, the Hapke inversion depends on
it), tile layout and formats. The sky package needs no change: it re-runs `impostor.spec.ts` and re-shoots
`pbr-spheres-lunar-surface` when the data lands.
