Status: resolved (commit 4cdeb62: the core's part; publishing the value is the vfx package's, NOTICE-core-1)
From: cockpit
Owner path: src/render/vfx (publish the window radiance of `plasmaWindowRadiance` per frame) and src/core/contracts/render.ts (`SharedResourceMap`: one new key, core-support)
Blocking: no (the cockpit lights its cabin from its own layout value meanwhile; the panes now show the vfx sheath, thank you for cockpit-9)

## Problem
Since c3568bf the sheath is drawn for a camera inside the vessel, and `plasmaWindowRadiance(data, heatFlux,
intensity, speed)` gives what a cabin window sees. The cockpit cannot call it: render packages never import
each other (`tools/dev/boundaries.test.ts`, `src/render/cockpit` may import `src/core`, `src/render/core`,
`src/ui` only). So the cabin's entry light still comes from the cockpit layout's own
`lighting.plasmaLuminance` x `plasmaIntensity^1.5` and `plasmaColor` (data/defs/visuals/cockpits/kestrel.json,
50 cd/m^2, lavender-pink after the EFT-1 frames), which agrees with the panes only by tuning, not by
construction: the light thrown into the cabin and the glow seen through the glass can drift apart whenever
the vfx model changes (heat flux, speed, wake gain).

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/world.spec.ts --project=functional -g reentry`
(integration lab, `scene=reentry`): the panes show the vfx sheath; the cabin is tinted by the layout's value.
`src/render/cockpit/feature.ts` `writeCabin` (CABIN.plasma) is where the number enters the cabin light; the
ambient pass (shaders.ts `AMBIENT_WGSL`) and the probe's window pass read it on the GPU.

## Requested change
Publish, per frame, the radiance the windows of each cabin vessel see, as a shared resource the cockpit can
bind on the GPU without importing the vfx package:
- a key in `SharedResourceMap`, e.g. `'vfx.plasmaWindow': GPUBuffer` (uniform, 16 bytes: rgb = the sheath's
  luminance seen through a lee-side window in cd/m^2, linear colour, for the vessel the camera is in or else
  the active vessel; w = that vessel's `plasmaIntensity`), default all zero;
- written by the vfx feature in `prepare` from `plasmaWindowRadiance` (the same mean over streaks and flicker).
The cockpit will then take its window plasma radiance from that buffer when it is non-zero (and keep its
layout value as the fallback when no vfx feature runs, e.g. its own lab). Must not change: what the vfx draws.

## Resolution

The core's part (`4cdeb62`), additive: `SharedResourceMap['vfx.plasmaWindow']: GPUBuffer` (uniform,
`PLASMA_WINDOW_BYTES` = 16: rgb = the sheath's luminance through a lee-side window in cd/m^2, linear sRGB,
for the vessel the camera is in or else the active vessel; a = that vessel's plasmaIntensity), default all
zero, and the binding set `plasmaWindow` of `createSceneBindings` (`var<uniform> plasmaWindow: vec4f;`).
Bind it from the cockpit's ambient and probe passes and fall back to your layout value while `plasmaWindow.a`
is 0 (no vfx feature, or no sheath). The vfx package publishes it: `docs/requests/NOTICE-core-1.md` tells it
(`ctx.resources.publish('vfx.plasmaWindow', buffer)` once, `queue.writeBuffer` in prepare from
`plasmaWindowRadiance`). Checked: the render-core spec "every default SharedResource works with no feature
present" binds every set with the defaults (3 of 3 with the shell specs). RENDER_API section 11 and 18.

The vfx part (commits `cb47e66`, `1e88202`, `1c86f29`): `src/render/vfx/plasma.ts` creates the 16-byte uniform
buffer, publishes it once as `'vfx.plasmaWindow'` and writes it in `prepare` whenever the value changes: rgb = the
colour of the gas times `plasmaWindowRadiance(...)` for the ACTIVE vessel (the cabin camera sits in it), a = its
plasmaIntensity; all zero while that vessel has no sheath (below `reentry.minIntensity`, or slower than 500 m/s).
With the round-2 model (the sheath one radius behind the shoulder plus half a radius of the base flow behind the
back shell, which glows with the square of the intensity) the value at 7.6 km/s and the lab's heat flux is
280 / 1,536 / 6,875 cd/m^2 at plasmaIntensity 0.3 / 0.6 / 1.0, colour (1.49, 0.85, 1.05) at unit luminance: about
twice the 3,020 of the cockpit-9 resolution at full intensity, half of its 610 at 0.3 (the wake cools faster as the
intensity falls, the base flow comes in at peak heating). Not seen from the cabin by vfx in this round: the
cockpit's own pictures are the check, and if the cabin is too bright at peak heating the place to say so is here.

What the published values mean (vfx round 3, for the cockpit's next fixer). `plasmaWindow.rgb` is a LUMINANCE in
cd/m^2 (linear sRGB, not pre-exposed: multiply by `frame.exposure.x` yourself): what a ray from inside the cabin
through a lee-side (back-shell) window meets on its way out, i.e. half a shoulder radius of the base flow behind
the back shell plus the sheath one radius behind the shoulder, averaged over the streaks and over the 8 to 30 Hz
flicker (the sheath flickers by +-22 % about it). It is the radiance of the PANE as a light source: a window of
solid angle W seen from a cabin surface under angle t lights it with `rgb * W * cos t` lux. It is not the shock
layer itself (900,000 cd/m^2 at the stagnation point at full intensity), which only a window near the shoulder,
looking forward, would see. `plasmaWindow.a` is the vessel's `plasmaIntensity` (0..1) and doubles as the "there is
a sheath" flag: a = 0 means rgb = 0 and your layout value is the fallback. The value is for the ACTIVE vessel.
It scales with the heat flux as flux^1.3 through `plasmaLuminance` and with the square of the intensity in the
base-flow part, so between intensity 0.6 and 1.0 it grows about 4.5 times (1,536 -> 6,875 cd/m^2 in the lab's
numbers); if that is too steep for the cabin, the place to flatten it is `BASE_GLOW` in `src/render/vfx/plasma.ts`
(say so here), not a clamp on your side, so that the panes and the light they throw keep agreeing.

Round 3 of the vfx close-out changed the wake of the reentry (its glow a little stronger against the layer,
`reentry.wakeGain` 0.05 -> 0.12; the layer itself is thinner and has an edge now, which a lee-side window does
not see). The published radiance follows: 317 / 1,664 / 7,288 cd/m^2 at intensity 0.3 / 0.6 / 1.0 in the lab's
numbers (was 280 / 1,536 / 6,875), same colour, same meaning as described above.
