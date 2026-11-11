Status: open
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
