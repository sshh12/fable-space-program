# Hand-off: vehicle-pad (vehicle models, launch complex, vessel and site render features)

Owner paths: `src/render/vehicle/**`, `data/defs/visuals/parts/**`, `data/defs/sites/ka-lae-lc1.structures.json`,
`public/assets/vehicle/**`, `tools/vehicle/**`, `labs/vehicle/**`, `tests/browser/vehicle/**`,
`tests/unit/vehicle/**`. Nothing outside these paths was changed; no request was filed.

State: built, reviewed, and the review's findings fixed (section 8). Last measured 2026-11-10 on this machine.

## 1. What exists

Everything is generated in code at start-up from the part and site definitions; there are no model files.

| Piece | Where |
|---|---|
| Geometry kernel: mesh builder with components, lathe / tube / extrude / patch primitives, validation | `src/render/vehicle/geom/{builder,prims,validate}.ts` |
| Material library (39 materials) and the texture files they use | `src/render/vehicle/materials.ts`, `public/assets/vehicle/*.png` |
| Decal sheet (content: names, texts, colours, sizes of every marking) | `data/defs/visuals/parts/livery.json` (section `visuals/parts/livery`), read by `src/render/vehicle/decals.ts` and baked by `tools/vehicle/bake-decals.ts` |
| 14 part generators, registry | `src/render/vehicle/parts/**` |
| 25 part visual files (parameters only) | `data/defs/visuals/parts/<partId>.json` |
| 12 launch-complex generators, registry | `src/render/vehicle/site/**` |
| Launch complex layout (25 structures, with the names of their markings) | `data/defs/sites/ka-lae-lc1.structures.json` |
| Vessel feature (id `vehicle`) and site feature (id `site`) | `src/render/vehicle/{vesselFeature,siteFeature}.ts` |
| Texture bakes (procedural, CPU), decal bake, model report | `tools/vehicle/{texlib,bake-textures,bake-decals,model-report}.ts` |
| Lab | `labs/vehicle/` (`/labs/vehicle/`) |

Part generator ids: `stage.tank`, `engine.liquid`, `stage.interstage`, `stage.ring`, `motor.pack`, `rcs.pod`,
`pad.clamp`, `capsule.mouldline`, `capsule.apexCover`, `lander.descent`, `lander.ascent`, `lander.legs`,
`fairing.petals`, `les.tower`. Site generator ids: `pad.apron`, `pad.flameTrench`, `pad.launchMount`,
`pad.umbilicalTower`, `pad.lightningMast`, `pad.catenary`, `pad.waterTower`, `pad.pipeRun`, `pad.tankFarm`,
`pad.crawlerway`, `pad.building`, `pad.floodlight`.

## 2. Public API (`import ... from '@/render/vehicle'`)

```ts
createVesselVisualFeature(options?: { exteriorGlass?: boolean; fadeSeconds?: number; maxLights?: number }): VesselVisualFeature
interface VesselVisualFeature extends RenderFeature {       // id 'vehicle'
  readonly stats: { vessels; instances; triangles; shadowTriangles; staggeredCascades; everyFrameCascades;
                    staggeredSubmissions; ghosts; lights; updateMs };
  partVisual(defId: string): PartVisual | undefined;
  anim(vesselId: string, instanceId: string): PartAnim;     // { nozzleTemp, soot, frost, clamp, antenna, lamp }
}
createSiteFeature(options?: { padElevation?: (site: LaunchSiteDef) => number; maxLights?: number; drawDistance?: number }): SiteFeature
interface SiteFeature extends RenderFeature {               // id 'site'
  readonly stats: { sites; instances; triangles; shadowTriangles; movingInstances; lights; updateMs };
  state(siteId: string): SiteState | undefined;             // { night, arms, crewArm }, each 0..1
  override(siteId: string, patch: Partial<SiteState> | null): void;   // pins a state at once (pictures); null releases
}
generatePart(defs, partDef): PartVisual          registerGenerator(id, generator)        generatorIds()
generateStructure(defs, site, model, params): SiteVisual   registerSiteGenerator(id, g)   siteGeneratorIds()
materialDef(id): PbrMaterialDef   MATERIAL_IDS   materialTextureFiles()
DECAL_SECTION   decalSheetOf(defs): DecalSheet   createDecalSheet(def)   layoutDecals(def)     // sheet.uv(name), .aspect(name), .has(name)
nozzleEquilibrium(throttle): K     stepNozzleTemp(T, firing, throttle, dt): K
```

Integration: put both features in the app's feature list after the terrain (`createSiteFeature({ padElevation })`
needs the pad surface height when the site's elevation is `'terrain'`). Both use only `src/core` and the public
API of `src/render/core` (mesh system). The vessel feature reads `SimSnapshot.vessels[].parts` and module states
only: engine throttle and gimbal (nozzle temperature model, glow of the radiative extension), heat shield
`surfaceTemp` (glow of the ablating face) and `ablatorFraction` (char), legs (`deploy`, `compression`,
`broken`), lights, antenna, fairing panel ids (`<id>#panel<k>`), clamps, and the part's `tempSkin`. A vessel
that disappears from the snapshot fades out over `fadeSeconds` as a ghost.

What a generator returns (`PartVisual`): named models with 3 LODs each, a `pose` that emits them for the part's
module state, optional `lights`, and `sootSeconds` (seconds of full-throttle firing that soot the engine and the
stage it is mounted on; absent or 0 for a part without an engine or one that burns clean). Per emitted item
(`PoseOpts`): `temperature` (K; the feature takes the larger of this and the part's skin temperature), `cold`
(never glows: glazing, lamp lenses, rime), `fade` (dithered coverage, for layers that thin out), `castShadow`,
`emissive`, `soot`, `frost`, `scale`.

Shadows. Every vessel instance is a moving caster. The camera's copies cast nothing; the same instances are
added to two caster batches built from the parts' LOD 1 and LOD 2 (single-LOD models). A cascade with texels up
to 0.1 m (the 12 m and 60 m cascades) is drawn from LOD 1, a coarser one from LOD 2. `drawShadow` issues the
draw for every cascade and counts, from the batch's own triangle counter, the staggered cascades into which the
draw put any triangle: `stats.staggeredSubmissions`, which stays 0 because the mesh batch keeps non-body-fixed
groups out of staggered cascades. The site's structures are body-fixed casters; swing arms, the crew arm and
the tail service mast are moving casters while they swing; pipe runs cast only into cascades with texels up to
0.35 m (`NEAR_SHADOW_TEXEL`; a second batch); apron, crawlerway and catenary wires cast nothing.

Conventions: part frame +Y nose, +X starboard, +Z dorsal; azimuth from +Z toward +X. Structure frame +Y up,
+X east, +Z south at heading 0. UVs are in metres; materials tile per metre. Fittings on a surface of
revolution (doors, umbilical plates, vents, louvres) are built with `surfaceFrame` / `curvedPanel` of
`parts/common.ts`, which follow a cone as well as a cylinder.

Content rule: the package's source names no marking, vehicle, part or site. Markings are named by the visual
files (`decals`, `placards`, ...) and by the structure parameters (`signs`, `signDecal`, `hazardDecal`,
`labels`, `sphereLabel`, `bulletLabel`, `crewArmSign`); a structure without those parameters is unmarked. A
second vehicle or site adds entries to `livery.json` and re-bakes the atlas. `looks.test.ts` scans the source
for marking texts and for part, vehicle and site ids.

## 3. How to run and verify

```
npm run typecheck:paths -- src/render/vehicle labs/vehicle tests/browser/vehicle tests/unit/vehicle tools/vehicle
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/vehicle tests/unit/vehicle src/core/defs tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vehicle --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vehicle --project=perf
node tools/dev/heavy.mjs --class=bake -- npx tsx tools/vehicle/bake-textures.ts [recipe ...]     # about 30 s for all
node tools/dev/heavy.mjs --class=gpu  -- npx tsx tools/vehicle/bake-decals.ts                    # canvas text in Chrome
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tools/vehicle/model-report.ts [partId ...]      # triangle counts, mesh checks
```

Lab query (`/labs/vehicle/?...`): `scene=pad|lowOrbit|lunarSurface`, `stage=<n>` (stages already fired),
`stages=<n>&coast=<s>&hold=1` (fire n more, drift, freeze), `focus=<text>` and `solo=1` (aim at / show alone
the vessel whose id or part instance id contains the text), `eye=x,y,z&at=x,y,z` (vessel frame, nose up),
`sun=az,el` or `sunv=x,y,z`, `env=`, `planet=0`, `glass=0`, `site=0`, `ballast=<iterations>`, `hud=0`.
`window.__veh = { app, sim, vehicle, site, env, setSun, setView }`; `sim.fireStage()` uses public.ts
`splitForStage`; `sim.setAll(type, patch)` patches module states (`heatShield.surfaceTemp`, `legs.broken`, ...);
`vehicle.anim(vesselId, instanceId)` is the presentation state (soot, frost). `tests/browser/vehicle/adhoc.spec.ts`
(skipped unless `VEH_ADHOC` is set) takes ad-hoc screenshots.

## 4. Acceptance, measured (2026-11-10, this machine, other agents' jobs running)

| Criterion | Result |
|---|---|
| Every part def has a generator and a visual file | 25 of 25 (`parts.test.ts`) |
| Meshes: unit normals, consistent tangents, no degenerate triangles, closed components watertight, none inside-out | pass for every model and LOD of the parts and of the complex |
| Bounds within 5 % of `PartDef.bounds` | pass (legs tested deployed; escape system 2.130 m against 2.05 m, 3.9 %) |
| Mated attach interfaces meet within 5 mm | 33 interfaces, gap 0 to 1.24 mm, no overlap |
| Capsule skin on the shared mould line within 2 mm; openings at the file's azimuth / y / size | 1.46 mm worst; openings exact (the test reads the file) |
| Nothing under a fairing or boost cover reaches through it (new) | boost cover over the capsule: least clearance 25.5 mm; cover 102.5 mm outside the capsule's mould line; payload fairing over its eight parts: least 19.7 mm (payload adapter) |
| Triangles, full stack | LOD0 1,123,110 (1.0 to 1.6 M), LOD1 272,028, LOD2 28,780 (< 60 k) |
| Launch complex triangles (all models) | LOD0 160,162, LOD1 53,382, LOD2 7,038 |
| No vessel caster in a staggered cascade | 766 staggered cascades drawn for, 0 received a triangle (measured on the batch, `staging.spec.ts`) |
| Staging sequence with `splitForStage` | all 10 stages; 13 vessels at the end; 120 instances before and after every split; expired debris fades in 70 frames |
| Vehicle G-buffer < 0.8 ms | 0.020 ms (stack filling the view), 0.063 ms (from the tower at 15 m) |
| Vehicle shadows < 0.4 ms | 0.225 ms, 0.252 ms (204,432 and 382,924 shadow triangles per frame; before the caster LODs 863,308 and 1,911,856) |
| Site G-buffer + shadow < 0.5 ms | 0.304 ms, 0.100 ms |
| CPU instance update < 0.3 ms | 0.175 ms p50, 0.285 to 0.305 ms p95 (site 0.04 ms) |
| `expectNoErrors` | in every browser test |

Perf: 2560 x 1440, `perf=features&scale=1&governor=off`, ballast 6.93 ms, p99 of timestamp queries, the MEDIAN
of three 240-frame windows per budget line, under `withGpuLock`; the three windows of each view are printed by
the spec (fill: shadow 0.006 / 0.225 / 0.229, site 0.303 / 0.305 / 0.303; tower: shadow 0.253 / 0.252 / 0.251,
site 0.100 / 0.099 / 0.338). Two other agents' perf jobs held GPU slots during the run, so the figures are
provisional in the sense of PACKAGE_RULES rule 16. Unit run: 50 tests in 6 files (this package's four files,
`src/core/defs` and the boundary test). Browser: 10 functional tests (8 screenshot tests with 56 views, staging,
shadows), 1 perf test.
Screenshots are in `out/screens/vehicle/`.

Generated assets: 45 MB in 41 files under `public/assets/vehicle` (limit 120 MB). No API key was used and no
money was spent: every texture and decal is baked procedurally. No Modal app was touched.

## 5. Deviations from the brief (wave-1 reality and decisions)

1. The structures file was rewritten, not extended. The capsule hatch is at azimuth 180 and the vehicle
   stands with its ventral side east (`padAzimuthDeg` 90), so the umbilical tower and crew arm are on the
   EAST side of the pad at `[27, 0, 0]`, not where the wave-1 placeholder file had a tower.
2. `createVesselVisualFeature` and `createSiteFeature` take options, not a context (the core hands the context
   to `init`), as every wave-1 feature does.
3. Capsule heat-shield dome: the generator uses the sphere of the file's `radiusOfCurvature` through the
   file's dome samples. It is within 1.46 mm of that surface; the raw sample polyline itself is up to 4.56 mm
   from it (chords of a coarse polyline), so the test compares against the analytic surface, not the chords.
4. Bounds test: radius within 5 % of `bounds.radius`; `yMin` / `yMax` within 5 % of max(radius, height).
   Interface test: vertical probes at 0.9 to 0.995 of the smaller node radius on 24 azimuths; no overlap
   above 5 mm anywhere, gap at most 5 mm on a ring with at least 90 % coverage.
5. The mesh system has no alpha-tested or transparent materials. Decals are opaque atlas rectangles cut into
   the lathe grid (their background is the paint under them). Window panes are an opaque, single-sided
   `glass` model, hidden when the camera is inside the vessel or with `exteriorGlass: false` (for the
   cockpit package's own glazing). The rime on a frosting tank is a layer drawn with the instance's dithered
   fade (the mesh shader's own frost term cannot take the clear coat off the paint under it, and on white
   paint it changes the picture by a level or two).
6. Flat slabs (apron, crawlerway) and the catenary wires cast no sun shadow; pipe runs cast into the near
   cascades only. With everything in every cascade the site's shadow pass was 0.38 to 0.6 ms p99.
7. `SiteFeature.override` pins a state immediately; the swing animation is driven by the vessel on the pad.
8. In the lab the pad surface is the reference sphere (`padElevation: () => 0`, the lab planet has no relief)
   and the sky, probe and ambient are the lab's analytic stand-ins, not the atmosphere package's.
9. The decal sheet lives at `data/defs/visuals/parts/livery.json` because that directory is this package's
   only owned place under `data/defs/visuals`; it holds the site's markings as well as the vehicle's.
10. Lattice structures (lightning masts, floodlight masts, the tower's bracing) and the catenary wires use
    their own `lodPixels` and LODs with members thick enough to hold a pixel, then a solid slender silhouette;
    the wires are not drawn at all beyond the distance where they would be a row of dots.

## 6. Known weaknesses (stated plainly)

- "Photoreal" is still not reached everywhere, and none of it has been judged under the real atmosphere and
  terrain: two attempts to take pictures in the integration lab from this package's ad-hoc spec gave black
  frames and were dropped; the lab lighting (analytic sky) is flat. Weakest: the hold-down clamps (plausible,
  not engineered), rainbirds and deluge headers (simple shapes), the umbilical swing arms (truss, walkway and
  lines, but no hoses or cables to the vehicle), the foil of the lander under a low sun from 10 m and more
  (facets of 4 to 10 cm read as a light and dark mosaic, right for a mirror film under a black sky but
  noisy), the tile tones of the capsule (about one tile in eight is tan, a little strong).
- The glow of the heat shield is one temperature over the whole face (one instance), so the disc is a flat
  colour; at the simulation's 3,100 K it saturates. The back shell glows as one surface at the part's skin
  temperature when that gets hot.
- The rime layer is drawn with dithered coverage. Converged it reads as a translucent white layer; in motion
  it relies on the TAA like every other dithered fade. Its patch outlines are polygons at the skin's grid
  (0.2 m by 0.5 m at LOD 0).
- Shadows are cast by LOD 1 / LOD 2: what only LOD 0 has (small lines, fasteners, the capsule's bolts) casts
  no shadow. The vessel's shadow pass did not get faster in proportion to its triangles (0.27 to 0.23 ms for
  a quarter of them), so its time is not triangle-bound; the margin to 0.4 ms is about 40 %.
- The site's shadow pass rose from 0.05 to 0.27 ms p99 in the view that holds the whole complex (pipe-run
  shadows and 50 % more site triangles); still inside the 0.5 ms line with the G-buffer.
- CPU instance update is 0.175 ms p50 (0.115 before the caster batches); p95 touches 0.3 ms on this loaded
  machine.
- Stippled dots appear on parts that sit inside a LOD cross-fade band in a still picture (for example the
  bell extensions in `engines-clean.png`) and on some shadow edges: the render core's dither, not resolved in
  the frozen frames the specs shoot.
- A broken leg is posed in the part's own frame (strut splayed 16 degrees, knee of 38 degrees, foot near the
  nominal ground): the feature does not know the terrain, so the foot is not planted on the real surface.
- Soot, frost amount and nozzle heat are presentation models inside the feature, not simulation outputs.
- Site lights are capped at 8 per frame (vessel 4) of the core's 16; with more lamps in view the nearest win.
- Not tested: more than one site, a site whose elevation comes from terrain, vehicles other than the one
  defined, behaviour at very low frame rates.
- The deluge main's pipe run passes through the small support building (it reads as a valve house; it was
  not designed as one).

Screenshots looked at in their final state in this session: boost-cover hatch, crew arm (two views), support
building, capsule in space, capsule windows, apron (low and from above), site overview at noon, site at
800 m, tank farm, frost before launch (tank and frost line), aft and engines sooted, M-2 foam on the pad,
lander deployed, MLI close-up, ascent stage, hot heat shield, broken leg. Produced by the passing run but not
opened: the night views, the pad from 300 m and from the tower, the stage views in space other than the
ascent stage, the staging frames, the fairing and escape-motor views, the perf frames.

## 7. Requests

None filed. No open request in `docs/requests` is against these paths (`ocean-3`, resolved, says this package
needs no change).

## 8. Review findings and what was done

| Finding | What was done |
|---|---|
| Boost cover: hatch panel a flat plate through the cone, capsule fittings through the cover; interstage door and plate skewed | `accessDoor`, `umbilicalPlate`, `ventPort`, louvres and ring fittings are built on the surface (`surfaceFrame`, `curvedPanel`); cover clearance 105 mm (data), capsule thrusters and handrails lowered; two new unit tests (cover clearance for every fairing module, cover outside the capsule's mould line). The first of them found a real clash of the fairing's hinge fittings with the payload adapter (61 mm), fixed |
| Reentry glow ignored the shield's surface temperature and lit the whole capsule | `shield` is a model of its own at `heatShield.surfaceTemp`; back shell at the part's skin temperature; glass and lamps `cold`; unit test and A / B screenshots |
| Decal list and site signs hard-coded | decal sheet in `data/defs/visuals/parts/livery.json`; structures name their markings; source scan test |
| Crew arm and buildings were boxes | crew arm: box truss, ribbed tunnel with windows, white room with frames, porthole, egress door and landing, roof rail, bellows hood and seal, air duct, slewing drive, kingpost and stays; buildings: precast panels, plinth, parapet and coping, roll-up doors with jambs, slats and bollards, personnel door with canopy, windows, gutters and downpipes, conduits, transformer, air handlers with fans and ducts, stacks, wall lights; tank farm: finned vaporisers, pump sets, racks, ladders, valves; tower: H-section columns, I-beams, guard rails on every level, elevator shaft framing and doors, stair stringers |
| Photoreal specifics | M-2: one foam with metre-scale tone drift, spray-pass ribbing and soft close-out patches (9.6 m tile), no alternating rings; MLI: facet-built normal map, close-up re-shot with the sun behind the camera; capsule: tiles in courses of equal width (no narrowing), 64 tiles with tone, replacements, gap fillers and part numbers; ascent-stage radiators with tubes, headers, frame and feed lines; M-3 one foam; concrete: 16 unique slabs per tile and grime weights on a tessellated apron and crawlerway; lattice LODs; pipe-run shadows |
| Frost and soot invisible or wrong | rime layer and frost line on heavily frosting tanks; soot inside engines only, all or nothing, none for hydrolox engines (`sootSeconds` 0 in data), streaked soot on the aft skin; A / B views with a pixel-difference assertion |
| Broken leg drawn intact | `brokenLegPose`; unit test and A / B views |
| Counter that could not fail; report counted as a test | `staggeredSubmissions` is measured from the batch's triangle counter; the report is `tools/vehicle/model-report.ts` |
| Perf: best-of-three, 0.86 to 1.9 M shadow triangles | median of three windows; shadows from LOD 1 / LOD 2 (0.2 to 0.38 M triangles) |
