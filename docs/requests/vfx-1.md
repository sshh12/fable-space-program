Status: resolved (commit 03242a3)
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

## Resolution
Done with the second option, the explicit hint (core-support, commit 03242a3).

```ts
coreOf(ctx).addEmissiveHint(luminance: number, coverage: number): void
```

Call it from `prepare`, every frame an emitter is in view, once per emitter (or once with a total).
`luminance` = representative luminance of its visible part in cd/m^2 (not pre-exposed; a mean over the
bright part, not the peak of one pixel). `coverage` = fraction of the frame it covers where there is NO
geometry behind it; the part of a plume in front of terrain or the vehicle is in the histogram already and
must not be counted twice. Hints are used by the next frame's metering and then discarded.

What the meter does with it (`src/render/core/post/exposure.ts`, exterior and map views only; an interior
view meters its cabin):
- the hint is added to the histogram as lit pixels of that luminance and coverage, so a plume over the sky
  counts exactly like the same plume over the ground;
- it raises the photometric prior towards the exposure that keeps the emitter below 4 x mid-grey
  (`EV100 = log2(L / 0.864)`): fully from 1 % coverage, in proportion below, not at all under 0.02 %.

With your numbers: the reentry trail (26,000 cd/m^2) over 2 % of a night frame gives EV100 14.9 instead of
-3: a bright line at 0.72, no frame-wide bloom. RCS jets (22,000) over 0.1 % move the exposure part of the
way (a few EV above the dark floor: the jets stop saturating the bloom, the lander in earthshine does not
go black for a puff); a speck under 0.02 % changes nothing. In daylight an emitter dimmer than the scene
changes nothing. Adaptation speeds are unchanged (2.5 EV/s towards darker images), so a fireball still
flashes for its first tenths of a second, as it should.

Why not the GPU variant: depth-0 pixels above 50 cd/m^2 include the sun's flare and ghosts and the sky's
impostors, so the "sun-disc rule" would have changed (the flare alone moved the exposure by 0.8 EV in a
trial calculation). A hint is exact about what is an emitter.

Tested: `tests/unit/render-core/exposureGovernor.test.ts`, "an emitter over the sky sets the exposure by
its coverage" (night trail, jets, speck, monotonic in coverage, additivity, daylight equality with the same
pixels over ground, interior unaffected). RENDER_API sections 11, 13 and 18. Estimate coverage from the
projected bounds of what you draw (clipped to the frame, times the part that is over sky); a factor of two
either way moves the result by less than a stop near the 1 % knee and not at all above it.
