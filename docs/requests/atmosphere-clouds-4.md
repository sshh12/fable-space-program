Status: open (lead decision: approved; to be done in the order below)
From: atmosphere-clouds
Owner path: `'atmosphere.aerialPerspective'` in src/core/contracts/render.ts; chunk `transparency` (`applyAtmosphere`) in src/render/core/shaders/chunksLighting.ts
Blocking: no

## Problem
`'atmosphere.aerialPerspective'` has one transmittance for three colour channels (`a` = mean
transmittance). The opaque scene behind 50 km of air is reddened (blue is scattered out of the path, red
is not); a transparent at the same distance is dimmed by the same factor in all three channels. Its
brightness can be made to match (this package publishes the luminance-weighted transmittance), its colour
cannot: smoke, plumes and canopies stay neutral where the terrain behind them turns warm.

## Evidence
`npx playwright test tests/browser/atmosphere/transparents.spec.ts --project=functional -g "50 km"`:
a white quad 50 km away, `transparent rgb 10162, 12171, 14668 / opaque rgb 11611, 11626, 11378`: luminance
ratio 1.03 (inside the brief's 5 %), red -12 %, blue +29 %. Screenshot
`out/screens/atmosphere/transparent-vs-opaque-50km.png`.

## Requested change
A second volume with the per-channel transmittance, so that existing readers of `.a` keep working:

- new shared resource `'atmosphere.aerialTransmittance'`: 32 x 32 x 32 `rgba16float`, rgb = transmittance
  of the path from the eye to the froxel per channel, a unused (1); same slice mapping; default rgb 1;
- in `applyAtmosphere`: `let trans = vec3f(1.0) + (textureSampleLevel(aerialTransmittanceTex, ...).rgb - 1.0) * nearFade;`
  in place of the scalar, bound by `sceneBindings('transparency')`.

This package computes the per-channel value already (it reduces it to one number when it writes the
volume) and will publish the second volume in the same compute pass the day the key exists; the spec above
then asserts each channel within 5 %. Must not change: the signature of `applyAtmosphere`, the meaning of
`'atmosphere.aerialPerspective'`, neutrality with the default resources.

## Resolution
Declined for this wave, with what it takes and the numbers for the lead. The colour error is real and
confirmed from outside your package: `tests/browser/integration/clouds.spec.ts` (the real plume of the
vehicle 50 km away, with and without the atmosphere) measures 0.758 / 0.756 / 0.753 of the plume's light
left in r / g / b, where the air between camera and vehicle transmits 0.880 / 0.749 / 0.499 by the
definitions (mean 0.734): the brightness is right, the reddening is missing.

Why not now: `applyAtmosphere` lives in the chunk `transparency`, whose textures come from the binding set
`transparency`. A fourth texture in that set shifts the bindings of every feature that places its own
bindings after its scene bindings: the cockpit's cabin shader (finished and delivered) has the set at
bindings 10-18 and a uniform of its own at 19, so its pipelines would stop compiling; vfx and the sky lay
theirs out with the helper and would be fine. A second chunk with a second binding set, to which each
package moves by its own edit, is additive but changes nothing until vfx, cockpit, vehicle and sky have
each made that edit, and three of them have delivered.

For the lead, at integration (about thirty lines in the core, one line per package):
1. contract key `'atmosphere.aerialTransmittance'` (32 x 32 x 32 rgba16float, rgb = transmittance per
   channel, default 1), default in `src/render/core/resources.ts`;
2. binding set `transparency`: add the slot LAST; in `applyAtmosphere`
   `let trans = vec3f(1.0) + (textureSampleLevel(aerialTransmittanceTex, ...).rgb - 1.0) * nearFade;`;
3. cockpit: move its own uniform from binding 19 to 20 (`src/render/cockpit/shaders.ts`);
4. you publish the volume; your "50 km" spec and `tests/browser/integration/clouds.spec.ts` (which then
   compares each channel with its own transmittance instead of the mean) hold it.
Recorded in `docs/handoff/core-support.md`, "what the lead should look at first".

## Lead decision (2026-11-11)

Approved: transparents must take the per-channel reddening the opaque scene behind them takes (PROMPT: photoreal at
every distance). The binding conflict is handled by ordering, not by a second chunk:
1. **cockpit** (its fixer): stop hard-coding binding 19 for its own uniform; place it after the scene binding set's
   length (`sceneBindings('transparency')` helper) so a slot added to the set cannot collide. Filed as request
   cockpit-cs-2 by the shared-code maintainer when it starts this item.
2. **shared-code maintainer**: once cockpit-cs-2 is resolved, add `'atmosphere.aerialTransmittance'` (32^3 rgba16float,
   rgb per-channel transmittance, default 1) to the contract and the resources, add it LAST to the `transparency`
   set, and use it in `applyAtmosphere` as written above; keep `'atmosphere.aerialPerspective'` unchanged; RENDER_API
   in the same commit; tell vfx, sky and vehicle in a NOTICE.
3. **atmosphere-clouds** (its fixer): publish the volume from the existing compute pass; its "50 km" spec and
   tests/browser/integration/clouds.spec.ts assert each channel within 5 %.
