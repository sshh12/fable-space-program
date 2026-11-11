Status: declined
From: ocean
Owner path: data/defs/bodies/earth.json (`ocean.swell`), and the ocean brief's rule that the swell is the only wave HEIGHT longer than 25 m (lead)
Blocking: no        (the visual critique's items 5 and 15 cannot be closed without it; everything else in the package can)

## Problem
The visual critique of the ocean (`out/qa/wave2/ocean.md`, items 5 and 15, both critics) still finds no wind sea in
the drawn HEIGHTS: from 2-3 m the horizon is a ruled line and no crest hides the base of the capsule; from 300 m to
10 km the resolved long waves are four exact sinusoids. The cause is not in the ocean's paths: the only height
longer than 25 m that the renderer may draw is the physics swell, four monochromatic components (180, 95, 52, 28 m,
steepness at most 0.034), while the 7 m/s wind sea peaks near 76 m. `ocean-5` asked for better swell data and was
escalated to the lead by core-support ("a decision about the mission"); it has had no answer.

What the ocean does within its paths (this round): the long-wave sea is drawn as NORMALS (FFT layer 4, now two
copies only 8 degrees apart so it keeps its own directional spread), whitecaps break on its crests (foam map), and
the far sheet shades a far-wave bank with the same variance. None of it changes the silhouette or the waterline.

## Evidence
- `out/screens/ocean/midday.png`, `splash.png`, `stability-animated.png`: ruled horizon from a 2-3 m camera.
- `out/screens/ocean/climb-273m.png`, `alt3k.png`: evenly spaced swell lines under the long-wave shading.
- `node -e` on `data/defs/bodies/earth.json`: `ocean.swell` has 4 entries; `MAX_SWELL` is 8
  (`src/render/ocean/swell.ts`); `oceanSwellHeight` takes any number.
- Height the renderer leaves undrawn: the long-wave layer's height RMS is 0.47 m (`debug.state().longWave`),
  against 0.11 m RMS for all FFT cascades that are drawn.

## Requested change
Either of the two, the lead's choice:

1. **Data** (what `ocean-5` asked): eight swell components instead of four, as a coarse sample of a real long-wave
   sea: wavelengths about 200, 150, 115, 90, 70, 54, 42, 32 m (no two within 15 %), directions spread over about
   +-35 deg around the wind (`windDirDeg` 60) plus one swell system from another direction, amplitudes falling
   roughly as lambda^0.75..1 with the total height variance kept at about 0.18 m^2 and every steepness below 0.06,
   phases spread over 0..2 pi. The physics and the renderer both read any count up to 8; the ocean needs no code
   change and its swell-agreement spec compares against whatever the data holds.

2. **Rule** (the critics' second suggestion): permission for the ocean to draw the long-wave layer's HEIGHT as
   render-only displacement (reported with the FFT term in the swell-agreement readback, as the brief already
   allows for the chop), blended to the pure physics swell within about ten hull radii of every vessel at the
   water, so the 5 cm waterline criterion holds where a vessel floats. Consequence the lead must accept: away from
   vessels the drawn sea then rises and falls by up to about +-1 m more than the surface the physics knows, so a
   capsule seen from a distance rides a locally calmer patch than the sea around it.

Must NOT change: `oceanSwellHeight` and its signature, `seaLevel`, the order of magnitude of the heights.

## Resolution
Escalate: lead

As with `ocean-5`, neither choice is core-support's to make: option 1 changes
`data/defs/bodies/earth.json`, which is the lead's and feeds the simulation (`src/core/geo/oceanSwell.ts` is
the height the splashdown physics floats the capsule on), and option 2 lifts a rule of the ocean brief and
of ARCHITECTURE 10.2 (the swell is the only wave height longer than 25 m, so that what is drawn is what
the vessel rides).

What I can add for the decision, from the code I maintain:

- Nothing in the core limits option 1. `oceanSwellHeight` (`src/core/geo/oceanSwell.ts`) sums whatever the
  list holds, and no unit test pins the number of components. The cost is in the mission:
  the headless run's log hash changes (every step after the capsule meets the water), and gate 13
  ("floating upright after 30 s", vertical speed at splashdown) has to be met again on the new sea, with
  eight components at up to 0.06 steepness instead of four at 0.034. That is one run of
  `npm run test:mission` (the nominal flight takes well under a minute headless) after the data change, by
  whoever owns `src/sim` then, and a new log hash.
- Option 2 keeps the mission as it is and costs a visible inconsistency instead (a calmer patch around
  every vessel at the water), plus a second definition of "the sea" that the sim does not know (a debris
  piece that splashes down outside the patch meets a surface the picture does not show).
- From the integrated lab the regular rows are there to see between 300 m and 15 km
  (`out/screens/integration/water-climb-all-2km.png`, `water-fadestart-6km-all.png`), and from the capsule
  at the water the horizon is a ruled line (`out/screens/integration/budget-splashdown-end.png`).

If asked for a recommendation: option 1. It is data, it keeps one sea for physics and picture, and its
price is a mission re-run, which the lead will do when integrating anyway.

Recorded in `docs/handoff/core-support.md` (decisions asked of the lead) together with `ocean-5`.
