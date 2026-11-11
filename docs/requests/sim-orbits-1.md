Status: resolved (commit 3d9fcae)
From: sim-orbits
Owner path: docs/WORK_PACKAGES.json (start-time constraints in the sim-orbits and sim-world-pilot briefs; scenario start policy)
Blocking: no

## Problem
The three scenario start-time constraints, with (a) read as the brief writes it (a coplanar ASCENDING-azimuth
launch opportunity 600 s after the start), cannot all be met in 2027-2030 for the resolved Ka Lae LC-1 pad
(18.987556 N, 155.603239 W, 21.62 m; commit 46b8647) and the lunar target, neither the nominal one
(0.674 N, 23.473 E) nor the bake-recommended one (0.661471 N, 23.435999 E in
data/defs/regions/moon-tranquility.json). Constraint (c) asks the landing-site Sun to stay within 5-35 deg
from start + 3 d to start + 5 d, but the lunar Sun climbs about 24.4 deg in those two days, so only a 5.6 deg
band of elevations at start + 3 d works, while successive ascending launch opportunities (one per sidereal
day) step that elevation by about 12.2 deg, and the pad-morning constraint (b) holds on only ~25 days per year.
In every year 2027-2030 the ascending sequence steps over the band. The DESCENDING (southbound, ~99 deg)
crossing of the same plane is just as coplanar (sim-design 12 and 15.1: "azimuth 81 deg ascending or 99 deg
descending"; no plane change at TLI either way), and it does have solutions in the range.

## Evidence
All numbers below are for the current pad and the nominal target, produced by tools/sim/findStartTime.ts and
re-asserted by tests/unit/sim-orbits/startTime.test.ts from tools/sim/start-time.json.

`npx tsx tools/sim/findStartTime.ts --extend-years 0` exits 1: "no start time in [2027-01-01, 2031-01-01)
satisfies the constraints (1465 opportunities in the requested range)". Closest ascending misses (all with
(a) and (b) met), from start-time.json `search.nearMissesInRequestedRange`:

| start (UTC) | pad Sun | landing Sun over +3 d .. +5 d | violation |
|---|---|---|---|
| 2028-08-07 18:10:13 | 28.8 deg | 4.35 -> 28.83 deg | 0.65 deg below 5 |
| 2029-08-26 16:56:28 | 10.9 deg | 12.30 -> 36.75 deg | 1.75 deg above 35 |
| 2027-08-19 17:26:01 | 18.1 deg | 2.38 -> 26.84 deg | 2.62 deg below 5 |
| 2030-08-14 17:44:36 | 22.6 deg | 2.10 -> 26.58 deg | 2.90 deg below 5 |

First exact ascending solutions: 2037-08-23T17:08:01Z (pad Sun 13.7 deg, landing Sun 9.5 -> 34.0 deg, launch
azimuth 80.6 deg), then 2040-08-18, 2042-08-25, 2043-08-14, 2045-08-20. The bake-recommended target gives
the same dates (2028-08-07 misses by 0.68 deg; 2037-08-23 lands at 9.47 -> 33.93 deg).

Descending crossings in 2027-2030 (start-time.json `otherLaunchKinds`, checked with
`checkStartConstraints(..., { launchKind: 'descending' })`; an independent re-implementation by the reviewer
found the same two):

| start (UTC) | launch | pad Sun | landing Sun over +3 d .. +5 d | margin to the nearest bound |
|---|---|---|---|---|
| 2028-10-05 17:42:46.7 | +600 s, azimuth 99.40 deg | 19.85 deg | 5.23 -> 29.65 deg, lit | 0.23 deg |
| 2029-09-24 18:26:58.8 | +600 s, azimuth 99.40 deg | 30.87 deg | 7.47 -> 31.90 deg, lit | >= 1 deg (2.47 / 3.10 / 4.13) |

## Requested change
Decide the start policy. Options, each needing no engine change (the tool, the constraint check and the
tests already support all of them):
1. Accept the first exact ascending solution after the range (what tools/sim/start-time.json holds now:
   `search.searchExtended = true`, startUt 1187932081.163427 = 2037-08-23T17:08:01Z).
2. Accept either coplanar azimuth: `npx tsx tools/sim/findStartTime.ts --launch-kind either` (or
   `descending`) picks 2029-09-24T18:26:58.8Z (ut 938240818.839663; the first solution with 1 deg margin
   on every bound; 2028-10-05 is the first plain one). The scenario test must then call
   `checkStartConstraints(..., { launchKind: 'either' })` (start-time.json `constraints.launchKind`).
   The mission profile is unchanged (coplanar parking orbit, TLI without plane change); only the launch
   heading is southeast instead of northeast, still within Ka Lae's open-ocean sector (60-130 deg).
3. Relax (c) to a 4 deg minimum: `npx tsx tools/sim/findStartTime.ts --landing-sun-min 4` picks
   2028-08-07T18:10:13Z (ut 902556613.3253119; landing Sun 4.35 -> 28.83 deg); the scenario test then uses
   `{ landingSunElevationDeg: [4, 35] }`.
4. Change the stay window (`--stay-from-days`, `--stay-to-days`), e.g. start + 3.1 d .. + 5 d.
Whatever is chosen, the values used are recorded in start-time.json `constraints`, and the sim-orbits test
re-checks the file with exactly those. What must NOT change: constraint (a) must stay a COPLANAR crossing
(ascending or descending) 600 s after the start - the TLI-without-plane-change profile depends on that.

## Resolution
Lead decision: **option 2 - either coplanar azimuth**. Constraint (a) reads "a coplanar launch opportunity to
the Moon's orbit plane, ascending or descending, 600 s after the start"; (b) and (c) are unchanged (pad Sun
10-35 deg; landing-site Sun 5-35 deg and rising from start + 3 d to start + 5 d, lit throughout), and so is
the 2027-2030 range.

Why this one: it keeps every number of the scenario constraints and the search range; the descending
crossing is exactly as coplanar as the ascending one (sim-design 12 and 15.1 name both azimuths), so the
profile that keeps the mission flyable by hand - parking orbit in the Moon's plane, TLI from any revolution
without a plane change - is untouched; the heading (99.4 deg) lies inside Ka Lae's open-ocean sector; and the
chosen date has at least 1 deg of margin on every bound, a pad in full morning daylight (Sun 30.9 deg) and a
low Sun for relief at lunar touchdown (7.4 deg at start + 3 d, about 11 deg half a day later). Option 1 leaves
the range by seven years for no gain, option 3 lowers the landing Sun below the 5 deg that keeps the landing
site out of long crater shadows with only 0.35 deg to spare at start + 3 d, option 4 moves the stay window
the mission timeline is built on.

What changed:
- `tools/sim/start-time.json` regenerated with
  `npx tsx tools/sim/findStartTime.ts --launch-kind either --landing-lat 0.661471 --landing-lon 23.435999`
  (final pad 18.987556 N 155.603239 W 21.62 m; the bake-recommended lunar target): **startUt
  938240818.839663 = 2029-09-24T18:26:58.839Z**; launch at +600 s (18:36:58.8Z), descending crossing,
  surface azimuth 99.4021 deg; pad Sun 30.866 deg; landing Sun 7.4353 -> 31.8633 deg, rising, lit;
  `constraints.launchKind` = 'either'. `tests/unit/sim-orbits/startTime.test.ts` re-asserts the file.
- Briefs: sim-orbits (item 6, constraint (a)) and sim-world-pilot (FIRST STEP: re-run with
  `--launch-kind either`, the expected result, the scenario test calls `checkStartConstraints` with the
  file's `constraints`, launchKind 'either'; a daylight splashdown is preferred where the trajectory leaves
  a choice, not a gate). ARCHITECTURE section 1 row 28; `sim-design.md` 15.3 constraint (a).
- No engine change. `START_CONSTRAINT_DEFAULTS.launchKind` stays 'ascending' (the function's default; the
  sim-orbits test pins it), so callers pass the kind from the file. `padAzimuthDeg` stays 90: the pilot (and
  the player) rolls the ventral side to the launch azimuth after tower clear, as sim-design 16.2 describes.
