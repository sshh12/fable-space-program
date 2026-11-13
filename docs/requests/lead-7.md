Status: resolved for the ocean (39dacd5: resetTemporal; proof and what still differs in "Resolution"); the acceptance's page still differs with every package, by the atmosphere's state after a stepped simulation (request ocean-12)
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

## Resolution (ocean, 2026-11-12, commit 39dacd5; the acceptance's page is NOT yet the same on every load, and what differs there is not the sea)

**What changed** (`src/render/ocean`): `OceanFeature.resetTemporal()`. It drops the foam map's history (whitecaps
and what they left: the next frame starts it from the wave field of the snapshot), the FFT's previous frame, the
impacts gathered from earlier snapshots, the wet lines and the wake's foam, the chart's anchor (kept by hysteresis
while the camera moves: re-anchored where the nadir is) and with it the baked roughness field's centre. All of it
is rebuilt by the next frame; `isIdle()` is false from the reset until that frame. Also: an impact is taken once
however often its snapshot is drawn (a frozen snapshot with a 'splash' in it filled the list with up to eight
copies, by how many frames it had been drawn). The running game is unchanged (nothing else calls the reset).
Wave phases: the swell, the FFT, the surf, an impact's rings and the foam's ageing were and are functions of the
snapshot's time. Two clocks of the shared chunk are not: the far-wave bank's phase on the far sheet and the redraw
of the glitter cells take `frame.time.x` (realTime; 0 in a capture, so captures are exact, but two clients differ).
The chunk can read nothing else in the deferred pass: request `ocean-11` (a simulation clock in the frame uniforms).

**Proof** (`tests/browser/ocean/exact.spec.ts`, 1280 x 720, 64 frames, three loads x three captures per view, and
on the last load one more capture after another history: 47 frames with the camera 60 km away, then back;
differing pixels):

| View | captures of a load | load against load | after another history | the same with the reset switched off |
|---|---|---|---|---|
| `near-sea-stepped` (your framing: 3 km east, 60 m, 180 steps), without the atmosphere package | 0 | 0 | 0 | 0 / 0 / **5 px, up to 2** |
| `splashdown-stepped` (chutes from 20 m, 240 steps to the water), without the atmosphere package | 0 | 0 | 0 | 0 / 0 / **721 px, up to 40** |
| `splashdown` (the manifest's page, every package) | 0 | 0 | 0 | 0 / 0 / 0 |
| `shoreline` (the manifest's page, every package) | 0 | 0, or **1,002 px, up to 3** | 0 | the same |

So the reset is what makes a capture independent of what the page did before (the last column), and the two
stepped views are exact with every package but the atmosphere.

**What still differs, and whose it is.**
1. Your framing with every package: capture 1 against 2 of each load 128,984 to 147,455 px by up to 9; load against
   load 121 to 56,000 px by up to 30; captures 2 and 3 identical. Taken apart: `&without=atmosphere` 0 px in all
   eight pairs (with the ocean's reset and without it); `&without=ocean` still 52,684 and 36,782 px from load to
   load, from row 0 down (the sky); `&without=vfx` 66,376 and 67,102 px. It is the atmosphere package's state after
   a stepped simulation (request `ocean-12`, with the table); the pixels gather in the bottom rows because the
   sun's glitter on the near sea makes a small change of the light large. The ocean was exact in this framing
   before the reset too: the diagnosis "because the ocean has no resetTemporal" does not hold for it.
   Beside it: 24 to 31 px in the plume's column between the first and the second capture of a load (page without
   the ocean): vfx's or the vehicle's, not looked into. `splashdown-stepped` with every package: 1 to 19 px of the
   first capture against the second, 0 without the atmosphere.
2. `shoreline` does NOT become exact by this. One load in three, in two runs of three (two loads of nine), ended in a second state: the
   same 1,002 pixels by up to 3 levels each time, in the far sea just under the horizon (x 585-819, y 166-217 of
   1280 x 720), once with the reset and once with it switched off. The captures of a load and the capture after
   another history are identical in both states, so it is not a history: it is something that is there or not when
   the page goes idle (a tile or a texture that arrives, a cloud's shadow from a map that is loaded). Not attributed:
   it takes about six loads to see it once. Your four identical loads at 19:08 were the common state. The spec
   holds it as a named, bounded difference and prints it when it shows; `notExact` with a tolerance stays right.

**The recorder's list of what the sea pictures show** (not touched now), against the round-2 critique
(`docs/qa/wave2/ocean.r2.combined.json`), after looking at `data/baselines/shoreline.png` and `ocean-climb-200m.png`:
- `shoreline`, the concentric arcs beyond the shore: RECOGNISED, finding 2 (slicks drawn as level lines of the
  stream function: closed loops and concentric rings around an eddy). The pale diagonal streak at the left:
  RECOGNISED, the same family (finding 2; finding 14 names the fronts of that field as straight pale lines). The dark
  smear band at the left: NEW, and probably not a defect of the sea: it lies where a cumulus stands between the sun
  and the water, a cloud's shadow seen at a grazing angle (since round 3 the shaded sea mirrors the cloud's base,
  not the blue sky); to be confirmed with the clouds off before anyone works on it.
- `ocean-climb-200m`, the two long curved bands to the horizon: RECOGNISED as finding 14 / 2 (fronts and slick
  lines of the roughness field, pale under an overcast because calmer water mirrors more of the sky); they follow
  the field's streamlines towards the horizon and are not arcs about the camera, so they are not the ring of
  ARCHITECTURE 31.3 (the hand-over spec's ring ratio is 1.37 against 1.6). The stark white blobs: RECOGNISED,
  finding 4 (whitecaps as stamped decals) with finding 8 (foam as one flat white).
- `ocean-climb-20km`, `reentry-peak-heating`, thin concentric arcs in the cloud gaps and in the glitter:
  RECOGNISED, finding 2 again (the same level lines from 3 to 100 km).
All of these but the smear band are the first items of the ocean's next visual round (finding 2 above all).
