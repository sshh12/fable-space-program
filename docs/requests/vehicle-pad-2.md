Status: open
From: vehicle-pad
Owner path: src/core/contracts/render.ts (LocalLight), src/render/core (deferred local-light pass)
Blocking: no (visual close-out item 8 "night lighting", major; a partial fix exists in my paths)

## Problem
`LocalLight` offers only unshadowed `point` and `capsule` kinds. A floodlight bank and a lander's landing lamp are
spot lights: with omni lights the pad at night is one radial pool on the ground with the vehicle no brighter than
the masts, the lamps' tilt has no effect, and a lamp mounted on a hull lights the far side of that hull. Nothing lit
by a local light casts a shadow (vehicle, tower and masts across the apron; landing legs in the landing light).

## Evidence
`out/screens/vehicle/site-overview-night.png`, `site-pad-night.png`, `lander-lights.png`;
`src/core/contracts/render.ts:428-437`; item 8 of `out/qa/wave2/vehicle-pad.md`.

## Requested change
1. `LocalLight.kind: 'spot'` with `dirRelCam?: Vec3` (unit, ROOT axes, the beam axis) and
   `cone?: [inner: number, outer: number]` (half angles, radians): intensity (cd) is that on the axis, full inside
   `inner`, smoothstep to 0 at `outer`; `range` as today. Point and capsule lights unchanged.
2. Optional, if it fits the budget of ARCHITECTURE 17.1: `castShadow?: boolean` on a spot light; the core
   renders one small shadow map (512 or 1024, perspective, the spot's cone) for at most the N brightest such
   lights in view (N = 2 is enough for the pad banks nearest the camera and for the landing lamp), drawn through
   the existing `drawShadow` hook with a cascade-like view (`everyFrame: true`), and falls back to unshadowed
   for the rest.

Must NOT change: the 16-light cap, the units (cd), existing callers.

Workaround in my paths: each lamp's point light is placed a few metres in front of its lens along the beam axis
with a range that cannot reach behind the hull; lander lamps shortened; many emissive work lights.
