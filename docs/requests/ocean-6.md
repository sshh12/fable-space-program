Status: open
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
