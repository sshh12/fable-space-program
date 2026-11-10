Status: open
From: sim-orbits
Owner path: docs/WORK_PACKAGES.json (start-time constraints in the sim-orbits and sim-world-pilot briefs; scenario start policy)
Blocking: no

## Problem
The three scenario start-time constraints cannot all be met in 2027-2030 for the Ka Lae site and the lunar
target, neither the nominal one (0.674 N, 23.473 E) nor the bake-recommended one (0.661471 N, 23.435999 E in
data/defs/regions/moon-tranquility.json). Constraint (c) asks the landing-site Sun to stay within 5-35 deg
from start + 3 d to start + 5 d, but the lunar Sun climbs about 24.4 deg in those two days, so only a 5.6 deg
band of elevations at start + 3 d works, while successive ascending launch opportunities (one per sidereal
day) step that elevation by about 12.2 deg, and the pad-morning constraint (b) holds on only ~25 days per year.
In every year 2027-2030 the sequence steps over the band.

## Evidence
`npx tsx tools/sim/findStartTime.ts --extend-years 0` exits 1: "no start time in [2027-01-01, 2031-01-01)
satisfies the constraints (1465 opportunities in the requested range)". Closest misses (all with (a) and (b)
met), from tools/sim/start-time.json `search.nearMissesInRequestedRange`:

| start (UTC) | pad Sun | landing Sun over +3 d .. +5 d | violation |
|---|---|---|---|
| 2028-08-07 18:12:53 | 29.5 deg | 4.38 -> 28.85 deg | 0.62 deg below 5 |
| 2029-08-26 16:59:08 | 11.6 deg | 12.32 -> 36.78 deg | 1.78 deg above 35 |
| 2027-08-19 17:28:41 | 18.8 deg | 2.40 -> 26.87 deg | 2.60 deg below 5 |
| 2030-08-14 17:47:16 | 23.3 deg | 2.13 -> 26.60 deg | 2.87 deg below 5 |

The first exact solution (both targets) is 2037-08-23T17:10:41Z (pad Sun 14.4 deg, landing Sun
9.5 -> 34.0 deg, launch azimuth 80.9 deg); the next ones are 2040-08-18, 2042-08-25, 2043-08-14, 2045-08-20.
With the target moved to >= 24.5 deg E, 2028-08-07 would satisfy all three.

## Requested change
Decide the start policy. Options, each needing no engine change:
1. Accept the first exact solution after the range (what the tool now writes by default: start-time.json has
   `search.searchExtended = true`, startUt 1187932241.46 = 2037-08-23T17:10:41Z). The constraint checks and
   the sim-world-pilot scenario test pass unchanged.
2. Relax (c) to a 4 deg minimum: `npx tsx tools/sim/findStartTime.ts --landing-sun-min 4` then picks
   2028-08-07T18:12:53Z (verified; landing Sun 4.38 -> 28.85 deg). The values used are recorded in
   start-time.json `constraints`; tests re-check with them, and the scenario test downstream must use the
   same numbers (`checkStartConstraints(..., { landingSunElevationDeg: [4, 35] })`).
3. Change the stay window (`--stay-from-days`, `--stay-to-days`), e.g. start + 3.1 d .. + 5 d.
Please do NOT change the definition of constraint (a) (coplanar ascending launch 600 s after the start):
the TLI-without-plane-change mission profile depends on it.
