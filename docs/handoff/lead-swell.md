# Lead: eight-component physics swell (requests ocean-5 / ocean-6)

Status: DONE (data commit 9d48042; ocean-5 and ocean-6 resolved; lead-1 resolved by the maintainer in bc3e291).

## What changed

`ocean.swell` of `data/defs/bodies/earth.json` (lead-owned) went from four monochromatic components (180, 95, 52,
28 m, one direction each, crossing into a regular lattice) to eight, chosen as a coarse sample of a real long-wave
sea at the splashdown: a swell system from the north-west and the long end of the 7 m/s wind sea along the wind
(`windDirDeg` 60 = the compass direction the wind blows toward, `data/defs/render/earth.ocean.json`).
Nothing else changed: `oceanSwellHeight` and its signature, `seaLevel`, the height variance (0.18 m^2) and the
order of magnitude of the heights are as before; no code changed. `tests/mission/golden.json` was re-recorded.

| # | lambda (m) | toward (deg) | system | a (m) | a k | period (s) | phase (rad) |
|---|---|---|---|---|---|---|---|
| 1 | 200 | 146 | swell | 0.3526 | 0.0111 | 11.3 | 0.691 |
| 2 | 150 | 164 | swell | 0.2842 | 0.0119 | 9.8 | 4.574 |
| 3 | 115 | 125 | swell | 0.2329 | 0.0127 | 8.6 | 2.174 |
| 4 | 90 | 61 | wind sea | 0.1937 | 0.0135 | 7.6 | 6.058 |
| 5 | 70 | 41 | wind sea | 0.1605 | 0.0144 | 6.7 | 3.658 |
| 6 | 54 | 80 | wind sea | 0.1321 | 0.0154 | 5.9 | 1.258 |
| 7 | 42 | 21 | wind sea | 0.1094 | 0.0164 | 5.2 | 5.141 |
| 8 | 32 | 101 | wind sea | 0.0892 | 0.0175 | 4.5 | 2.741 |

| Quantity | Before (4 components) | After (8 components) | ocean-5 asks |
|---|---|---|---|
| Height variance sum(a^2/2) | 0.1817 m^2 | 0.1800 m^2 | about 0.18 |
| Significant height 4 sqrt(var) | 1.70 m | 1.70 m (swell system 1.44 m, wind sea 0.90 m) | about 1.7 m |
| Largest steepness a k | 0.0337 (28 m) | 0.0175 (32 m) | < 0.06 |
| Slope variance (both axes) | 0.00124 | 0.00081 | (the ocean's long-wave layer carries the rest) |
| Amplitude bound sum(a) | 1.12 m | 1.56 m | same order |
| Closest wavelengths (ratio) | 1.83 | 1.28 (115 / 90) | > 1.15 |
| Directions at the splash point | 351, 297, 54, 202 deg (the 28 m wave vector is steep there: surface wavelength 62 m, weight 0.95) | 21-164 deg, closest 18 deg apart (146 / 164), every component at full weight | >= 15 deg apart |
| Phases | 0, 1.3, 2.9, 4.4 | golden-ratio sequence over 0..2 pi, closest 0.57 rad | spread over 0..2 pi |
| Height at the splash point over 30 min | -1.09 .. +1.10 m, rms 0.426 m | -1.35 .. +1.37 m, rms 0.425 m | |
| Surface vertical speed there, max | 0.94 m/s | 1.05 m/s | |

## How the numbers were made

- **Geometry.** Each component is a plane wave in body-fixed space, `a w cos(k R (d . n) - omega t + phi)`
  (`src/core/geo/oceanSwell.ts`). Every `d` is taken TANGENT to the sphere at the nominal splash point P0 =
  15.34 N 141.53 W (the golden flight's splashdown; the perturbed flights and the QA starts come down within about
  1 degree of it), along compass bearing theta: `d = sin(theta) East(P0) + cos(theta) North(P0)`, with
  `East = (-sin lon, cos lon, 0)`, `North = (-sin lat cos lon, -sin lat sin lon, cos lat)` in the frame of
  `latLonToDir`. At P0 every component then has full weight (`|d x n|` = 1), its surface wavelength is exactly
  lambda, it travels exactly toward theta, and its phase is exactly `phi - omega t`. Elsewhere the local
  wavelength stretches by `1 / |d x n|`; the weight stays 1 at all three recovery-zone centres, at the ocean lab
  site (8 N 146 W) and at 0 N 90 E (the sim-vessel water test). `dir` is written to 12 decimals: unit to 4e-13
  (the loader test holds 1e-9).
- **Wavelengths** 200, 150, 115, 90, 70, 54, 42, 32 m as ocean-5 lists them (successive ratios 1.28-1.33).
- **Directions.** The 7 m/s wind sea over a 200 km fetch peaks near 76 m (ocean hand-off; its unit test holds
  40-120 m), so 115 m and longer are on the steep forward face of the wind-sea spectrum, where a real sea holds
  swell instead. Swell system (115, 150, 200 m): travelling toward 125-164 deg, mean 145 (from the north-west, the
  North Pacific swell of the central Pacific), narrow spread +-20 deg: long-crested. Wind sea (90-32 m): 21-101 deg
  around 60, +-40 deg, the components nearest the peak nearest the wind and the spread growing away from the peak
  (90 m at 61, 70 m at 41, 54 m at 80, 42 m at 21, 32 m at 101): short-crested. Spacing 18-24 deg, no two within 15.
- **Amplitudes** `a = C lambda^0.75`, `C = 6.6306e-3` from `sum(a^2/2) = 0.18`. The exponent is the low end of
  ocean-5's range: the equilibrium (Toba) range `S(omega) ~ omega^-4` sampled at log-spaced wavelengths gives
  `a^2 ~ k^-1.5`, i.e. `a ~ lambda^0.75` (the saturation range `omega^-5` would give `lambda^1`). It puts as much of
  the fixed variance into the shorter, visible waves as the range allows, and the split it gives is the physical
  one: wind sea Hs 0.90 m (a fully developed 7 m/s sea has about 0.21 U^2 / g = 1.05 m), swell Hs 1.44 m.
  Amplitudes rounded to 0.1 mm.
- **Phases** `2 pi frac(0.11 + i 0.618034)`, i = 0..7 (golden-ratio sequence).
- **Script.** `swell8.mjs` (the lead's scratch area of this session, not kept in `tools/`, which is the
  maintainer's). It is short enough to restate: the table above plus the three formulas (`d`, `a`, `phi`)
  reproduce the data exactly; `node swell8.mjs --json` printed the eight lines now in `earth.json`.

## Mission before and after

Nominal flight (`tests/mission/full-mission.test.ts`, gate 13 "SPLASHDOWN on water inside a recovery zone, at
no more than 9.5 m/s, crew alive, floating upright after 30 s"):

| | Before (golden df7f7684eabc0028) | After (golden 3f3a131cdd88eba7) | Gate |
|---|---|---|---|
| Splash point | 15.34 N 141.53 W, 1,161.5 km from "Central Pacific" (r 2,000 km) | same (the flight is identical until the water) | inside a zone |
| Vertical speed at first contact | 7.82 m/s | 7.82 m/s | <= 9.5 m/s |
| Tilt at first contact | 3.89 deg | 3.89 deg | |
| Tilt 30 s after | 9.0 deg | 7.5 deg | < 25 deg |
| Largest tilt afloat | 12.9 deg | 14.9 deg | < 60 deg |
| Crew alive, settled for | yes, 30 s | yes, 30 s | alive, >= 30 s |
| Steps | 593,612 | 593,636 | (hash changes after the capsule meets the water) |

Every other milestone, the QA scenario captures (they end at drogue deployment) and the debris list are
unchanged. The perturbed flights and the browser-loop flight on the new sea: engine under-performance
15.83 N 142.49 W, 7.83 m/s, 8.4 deg after 30 s; launch 60 s late 15.36 N 142.05 W, 7.82 m/s, 10.4 deg; sloppy
pitch programme 14.92 N 142.04 W, 7.83 m/s, 11.4 deg; browser loop 15.26 N 140.87 W, 7.82 m/s, 9.9 deg. All
inside the Central Pacific zone (1,126-1,235 km from its centre).

## Checks

| Check | Result |
|---|---|
| `node tools/dev/heavy.mjs --class=cpu -- npm run test:mission` on the new sea, before re-recording | 30 of 31 pass; the one failure is the golden step count / hash (593,636 vs 593,612), as expected |
| `MISSION_UPDATE_GOLDEN=1 npm run test:mission -- tests/mission/full-mission.test.ts` (gated) | passes; golden 3f3a131cdd88eba7, 593,636 steps, tiles unchanged |
| `npm run test:mission` again (gated) | 5 files, 31 of 31 pass, 77.8 s; pilot = replay (3,628 late tile reads) = golden 3f3a131cdd88eba7 |
| `npx vitest run tests/unit/ocean tests/unit/sim-vessel/landing-water.test.ts tests/unit/sim-world/surface.test.ts src/core/defs/loader.test.ts` (gated) | 49 of 50: everything that floats the capsule on the swell or feeds the renderer passes (ocean spectrum, long-wave layer gain in (0, 1), Cox-Munk room, far-wave bank; "rides the shared swell"; splashdown and three minutes afloat from qa-drogues); the one failure was the loader test's pinned count of 4 (request lead-1, fixed by the maintainer in bc3e291: 8 of 8 since) |
| `npx playwright test tests/browser/ocean/swell.spec.ts --project=functional` (gated) | 3 of 3: readback worst 0.019 mm from `oceanSwellHeight` (FFT rms 0.10-0.12 m); damping zone worst 3.9 / 2.8 / 3.0 cm (limit 5 cm), outside rms 0.10-0.13 m; rasterised surface worst 0.020 mm chop off, 5.5 mm chop on |

## Open items

- The ocean's visual critique items 5 and 15 (no wind-sea heights, swell lattice 300 m - 15 km) can be re-judged:
  the drawn heights are now these eight components. Screens: `npx playwright test tests/browser/ocean/screens.spec.ts
  --project=functional` (through the gate) or `/labs/ocean/?preset=alt3k|alt10k|midday|splash`.
- `docs/handoff/sim-world-pilot.md` still quotes the old golden hash `df7f7684eabc0028` and "floating at 9.0 deg
  after 30 s" (its mission-log section); the numbers on the new sea are the ones above. That hand-off belongs to
  sim-world-pilot and is left for its next owner to refresh.
