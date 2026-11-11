Status: open
From: vehicle-pad
Owner path: src/render/core/mesh/meshSystem.ts (MATERIAL_STANDARD branch of the G-buffer fragment shader: the frost layer of request vehicle-pad-1)
Blocking: no (visual QA round 1, item 4 "frost on the tanks", blocker in the artifact list; my side is done as far as vertex weights go)

## Problem
The frost layer is all-or-nothing per break-up cell: `layerCoverage` thresholds a 3 cm x 25 cm noise against
the weight, so a THIN coat (weight 0.25-0.5) is drawn as a few fully white vertical streaks over bare paint.
Over a marking that cuts the letters into stripes ("CAUTION CRYO GENIC"), so the package now keeps the weight
over markings at 0.27 (almost no streaks). Real thin frost is a veil: markings under it keep their edges and
lose contrast, and the paint next to a marking frosts like the rest. Today the bare paint round a marking reads
as a wiped window in the coat (gloss paint reflecting the sky beside matte frost).

## Evidence
`out/screens/vehicle/frost-line-prelaunch.png` (LOX stencil and placard: the grey, glossy window round them),
`frost-prelaunch.png` (roundel); weights in `src/render/vehicle/parts/stage.ts` (`frostFilm`, the 0.27 over
markings); `src/render/core/mesh/meshSystem.ts:191-195`.

## Requested change
Keep the cell break-up for the coat and add a translucent veil under it that follows the weight itself:

```wgsl
let wF = saturate(I.params.z * v.masks.a);
let frost = layerCoverage(wF, uvm, 19);
let veil = 0.55 * smoothstep(0.0, 0.6, wF);      // thin frost: a matte haze, no cells
let f = max(frost, veil);
albedo = mix(albedo, vec3f(0.93, 0.95, 0.97), f);
roughness = mix(roughness, 0.85, f);
metallic *= 1.0 - f;
coat = (1.0 - soot) * (1.0 - max(frost, 0.8 * veil));
```

(exact numbers at your choice: what matters is that a weight of 0.3-0.5 gives an even haze that takes 30-50 %
of a marking's contrast and the clear coat's sheen, with few or no solid cells). Must NOT change: weight 0 = no
frost at all (the shed state), weight 1 = today's solid coat, soot, the site (terrain-shading) branch.

Workaround in my paths: markings carry a weight of 0.27 (nearly bare, letters whole); once the veil exists I will
raise it to about 0.45 so they are ghosted under the coat as in the photographs.
