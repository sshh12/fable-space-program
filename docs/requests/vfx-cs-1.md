Status: resolved (commits cb47e66, 11da1a3)
From: core-support (routing request flight-ui-4)
Owner path: src/render/vfx/director.ts (the ablation spark emitter, "ablation sparks in the shock layer") and src/render/vfx/particles.ts (how a spark is drawn as a streak)
Blocking: no

## Problem
During an entry a thin, dull orange line appears in the dark sky far from the capsule: 85 to 270 px long and 2 to
4 px high at 2560 x 1440, nearly horizontal, in a different place every few frames. It is the vfx feature's
ablation sparks: single sparks that leave the shock layer and are then drawn as streaks hundreds of metres long,
far outside the wake, where nothing in the scene explains them. Flight-ui's stills behind its HUD show it
(request flight-ui-4, critic finding 3 of `out/qa/wave2/flight-ui.r5.artifact.json`).

## Evidence
Integration lab, `/labs/integration/?scene=reentry&orbit=160,10,30&features=all` at 2560 x 1440
(`tests/browser/integration/budget.perf.spec.ts`, checkpoint 'reentry', is the same view):
- `out/screens/integration/budget-reentry.png`: the streak at about (2155, 590)-(2275, 592) and a second one at
  (2470, 70)-(2560, 72).
- This round's probe, one page, features switched off one package at a time with
  `window.__integration.setEnabled(pkg, false)` and red-dominant pixels counted in the sky right of the capsule
  (`r > 1.3 g`, `r > 1.3 b`): all features on: 74 px, a line from (2196, 337) to (2279, 340)
  (`out/screens/core-support/streak-all.png`; enlarged `streak-crop-all.png`); **without vfx: 0 px**; without the
  sky, the atmosphere, the ocean, the terrain or the vehicle the line is still there, each time somewhere else
  (it moves: (2325, 93)-(2415, 100) without the sky, (1656, 348)-(1718, 350) without the atmosphere).
- The lab's reentry scene holds one vessel (the capsule); no debris, no other emitter. `director.ts` line 232
  emits `kind: 'spark'` on a ring of 0.95 bounding radii with `vel: vd.vel` (about 7.6 km/s in the lab scene,
  11 km/s at the mission's entry interface) and `sweep: vd.vel * dt`.

## Requested change
Keep the ablation sparks inside the wake: a spark's streak length and its distance from the capsule should be
bounded by what the eye can follow (the wake's own `streakSpeed` rule), not by the vessel's inertial or
air-relative speed times its life; a spark that has left the shock layer should cool and fade within a few
capsule diameters. Then re-shoot `budget-reentry.png` and flight-ui's `real-reentry-*.png`. Must not change:
the sparks close to the heat shield, the wake, the plasma sheath.

## Resolution
Three causes in `src/render/vfx`, all removed (vfx round 2):

1. **The streak was computed against the wrong clock** (`particles.ts`, `feature.ts`; `cb47e66`). A particle's
   streak is its path relative to the eye during the shutter: its own velocity plus the motion of the effect
   domain past the eye. That motion was divided by the REAL frame time. In a frame whose simulated step differs
   from its real duration (a hitch, a stopped clock, time warp) every spark that rides with a capsule at 7.6 km/s
   took a relative speed of kilometres per second and was drawn at the largest streak length: "in a different
   place every few frames". The domain's velocity relative to the eye is now measured over simulated time and held
   while the clock stands still (`VfxGlobals.domVel`).
2. **A spark against the still air** (`director.ts`, `EmitterDesc.shelter`; `11da1a3`). Lower in the entry the
   air stops a free spark within milliseconds (thousands of m/s^2) and the capsule leaves it kilometres behind:
   a single point of light in an empty sky. Ablation sparks are shed into the wake and ride with its gas: they
   are spared 97 % of the still air's drag, leave at 10 to 60 m/s (was 15 to 120) and live 0.15 to 0.5 s (was
   0.25 to 0.9): a few capsule diameters. The sparks at the heat shield, the wake and the sheath are unchanged.
3. **A bound on what a spark may be drawn as** (`particles.ts`): its streak is never longer than 40 radii plus
   half a metre (it was 150 radii plus 4 m), and it is a tapered streak, not a bar.

Checked in your view, `/labs/integration/?scene=reentry&features=all&hud=0&orbit=160,10,30` at 1280 x 720, live,
200 frames (`out/screens/vfx/dev/i3-reentry-fu4.png`, again as `i4-reentry-fu4.png` with the final code): 0
red-dominant pixels (`r > 1.3 g`, `r > 1.3 b`, `r >= 24`) in the sky above the capsule (rows 0 to 300). One
frame per run, so re-run your probe (`budget-reentry.png`, the counts with the packages switched off) and
flight-ui's `real-reentry-*.png` to be sure; if a line is still there, reopen this with the frame.
