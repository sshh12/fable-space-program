Status: accepted (lead decision: eight-component swell; data change in progress by the lead)
From: ocean
Owner path: data/defs/bodies/earth.json (`ocean.swell`; the lead's body data)
Blocking: no

## Problem
The physics swell is the only wave HEIGHT longer than 25 m that the renderer may draw (the FFT chop is
high-passed at 25 m so that physics and rendering share the long waves, ARCHITECTURE 10.2 / ocean brief). It
has four monochromatic components (180, 95, 52 and 28 m, one direction each). From about 1.5 km to 15 km above
the sea everything shorter than about 25 m is below a pixel, so these four are the only resolved waves there,
and they cross into a perfectly regular lattice in the sun glint. A real sea at those scales is a continuous
spectrum with directional spread: an irregular, short-crested pattern.

## Evidence
- `out/screens/ocean/alt10k.png` and `climb-4796m.png` (`npx playwright test tests/browser/ocean/screens.spec.ts
  --project=functional`, lab `/labs/ocean/?preset=alt10k`): a fine diagonal cross-hatch in the glint.
- Integrated app: `out/screens/integration/water-climb-all-2km.png` (core-support's water spec): regular
  corrugation rows.
- `node -e` on `data/defs/bodies/earth.json`: `ocean.swell` has 4 entries; the renderer takes up to
  `MAX_SWELL` = 8 (`src/render/ocean/swell.ts`); `oceanSwellHeight` (`src/core/geo/oceanSwell.ts`) takes any
  number.

The ocean now adds render-only, normals-only long-wave texture in its own paths (hand-off section 4), which
breaks the lattice up visually, but the heights the capsule floats on stay these four sinusoids.

## Requested change
Eight swell components instead of four, chosen as a coarse sample of a real long-wave sea: a swell system plus
the long end of the 7 m/s wind sea (`windDirDeg` 60 = the wind blows toward 60 deg at the splashdown zone):
- wavelengths spread between about 30 m and 200 m, no two within 15 % of each other (for example 200, 150, 115,
  90, 70, 54, 42, 32 m);
- directions spread over about +-45 deg around two mean directions (a swell from one direction, the wind sea
  along the wind), no two components within 15 deg of each other where the splashdown happens;
- amplitudes falling with wavelength roughly as a JONSWAP tail (a ~ lambda^0.75 ... lambda^1), with the total
  height variance sum(a^2 / 2) about what it is now (0.18 m^2, significant height about 1.7 m) and every
  steepness a k below 0.06;
- phases spread over 0 .. 2 pi.
Must NOT change: `oceanSwellHeight` and its signature, `seaLevel`, the order of magnitude of the heights (the
splashdown dynamics and the ocean's swell-agreement spec use them). The ocean needs no code change: the
renderer reads any count up to 8 and its swell spec compares against whatever the data holds.

## Resolution
Escalate: lead

`data/defs/bodies/earth.json` is the lead's (`data/defs/bodies` is not a path of core-support or of any
wave-2 package), and `ocean.swell` is shared with the simulation: the physics swell of the splashdown is the
same list (`src/core/geo/oceanSwell.ts`), so adding components changes the vessel's motion in the water as
well as the picture. That is a decision about the mission, not a rendering fix.

Recorded for the lead in `docs/handoff/core-support.md` with your evidence. What supports it from the
integrated lab: `out/screens/integration/water-climb-all-2km.png` and the neighbouring frames of
`tests/browser/integration/water.spec.ts` show the regular rows between 1.5 km and 15 km. Nothing in the
core limits the count (`oceanSwellHeight` takes any number of components; your renderer takes up to 8).

## Lead decision (2026-11-11)

Accepted: option 1 of ocean-6, the data. What is drawn stays what the capsule rides (ARCHITECTURE 10.2); option 2
of ocean-6 would break that rule and is declined. The lead replaces `ocean.swell` in data/defs/bodies/earth.json with
eight components as specified here (wavelengths about 200-32 m, directional spread around the wind plus one swell
system, amplitudes on a JONSWAP-like tail, total variance about 0.18 m^2, every steepness below 0.06), re-flies the
headless mission, re-checks the splashdown gates and re-records tests/mission/golden.json. This request is marked
resolved with the commit when that is done.
