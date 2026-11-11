Status: open
From: vfx
Owner path: src/render/core/post (exposure adaptation)
Blocking: no

## Problem
Auto-exposure moves towards a brighter scene at 2.5 EV/s whatever the distance. A night launch takes the
frame from the dark-adapted floor (EV100 about -3, or a few EV with a floodlit pad) to the exposure of a
sunlit scene (the plume and the cloud it lights: EV100 14 to 16): 15 EV or more, six seconds at 2.5 EV/s.
For those seconds, from ignition to several seconds after lift-off, the plume, the pad cloud and the lit
ground are a white area with a frame-wide bloom. A camera's (or an eye's) reaction to a sudden bright light
takes a fraction of a second for the first ten stops; the slow part is the last stop or two.

## Evidence
- `tests/browser/vfx/liftoff.spec.ts`, night, pad camera (ignition 3 s before T+0): EV100 1.6 at T+2 s,
  4.6 at T+4 s, 13.3 at T+6 s, 16.5 at T+8 s. The emissive hints (request vfx-1) give the meter the right
  target from the first frame of ignition; only the speed is missing.
- `out/screens/vfx/liftoff/t0-night.png` (`/labs/vfx/?scene=pad&night=1`, lab time 4 s): blown out.
  The same frame with `&ev=14` is a correctly exposed plume over a glowing cloud.

## Requested change
Make the adaptation rate towards brighter scenes grow with the gap, for example
`rate = 2.5 EV/s x max(1, gap / 2 EV)` (a 15 EV step is then within 2 EV of its target after about half a
second, a 2 EV step behaves as today), or any other law with the same two properties: a jump of ten stops
or more is mostly taken within about half a second, small changes keep today's gentle 2.5 EV/s. The rate
towards darker scenes (0.8 EV/s) and the metering itself should not change. No workaround in vfx paths: a
feature cannot set the exposure, and dimming the plume would break its photometric values.
