Status: resolved (32df5d0: frost is a coat with a thickness, the requester's text; at weight 0.35 the steps between neighbouring pixels 0.47 -> 0.046 of the way from paint to coat; the sparkle is not built)
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

## Resolution (shared-code maintainer, 32df5d0, 2026-11-12)

Your text is the frost block of the mesh G-buffer shader (`src/render/core/mesh/meshSystem.ts`), as you
wrote it: `frostDensity = saturate(weight x (0.75 + 0.5 x layerStreaks(uvm, (0.08, 1.2), 19)))`,
`frostCover = smoothstep(0, 0.6, frostDensity)`, albedo to (0.90, 0.94, 1.0), roughness to 0.95, metal out,
the clear coat by `(1 - smoothstep(0, 0.35, soot)) x (1 - frostCover)`. `layerCoverage` and the veil under
its cells are gone. `MeshInstance.frost` and mask a mean what they meant; soot and the MATERIAL_TERRAIN
branch are untouched. RENDER_API section 10; NOTICE-core-6.

Measured beside the mask on the core's layers panel (one page each, `tests/browser/render-core/mesh.spec.ts`,
"frost is a coat with a thickness", 2026-11-12 19:05; luminance against the clean paint's; steps between
neighbouring pixels in units of the way from paint to full coat):

| weight | mask: mean (darkest .. brightest), 99 % of the steps under | coat: the same |
|---|---|---|
| 0.12 | 1.13 (1.10 .. 1.54), 0.000 | 1.24 (1.12 .. 1.46), 0.013 |
| 0.35 | 1.87 (1.72 .. 3.23), 0.473 | 2.35 (1.96 .. 2.72), 0.046 |
| 0.5 | 2.50 (2.10 .. 3.23), 0.482 | 2.97 (2.59 .. 3.16), 0.046 |
| 0.75 | 3.16 (2.21 .. 3.23), 0.371 | 3.16 (3.16 .. 3.16), 0.000 |
| 1 | 3.22 | 3.16 |

At an in-between weight the mask had pixels of the full coat beside pixels a quarter of the way there
(the dashes); the coat has neither bare nor full pixels at 0.35 and no step larger than a twentieth. The
far-away mean: 3 % lower at weight 1 (the cooler white), higher in between (2.35 against 1.87 at 0.35): the
coat covers more at a given weight than the mask's mean did, so a weight that was chosen for the mask may
want to come down.

Your pictures with it (`tests/browser/vehicle/screens.spec.ts`, "frost on the cryogenic tanks", your test
passes; 19:19): `out/screens/vehicle/frost-line-prelaunch.png` looked at: the intertank band and the
barrel without dashes, soft runnels, "LOX" and the caution label under a haze. `frost-prelaunch.png` is
yours to judge.

Not built: the sparkle (a few per cent of the coat's texels returning the sun at grazing incidence). It
needs a term in the deferred pass for MATERIAL_STANDARD pixels with frost, which has no channel for "frost"
today (RT4's coat goes to 0 under it); a request of its own if the coat alone is not brilliant enough.
