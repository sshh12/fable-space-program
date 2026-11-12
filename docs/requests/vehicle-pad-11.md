Status: open
From: vehicle-pad
Owner path: src/render/core/mesh/meshSystem.ts (G-buffer shader, the frost layer of MATERIAL_STANDARD: `layerCoverage`, the veil and the three lines after `let frostCover = ...`)
Blocking: yes (critique round 2, finding 1, major on both lenses: "frost reads as blotchy grey whitewash with birch-bark dashes"; what is mine is done, the coat itself is drawn here)

## Problem
Frost is still drawn as a mask: `layerCoverage` turns the weight into coverage over 3 cm x 25 cm cells through
a smoothstep 0.36 wide, with a veil capped at 0.55 under it. Wherever the weight is in between (the edge of a
bare lane, a frost line, a thin coat on dark structure) the coat breaks into hard vertical dashes of full
white beside bare paint: on the dark intertank a two-tone "birch bark", on the barrel grey blotches with hard
edges. Soot had the same defect and request 7 cured it by making it a density; frost needs the same.

## Evidence
`out/screens/vehicle/frost-line-prelaunch.png` (intertank band x 355-870, y 310-400: dashes),
`frost-prelaunch.png` (lane edges x 560-700, y 300-600). References: `out/qa/ref/launch-pad/
apollo15-saturnv-from-ml.jpg`, `out/qa/ref/liftoff-ascent/apollo4-liftoff.jpg` (a soft-edged, brilliant, dead-matte
coat, thickest on bare metal; sheets missing with tapered edges).

## Requested change
Frost as a thickness, continuous in the weight (proposed text; `layerStreaks` is the function of request 7):

```wgsl
    // Frost is a coat with a thickness, not a mask: the weight, modulated by a quarter in runnels of
    // 8 cm x 1.2 m. A thin coat is a translucent haze (the paint and its markings show through, greyed);
    // from a weight of about 0.6 the coat is opaque rime. Nothing has an edge unless the weight has one.
    let frostDensity = saturate(saturate(I.params.z * v.masks.a) * (0.75 + 0.5 * layerStreaks(uvm, vec2f(0.08, 1.2), 19)));
    let frostCover = smoothstep(0.0, 0.6, frostDensity);
    albedo = mix(albedo, vec3f(0.90, 0.94, 1.0), frostCover);        // cool white: it is ice, not paint
    roughness = mix(roughness, 0.95, frostCover);
    metallic *= 1.0 - frostCover;
    coat = (1.0 - smoothstep(0.0, 0.35, sootDensity)) * (1.0 - frostCover);
```

and, if the deferred pass can afford it for MATERIAL_STANDARD pixels with frost, a sparkle: a few per cent of
the coat's texels (hash of the texture-space cell at about 4 mm) return the sun at grazing incidence.

Must NOT change: the meaning of `MeshInstance.frost` and of mask a (weight = their product), the soot layer,
the MATERIAL_TERRAIN branch, the far-away mean.

Workaround in my paths: weights are kept out of the in-between range where I can (the coat is at 0.75 and
above, lanes at 0.12, markings under a veil of at most 0.33, the intertank at 0.85), and the tank barrels are
painted light grey so that the coat is the brightest thing on the stage. Edges of lanes and frost lines still
break into dashes until this lands.
