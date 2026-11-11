# Hand-off: vehicle-pad (vehicle models, launch complex, vessel and site render features)

Owner paths: `src/render/vehicle/**`, `data/defs/visuals/parts/**`, `data/defs/sites/ka-lae-lc1.structures.json`,
`public/assets/vehicle/**`, `tools/vehicle/**`, `labs/vehicle/**`, `tests/browser/vehicle/**`,
`tests/unit/vehicle/**`. Nothing outside these paths was changed. Requests: section 7.

State: built, reviewed, fixed, and reworked once after the first visual critique (section 9, "Visual
close-out, round 1", 2026-11-11). Sections 1 to 7 describe the package as it is now.

## 1. What exists

Everything is generated in code at start-up from the part and site definitions; there are no model files.

| Piece | Where |
|---|---|
| Geometry kernel: mesh builder with components and position-based re-masking, lathe / tube / extrude / patch primitives, validation | `src/render/vehicle/geom/{builder,prims,validate}.ts` |
| Material library (57 materials) and the texture files they use | `src/render/vehicle/materials.ts`, `public/assets/vehicle/*.png` |
| Decal sheet (content: names, texts, colours, sizes of every marking; `foil: true` for markings painted on metal film) | `data/defs/visuals/parts/livery.json` (section `visuals/parts/livery`), read by `src/render/vehicle/decals.ts`, baked by `tools/vehicle/bake-decals.ts` into `decals.png` and `decals_orm.png` |
| 14 part generators, registry | `src/render/vehicle/parts/**` |
| 25 part visual files (parameters only) | `data/defs/visuals/parts/<partId>.json` |
| 13 launch-complex generators, registry | `src/render/vehicle/site/**` (`ground.ts` is new: earthworks) |
| Launch complex layout (26 structures, with the names of their markings) | `data/defs/sites/ka-lae-lc1.structures.json` |
| Vessel feature (id `vehicle`) and site feature (id `site`), LOD selection | `src/render/vehicle/{vesselFeature,siteFeature,lod}.ts` |
| Texture bakes (procedural, CPU), decal bake, model report, site ground report | `tools/vehicle/{texlib,bake-textures,bake-decals,model-report,site-ground}.ts` |
| Lab | `labs/vehicle/` (`/labs/vehicle/`) |

Part generator ids: `stage.tank`, `engine.liquid`, `stage.interstage`, `stage.ring`, `motor.pack`, `rcs.pod`,
`pad.clamp`, `capsule.mouldline`, `capsule.apexCover`, `lander.descent`, `lander.ascent`, `lander.legs`,
`fairing.petals`, `les.tower`. Site generator ids: `pad.apron`, `pad.flameTrench`, `pad.launchMount`,
`pad.umbilicalTower`, `pad.lightningMast`, `pad.catenary`, `pad.waterTower`, `pad.pipeRun`, `pad.tankFarm`,
`pad.crawlerway`, `pad.building`, `pad.floodlight`, `pad.groundworks`.

## 2. Public API (`import ... from '@/render/vehicle'`)

```ts
createVesselVisualFeature(options?: { exteriorGlass?: boolean; fadeSeconds?: number; maxLights?: number }): VesselVisualFeature
interface VesselVisualFeature extends RenderFeature {       // id 'vehicle'
  readonly stats: { vessels; instances; triangles; shadowTriangles; staggeredCascades; everyFrameCascades;
                    staggeredSubmissions; ghosts; lights; fading; updateMs };
  partVisual(defId: string): PartVisual | undefined;
  anim(vesselId: string, instanceId: string): PartAnim;     // { nozzleTemp, soot, frost, clamp, antenna, lamp }
}
createSiteFeature(options?: { padElevation?: (site: LaunchSiteDef) => number;
                              groundHeight?: (site: LaunchSiteDef, east: number, north: number) => number;
                              maxLights?: number; drawDistance?: number }): SiteFeature
interface SiteFeature extends RenderFeature {               // id 'site'
  readonly stats: { sites; instances; triangles; shadowTriangles; fading; movingInstances; lights; updateMs };
  state(siteId: string): SiteState | undefined;             // { night, arms, crewArm }, each 0..1
  override(siteId: string, patch: Partial<SiteState> | null): void;   // pins a state at once (pictures); null releases
}
generatePart(defs, partDef): PartVisual          registerGenerator(id, generator)        generatorIds()
generateStructure(defs, site, model, params): SiteVisual   registerSiteGenerator(id, g)   siteGeneratorIds()
materialDef(id): PbrMaterialDef   MATERIAL_IDS   materialTextureFiles()
DECAL_SECTION   decalSheetOf(defs): DecalSheet   createDecalSheet(def)   layoutDecals(def)     // sheet.uv(name), .aspect(name), .has(name), .foil(name)
nozzleEquilibrium(throttle): K     stepNozzleTemp(T, firing, throttle, dt): K
legPose(leg, deploy, compression): LegPose      // foot joint of a landing leg (the sim's own rule)
shieldGlowLuminance(T): cd/m^2                  // hottest point of an ablating heat shield (see below)
```

Integration: put both features in the app's feature list after the terrain. `createSiteFeature()` without
options stands every structure on the pad plane at `location.padElevation`, which is right for this site: the
baked terrain is flat to 2 cm out to `pad.flatRadius` (450 m; `npx tsx tools/vehicle/site-ground.ts radial`).
A site on unflattened ground passes `groundHeight` (each structure then stands at the height of the ground
under its own origin) and, when its elevation is `'terrain'`, `padElevation`. Both features use only `src/core`
and the public API of `src/render/core` (mesh system). The vessel feature reads `SimSnapshot.vessels[].parts`
and module states only: engine throttle and gimbal (nozzle temperature model, glow of the radiative
extension), heat shield `surfaceTemp` (the shield's glow) and `ablatorFraction` (char), legs (`deploy`,
`compression`, `broken`), lights, antenna, fairing panel ids (`<id>#panel<k>`), clamps, and the part's
`tempSkin`. A vessel that disappears from the snapshot fades out over `fadeSeconds` as a ghost.

What a generator returns (`PartVisual`): named models with 3 LODs each (a wire has 4), a `pose` that emits them
for the part's module state, optional `lights(input)` (lamps when on, the spill of a glowing heat shield; a
light may be a line with `end`), and `sootSeconds`. Per emitted item (`PoseOpts`): `temperature`, `cold`,
`fade` (dithered coverage: used only for a vessel that fades out), `castShadow`, `emissive`, `soot`, `frost`,
`scale`. A site item (`SiteItemOpts`): `emissive`, `moving`, `castShadow`, `grime`, and the shadow classes
`nearShadowOnly`, `fineShadowOnly`, `shadowProxy` (below).

LOD. Every LOD of a model is a single-LOD model of the mesh system and the features pick which to draw
(`lod.ts`): by projected diameter with 12 % hysteresis, and a switch is a 0.25 s cross-fade in time (the coarser
LOD solid, the finer dithering in or out); in deterministic captures it is immediate. Nothing is left
half-dithered by where the camera stands (`stats.fading` is 0 at rest; `screens.spec.ts`, LOD dolly test).
Switch sizes: engines 110 / 30 px, stages 700 / 110 px, tower 900 / 260, masts 520 / 170, default 220 / 60.

Shadows. Every vessel instance is a moving caster; the camera's copies cast nothing, LOD 1 casts into cascades
with texels up to 0.1 m and the last LOD into coarser ones (`stats.staggeredSubmissions` stays 0). Site: an
ordinary structure casts from LOD 1 when it is drawn at LOD 0 (shadow-only batch); `fineShadowOnly` items
(swing arms, pipe runs, floodlight and lightning masts) cast only into cascades with texels up to 0.1 m
(`FINE_SHADOW_TEXEL`), and each has a `shadowProxy` item (a solid slender stand-in, never drawn) that casts
into the coarser cascades, pipe-run stand-ins only up to 0.35 m; the tower's lattice casts into the fine
cascades through a shadow-only model of its bracing (`shadowProxy` with `fineShadowOnly`); rails, treads,
gusset plates, gratings, ground slabs, earthworks and wires cast nothing. Swing arms, the crew arm and the tail service mast are moving casters
while they swing.

Conventions: part frame +Y nose, +X starboard, +Z dorsal; azimuth from +Z toward +X. Structure frame +Y up,
+X east, +Z south at heading 0. UVs are in metres (u round a part, v along it: the mesh shader's soot and frost
break-up relies on that); materials tile per metre; the heat shield's UVs are 0..1 across 1.04 shield diameters
(planar). Fittings on a surface of revolution are built with `surfaceFrame` / `curvedPanel` of `parts/common.ts`.

Content rule: the package's source names no marking, vehicle, part or site. Markings are named by the visual
files (`decals`, `placards`, `hazardDecal`, ...) and by the structure parameters; `looks.test.ts` scans the
source for marking texts and for part, vehicle and site ids.

## 3. How to run and verify

```
npm run typecheck:paths -- src/render/vehicle labs/vehicle tests/browser/vehicle tests/unit/vehicle tools/vehicle
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/vehicle tests/unit/vehicle src/core/defs tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vehicle --project=functional   # about 12 min; run screens / staging / game separately if a 10 min limit applies
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vehicle --project=perf
node tools/dev/heavy.mjs --class=bake -- npx tsx tools/vehicle/bake-textures.ts [recipe ...]     # about 40 s for all
node tools/dev/heavy.mjs --class=gpu  -- npx tsx tools/vehicle/bake-decals.ts                    # canvas text in Chrome
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tools/vehicle/model-report.ts [partId ...]      # triangle counts, mesh checks
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tools/vehicle/site-ground.ts [radial]           # terrain under every structure
```

Browser specs: `screens.spec.ts` (8 screenshot tests with 66 views in the vehicle lab, live captures: jitter
and noise running, 72 frames of temporal accumulation; and the LOD dolly test), `staging.spec.ts`, `game.spec.ts` (the integration lab on the real
terrain, sky and exposure: 9 pad views, 4 flight views, 3 lunar ground views, and the terrain-to-pad-plane gap
under every structure), `vehicle.perf.spec.ts`, `adhoc.spec.ts` (`VEH_ADHOC`). Pictures: `out/screens/vehicle/`
(`game-*` are the integrated game).

Lab query (`/labs/vehicle/?...`): `scene=pad|lowOrbit|lunarSurface`, `stage=<n>`, `stages=<n>&coast=<s>&hold=1`,
`focus=<text>`, `solo=1`, `eye=x,y,z&at=x,y,z` (vessel frame, nose up; on the pad x = south, z = west),
`sun=az,el` or `sunv=x,y,z`, `env=`, `planet=0`, `glass=0`, `site=0`, `ballast=<iterations>`, `hud=0`.
`window.__veh = { app, sim, vehicle, site, env, setSun, setView }`. On a surface the lab draws only the body
underfoot and places a vessel on legs by its foot pads; separated pieces get the relative motion they have in
flight.

## 4. Acceptance, measured (2026-11-11, this machine, other agents' GPU and CPU jobs running throughout)

| Criterion | Result |
|---|---|
| Every part def has a generator and a visual file | 25 of 25 |
| Meshes: unit normals, orthonormal tangents, no degenerate triangles, closed components watertight, none inside-out | pass for every model and LOD of the parts and of the complex (42 unit tests in 5 files with the boundary test) |
| Bounds within 5 % of `PartDef.bounds` | pass (feedlines, blisters and clamp keepers were sized to this limit) |
| Mated attach interfaces meet within 5 mm | 33 interfaces, gap 0 to 1.24 mm, no overlap |
| Capsule skin on the shared mould line within 2 mm; openings at the file's azimuth / y / size | pass (the test reads the file) |
| Nothing under a fairing or boost cover reaches through it | boost cover over the capsule: least clearance 25.5 mm; fairing over the descent stage 156 mm |
| Triangles, full stack | LOD0 1,245,846 (1.0 to 1.6 M), LOD1 298,770, LOD2 28,764 (< 60 k) |
| Launch complex triangles (all models) | LOD0 279,252, LOD1 75,318, LOD2 8,900 |
| No vessel caster in a staggered cascade | 0 staggered submissions (`staging.spec.ts`) |
| Staging sequence with `splitForStage` | all 10 stages; separated pieces are full models and clear the stack |
| LOD: nothing left dithered | dolly of 12 distances from 7 to 360 m: 273 cross-fades started, 0 items fading 60 frames after each stop |
| Terrain under the site | largest terrain-to-pad-plane gap under the 26 structures 0.000 m in the integration lab (`game.spec.ts`), 0.02 m at 450 m by `site-ground.ts` |
| Vehicle G-buffer < 0.8 ms | 0.017 ms (stack filling the view), 0.075 ms (tower at 15 m), p99; p50 0.015 / 0.066 |
| Vehicle shadows < 0.4 ms | last run: 0.360 ms (fill; windows 0.360 / 0.363 / 0.358), 0.252 ms (tower; 0.252 / 0.380 / 0.251), p99; p50 0.007 / 0.014. **Two of the three runs of the final code failed this line in the fill view (1.075 and 2.230 ms p99)**, see below |
| Site G-buffer + shadow < 0.5 ms | 0.077 + 0.019 ms (fill), 0.032 + 0.043 ms (tower), p99; p50 0.066 + 0.017 / 0.029 + 0.041 |
| CPU instance update < 0.3 ms | 0.240 ms p50, 0.34 to 0.44 ms p95 (site 0.12 ms) |
| `expectNoErrors` | in every vehicle-lab test |

Perf: 2560 x 1440, `perf=features&scale=1&governor=off`, ballast 6.96 ms, p99 of timestamp queries, median of
three 240-frame windows, under `withGpuLock`, with two to three other agents' browser jobs on the GPU in
every run. The spec was run six times in this round and passed once (the last run; figures above). What the
failures were:

- Runs 1 to 3: the site's shadow line in the tower view, 1.74 / 1.62 / 1.70 ms p99 against a median of
  0.055 ms. A probe (same view, 240 frames per variant) put it in the two finest cascades and in one caster:
  with the tower's lattice (rails, treads and gusset plates on 23 levels) left out of them the site's shadow
  passes were 0.026 ms p50 and 0.028 to 0.038 ms p99; with it, 0.6 to 1.6 ms p99 at the same median. Fixed:
  in the fine cascades the lattice now casts through its bracing alone (a shadow-only model), and ordinary
  structures cast from LOD 1 (site shadow triangles per frame in the tower view 508,320 before, under 310,000
  after). The site line has passed in every run since (0.07 to 0.10 ms).
- Runs 4 and 5: with the site's passes short, the same kind of event (a pass of microseconds at the median
  taking 1 to 2.4 ms in more than one frame in a hundred) showed in the vehicle's shadow line instead: fill
  view 1.075 and 2.230 ms p99 (windows 2.301 / 0.797 / 1.075 and 2.352 / 2.230 / 0.623), tower 0.296 and
  0.631 ms. Nothing in the vessel feature's shadow path changed between the runs in which this line passed
  (runs 1 to 3: 0.007 to 0.30 ms) and these. I could not find a cause in the workload and take it for time lost
  to other GPU clients in whichever shadow pass is running, but have not proven it: it needs the quiet machine
  (PACKAGE_RULES 16). Even in the passing run the vehicle's shadow line in the fill view is 0.36 ms, 10 % under
  its budget (0.225 ms in the first hand-off).

Generated assets: 89.9 MB in 63 files under `public/assets/vehicle` (limit 120 MB). No API key was used and no
money was spent: every texture and decal is baked procedurally. No Modal app was touched.

## 5. Deviations from the brief (wave-1 reality and decisions)

1. The structures file was rewritten, not extended (tower and crew arm on the EAST side of the pad).
2. `createVesselVisualFeature` and `createSiteFeature` take options, not a context.
3. Capsule heat-shield dome: the sphere of the file's `radiusOfCurvature` through the file's dome samples.
4. Bounds test: radius within 5 % of `bounds.radius`; `yMin` / `yMax` within 5 % of max(radius, height).
5. The mesh system has no alpha-tested or transparent materials (request 4). Decals are opaque atlas
   rectangles cut into the lathe grid; window panes are an opaque, single-sided `glass` model; bar gratings are
   real bars at LOD 0 and open frames at LOD 1.
6. LOD selection is done by the features, not by the mesh system's size band (section 2).
7. `SiteFeature.override` pins a state immediately; the swing animation is driven by the vessel on the pad.
8. In the vehicle lab the pad surface is the reference sphere and the sky, probe and ambient are the lab's
   analytic stand-ins. The hardware is judged for play in `game.spec.ts`.
9. The decal sheet lives at `data/defs/visuals/parts/livery.json`.
10. A wire cannot be drawn with sub-pixel coverage: it is four gauges (true, 0.22, 0.7, 2.2 m), each used
    where it is one to three pixels wide.
11. Floodlight banks register a vertical line light in front of the vehicle (where their beams land), not a
    light at the lenses: the core has no spot lights (request 2).
12. The heat shield's glow is compressed against a black body (`shieldGlowLuminance`): sunlit white at 1,900 K,
    eight times that at 3,100 K, so the face keeps its gradient instead of burning out to a flat disc.

## 6. Known weaknesses (stated plainly)

- Night: no local light casts a shadow (request 2). The vehicle is lit top to bottom and is the brightest thing
  on the pad, the tower carries work lights, but the tower and masts throw no shadows across the apron, there
  are no beams in the haze, and the lander's legs cast no shadow in its landing lights.
- Perf: the vehicle's shadow line failed its p99 budget in two of the last three runs under load and is within 10 % of it in the third (section 4).
- Glass is opaque: no inner panes, no cabin behind the windows from outside (the cockpit package's glazing
  replaces the panes when `exteriorGlass` is false).
- The capsule's markings are atlas rectangles in the film's colour: closer than before, still a faintly visible
  patch at grazing light (no tile seams under the lettering).
- Stages seen whole from 40 m are still mostly clean barrels: the 5 % bounds criterion limits anything that
  stands off the skin to 0.22 m (M-1, M-2) and 0.16 m (M-3), so feedlines are 0.15 m lines and blisters are low.
- Fairing petals and the cork shoulder are plain; the escape motor has a manifold and nozzle rings but no
  fluting. Tower joints have gusset plates but no bolt groups; weathering of the steelwork is vertex grime.
- No perimeter fence, camera towers, parked vehicles or vegetation dressing on the site; the perimeter road is
  a regular twelve-sided loop.
- Vent fog and falling ice at lift-off are the effects package's; this package exposes no anchor points for
  them yet.
- A broken leg is posed in the part's own frame: the feature does not know the terrain.
- Soot, frost amount and nozzle heat are presentation models inside the feature, not simulation outputs.
- Site lights are capped at 8 per frame (vessel 4) of the core's 16.
- Not tested: more than one site, a site on unflattened ground (`groundHeight` is implemented, not exercised),
  vehicles other than the one defined.

## 7. Requests

| File | To | State | What |
|---|---|---|---|
| `docs/requests/vehicle-pad-1.md` | render core, mesh shader | resolved (ad38ab3) | clear coat under soot and frost, texture-space break-up of both, frost and soot colours. Used: frost and soot are plain vertex weights on the skin now |
| `docs/requests/vehicle-pad-2.md` | render core, contracts | open | spot lights, shadowed local lights |
| `docs/requests/vehicle-pad-3.md` | terrain render | open (the terrain package is drawing a site ground plan from the structures' footprint parameters as of this writing) | site ground as graded earthwork instead of a concrete disc |
| `docs/requests/vehicle-pad-4.md` | render core, contracts | open | alpha-cutout materials |

No open request in `docs/requests` is against these paths.

## 8. First review: findings and what was done

Boost cover and cone fittings follow the surface; heat shield as its own model; decal sheet and site markings
as data; crew arm, white room, buildings and tank farm hardware; soot inside engines only; broken leg pose;
measured staggered-cascade counter; perf spec on the median window. (Details in the history of this file.)

## 9. Visual close-out, round 1 (2026-11-11)

Work list: `out/qa/wave2/vehicle-pad.md` (25 items; photo 4/10, artifact 4/10). Every picture named below is in
`out/screens/vehicle/`, taken live (not with frozen noise).

| # | Item | What was done | Shows in |
|---|---|---|---|
| 1 | Complex does not sit on the ground (blocker) | Measured first: the terrain is flat to 2 cm across the site; the floating look was a concrete disc with a circular rim, slabs with bare edges and nothing between the structures. New `pad.groundworks`: a graded field of compacted stone round the hardstand with an irregular outline and a shoulder that slopes 0.75 m below grade (it covers the terrain's disc), stone pads under the tank farms, water tower and support building, asphalt service roads with stone shoulders and edge lines (perimeter loop, spurs to both farms, the pad and west along the crawlerway), earth berms between the farms and the pad with gaps where the pipe runs pass. `groundHeight` option for sites on unflattened ground. Request 3 to the terrain. Integration views and a terrain-gap assertion added | `game-pad-noon-300m`, `game-site-aerial`, `game-site-tank-farm-low`, `game-site-crawlerway-low`, `site-aerial`, `site-tank-farm-berm` |
| 2 | Capsule reads as a tiled kiln (blocker) | New back shell: tiles closed out with aluminised tape (metal film, faint thin-film tint, joints in the normal / occlusion / roughness maps only, under 10 % in albedo, vent plugs, wrinkles), smooth taped close-out panels round every opening that end on course joints with a fastener row, anodised retainers, forward bay in gore panels with taped joints and two fastener rings, white apex cover, shoulder seal band, thruster fairings instead of black boxes, mirror tape on the panel joints, markings painted on the film (`decal-foil` with an ORM atlas) | `stage-capsule-space`, `capsule-windows`, `capsule-hatch` |
| 3 | Lander insulation is static (blocker) | New blanket texture (pillows, long warped creases; the crinkle is in the roughness, not in the normal map), amber film albedo that deepens in the folds, roughness 0.43 to 0.5; blanket geometry with stand-off buttons, sag over decimetres, finite-slope edges, tape strips on the joints, black panels between the tank lobes | `lander-deployed`, `lander-deployed-sun-5`, `lander-deployed-sun-40`, `lander-mli-closeup`, `game-moon-lander-landed` |
| 4 | Frost is dithered cut-outs (blocker) | The rime shell is gone. Frost is a weight on the skin from frost line to frost line (heavier low on a tank, thinner over markings) that the mesh shader (request 1) turns into a matte white coat breaking up in vertical streaks; it thins by itself after lift-off. Nothing is dithered | `frost-prelaunch`, `frost-line-prelaunch`, `pad-swing-arm-umbilical` |
| 5 | Launch mount dressed with primitives (blocker) | Deck in steel plate with rust and scorch, refractory ring, hatches, drains, cable trays, hydraulic unit and lines; ring main, risers and six flanged goose-neck rainbirds with fan nozzles and braces; stair tower with stringers, grating treads, landings, rails and bracing; clamps as boxed weldments with ribs, cheeks, blast shield, cylinder, keeper plates and decal hazard stripes; service mast hood, hoses and couplings; swing-arm hoses (frosted cryogenic ones), couplings and drip trays | `pad-engine-section`, `pad-hold-down-clamp`, `pad-mount-deck`, `pad-swing-arm-umbilical`, `game-pad-mount-deck` |
| 6 | Dither stipple near LOD switches | LOD selection moved into the features: hysteresis and a 0.25 s timed cross-fade; engine and stage switches moved away from the hero distances; live captures. Dolly test | every engine view; `screens.spec.ts` LOD dolly |
| 7 | Stages are plain tubes | Feedlines on brackets with bellows, a second cable tray, blister fairings, framed aft-skirt interiors, bottles / avionics / harness on the forward dome, foam without repeating patches (5 cm ribbing, streaks), smoother white foam, irregular quilt. Limited by the 5 % bounds criterion (section 6) | `stage-m1-space`, `stage-m2-space`, `stage-m3-space`, `interstage-interior`, `closeup-foam` |
| 8 | Night lighting | Floodlight banks as line lights on the vehicle, work lights on every tower level, lander and capsule lamps in front of their lenses with short reach, larger lamp housings. Shadows and beams need request 2 | `site-pad-night`, `site-overview-night`, `game-pad-night`, `lander-lights` |
| 9 | Glowing shield is one flat colour | Glow as an emissive map (stagnation point off centre, hot windward shoulder, bright seams and streaks, dull lee side) scaled with the surface temperature; three rim lights spill onto the back shell | `capsule-entry-hot-shield`, `capsule-entry-peak-heating` |
| 10 | Shield and back shell do not look flown | Shield textures are one planar picture (blocks, not rings and wedges); a charred set (ash, streaks from the stagnation point, spall pits, burnt seams) replaces it once char passes a fifth; back-shell scorch as continuous streaks, heavy windward and at the shoulder | `capsule-heat-shield-pristine`, `capsule-heat-shield-charred`, `capsule-charred-back-shell` |
| 11 | Engines from aft | Gas side in heat-stained nickel (copper only above the throat), ringed extensions in two sheet tints, desaturated heat tint, grey boots | `stage-m1-aft-space`, `stage-m2-aft-space`, `engines-clean` |
| 12 | Soot is polished grey metal | One continuous soot field (reaches higher on the lee side) applied to the skin and to everything on it (`MeshBuilder.remask`); matte and streaked through request 1 | `aft-sooted`, `engines-sooted` |
| 13 | Model railway set | Earthworks of item 1; sphere tanks in plate courses with weld lands and gore welds; pipe runs end in sleeves. Not done: fence, camera towers, vehicles | `site-overview-noon`, `site-tank-farm`, `site-far-800m`, `game-site-aerial` |
| 14 | Shadows of thin structure | Shadow classes (section 2): lattices cast into the fine cascades only, solid stand-ins into the coarse ones (a mast's shadow is a lattice near the camera and a continuous band beyond; it no longer drops out); gratings, rails and treads cast nothing; live captures | `site-mast-shadows-low-sun`, `site-apron`, `pad-stack-300m` |
| 15 | Thin geometry breaks into dots | Wires in four gauges that never drop out; fasteners made flush; stage LOD 0 only within about 45 m | `site-wires-from-mast-foot`, `pad-stack-tower-15m-up`, `site-overview-noon`, `game-pad-tower-from-ground` |
| 16 | Markings broken by geometry | Stringers leave marking panels smooth; decal roughness matched to the paint and the paint's waviness reduced; white-room battens stop at the sign and the porthole; larger placards | `stage-m2-aft-space`, `stage-m1-space`, `site-crew-arm-white-room` |
| 17 | Grating is an opaque slab | Real bearing bars at LOD 0, open frames at LOD 1, no shadow (request 4 for cut-out materials) | `pad-stack-tower-15m-up`, `pad-stack-tower-15m` |
| 18 | Brushed steel banding | Texture rebuilt from 129,000 finite scratches on a 1.6 m tile (normal map uses its range) | `closeup-brushed-steel`, `stage-m3-space` |
| 19 | Lander hovers in the lab | The lab places a vessel on legs by its foot pads; unit and picture checks | `lander-foot-pad`, `lander-ground-contact`, `game-moon-lander-foot-pad` |
| 20 | Windows and hatch seal | Deeper panes, rounder corners, one anodised retainer design, flat hatch frame. Not done: inner panes, cabin glow (opaque glass) | `capsule-windows`, `capsule-hatch` |
| 21 | Top of the stack | Lighter cork, escape motor manifold, nozzle flanges and exit rings, white apex cover. Petals unchanged | `les-motor-closeup`, `les`, `fairing-petal-outside` |
| 22 | Tower and crew arm flat | Gusset plates, treaded stairs, per-member weathering with scorch toward the vehicle, cable stays, galvanised steel as a grey patina | `site-crew-arm`, `site-crew-arm-from-tower`, `pad-stack-tower-15m` |
| 23 | Clipping and loose ends | Pipe runs end at the valve house wall in sleeves; stays are cables; shoulders on every slab edge (item 1); separated pieces clear the stack | `site-support-building`, `staging-03` to `staging-10` |
| 24 | Broken leg hard to tell | Tube swung 30 degrees, piston hanging kinked to the ground, pad tilted 27 degrees, crushed core and torn tube mouth as a model of its own | `lander-leg-broken` |
| 25 | Views cannot show the hardware in play | `game.spec.ts`: 16 views in the integration lab; the lab draws only the body underfoot (no black Moon) | `game-*` |

Seen while checking, from the list: the slab on the descent stage in `staging-07` and the petal against the
stack in `staging-03` were not investigated separately; with separated pieces now moving clear, `staging-03`
shows the petals away from the stack.

Not fixed, and why: shadowed and aimed local lights, beams (request 2, open); cut-out gratings at distance
(request 4, open; geometric substitute in place); inner window panes (needs transparency); fence, camera
towers and parked vehicles (not started: the earthworks and the mount took the time); bolt groups at tower
joints; fairing petal detail; vent-fog anchor points for the effects package.

Perf after the round: section 4.
