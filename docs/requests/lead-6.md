Status: open
From: the lead (the recording of the reference images before sub-wave 3.2, 2026-11-12; docs/handoff/lead-baseline-v2.md section 22)
Owner path: src/app/** (the app shell, app-integration)
Blocking: no (the app's pad checkpoint is recorded, with a wide tolerance); it decides how sharp the app's own reference images are

## Problem
A lab page is frozen from its first frame by its query (`deterministic=1&paused=1`), so a reference capture
of it is the same picture on every load: 25 of the 30 recorded checkpoints are identical to the bit across
their three loads, and none of the lab pages differs by more than a few levels in a fraction of a percent
of its pixels. The app has no such start. Its simulation, its camera rigs
and its presentation time run from the reveal until a test calls `__test.setDeterministic(true)` and
`__test.setPaused(true)`, which happens a different time after the reveal on every load. The app's
checkpoint therefore differs from load to load, its tolerance (three times the largest difference between
the loads) comes out wide, and the gate it gives the presentation sweep on the app's own wiring is coarse.

## Evidence
`sweep-app-pad` (`/?scenario=lunar-direct&governor=off&mute=1&capturepill=0`, then the two test hooks), on
2026-11-12, tree at 9a873e0:

- Recording: the three loads differ by mean 0.084 and 7 levels at the 99.9th percentile, so the tolerance
  is mean 0.253, p99.9 21 (the lab checkpoints: mean 0.02 and p99.9 1, the floor, or p99.9 3).
- Probe with three loads (`BASELINE_EXACT_PROBE=sweep-app-pad BASELINE_EXACT_LOADS=3`): load 1 against load
  2 differs in 103,152 of 921,600 pixels by up to 29 levels, load 1 against load 3 in 99,441 by up to 31,
  spread over the ground, the sea and the sky alike
  (`out/screens/baselines/sweep-app-pad.probe.load-2.png`). Within one load the second and third capture
  are identical.
- The lead-in capture of a load differs from the capture used in 413, 624 and 367 pixels (recording) and
  in 1,525, 424 and 1,067 (probe): request core-7's effect, about a hundred times what the labs show (0 in
  26 checkpoints).
- `sweep-app-cockpit`: besides the cabin's own settling (request lead-5), the picture MOVES between the
  first capture after the pause and the later ones: the instrument panel stands about 9 pixels further left
  and 6 further up from the second or third capture on
  (`sweep-app-cockpit.probe.first.png` against `.last.png`). Something of the cockpit view (the rig, the
  seat pose, a transition) is still under way when the hooks have frozen the app and every feature reports
  idle.

## Requested change
1. Honour `?deterministic=1&paused=1` from the app's first frame, as `createLabApp` pages do: the
   simulation does not advance, the camera rigs get the fixed step, and the presentation time is the
   capture's. The scenario's start state is then the state of the picture, on every load.
2. With that, report busy until the camera of the chosen view has come to rest (the cockpit view above), so
   that a capture is not taken while it moves.

What must not change: the app without those parameters.

## Acceptance
`BASELINE_EXACT_PROBE=sweep-app-pad BASELINE_EXACT_LOADS=3 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-exact-probe.spec.ts --project=functional`
with the page's query extended by the two parameters prints "identical" for load 1 against loads 2 and 3.
The lead then re-records `sweep-app-pad` (and `sweep-app-cockpit`, once request lead-5 is done) with the
setup steps replaced by the query, and their tolerance falls to the floor.
