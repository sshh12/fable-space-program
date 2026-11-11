Status: resolved (commit d48e735)
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

## Resolution

Part 1 done (`d48e735`), additive: `LocalLight.kind: 'spot'` with `dirRelCam?: Vec3` (unit beam axis,
camera-relative ROOT axes, the direction the light travels) and `cone?: [inner, outer]` (half angles, rad,
default [0, PI / 4]); `intensity` is the value on the axis, full inside `inner`, a smoothstep in the cosine to
0 at `outer`, `range` as before. Every light also takes `radius?: number` (request vfx-5: illuminance floored
at the source's surface, horizon handling), useful for a lamp bank's face. The 16-light cap, the units and
existing callers are unchanged (a light without the new fields is lit exactly as before).

A spot on a hull no longer lights the far side of that hull as long as the hull is outside its cone: aim the
cone away from the hull. It still lights what is inside the cone behind other geometry: see part 2.

Tests: `tests/browser/render-core/lighting.spec.ts`, "lighting inputs ... (point, sphere, spot)": a 1e6 cd spot
4 m above the card, cone 10 / 20 deg: on the axis the point light's value (0.408 against 0.402 by hand), 15 deg
off 0.621 of it (smoothstep 0.621), 30 deg off 0. Lab: `?probe=inputs`, `__rc.probes.inputs.setPointLight({
intensity, height, at, radius?, range?, spot?: { dir, cone } })`. RENDER_API section 7 and section 18.

Part 2 (shadowed spots) is NOT built in this pass. What it takes: a perspective shadow map per shadowed spot,
drawn with every caster (vehicle, tower, masts: the core's mesh batches), a culling and bias path for a
perspective view in the mesh system (its cascade culling and texel-size rules are orthographic), and a fourth
sampled texture in the lighting pass. It is listed first under "open" in `docs/handoff/core-support.md`; I
build it after this pass's queue if the time allows and tell you in a NOTICE. Meanwhile: aim the lamps with
`cone` so that what they must not light is outside it, and keep the vehicle's own shading for its shadowed
side.
