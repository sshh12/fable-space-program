Status: open
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
