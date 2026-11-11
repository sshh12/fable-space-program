Status: open
From: sky-lighting
Owner path: src/render/core/post/postProcess.ts (TAA resolve)
Blocking: no

## Problem
Two measured properties of the TAA resolve hit small bright sources, which the sky consists of.
(1) Energy loss of thin bright geometry: a sunlit crescent Earth 6.6 px across (lit width about 1.4 px) keeps
only 25 % of its flux in the resolved image, against the HDR target averaged over the jitter cycle; 79 % at
13 px, 89 % at 21 px. The temporal blend runs in the reversible tonemap space, so a pixel that is bright in some
jitter phases and dark in others converges towards the dark ones (RENDER_API 13 says so for fireflies); for a
static, legitimately sub-pixel feature that is a loss of energy, and visibly: the crescent dims by 4 x while
the camera holds still. The sky's PSF impostors (below 6 px) keep 99-100 %, so the hand-over from impostor to
geometry shows a brightness step in the display image even though the HDR flux is continuous within 3 %.
(2) No convergence for a static camera: with a static scene the resolved image of a sigma 0.7 px star follows
the 8-phase jitter cycle: consecutive frames differ by 0.8 % on average and up to 10 % at star pixels, frames 8
apart by up to 3.5 %; in 8-bit after tonemapping a few pixels change by up to 11 levels. The sky feature's own
output is exactly constant (frame difference 0 in the HDR target), and a 3 x 3 reconstruction with
w = exp(-2.29 d^2) varies by 48 % per frame at the rim of such a PSF (22 % even at sigma 1.2 px; computed), so
this cannot be fixed by the PSF.

## Evidence
- `npx playwright test tests/browser/sky/impostor.spec.ts --project=functional -g crescent` logs the kept
  fraction per tile ("TAA keeps 25 %" at 6.6 px); `out/screens/sky/crescent-earth-approach-sheet.png` (tile 5).
- `npx playwright test tests/browser/sky/stars.spec.ts --project=functional -g "static camera"` logs the
  consecutive-frame and same-phase differences (frames stepped with `__lab.renderFrame()`, 'resolved' readback).
- Lab: `/labs/sky/?scene=translunar&clouds=1&parts=-flare&hud=0`, camera 1.2e9 m from the Earth at phase 125 deg.

## Requested change
Whatever the core judges right; two options that would each fix both:
- For pixels whose reprojection is exact (no geometry motion: velocity 0 and depth unchanged, or sky), blend
  linearly towards the running mean over the jitter cycle (e.g. history weight approaching 1 - 1/n with the
  number of frames the pixel has been static, capped), so a static image converges to the cycle average, which
  is energy-correct; keep the tonemap-space blend for moving or disoccluded pixels where fireflies come from.
- Or keep the current blend and do the firefly rejection only where the neighbourhood's history disagrees with
  the current frame beyond the jitter cycle's own variation.
Must not change: energy of saturated sources (RENDER_API 13, sun disc 95 % after 140 frames), ghosting bounds,
`setJitter` / `setDeterministic` behaviour. A test of the crescent's kept fraction (above 90 %) and of the
static-camera star difference would hold it.
