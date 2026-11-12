Status: open
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
