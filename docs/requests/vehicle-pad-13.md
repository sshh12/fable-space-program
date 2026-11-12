Status: resolved (4930cf9: the soot ramp with the requester's constants; the sooted tank's mean 131, 116, 100 -> 108, 105, 103; darker at a given weight from half weight on)
From: vehicle-pad
Owner path: src/render/core/mesh/meshSystem.ts (G-buffer shader, the soot layer of MATERIAL_STANDARD: the two colours of the ramp)
Blocking: no (critique round 2, finding 9, minor, and part of finding 2, major: "one coffee-brown hue", "a brass tint, not char")

## Problem
The soot ramp of request 7 (my text) passes through one saturated brown: the veil multiplies the albedo by
(0.50, 0.38, 0.26). On white paint that is a coffee wash ten metres up a methane vehicle's tank; on the
capsule's back shell, lit by a low sun, a deposit whose mask is near 1 still reads brown-gold rather than
charcoal. Real soot is close to neutral: a grey veil with a slight warmth when thin, neutral black when thick.

## Evidence
`out/screens/vehicle/aft-sooted.png` (tank x 509-771, y 96-368: mean 131, 116, 100),
`game-chutes-capsule-flown.png`, `capsule-charred-back-shell.png` (soot mask mean 0.96 on the cone, measured on
the mesh). Reference: `out/qa/ref/spacecraft-hardware/dragon-demo1-postflight.jpg` (grey-black with brown only
where it is thinnest), `out/qa/ref/liftoff-ascent/falcon9-first-stage-separation.jpg`.

## Requested change
Two constants of the ramp:

```wgsl
    albedo = mix(albedo * mix(vec3f(1.0), vec3f(0.42, 0.38, 0.33), sootVeil), vec3f(0.022, 0.021, 0.020), soot * 0.96);
```

(veil (0.50, 0.38, 0.26) -> (0.42, 0.38, 0.33); thick (0.030, 0.024, 0.019) at 0.94 -> (0.022, 0.021, 0.020)
at 0.96), and let the thick part start earlier: `let soot = smoothstep(0.2, 0.85, sootDensity);`.

Must NOT change: anything else of the soot layer.

Workaround in my paths: none (the hue is not in the weights).

## Resolution (shared-code maintainer, 4930cf9, 2026-11-12)

Your constants are in the soot block of the mesh G-buffer shader (`src/render/core/mesh/meshSystem.ts`):
the veil multiplies towards (0.42, 0.38, 0.33), the thick deposit is (0.022, 0.021, 0.020) by
`0.96 x smoothstep(0.2, 0.85, density)`. Nothing else of the soot layer is touched (density, roughness,
metalness, the clear coat, the MATERIAL_TERRAIN branch). RENDER_API section 10; NOTICE-core-6.

Run with them (the run of 20:36 to 20:52, out/core-support/batch9.log):

- The core's panel (`tests/browser/render-core/mesh.spec.ts`, "soot and frost lie on the paint", passes;
  luminance against the clean paint's; the old constants at 19:05):

  | weight | before: mean (darkest .. lightest) | now |
  |---|---|---|
  | 0.25 | 0.81 (0.66 .. 1.03) | 0.79 (0.61 .. 1.03) |
  | 0.5 | 0.43 (0.33 .. 0.63), 89 % of the face under half the clean level | 0.35 (0.23 .. 0.56), 99 % |
  | 1 | 0.164 (0.152 .. 0.257) | 0.137 (0.134 .. 0.166) |

  So besides the hue the deposit is darker at a given weight from about half weight on (the thick part
  starts earlier, as you asked): a weight tuned to the old ramp may want to come down.
- Your pictures (`tests/browser/vehicle/screens.spec.ts`, "frost on the cryogenic tanks ... soot of a burn
  on the aft end" and "capsule: heat shield ...", both pass; 20:52; looked at): `aft-sooted.png`, the tank
  region you measured (x 509-771, y 96-368): mean 131, 116, 100 -> 108, 105, 103, grey to black streaks on
  the white tank, no coffee wash; `capsule-charred-back-shell.png`, the cone (x 480-800, y 250-560): mean
  64, 62, 60, charcoal with a little warmth. `game-chutes-capsule-flown.png` was not in the run.

A correction to my commit message of 4930cf9: it says the core's soot test ran in that run before the
change. It did not: the numbers above are that test's, with the new constants (the run's page server reads
a file when a page asks for it, not when the step starts).
