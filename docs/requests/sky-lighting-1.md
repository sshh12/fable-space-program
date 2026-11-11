Status: declined
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

## Resolution
Declined for now, with what was tried and what is left for the lead. Both effects are real; neither has a
fix that I could prove safe for the rest of the frame in this wave.

**(1) Energy of thin bright geometry.** I implemented your first option in its simplest form (pixels with
zero screen velocity blended in linear light instead of the squashed space) and ran the core's suite: the
saturated-source spec (`exposure.spec.ts`, 9-pixel sun disc at HDR_MAX) then measures 122 % of the disc's
HDR energy in the resolved image (it must stay between 60 % and 110 %; it was 95 %). A linear temporal mean
lets rim pixels of a saturated source keep a share that the clamp at HDR_MAX has already cut from the core,
so energy is created; the squashed blend hides that. The change was withdrawn (commit 2cc2aea contains
only the two additions below). A correct version needs the accumulation to be bounded per pixel by the
unclamped source, or a per-pixel count of still frames with a clip that is built over the jitter cycle
instead of over this frame's 3 x 3 taps; the second also solves (2), and it needs a second history
attachment. That is a redesign of the resolve, not a patch.

**(2) Residual of the jitter cycle for a static camera.** It follows from the 0.9 history weight and the
3 x 3 reconstruction, as you computed. Raising the weight for still pixels removes it but makes every change
that has no motion vector (display digits, plume turbulence, blinking lights) ghost for half a second where
the neighbourhood clip does not catch it; a still-frame counter in the history alpha is defeated by the
same clip in the frames whose taps miss the feature. Not changed.

**What did change (commit 2cc2aea), and helps the sky a little:**
- the history is rescaled by the exposure ratio before use, so stars and impostors no longer carry the
  previous exposure through an adaptation;
- `'post.reactive'` exists (RENDER_API section 13): a feature can lower the history weight per pixel. It is
  not a tool against (1) or (2): less history means less temporal anti-aliasing.

**What you can do inside your paths.**
- Keep bodies on the PSF / impostor path, which is prefiltered and keeps 99-100 %, for as long as their LIT
  WIDTH is below about 2 px, not their diameter below 6 px: a crescent 20 px across with a 1.4 px lit width
  is exactly the case that loses energy as geometry. Hand over to the terrain when the lit width passes
  2 px (the phase angle is in `BodyPose.sunDir`).
- For stars, a PSF sigma of 1.0 px or more halves the per-frame variation of the reconstruction (your own
  figure: 22 % at 1.2 px against 48 % at 0.7 px) and with it the 8-bit flicker; the flux is unchanged.

**For the lead** (recorded in `docs/handoff/core-support.md`): the resolve loses energy of sub-pixel bright
geometry under jitter (25 % kept at 1.4 px lit width, 79 % at 13 px disc size, your numbers) and leaves a
0.8 % mean / 10 % peak jitter-cycle ripple on star pixels for a static camera. Fixing both properly is a
resolve with per-pixel accumulation and a jitter-cycle clip box (FSR2-style locks).
