Status: open
From: island-core
Owner path: tests/mission/trajectory-guard.json (pinned, tools/dev/guard-pins.test.ts); the tolerance of the brief's acceptance line ("debris by fate within 2 s and 500 m")
Blocking: yes        (scope item E, "the 25 km bubble becomes island formation by the join distance", cannot be switched on with the mission green)

## Problem
With island formation by the rules' join distance (1 km + 2 s x closing speed, parting at twice that) instead
of v1's 25 / 27 km, the attended craft still flies bit for bit, but two checks of the pinned trajectory
guard cannot be met, both by construction of the recording:
1. The launch-clamp vessel is compared BIT FOR BIT at 400 ticks. A held vessel inside the island rides the
   body through the step's expression (orientation at the step start turned by spin x dt); outside it, through
   the tick-pure expression (orientation at the tick). The two differ in the last bits. The recording has
   the clamps in the full tier until the rocket is 27 km away; with the join distance they leave at about
   2 km, so the samples in between differ.
2. One piece of debris of thirteen misses the fate tolerance: the reduced tier (a point mass with a
   tumbling-average drag area) takes the fairing panel over at 2 km instead of 27 km.

## Evidence
`node tools/dev/heavy.mjs --class=cpu -- npm run test:mission` with the change of
`out/island-core/e2-formation.diff` (also in docs/handoff/island-core.md, section 6) applied to
`src/sim/world/sim.ts`:
- "sample 7 (control tick 2806, grid), first shed vessel: r[0] = -3680843.144146355, recorded
  -3680843.1441463567; difference 1.862645149230957e-9" (2 ulp);
- "Lander adapter fairing panel 3: 511.9 m from the recorded place" (limit 500 m);
- everything else passes (33 of 36: the two guard tests and the golden hash).
Without the change (v1's 25 / 27 km, the Armed tier on): 36 of 36, golden `f6efbe54f52a40de`.

## Requested change
A decision, then the island-core successor or session-switch applies the diff and re-baselines the golden:
(a) the clamp vessel is debris and is compared by fate like the other twelve (what the brief's acceptance
    line says: "attended craft and the six fixtures; debris by fate"), or to a tolerance (1e-6 m), or it
    stays bit-exact and formation keeps a held vessel in the island out to v1's distance;
(b) the fate tolerance for debris in the reduced tier (511.9 m observed for one panel after about 100 km of
    fall; 500 m asked), or a longer stay in the Full tier for debris in an atmosphere, which is a rule the
    architecture does not have.
What must NOT change: the attended craft's 400 samples, the six fixtures, the pins.
