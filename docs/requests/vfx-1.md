Status: open
From: vfx
Owner path: src/render/core/post/exposureMeter.ts (and exposure.ts)
Blocking: no

## Problem
The exposure meter skips every pixel whose depth is 0 ("sky, stars, sun disc: never metered"). Emissive
transparents drawn over the sky or over space are therefore invisible to it: an engine plume, a reentry wake
or a fireball against a black sky is exposed for whatever geometry happens to be in view, or for the
dark-adapted floor when there is none, and burns out to a white blob with a frame-wide bloom. In daylight
the lit geometry sets a sensible exposure and nothing is wrong; the cases that fail are night launches seen
against the sky, the reentry trail seen from far away at night, and vacuum burns with the vehicle in shadow.

## Evidence
- `/labs/vfx/?scene=reentry&plasma=1&far=1&night=1&paused=1&hud=0` then `__vfx.runTo(20)`: the trail (26,000
  cd/m^2 at most) fills the frame with white; the same shot with `&ev=10` is the thin line it should be
  (`out/screens/vfx/reentry/trail-50km-night.png` is taken with the fixed exposure for that reason).
- `/labs/vfx/?scene=rcs&all=1&sun=-20`: RCS jets (22,000 cd/m^2) on a lander in shadow saturate the frame.
- `/labs/vfx/?scene=explosion&night=1`, `__vfx.runTo(1.2)`: the fireball is a flat white disc.

## Requested change
Let bright transparent pixels take part in metering: either meter the HDR target after the transparent
pass for pixels with depth 0 whose luminance is above a threshold well over the night sky and stars (say
above 50 cd/m^2, so that stars and airglow still never count), or expose a per-frame hint a feature can set
(`ctx.exposure.addEmissiveHint(luminance, coveredFraction)`) that the meter treats like lit coverage. The
sun-disc rule and the "sky is never metered" rule for ordinary sky must not change. No workaround exists in
vfx paths (a feature cannot set the exposure); the vfx luminances are physical and are left as they are.
