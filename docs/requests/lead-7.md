Status: open
From: the lead (the recording of the reference images before sub-wave 3.2, 2026-11-12; docs/handoff/lead-baseline-v2.md section 22)
Owner path: src/render/ocean/** (ocean)
Blocking: no (the checkpoint that showed it is framed without the sea)

## Problem
After the simulation has advanced and been frozen again, the near sea is not the same picture on every
load. A frame-exact capture restarts every temporal sequence so that its frames depend on the scene alone
(RENDER_API section 13); the sea close to the camera then still carries something of the frames before the
capture. The ocean package has no `resetTemporal` (no occurrence in `src/render/ocean`).

## Evidence
`ascent-cloud-deck` as first corrected: the integration lab on the FakeSim, a ground camera 3 km east of
the pad and 60 m above the sea looking at the vehicle, the simulation stepped for exactly 180 frames of
1/60 s with the loop stopped and then frozen
(`/labs/integration/?scene=ascent&start=450&throttle=1&sun=140,50&sunsite=earth,18.987556,-155.603239&hud=0&governor=off&deterministic=1&paused=1`,
then `__integration.watchVesselFrom({ bodyId: 'earth', latDeg: 18.987556, lonDeg: -155.574706, alt: 60 })`
and the stepping of the manifest's present entry). The lead's probe with four loads
(`BASELINE_EXACT_LOADS=4`), 2026-11-12, tree at 9a873e0:

- within each load the second and third capture are identical; the first (the lead-in) differs from them
  in 130,000 to 147,000 pixels by up to 9 levels, most of them in the bottom rows of the frame, where the
  near sea is;
- load 1 against load 2: 37,118 pixels differ by up to 30 levels; load 1 against loads 3 and 4: 53,679
  pixels by up to 8 levels, and loads 3 and 4 are identical to each other. Again the bottom rows hold most
  of them. So the sea settles into one of a few states, by how many frames the page had drawn before the
  stepping began;
- the recording's own three loads had agreed (mean difference 0.00006), and a fourth load in the self-check
  then differed in 1.72 % of the pixels, at the edge of the tolerance.

The same framing without the stepping (the page frozen from its first frame) is identical on every load,
and so are the four ocean stations, the shoreline apart from a 99.9th percentile of one level, and the
splashdown: this shows only once the simulation has moved.

## Requested change
Add `resetTemporal()` to the ocean feature and restart there whatever the near field keeps from the frames
before (the accumulated foam, a progressive or round-robin update of the wave cascades, a history of the
near patch), so that the sea of a capture is a function of the snapshot and of the capture's frames alone.

## Acceptance
The framing above, put back into a scratch manifest entry, probed with `BASELINE_EXACT_LOADS=4`: every
load identical to the first.

## What the lead did meanwhile
`ascent-cloud-deck` is framed from 1.2 km north of the pad looking up at the vehicle: sky, clouds, the
vehicle and its plume, no sea. Four loads of that are identical to the bit.

## Lead note (2026-11-12, 19:10): the shoreline as well

`shoreline` (frozen from its first frame, never stepped) is the other recorded checkpoint in which the sea
differs between loads: the recording's three loads differ by a 99.9th percentile of one level (mean
0.00097), and a fresh load in the self-check differed from the reference in 0.183 % of the pixels by up to
3 levels. It is compared within a tolerance and marked `notExact` in the manifest with this request. A
probe of four loads at 19:08, with this package's work in progress in the tree, gave four identical
loads: when the fix is in, the lead re-records `shoreline` and it should become `exact`.
