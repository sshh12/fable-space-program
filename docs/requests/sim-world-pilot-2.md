Status: open
From: sim-world-pilot
Owner path: docs/ARCHITECTURE.md (section 18.2)
Blocking: no

## Problem
Section 18.2 says the browser mission takes "about 20-25 minutes" of real time. With the pilot driven
through `Sim.advance(1/60, onControlTick)` and the warp rules of sim-design section 5 it takes about 45
minutes, and no pacing of this flight plan can bring it to 25: the flight that must be integrated (ascent,
burns, alignment turns, proximity after separations, entry, parachutes) is 82.5 minutes of simulation time,
which is 20.6 minutes even if every physics step ran at 4x, and the coasts add 18 minutes on rails (each step
down a warp level waits out the 4 s of real-time look-ahead; 50x is the most a 185 km parking orbit allows).
Whoever writes the Playwright `mission` spec should budget for it.

## Evidence
`node tools/dev/heavy.mjs --class=cpu -- npx tsx tools/sim/flyFrames.ts` (the same loop as the app, real
Sim, real tiles): `161656 frames = 44.9 min of real time at 60 Hz`; `95924 frames (26.6 min) ran 594192
physics steps = 82.5 min of integrated flight (20.6 min if every one of them ran at 4x); 65732 frames
(18.3 min) advanced on rails`. Per-phase table in docs/handoff/sim-world-pilot.md ("Through Sim.advance").
`tests/mission/browser-loop.test.ts` asserts under 50 minutes. Before this package's review fixes it was
52.7 minutes; 7.8 of them were a defect in the world's warp look-ahead (fixed) and pilot pacing.

## Requested change
In docs/ARCHITECTURE.md 18.2 replace "(about 20-25 minutes)" by "(about 45 minutes at 60 Hz; the per-phase
table is in docs/handoff/sim-world-pilot.md)". Nothing else: the Playwright `mission` project timeout
(3 hours in playwright.config.ts) already covers it. If 45 minutes is too long for the acceptance run, the
levers are rule changes, not pilot changes, and they are the lead's to decide: the 4 s look-ahead of
sim-design 5.3 (the step-downs are roughly half of the 18 minutes on rails, so 2 s would save a few
minutes: an estimate, not measured) or the 4x cap of physics warp.
