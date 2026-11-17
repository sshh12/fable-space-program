Status: open
From: presentation-sweep
Owner path: tests/browser/baselines.manifest.json, data/baselines (the lead)
Blocking: no (the labs' fake keeps the v1 origin until this is decided; everything else is on the session's origin)

## Problem
Request presentation-sweep-4 asked whether the lab fake may state ROOT positions about the Moon in the lunar
scenes; the lead's answer was: find the cause of the origin dependence first. The cause is found, it is not
in the renderer, and it cannot be removed; what is left is a decision about two recorded pictures.

**The cause.** The renderer draws the same picture to the bit from the same frame about another origin. The
test (`tests/browser/integration/origin.spec.ts`, part 1) opens each lunar checkpoint as it was recorded and
hands the renderer the frame once as the fake states it about the root body and once translated exactly to
the Moon's centre (`?frameorigin=moon`, `src/render/core/lab/origin.ts`: every difference of two ROOT
positions is the same float64 number):

| Checkpoint | Translated to the Moon (same numbers) | Computed about the Moon (`&origin=focus`) | Camera relative to the vessel |
|---|---|---|---|
| `lunar-terminator-5000km` (exact) | 0 pixels | 0 pixels | 1.09e-8 m elsewhere |
| `lunar-orbit-low-sun` (exact) | 0 pixels | 0 pixels | 2.73e-8 m elsewhere |
| `lunar-surface-cockpit` (exact) | 0 pixels | 12,279 pixels, up to 17 levels, mean 0.0074, p99.9 1 | 1.60e-8 m elsewhere |
| `lunar-touchdown` (tolerance 0.02 / 3) | 0 pixels in one run; 1,706 pixels, up to 5 levels, mean 0.0010 in another (two loads of this page differ by as much: lead-8) | 8,379 pixels, up to 10 levels, mean 0.0070, p99.9 2 (inside its tolerance) | 2.88e-8 m elsewhere |

So nothing in the renderer depends on where the origin is. What differs when the frame is COMPUTED about the
other origin is the input: a position 384,000 km from the origin lies on a float64 grid of 6e-8 m, one about
the Moon on a grid of 2e-10 m, so `vessel.rRoot + offset` puts the camera up to 3e-8 m elsewhere relative to
the vessel (measured: the last column). A sixth of a float32 step at one metre is enough to carry
single-precision values on the GPU across a rounding boundary, and with them isolated samples: the coverage
of a pixel on a high-contrast edge in one frame of the jitter sequence, a stochastic tap of the cabin's sun
shadow (`cell = floor(p * 2500)`, src/render/cockpit/shaders.ts). In the cockpit on the lunar surface that
is 1.3 % of the pixels by one level and a few on the window frames by up to 17; the frame as a whole is the
same (mean 0.0074 level). It is v1's far origin that is the coarser one: the session's origin (the SOI body's
centre) is the better input, and the picture a player sees is the one computed about it.

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/origin.spec.ts --project=functional`
prints the `[origin]` lines above; pictures and difference maps (git-ignored) in
`out/screens/presentation-sweep/origin/`: `<checkpoint>.root.png`, `.translated.png`, `.translated.diff.png`,
`.focus.png`, `.focus.diff.png`. The cockpit-only run (`ORIGIN_EXTRA="&without=terrain,vehicle,ocean,sky,atmosphere,vfx"`)
shows the same thing with one package drawing: 24,479 pixels computed about the Moon.

## Requested change
A decision, one of:
1. Keep `createFakeSim` (the labs' fake) on the root-body origin, as the tree stands. The 25 lab checkpoints
   stay as recorded. `createFakeSession` (the menu's and wave 5's fake) and the real session are on the
   session's origin.
2. Give `createFakeSim` the session's origin (`renderRoot: 'focusBody'`, one line in
   `src/core/fakes/fakeSim.ts`) and re-record `lunar-surface-cockpit` with a note: it is the one EXACT
   checkpoint that moves (12,279 pixels, the map is `lunar-surface-cockpit.focus.diff.png`).
   `lunar-touchdown` moves within what its own loads differ by; the other 23 lab checkpoints are in the root
   body's sphere of influence or measured at 0 pixels.

The real simulation in the integration lab and the app is on the session's origin since this sweep
(`createSession`); `sweep-lunar-orbit`, the one recorded picture of it in the Moon's sphere of influence,
compares within its tolerance (the hand-off has the line).
