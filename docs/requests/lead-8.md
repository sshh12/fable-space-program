Status: open
From: the lead (the reference images recorded before sub-wave 3.2, 2026-11-12; docs/handoff/lead-baseline-v2.md sections 22 and 23)
Owner path: src/render/vfx/** (vfx)
Blocking: no (the checkpoint is recorded and compared within a tolerance instead of to the bit)

## Problem
The dust that a burning descent engine throws out over the lunar ground is not the same picture on every
load. A frame-exact capture restarts every temporal sequence so that its frames depend on the scene alone
(RENDER_API section 13); the particles then still stand where the frames before the capture put them, and
those frames differ from load to load. The vfx package has no `resetTemporal` (no occurrence in
`src/render/vfx`).

## Evidence
`lunar-touchdown` (`tests/browser/baselines.manifest.json`): the integration lab on the FakeSim, the lander
hovering 12 m over the landing target, exactly 180 frames of 1/60 s stepped with the loop stopped so that
the descent engine burns, then frozen.

- The recording's three loads differ by a 99.9th percentile of one level (mean 0.0012); a fresh load in a
  self-check differed from the reference in 0.212 % of the pixels by up to 8 levels.
- The lead's probe with four loads (`BASELINE_EXACT_PROBE=lunar-touchdown BASELINE_EXACT_LOADS=4`,
  2026-11-12): within every load the two captures are identical; load 1 against loads 2, 3 and 4 differs
  in 1,353, 2,207 and 1,706 pixels by up to 5, 8 and 5 levels. The differing pixels are short streaks and
  small clusters scattered over the ground around the lander, nowhere else
  (`out/screens/baselines/lunar-touchdown.probe-loads.load-3.png`): single particles of the dust.
- The same page without the stepping (the engine dark) was identical on every load.

## Requested change
Add `resetTemporal()` to the vfx features and make the particles of a capture a function of the snapshot
and of the capture's frames: restart the emitters' random sequences and spawn phases there (seeded from
the vessel and the engine, not from a running frame or clock), and drop or re-derive the particles that
are alive, so that a frozen scene with a burning engine gives the same dust on every load.

What must not change: the running picture.

## Acceptance
`BASELINE_EXACT_PROBE=lunar-touchdown BASELINE_EXACT_LOADS=4 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-exact-probe.spec.ts --project=functional`
prints "identical" for load 1 against loads 2, 3 and 4. The lead then re-records `lunar-touchdown`, which
becomes `exact` in the manifest.
