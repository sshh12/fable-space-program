Status: resolved (lead decision 2026-11-12; baseline checker in commit 431930f, the tick-grid step in the commit that adds this file)
From: sim-core-v2
Owner path: tests/mission/baseline-v1.json, tools/dev/record-mission-baseline.ts (the lead's), and the acceptance wording of MIGRATION_V2 step 3.1
Blocking: yes (the stated tolerance of step 3.1 cannot be met by any flight on a moved clock)

## Problem

Step 3.1 (the tick grid) was to be judged against `tests/mission/baseline-v1.json` by tolerance: orbit
elements at each milestone to 1e-6 relative, event times within 1 s. No flight whose start is not
bit-identical to the baseline's can meet that after the first decision of the scripted pilot: the pilot
decides at 30 Hz control ticks, the phase of those ticks against the flight changes with the start instant
and with every rails landing, one control tick at a burn cutoff is 1e-4 in the elements, and guidance then
steers a different, equally valid flight.

## Evidence

All flights: `lunar-direct`, the real tiles, the scripted pilot, to splashdown, cheatCounter 0, no incomplete
terrain query, splashdown in "Central Pacific". Differences are from `baseline-v1.json`.

| Flight | EARTH_ORBIT da/a | TLI_COMPLETE da/a | MOON_SOI_ENTER dt | LUNAR_TOUCHDOWN dt | MOON_SOI_EXIT dt | EARTH_PERIGEE_TARGETED dt | SPLASHDOWN dt |
|---|---|---|---|---|---|---|---|
| v1 code, start unshifted (control of the method) | 0 | 0 | 0 | 0 | 0 | 0 | 0 (state hash 3f3a131cdd88eba7, every field equal) |
| v1 code, start +2.004 ms | 4.8e-5 | 1.6e-3 | -12.8 s | +46.8 s | +83.6 s | -460 s | +15.3 s |
| v1 code, start +8.333 ms | 4.8e-5 | 1.8e-3 | -12.9 s | +47.1 s | +59.7 s | +59.7 s | +16.8 s |
| tick grid (start +2.004 ms, landings on ticks) | 4.8e-5 | 1.8e-3 | -8.2 s | +52.0 s | +24.7 s | -519 s | +8.1 s |

"v1 code" is `src/sim/world/sim.ts` of commit 6f012fe run from `git show` with nothing changed but the
scenario's `startUt`. The tick grid against the v1 code at the SAME start agrees to 5e-10 in a, e, energy and
h at every milestone up to EARTH_ORBIT, with every event at the same control tick.

## Requested change

Judge a step that legitimately moves time by something that separates "the same simulation on a moved
clock" from "a changed simulation", and keep `baseline-v1.json` as the exact reference for bit-identical
starts.

## Resolution (lead decision, 2026-11-12)

Accepted. The tick-grid step is judged by four things, all measured in `docs/handoff/sim-core-v2.md`
(section "Step 1") and asserted in tests where that is cheap:

1. **Same-start equality** (the physics did not change): the tick grid against the v1 clock at the same
   tick-aligned start, at every milestone up to and including EARTH_ORBIT. The v1 flight from that start
   was recorded while the v1 clock could still be run: `tests/mission/reference-v1-aligned.json` (25
   states: the six milestones and every 30 s of the ascent; `tools/sim/referenceFlight.ts`). Asserted by
   `tests/mission/full-mission.test.ts` ("same-start equality"). No copy of the old clock is in the tree.
2. **Rails equivalence**: the propagator is untouched; only the landing instants moved. Asserted by
   `tests/unit/sim-world/railsEquivalence.test.ts` from the six coast states of the baseline; measured
   once against the v1 clock itself (36 of 36 landings bit-identical).
3. **The mission's own gates** on the tick grid: `npm run test:mission` (full mission, perturbed starts,
   entry corridor, browser loop, ascent), no gate or tolerance loosened.
4. **Envelope**: at every milestone the tick-grid flight's difference from the baseline in event mission
   time and in da/a lies within twice the largest difference among four control flights of the unmodified
   v1 code with shifted starts (+2.004 ms, +8.333 ms, -5 ms, +16.667 ms): `tests/mission/controls-v1.json`,
   compared by the lead's `tools/dev/mission-baseline.ts` (`compareEnvelope`; commit 431930f, which also
   moved `baseline-v1.json` to format 2 with the EXACT and ENVELOPE modes). Asserted by
   `tests/mission/full-mission.test.ts` ("envelope").

`baseline-v1.json` remains the exact reference for bit-identical starts only.

One number differs from the wording of the decision and is stated here so nobody is surprised: in the
same-start comparison a, e, energy and h agree within 5.0e-10 (inside the 1e-9 named), but the plane
angles differ by up to 2.0e-9 rad (i) and 7.7e-9 rad (LAN), and every event is 18.6 microseconds later
than in the reference. Cause, measured: the v1 clock summed float instants while it warped on the pad and
lifted off 18.6 microseconds before the whole tick; the Earth turns 1.4e-9 rad in that time, and closed-loop
steering carries that into the plane angles (LAN 1.4e-9 rad at lift-off, 7.7e-9 at worst, 2.4e-11 at
EARTH_ORBIT). The test therefore holds i and LAN to 1e-8 rad and event times to 1e-4 s, and a, e, energy
and h to 1e-9.
