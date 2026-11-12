Status: open
From: vehicle-pad
Owner path: src/render/core/mesh/meshSystem.ts (G-buffer shader, the soot layer of MATERIAL_STANDARD: `layerCoverage` and the three lines after `let soot = ...`)
Blocking: yes (visual close-out round 2: critique items 3 and 4 of `docs/qa/wave2/vehicle-pad.r1.combined.json`, "soot and scorch are flat grey cut-outs with torn or sawtooth edges", "the capsule is spotless at splashdown"; both are two of the critic's five worst and cannot be met from the vertex weights alone)

## Problem
Soot on a vehicle is drawn as a mask: `layerCoverage` turns the weight (instance soot x vertex mask b) into
coverage through a smoothstep 0.36 wide over 3 cm x 25 cm cells, so a surface is either bare or one flat
matte dark grey (albedo to 0.03 at 0.92, roughness 0.92), with hard-edged vertical dashes between them.
A weight field that falls off smoothly (my side: aft skirts, the capsule's back shell after an entry) is
therefore drawn as torn paper, never as a graded deposit. Real soot is a density: a thin deposit is a brown
veil through which paint, tiles and markings still show, a thick one is near black, and the two grade into
each other over decimetres to metres in long feathered streaks along the flow.

## Evidence
`out/screens/vehicle/aft-sooted.png` (tank x 511-775, y 150-400: one grey, mean 80/76/74, ending upward in
dashes), `capsule-charred-back-shell.png` (x 390-840, y 280-550: stalagmites, pure film between them),
`out/screens/mission/05-stage-sep-2-chase.png` (M-2 aft skirt). Reference: `out/qa/ref/spacecraft-hardware/
dragon-demo1-postflight.jpg` (near black at the shoulder through brown to a tan veil, streaks 1-3 m long,
the tile pattern visible under it), `out/qa/ref/liftoff-ascent/falcon9-first-stage-separation.jpg`.
`src/render/core/mesh/meshSystem.ts:150-157` and `:212-215`.

## Requested change
Soot becomes a density, continuous in the weight; the noise only modulates it by a third, in cells long
along v (UVs are metres on a vehicle, v along the flow). Proposed text (replaces the soot lines of the
MATERIAL_STANDARD branch; `layerCoverage` stays for frost, unchanged):

```wgsl
/// Streak noise of a layer in texture space, in [0, 1] about 0.5: cells long along v, and an octave four
/// times larger; gives way to its mean where a cell is under a pixel (no shimmer far away).
fn layerStreaks(uvm: vec2f, cell: vec2f, seed: i32) -> f32 {
  let p = uvm / cell;
  let footprint = max(fwidth(p.x), fwidth(p.y));
  let fine = mix(latticeNoise2(p, seed), 0.5, smoothstep(0.5, 2.0, footprint));
  let coarse = mix(latticeNoise2(p * 0.25, seed + 31), 0.5, smoothstep(0.5, 2.0, footprint * 0.25));
  return 0.55 * fine + 0.45 * coarse;
}
...
    // Soot is a density, not a mask (request vehicle-pad-7): the weight, modulated by a third in streaks of
    // 6 cm x 1.5 m (and 24 cm x 6 m) along the flow. A thin deposit is a brown veil over the surface (its
    // albedo is multiplied, so tiles, seams and markings still show); a thick one is near black. Roughness,
    // metalness and the clear coat follow the density continuously.
    let sootDensity = saturate(saturate(I.params.y * v.masks.b) * (0.67 + 0.66 * layerStreaks(uvm, vec2f(0.06, 1.5), 7)));
    let sootVeil = smoothstep(0.0, 0.5, sootDensity);
    let soot = smoothstep(0.3, 1.0, sootDensity);            // the opaque part, as before in `coat` below
    albedo = mix(albedo * mix(vec3f(1.0), vec3f(0.50, 0.38, 0.26), sootVeil), vec3f(0.030, 0.024, 0.019), soot * 0.94);
    roughness = mix(roughness, 0.92, smoothstep(0.0, 0.7, sootDensity));
    metallic *= 1.0 - smoothstep(0.15, 0.9, sootDensity);
    ...
    coat = (1.0 - smoothstep(0.0, 0.35, sootDensity)) * (1.0 - max(frost, 0.8 * veil));
```

So: weight 0 = bare; 0.25 = a tan veil (albedo x about 0.75/0.69/0.63, clear coat half gone); 0.5 = brown
(x 0.5/0.38/0.26, matte); 1 = near black. Nothing has an edge unless the weight has one.

Must NOT change: the meaning of `MeshInstance.soot` and of mask b (weight = their product, 0 = none,
1 = full), the frost layer, the MATERIAL_TERRAIN branch (site grime is already a plain blend), the normal
map under the layer (it is kept today; keep it), the far-away mean (no shimmer).

Workaround in my paths: none that gives a graded deposit. My vertex weights are being rewritten in this round
as smooth density fields (no thresholds on my side any more: aft skirts, engines, clamps, the capsule's back
shell from the shield's ablation history); with the present shader they show as before (a mask whose edge
sits at weight 0.36 to 0.63), with the proposed one as the graded deposit they describe.
