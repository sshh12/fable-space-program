Status: resolved (commits d48e735, 1426e0d)
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

## Resolution, part 2 (shadowed spots)

Built after all (`1426e0d`), additive: `LocalLight.castShadow?: boolean` on a `'spot'`.
- The core gives the `SPOT_SHADOW_MAX` = 2 brightest such spots at the camera (luminous intensity over the
  squared distance) a 1024 x 1024 perspective depth map each (`src/render/core/shadows/spotShadows.ts`: the
  cone's outer angle as the field of view, near 2e-4 x range, far = range), rendered EVERY frame (pass
  `core.spotShadows`, counter `spotShadows`) from every core mesh batch's casters that were filled this frame
  (`castShadow` instances, bodies and vessels alike: your vehicle, tower, masts, legs, site structures); terrain
  and features' own geometry receive these shadows but do not cast into them. Cut-out materials cast dappled
  shadows here too (request vehicle-pad-4).
- The deferred pass looks them up per pixel (3 x 3 bilinear PCF, normal offset of 1.5 texels at that distance);
  the other spots and every other light stay unshadowed. A forward copy of the light loop sees such a light as a
  point light, as before.
- Test: `tests/browser/render-core/lighting.spec.ts`, "a spot light with castShadow casts the shadows of mesh
  casters": a 2e6 cd spot 6 m over the stand's floating bar at night: the ground under the bar 293 without
  `castShadow` (270 beside it), 0.0002 with it (0 / 1 maps rendered); `out/screens/render-core/lighting-spot-shadow.png`.
  Unit tests of the matrix and the pick: `tests/unit/render-core/spotShadows.test.ts`. RENDER_API section 7 and 18.
- Cost: two 1024^2 depth passes of the casters inside the cones, every frame: give `castShadow` to the lamps
  that matter (the bank nearest the pad, the landing lamp), not to every floodlight.
