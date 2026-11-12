Status: open
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
