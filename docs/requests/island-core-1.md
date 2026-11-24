Status: resolved in the code (lead decision of 2026-11-24: formation by the join distance goes in; commit 2e23f69). OPEN with the lead: the re-record of the pinned guard
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

## Resolution
The lead decided: formation by the join distance is the v2 design; the guard protects the flight a player
flies, and unattended debris stepped in another regime may differ. Applied in 2e23f69 with the proof and the
table in docs/handoff/island-core.md, section 6: every attended vessel EXACTLY equal (17 of 17 milestones in
every field, 596,933 steps, all 400 guard samples), golden `f0c0855ea40d8c59`.
CORRECTION of this request's evidence: it named one fate outside the tolerance. There are three (the test
stopped at the first row; it now names all): "Lander adapter fairing panel 3" (511.9 m), "Heron ascent
stage" (8.6 s and 57.9 km: it is taken over by the Reduced tier during the entry at 11 km/s) and "Kestrel
apex cover" (1.6 s inside the time tolerance, 695.8 m). The clamps differ at samples 7 to 11 by up to 8 ulp.
To re-record (the lead's records agent; `tests/mission/trajectory-guard.json` and its pin): `samples[7..11]
.firstShed` and the three `debris` entries above (or the whole debris list from one flight of this tree).
Until then `npm run test:mission` has two red tests, both of the guard.
