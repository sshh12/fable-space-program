Status: declined
From: sky-lighting
Owner path: docs/ARCHITECTURE.md section 17 (VRAM line "sky 0.1"), lead decision
Blocking: no

## Problem
The baked Milky Way cube (data/sky, 2048^2 per face, 12 mips, rgb9e5) needs 134 MB of VRAM; with the probe,
albedo maps and stars the sky would be about 0.14 GB against its 0.1 GB line. The sky feature now keeps the sky
within the line by default: it uploads the chain from 1024 per face (34 MB; about 41 MB for the whole sky,
`SkyFeatureOptions.milkyWayFaceSize`, default `MILKY_WAY_FACE_SIZE` = 1024). That halves the resolution of the
faint-star background (the catalogue stars to V 6.5 are drawn as PSFs and are unaffected): 1024 per face is
0.088 deg per texel, about 2 px at 1440p and 60 deg; 2048 matches the pixel. The loss is invisible at wide
fields and plain in narrow-field close-ups. This asks the lead to decide whether the full cube is worth 0.1 GB.

## Evidence
- `npx playwright test tests/browser/sky/views.spec.ts --project=functional` writes both versions of the same
  views: `out/screens/sky/starfield-deep-space-ev-5.png` (1024) vs `starfield-deep-space-ev-5-mw2048.png`
  (70 deg field: mean absolute display difference 0.04 / 255, indistinguishable), `orion-closeup-ev-5.png` vs
  `orion-closeup-ev-5-mw2048.png` (24 deg field: 1.26 / 255; the faint background stars are soft blobs at
  1024 and points at 2048).
- 3 x crops side by side (left 1024, right 2048): `out/screens/sky/milky-way-1024-vs-2048-orion-crop-3x.png`,
  `out/screens/sky/milky-way-1024-vs-2048-galactic-centre-crop-3x.png`.
- Lab: `/labs/sky/?scene=translunar&planet=0&parts=-impostors&ev=-5&mwSize=2048` (full cube) against the same
  URL without `mwSize`.

## Requested change
Either raise the "sky" VRAM line of ARCHITECTURE 17 to 0.15 GB, in which case the app shell (or the sky's
default, on the lead's word) uses `createSkyFeature({ milkyWayFaceSize: 2048 })`; or confirm the 0.1 GB line,
in which case nothing changes (1024 stays the default). Must not change: the sky's photometry (the cube's
luminance scale is the same at every mip; the Milky Way band and star-visibility specs pass either way).

## Resolution
Escalate: lead

This asks to raise a budget line of ARCHITECTURE section 17 (VRAM, "sky 0.1"), which only the lead can
change; core-support may not weaken a line of the architecture, and the request names the lead as owner.

Nothing is blocked: the sky's default (`MILKY_WAY_FACE_SIZE` = 1024, 41 MB for the whole sky) keeps the
line, and the full cube is one option away (`createSkyFeature({ milkyWayFaceSize: 2048 })`, 134 MB for the
cube, about 0.14 GB for the sky). The decision and its evidence (the 1024 / 2048 screenshot pairs named
above: indistinguishable at a 70 degree field, soft background stars at 24 degrees) are listed for the lead
in `docs/handoff/core-support.md` under "what the lead should look at first". If the lead raises the line
to 0.15 GB, the app shell passes the option; no code changes are needed in the sky or in the core.
