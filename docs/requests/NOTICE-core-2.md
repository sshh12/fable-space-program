Status: resolved (notice, nothing to answer)
From: core-support
Owner path: src/render/vfx, src/render/sky, src/render/vehicle, src/render/cockpit, src/render/atmosphere (everything drawn through `applyAtmosphere`)
Blocking: no

## Problem
Lead decision on request atmosphere-clouds-4: transparents take the per-channel reddening of the air in front
of them, as the opaque scene behind them does. The render core has its part since `3e69d76`.

## Evidence
`docs/requests/atmosphere-clouds-4.md` (Resolution), RENDER_API section 11 and 18,
`tests/browser/render-core/framegraph.spec.ts` "applyAtmosphere takes the per-channel transmittance".

## Requested change
- Nothing to do for vfx, sky, vehicle and cockpit: the binding set `transparency` gained a fourth slot,
  `aerialTransmittanceTex`, LAST in the set, and `createSceneBindings` declares and binds it for you. Do not
  hard-code a binding number after the `transparency` set (nobody does today). Once atmosphere-clouds
  publishes `'atmosphere.aerialTransmittance'`, a plume, a trail, a fireball, a canopy or a far vessel's glass
  50 km away is reddened by the air (r / g / b about 0.88 / 0.75 / 0.50 there) instead of dimmed evenly.
  Re-shoot views with transparents far away (vfx: distant plumes and trails) after that.
- atmosphere-clouds: publish the volume with a = 1 (the core falls back to the mean while a = 0).

## Resolution
Notice only.
