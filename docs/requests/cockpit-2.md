Status: resolved (commit 113438e)
From: cockpit
Owner path: src/render/core/lighting/deferred.ts
Blocking: no

## Problem
Planetshine reaches every pixel unshadowed, including the inside of a closed cabin. The cockpit writes
baked ambient occlusion 0 to RT0.a for its interior so that the environment probe (the open sky) does not
light the cabin through its walls (the cabin's own ambient comes from its windows and lamps, computed by
the cockpit and written as emission). Planetshine has no such gate: on the Moon with a full Earth the
interior receives about 15 lux of earthshine through the pressure shell from the Earth's direction, which
is a visible fraction of a night-side cabin lit by its displays (5 - 20 lux near the console).

## Evidence
`src/render/core/lighting/deferred.ts`, the planetshine loop (`frame.shine[receiver * 2 + k]`): no
occlusion term. The core's own comment says planetshine is faded out closer than 4 R, so it matters in
lunar orbit, on the lunar surface and on the translunar coast, which is where the cabin is darkest.

## Requested change
Multiply the planetshine term by the pixel's baked occlusion `g.ao` (RT0.a), the same factor that gates
the probe ambient. Planetshine is an extended source (a planet's disc), for which baked occlusion is a
reasonable visibility proxy; vehicles and terrain write ao near 1 on open surfaces, so their lighting
barely changes, and the cockpit's 0 removes the leak. Must not change: the sun term, local lights, the map
fill light.

No workaround exists in my paths (the term is added after my G-buffer write).

## Resolution
Done as requested (core-support, commit 113438e): the planetshine term in
`src/render/core/lighting/deferred.ts` is multiplied by the pixel's baked occlusion `g.ao` (RT0.a), the
factor that already gates the probe ambient. The screen-space AO is NOT applied to it (only the baked
value), and the sun, local lights and the map fill light are unchanged.

What it means for others: a surface that bakes AO below 1 into RT0.a receives that much less planetshine
(vehicle cavities, terrain normal-map AO); open surfaces write about 1 and are unchanged. Documented in
RENDER_API sections 7 and 18.

Tested: `tests/browser/render-core/lighting.spec.ts`, "planetshine is gated by the baked occlusion ...":
night on the Moon with the Earth 66 deg above the horizon; of two equal boxes the one with baked AO 1 reads
1.97 cd/m^2 of earthshine on its top face, the one with AO 0 reads 0. Screenshot
`out/screens/render-core/lighting-planetshine-occlusion.png`.
