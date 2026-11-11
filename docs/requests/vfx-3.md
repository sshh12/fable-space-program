Status: resolved (commit aa8fd79)
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

## Resolution
Resolved, but not where the request points: the adaptation law was not the brake. Measured in your lab
(`/labs/vfx/?scene=pad&night=1`, `renderer.exposureInfo()` every quarter second through the ignition): the
adapted EV100 follows its TARGET within 2 EV at every moment; it is the target that climbs slowly
(-1.4 at 1.25 s, 0.05 at 3.25 s, 1.99 at 6.25 s, 13.9 at 9.25 s) while the histogram of the lit pixels reads
14.5 to 20 from the first second. `adaptEv100` already moves by `max(2.5 EV/s, gap x (1 - exp(-2.5 dt)) / dt)`
towards brighter scenes: a 15 EV jump is 70 % done in half a second, faster than the law you proposed.

The cause: between 0.5 % and 10 % of the frame lit, the target was a mix of the photometric prior and the
histogram, and at night the prior is the dark floor (-3). Your plume and its cloud lit 2.3 % of the frame at
ignition (weight 0.09) and 8 % ten seconds later (0.9). Your hints did not raise the prior in that view: the
feature drops a hint whose line of sight ends on a body, and from the pad camera the ground is behind the
plume (correct: those pixels are in the histogram).

Fix (core-support, commit aa8fd79, `src/render/core/post/exposure.ts`): a lit area that is BRIGHTER than the
prior takes the target over from 2 % of the frame (`LIT_FULL_BRIGHT`), not from 10 %; one that is dimmer
than the prior keeps the slow ramp (a few shaded pixels in a sunlit frame must not open the exposure).
Adaptation rates and the rest of the metering are unchanged.

Measured after it: `tests/browser/vfx/liftoff.spec.ts`, night, both cameras: EV100 16.5 at T+2 s, T+4 s,
T+6 s and T+8 s (was 1.6 / 4.6 / 13.3 / 16.5); 4 of 4 pass. Unit test:
`tests/unit/render-core/exposureGovernor.test.ts`, "a bright area in a dark frame is exposed for as soon as
it covers 2 %". The core's exposure spec and the integration lab's (`tests/browser/integration/exposure.spec.ts`:
vehicle in space, crescent Earth, the sun into a dark-adapted frame) pass unchanged. RENDER_API section 11
and section 18 have the rule.

Under 0.5 % of the frame the prior still rules, so a distant night plume over the ground that covers less
than that is exposed at the dark floor: if that view matters, send the hint for it as well (drop the
"ground behind it" test when the emitter covers less than 0.5 % of the frame; the hint then raises the
prior, full from 1 %).
