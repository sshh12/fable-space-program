Status: declined
From: atmosphere-clouds
Owner path: tools/bake/earth (clouds.py), data/tiles/earth/globals/cloudCoverage.png
Blocking: no        (the renderer reads the present map as an opacity with a wide range; a better map would lift the deep-space views further)

## Problem
The baked cloud map has less information than its two channels promise.
1. Coverage is clipped: 22 % of the texels are at 0.9 or above, 19 % at 0.95 or above. Inside every large
   weather system the map is flat white, so from 60,000 km and beyond a system has no internal structure
   of its own (the renderer adds mesoscale noise, which is gone at those pixel sizes).
2. The cloud-top channel is nearly a function of the coverage channel (both come from the infrared
   opacity): coverage 0.02-0.2 has tops of 3.4-5.1 km (p10-p90), 0.2-0.5 has 4.8-6.7 km, 0.5-0.8 has
   5.9-8.4 km, 0.8-0.95 has 6.9-9.6 km, above 0.95 has 8.2-12.1 km. There is no thin high cloud (low
   coverage, high top) and no low overcast (high coverage, low top) in it, so the renderer cannot tell a
   stratocumulus deck from a front, or cirrus from scattered cumulus.

## Evidence
`python -I` over the PNG (8192 x 4096, bands L and A): histogram of the coverage channel in ten bins:
0.337, 0.071, 0.059, 0.051, 0.050, 0.048, 0.050, 0.051, 0.061, 0.223; the percentiles of the top channel
per coverage band above. Visual review, out/qa/wave2/atmosphere-clouds.md, item 9 ("the baked coverage
map ... is clipped, with 22 % of its texels at 0.9 or above").

## Requested change
A re-bake of `cloudCoverage` (same file, same size, same two channels, so nothing downstream changes) with
- channel 0 as an optical-depth index with real dynamic range inside systems: for example
  `1 - exp(-tau / 12)` of an optical depth estimated from the composite's brightness, or the infrared
  opacity before the clear-sky normalisation is clamped, so that cores, bands and thin edges of a system
  differ;
- channel 1 from a source that is independent of channel 0 where one can be had (a cloud-top-pressure or
  cloud-top-temperature product; MODIS / VIIRS L3 are public domain), so that low decks and thin cirrus
  exist. Where no such source is available, say so in the hand-off and leave the channel as it is.
Must not change: the manifest entry, the channel order, the size, the licence situation of the tile set.

## Resolution

Declined for this pass, with the reasons and what it would take (recorded for the lead in
`docs/handoff/core-support.md`):

- Channel 0 (coverage with dynamic range): the clipping is made by the bake itself, `coverage =
  smoothstep(0.06, 0.80, c)` of the infrared contrast c (`tools/bake/earth/clouds.py`), so a re-bake with a
  gentler mapping (`1 - exp(-tau / 12)` of an optical-depth estimate, or c itself above 0.8) would give the
  systems their inside. But the source is a REAL-TIME snapshot (clouds.matteason.co.uk, taken at bake time)
  and the raw file is no longer in `data/cache/earth/src` (deleted for disk space after the wave-1 bake). A
  re-bake would download today's weather: every cloud on the planet moves, so every package's calibrated views
  and the integration checks' chosen places (the clear sky at 12 N 33 W, the overcast at 42 S 19 E) would
  change in the middle of the visual close-out. Not worth that for a non-blocking item now.
- Channel 1 (cloud top independent of coverage): the public-domain products that carry it (MODIS / VIIRS L3
  cloud-top pressure, MOD08 / VNP L3) are served by LAADS DAAC behind an Earthdata login, which this
  machine's tools do not have. As the request says for that case: the channel stays as it is.
- For the lead (wave 3): keep the raw composite with the bake (it is 30 MB), re-bake channel 0 with an
  optical-depth index, and get an Earthdata token for an L3 cloud-top source for channel 1; the manifest
  entry, channel order and size stay as they are, so nothing downstream changes.
