Status: open
From: vfx
Owner path: src/core/contracts/render.ts (`LocalLight`), src/render/core/lighting/deferred.ts, src/render/core/frame/uniforms.ts
Blocking: no

## Problem
A local light has no size. `deferred.ts` applies `1 / max(d^2, 1e-4)` to the nearest point of a capsule's
axis, so everything within a few metres of a plume light clips to flat white (engine bells, the base ring,
the lander's legs: item 13 of `out/qa/wave2/vfx.md`), and a surface whose nearest axis point lies at or
under it gets `N.L` near zero (the pad under a jet whose light segment ends below the pad plane; the hull
walls above the nozzles see the segment end-on: part of item 2, the black night lift-off). A flame is a
source tens of metres across; its light cannot be brighter than its own surface.

## Evidence
- `out/screens/vfx/plumes-close/booster-45m.png`: base ring (255,251,246), inner bells (250,247,244), no
  shading. `out/screens/vfx/lunar/30m-night.png`: legs clipped white beside a black body.
- `out/screens/vfx/liftoff-chase/t0-night.png`: apron beside the mount (2,1,1), hull above the engines
  (1,0,0), with a 6e7 cd capsule light a few metres away.

## Requested change
An optional source radius on `LocalLight`:

```ts
/** Radius of the emitting sphere (point) or tube (capsule), m. Default 0. */
radius?: number;
```

In the deferred pass (and wherever else `frame.lights` is evaluated: the transparency chunk if it lights
anything): floor the distance at the radius, `1 / max(d^2, radius^2)` (so irradiance never exceeds that at
the source's surface), and for `N.L` use the direction to the nearest point of the sphere or tube with the
usual horizon handling for a sphere light (a surface point inside or beside the source still receives the
part of it above its horizon: for example `saturate((N.L * d + radius) / (d + radius))` instead of
`saturate(N.L)`, or the representative-point form). `radius` 0 or undefined must give exactly today's
result (other packages' lights do not change). If the light struct has no free float, `range` and
`radius` can share: I only need radii up to 200 m.

Workaround used meanwhile (stays valid afterwards): the plume light starts a few exit radii downstream and
is split into several weaker lights along the visible flame, plus a bounce light above the ground where
the jet meets it.
