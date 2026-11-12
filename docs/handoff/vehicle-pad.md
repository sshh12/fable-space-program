# Hand-off: vehicle-pad (vehicle models, launch complex, vessel and site render features)

Owner paths: `src/render/vehicle/**`, `data/defs/visuals/parts/**`, `data/defs/visuals/sites/**`, the site's
structures file under `data/defs/sites/`, `public/assets/vehicle/**`, `tools/vehicle/**`, `labs/vehicle/**`,
`tests/browser/vehicle/**`, `tests/unit/vehicle/**`. Nothing outside these paths was changed. Requests: section 7.

State: built, reviewed, fixed, and reworked three times after visual critiques (section 9, "Visual close-out,
round 1", 2026-11-11; sections 10 and 11, rounds 2 and 3, 2026-11-12). Sections 1 to 7 describe the package as
it is now.

## 1. What exists

Everything is generated in code at start-up from the part and site definitions; there are no model files.

| Piece | Where |
|---|---|
| Geometry kernel: mesh builder with components and position-based re-masking, lathe / tube / extrude / patch primitives, validation | `src/render/vehicle/geom/{builder,prims,validate}.ts` |
| Material library (64 materials) and the texture files they use | `src/render/vehicle/materials.ts`, `public/assets/vehicle/*.png` |
| Decal sheet (content: names, texts, colours, sizes of every marking; `foil: true` for markings painted on metal film) | `data/defs/visuals/parts/livery.json` (section `visuals/parts/livery`), read by `src/render/vehicle/decals.ts`, baked by `tools/vehicle/bake-decals.ts` into `decals.png` and `decals_orm.png` |
| 14 part generators, registry | `src/render/vehicle/parts/**` |
| 25 part visual files (parameters only) | `data/defs/visuals/parts/<partId>.json` |
| 16 launch-complex generators, registry | `src/render/vehicle/site/**` (`ground.ts`: earthworks and roads; `fence.ts`; `dressing.ts`: vehicles, camera towers) |
| Ground survey of a site (the real terrain under the complex) and its reader | section `visuals/sites/<siteId>` (`data/defs/visuals/sites/<siteId>.json`), `src/render/vehicle/site/survey.ts` |
| Launch complex layout (34 structures, with the names of their markings) | the site's `*.structures.json` under `data/defs/sites/` |
| Vessel feature (id `vehicle`) and site feature (id `site`), LOD selection | `src/render/vehicle/{vesselFeature,siteFeature,lod}.ts` |
| Texture bakes (procedural, CPU), decal bake and its cut-out copy (ink only, for lettering painted on a skin), model report, site ground report and survey | `tools/vehicle/{texlib,bake-textures,bake-decals,decal-coverage,model-report,site-ground}.ts` |
| Lab | `labs/vehicle/` (`/labs/vehicle/`) |

Part generator ids: `stage.tank`, `engine.liquid`, `stage.interstage`, `stage.ring`, `motor.pack`, `rcs.pod`,
`pad.clamp`, `capsule.mouldline`, `capsule.apexCover`, `lander.descent`, `lander.ascent`, `lander.legs`,
`fairing.petals`, `les.tower`. Site generator ids: `pad.apron`, `pad.flameTrench`, `pad.launchMount`,
`pad.umbilicalTower`, `pad.lightningMast`, `pad.catenary`, `pad.waterTower`, `pad.pipeRun`, `pad.tankFarm`,
`pad.crawlerway`, `pad.building`, `pad.floodlight`, `pad.groundworks`, `pad.fence`, `pad.vehicle`,
`pad.cameraTower`.

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
                              levelGround?: boolean;        // build on level ground, not on the survey (a level stand-in surface only)
                              maxLights?: number; drawDistance?: number }): SiteFeature
interface SiteFeature extends RenderFeature, TemporalFeature {   // id 'site'; resetTemporal() for frame-exact capture
  readonly stats: { sites; instances; triangles; shadowTriangles; fading; movingInstances; lights; updateMs };
  siteIds(): string[];                                      // the sites it draws
  state(siteId: string): SiteState | undefined;             // { night, arms, crewArm }, each 0..1
  override(siteId: string, patch: Partial<SiteState> | null): void;   // pins a state at once (pictures); null releases
}
generatePart(defs, partDef): PartVisual          registerGenerator(id, generator)        generatorIds()
generateStructure(defs, site, model, params, placement?: { offsetEnu, headingDeg }, ground?: GroundField): SiteVisual
registerSiteGenerator(id, g)   siteGeneratorIds()
// site/survey.ts: siteGround(defs, site): GroundField   siteSurvey(defs, site)   structureGround(ground, offsetEnu, headingDeg)
//                 LEVEL_GROUND   surveySectionOf(siteId)   interface GroundField { hi(x, z); lo(x, z); surveyed }
materialDef(id): PbrMaterialDef   MATERIAL_IDS   materialTextureFiles()
DECAL_SECTION   decalSheetOf(defs): DecalSheet   createDecalSheet(def)   layoutDecals(def)     // sheet.uv(name), .aspect(name), .has(name), .foil(name)
nozzleEquilibrium(throttle): K     stepNozzleTemp(T, firing, throttle, dt): K
legPose(leg, deploy, compression): LegPose      // foot joint of a landing leg (the sim's own rule)
shieldGlowLuminance(T): cd/m^2                  // hottest point of an ablating heat shield (see below)
```

Integration: put both features in the app's feature list after the terrain. `createSiteFeature()` without
options stands every structure's origin on the pad plane at `location.padElevation` and builds everything
that is not on a level area of the pad shape (roads, stone pads, berms, fence, pipe supports, lamp posts,
camera towers) ON THE SITE'S GROUND SURVEY: the section `visuals/sites/<siteId>` holds the highest and the
lowest terrain round every node of a 5 m grid over the complex (cm about the pad plane), written from the
height authority by `tools/vehicle/site-ground.ts survey`. Earthworks are fill over the upper bound with
shoulders and feet under the lower one, so nothing is buried and nothing hangs whatever the relief
(`pad.shape` keeps a quarter of it between the level areas: -2.1 .. +2.8 m here). **A site with structures and
no survey does not load** (`siteGround` throws); **the survey must be re-run when the terrain inside the site
changes** (tiles, pad shape, amplification) or the structures' extent grows: `site-ground.ts verify` exits 1
when the survey in the library no longer bounds the terrain, and `game.spec.ts` checks it against the live
terrain of the integration lab. Only a caller that draws the site on a level stand-in surface passes
`levelGround: true` (the vehicle lab). `groundHeight` / `padElevation` are as before (a structure's origin on
unflattened ground; an elevation of `'terrain'`). Both features use only `src/core` and the public API of
`src/render/core` (mesh system): neither creates a pipeline of its own, so there is nothing of theirs for
`shaders.warm()` (NOTICE-core-5) to create ahead; both implement `resetTemporal()` (LODs chosen afresh,
arms at their targets). The vessel feature reads `SimSnapshot.vessels[].parts`
and module states only: engine throttle and gimbal (nozzle temperature model, glow of the radiative
extension), heat shield `surfaceTemp` (the shield's glow) and `ablatorFraction` (char), legs (`deploy`,
`compression`, `broken`), lights, antenna, fairing panel ids (`<id>#panel<k>`), clamps, and the part's
`tempSkin`. A vessel that disappears from the snapshot fades out over `fadeSeconds` as a ghost.

What a generator returns (`PartVisual`): named models with 3 LODs each (a wire has 4), a `pose` that emits them
for the part's module state, optional `lights(input)` (lamps when on, the spill of a glowing heat shield; a
light may be a line with `end`, or a spot with `dir` and `cone`: every lamp is one), and `sootSeconds`. Per emitted item (`PoseOpts`): `temperature`, `cold`,
`fade` (dithered coverage: used only for a vessel that fades out), `castShadow`, `emissive`, `soot`, `frost`,
`scale`. A site item (`SiteItemOpts`): `emissive`, `moving`, `castShadow`, `grime`, and the shadow classes
`nearShadowOnly`, `fineShadowOnly`, `shadowProxy` (below).

LOD. Every LOD of a model is a single-LOD model of the mesh system and the features pick which to draw
(`lod.ts`): by projected diameter with 12 % hysteresis, and a switch is a 0.25 s cross-fade in time (the coarser
LOD solid, the finer dithering in or out); in deterministic captures it is immediate. Nothing is left
half-dithered by where the camera stands (`stats.fading` is 0 at rest; `screens.spec.ts`, LOD dolly test).
Switch sizes: engines 420 / 30 px (LOD 0 only where its fasteners cover pixels), stages 700 / 110 px, tower
900 / 260, lightning masts 1500 / 420 (a lattice only where its braces cover a pixel), fence runs 2700 / 600,
camera towers 420 / 110, default 220 / 60.

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
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tools/vehicle/decal-coverage.ts                 # after every decal bake: decals_cut.png (ink only)
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tools/vehicle/model-report.ts [partId ...]      # triangle counts, mesh checks
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tools/vehicle/site-ground.ts [radial]           # terrain under every structure
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tools/vehicle/site-ground.ts survey             # writes data/defs/visuals/sites/<siteId>.json (about 25 s)
node tools/dev/heavy.mjs --class=cpu  -- npx tsx tools/vehicle/site-ground.ts verify             # exit 1 if the survey no longer bounds the terrain
```

Browser specs: `screens.spec.ts` (8 screenshot tests with 72 views in the vehicle lab, live captures: jitter
and noise running, 72 frames of temporal accumulation; and the LOD dolly test), `staging.spec.ts`, `game.spec.ts` (the integration lab on the real
terrain, sky and exposure: 13 pad views, 6 flight views of which two are the flown capsule in the real
simulation's state (`sim=real&scenario=qa-drogues`), 3 lunar ground views, the live terrain against the ground
survey, and the terrain-to-pad-plane gap under every structure that stands on a level area),
`vehicle.perf.spec.ts`, `adhoc.spec.ts` (`VEH_ADHOC`). Pictures: `out/screens/vehicle/` (108 files; `game-*`
are the integrated game). The pad, lunar and survey tests of `game.spec.ts` skip themselves when the
integration lab could not load the terrain package (another package's shader in mid-edit does that): run it
again before concluding.

Lab query (`/labs/vehicle/?...`): `scene=pad|lowOrbit|lunarSurface`, `stage=<n>`, `stages=<n>&coast=<s>&hold=1`,
`focus=<text>`, `solo=1`, `eye=x,y,z&at=x,y,z` (vessel frame, nose up; on the pad x = south, z = west),
`sun=az,el` or `sunv=x,y,z`, `env=`, `planet=0`, `glass=0`, `site=0`, `ballast=<iterations>`, `hud=0`.
`window.__veh = { app, sim, vehicle, site, env, setSun, setView }`. On a surface the lab draws only the body
underfoot and places a vessel on legs by its foot pads; separated pieces get the relative motion they have in
flight.

## 4. Acceptance, measured (2026-11-12, this machine, other agents' GPU, CPU and bake jobs running throughout)

| Criterion | Result |
|---|---|
| Every part def has a generator and a visual file | 25 of 25 |
| Meshes: unit normals, orthonormal tangents, no degenerate triangles, closed components watertight, none inside-out | pass for every model and LOD of the parts and of the complex (38 unit tests in 4 files; the boundary test, 93 tests, green) |
| Bounds within 5 % of `PartDef.bounds` | pass (feedlines, blisters and clamp keepers were sized to this limit) |
| Mated attach interfaces meet within 5 mm | 33 interfaces, gap 0 to 1.24 mm, no overlap |
| Capsule skin on the shared mould line within 2 mm; openings at the file's azimuth / y / size | pass (the test reads the file) |
| Nothing under a fairing or boost cover reaches through it | boost cover over the capsule: least clearance 25.5 mm; fairing over the descent stage 156 mm |
| Triangles, full stack | LOD0 1,299,720 (1.0 to 1.6 M), LOD1 309,086, LOD2 28,928 (< 60 k) |
| Launch complex triangles (all models, 34 structures) | LOD0 394,720, LOD1 120,928, LOD2 18,274 |
| No vessel caster in a staggered cascade | 0 staggered submissions (`staging.spec.ts`) |
| Staging sequence with `splitForStage` | all 10 stages; separated pieces are full models and clear the stack |
| LOD: nothing left dithered | dolly of 12 distances from 7 to 360 m: 271 cross-fades started, 0 items fading 60 frames after each stop |
| The complex on the real ground | the survey bounds the terrain: 219,240 samples of the height authority (`site-ground.ts verify`) and 775 live samples in the integration lab (`game.spec.ts`), worst excess over its bounds 0.000 m in both; every vertex of the ground model is at least 2 cm over the upper bound or at least 0.3 m under the lower one, every level face is above the upper bound at its centre (`site.test.ts`); largest terrain-to-pad-plane gap under the 22 structures that stand on level areas 0.000 m |
| Vehicle G-buffer < 0.8 ms | 0.022 ms (stack filling the view), 0.072 ms (tower at 15 m), p99 |
| Vehicle shadows < 0.4 ms | 0.210 ms (fill; windows 0.007 / 0.210 / 0.241), 0.251 ms (tower; 0.252 / 0.251 / 0.251), p99 |
| Site G-buffer + shadow < 0.5 ms | 0.069 + 0.243 ms (fill), 0.033 + 0.045 ms (tower), p99 |
| CPU instance update < 0.3 ms | 0.185 ms p50 / 0.345 ms p95 (fill), 0.195 / 0.305 ms (tower); the site's own update 0.105 / 0.100 ms p50. **One run of round 2 failed this line** (0.310 and 0.305 ms p50) under a multi-process bake; see below |
| `expectNoErrors` | in every vehicle-lab test |

Perf: 2560 x 1440, `perf=features&scale=1&governor=off`, ballast 6.9 ms, p99 of timestamp queries, median of
three 240-frame windows, under `withGpuLock`. The spec was run twice on the final code. Run 1 (06:55, with a
multi-process terrain bake and a CPU job running, other agents' browser jobs queued behind it): every GPU
line passed (fill 0.022 / 0.224 / 0.070 + 0.260 ms, tower 0.072 / 0.259 / 0.034 + 0.045 ms) and the CPU line
failed by a hair (0.310 and 0.305 ms p50 for the vessel feature's update; the site's 0.290 and 0.255 ms).
Nothing in the vessel feature's update path had changed since round 1 (0.240 ms then), so I took the miss for
load and did not touch the assertion; I did cut the site's own per-frame work (the fence in runs of 180 m
instead of 60 m: a third of its items) and ran again. Run 2 (08:39, a bake and a CPU job starting during it):
all lines passed with the figures in the table. The CPU line has little margin under load (p95 0.31 to
0.42 ms): most of the update is three `MeshBatch.add` calls per instance (the camera's copy and the two
caster batches), each of which builds its matrices again. The lead should re-measure on a quiet machine
(PACKAGE_RULES 16).

Round 3 (the figures in the table): the spec passed in both of its runs (the other: fill 0.022 / 0.242 /
0.070 + 0.260 ms and 0.160 ms p50; tower 0.072 / 0.253 / 0.034 + 0.045 ms and 0.145 ms p50), 125 instances
(the markings models are four more).

Generated assets: 91 MB in 70 files under `public/assets/vehicle` (limit 120 MB). No API key was used and no
money was spent: every texture and decal is baked procedurally. No Modal app was touched.

## 5. Deviations from the brief (wave-1 reality and decisions)

1. The structures file was rewritten, not extended (tower and crew arm on the EAST side of the pad).
2. `createVesselVisualFeature` and `createSiteFeature` take options, not a context.
3. Capsule heat-shield dome: the sphere of the file's `radiusOfCurvature` through the file's dome samples.
4. Bounds test: radius within 5 % of `bounds.radius`; `yMin` / `yMax` within 5 % of max(radius, height).
5. The mesh system has no transparent materials; it has alpha-tested ones since request 4. Decals are opaque
   atlas rectangles cut into the lathe grid; window panes are an opaque, single-sided `glass` model; bar gratings
   are real bars at LOD 0 and a cut-out plate (`grating`, `alphaCutoff` 0.5) beyond.
6. LOD selection is done by the features, not by the mesh system's size band (section 2).
7. `SiteFeature.override` pins a state immediately; the swing animation is driven by the vessel on the pad.
8. In the vehicle lab the pad surface is the reference sphere and the sky, probe and ambient are the lab's
   analytic stand-ins. The hardware is judged for play in `game.spec.ts`.
9. The decal sheet lives at `data/defs/visuals/parts/livery.json`.
10. A wire cannot be drawn with sub-pixel coverage: it is four gauges (true, 0.22, 0.7, 2.2 m), each used
    where it is one to three pixels wide.
11. Lamps are spot lights at their lenses (request 2): floodlight banks aimed at the vehicle with a second
    wide spot on the apron from every pole, the tower's lamps across at the vehicle, landing lamps down at the
    touchdown area. The core shadows the two brightest shadow-casting spots at the camera (the banks, the
    landing lamps).
12. The heat shield's glow is compressed against a black body (`shieldGlowLuminance`): sunlit white at 1,900 K,
    eight times that at 3,100 K, so the face keeps its gradient instead of burning out to a flat disc.
13. A site's earthworks are built on a ground survey that is DATA (section `visuals/sites/<siteId>`, written
    by `tools/vehicle/site-ground.ts survey`), not on the terrain provider at run time: the features may import
    only `src/core` and the render core, and the app constructs the site feature without options. The survey
    bounds the terrain (upper and lower) and is checked against the tiles by the tool and against the live
    terrain by `game.spec.ts`.

## 6. Known weaknesses (stated plainly)

- The ground survey is a snapshot: when the terrain inside the site changes (tiles, pad shape, amplification)
  the roads are fill over the surface as it WAS. `site-ground.ts verify` and `game.spec.ts` catch it; nothing
  re-surveys by itself. The survey is per site, in the frame of the site's reference point; the sixteen pads
  of v2 have no structures of their own yet (request sim-core-v2-2, resolution).
- Earthworks can only fill: the terrain draws over anything cut into it. A road therefore stands a quarter
  metre and more above the highest ground along it, and its embankment is taller where the ground is rough.
- The terrain's ground cover does not know the roads and the fence line (request 8): shrubs and trees stand
  at the shoulders.
- Night: no beams in the air (no transparent pass in this package); the core shadows two spots, so the
  shadows of tower and masts across the apron come from the two banks nearest the camera only; site lights
  are capped at 12 per frame (vessel 4) of the core's 16, the nearest win.
- Frost: the coat is brilliant against the grey tank barrels now (display luma 180 against 155), but the edges
  of its bare lanes and of the frost lines break into hard dashes: the core draws frost as a mask (request
  11). No vapour and no falling ice (request 9).
- The returned capsule's soot mask is thick (mean 0.96 on the cone, the shader's near-black), yet in direct
  low sun it still reads brown-gold rather than charcoal: the hue of the deposit is the core's ramp
  (request 13).
- Markings on the interstages, the boost cover, the fairing and the site's signs are still atlas rectangles
  (on dark or flat surfaces); only the stages and the capsule have cut-out lettering.
- Glass is an opaque dark mirror: no inner panes, no cabin behind the windows from outside (the cockpit
  package's glazing replaces the panes when `exteriorGlass` is false).
- Stand-off fittings thinner than the contact march resolves get a ragged contact shadow (request 10; the
  hatch's handle and handrails were made solid).
- Lightning masts beyond about 450 m are solid posts; fence fabric beyond about 100 m is a faint veil.
- Fairing petals have no panel joints, vents or rails; the capsule's nose has no docking mechanism; tower
  joints have gusset plates but no bolt groups; the launch mount's water system is plain painted pipe.
- A broken leg is posed in the part's own frame: the feature does not know the terrain.
- Soot, frost amount and nozzle heat are presentation models inside the feature, not simulation outputs
  (the capsule's scorch is the exception: it follows the shield's `ablatorFraction`).
- Not tested: more than one site, a site on unflattened ground under its structures' origins (`groundHeight`
  is implemented, not exercised), vehicles other than the one defined.

## 7. Requests

| File | To | State | What |
|---|---|---|---|
| `docs/requests/vehicle-pad-1.md` | render core, mesh shader | resolved (ad38ab3) | clear coat under soot and frost, texture-space break-up of both, frost and soot colours |
| `docs/requests/vehicle-pad-2.md` | render core, contracts | resolved (d48e735, 1426e0d) | spot lights (every lamp), shadows of the two brightest spots |
| `docs/requests/vehicle-pad-3.md` | terrain render | resolved (4d55e12, 34548f5; item 1 declined in part) | site ground plan instead of a concrete disc |
| `docs/requests/vehicle-pad-4.md` | render core, contracts | resolved (95d2c70) | alpha-cutout materials. Used: `grating`, `chainlink` |
| `docs/requests/vehicle-pad-5.md` | integration lab | resolved (f184651) | lunar scene with the lander's legs deployed |
| `docs/requests/vehicle-pad-6.md` | render core, mesh shader | resolved (94e4266) | thin frost as a veil instead of sparse streaks |
| `docs/requests/vehicle-pad-7.md` | render core, mesh shader | resolved (038cf6f, 06c9167) | soot as a density instead of a mask. Used: every soot weight of the package |
| `docs/requests/vehicle-pad-8.md` | terrain render | open | ground cover and loose rocks off the roads, stone pads and fence line of a site; a strip of disturbed soil; word when the height function changes inside a site |
| `docs/requests/vehicle-pad-9.md` | vfx | open | vent vapour, vapour down the frosted barrels and falling ice, from the vents and frost bands the visual files declare |
| `docs/requests/vehicle-pad-10.md` | render core, lighting | open | contact shadows of thin stand-off casters |
| `docs/requests/vehicle-pad-11.md` | render core, mesh shader | open | frost as a coat with a thickness (soft edges, cool white, sparkle) instead of a mask |
| `docs/requests/vehicle-pad-12.md` | vfx or atmosphere | open | single scattering of the frame's spot lights in the air (beams on the night pad) |
| `docs/requests/vehicle-pad-13.md` | render core, mesh shader | open | soot ramp: a grey-brown veil and a neutral black instead of one coffee brown |

Against these paths: `cockpit-11` (ports in the boost cover) resolved in 9a5339a; `sim-core-v2-2` (a site
with structures and no ground survey must fail at load) resolved in 37d3ad2. No other open request in
`docs/requests` is against these paths.

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

### Round 1, continued (second agent, 2026-11-11 afternoon)

The first agent's account hit a spend limit after part 7; its last uncommitted change (launch-mount plate faces
keep the plate's own weathering) was committed as it was. What was done after that, by list item:

| # | Item | What was done | Shows in |
|---|---|---|---|
| 3 | Lander insulation | Film texture rebuilt as crumpled film: straight folds of finite length (30-90 cm hanging folds mostly along the blanket, fewer gentle 10-30 cm ones), each a ridge or valley with flat flanks, so the surface is flat facets between sharp creases (the previous one was soft pillows that read as hammered copper); narrower amber tint range | `lander-mli-closeup`, `lander-deployed`, `lander-deployed-sun-5` |
| 4 | Frost | Fuller coat on the barrels (weight 0.62 to 1, heavier low); over markings a veil (weight 0.38) that the core now draws as a haze instead of a few solid streaks (request 6), so the letters keep their edges and lose contrast instead of being cut into stripes | `frost-prelaunch`, `frost-line-prelaunch` |
| 8 | Night lighting | Every lamp is a spot light at its lens (request 2 part 1): six banks aimed at the vehicle (1.2e7 cd, 24 / 44 degrees: the vehicle brightest, the apron round its base at about a third, the ground under the masts dark), the tower's lamps across at the vehicle, the landing lamps down at the touchdown area, the capsule lamp along its axis. Still no shadows (part 2) | `site-overview-night`, `site-pad-night`, `game-pad-night`, `lander-lights` |
| 13 | Model railway set | Asphalt cracks are a few wandering sealed lines across and along the road (the polygon network read as cracked mud) | `game-site-tank-farm-low` |
| 17 | Grating | Cut-out material (request 4): real bars only at LOD 0, a cut-out plate with frame beyond it, on walkways, tower floors and treads; the swing-arm walkways are models of their own that pick their LOD by their own bar pitch (their 60 mm bars aliased into glitter from 15 m) | `pad-stack-tower-15m`, `pad-stack-tower-15m-up` |
| 19, 24 | Lander in the integration lab | The lunar scene had the legs stowed (request 5, resolved): re-shot standing on its pads | `game-moon-lander-landed`, `game-moon-lander-low-sun`, `game-moon-lander-foot-pad` |
| - | Request cockpit-11 | Boost cover: real ports (cut through the wall, reveals, bezels, a pane model left out from inside) over the hatch window and the commander's forward window, sized from every seat's eye point and declared as `params.windowPorts`; dark lining inside | `les-boost-cover-port` (new), `les-boost-cover-hatch` |

Spec changes: `les-boost-cover-port` added; `capsule-hatch` takes its sun at `0.85,0.45,-0.1` (the hatch faces the
planet in the lab's attitude, and since the core's per-pixel occlusion by other bodies a sun 14 degrees toward it is
eclipsed: the old view was black). Unit tests: a sight-line test for the cover's ports (`parts.test.ts`), and the
open-component allow list names the cover, its reveals and panes (it is a shell with openings now, like the
capsule skin).

Not done in this part, and why: shadows of local lights (request 2 part 2, not built by the core); fence, camera
towers, parked vehicles; bolt groups at tower joints; fairing petal detail; vent-fog anchors; inner window panes.

## 10. Visual close-out, round 2 (2026-11-12)

Work list: `docs/qa/wave2/vehicle-pad.r1.combined.json` (photo 5/10, artifact 5/10; 1 blocker, 10 majors, 10
minors; 19 earlier items still open). Pictures are in `out/screens/vehicle/` (`game-*` are the integrated
game); every one named here was looked at, most of them twice (after the first change and after the fix of
what the first look showed).

| # (r1 finding) | Item | What was done | Shows in |
|---|---|---|---|
| 1 (blocker) | The terrain buries roads and stone | Found which side was wrong: both. The pad shape (terrain-render-6) keeps a quarter of the natural relief between the level areas (-2.1 .. +2.8 m inside the fence, 0.1 to 0.3 m hummocks at metre scale) and my earthworks assumed the pad plane. Fixed on my side: a ground survey of the site from the height authority (section `visuals/sites/<siteId>`, 5 m grid, highest and lowest terrain round every node; `site-ground.ts survey` / `verify`), and every earthwork built on it: road grade lines from the smoothed upper envelope of the ground along them plus a quarter metre of fill, shoulders and embankment feet under the lowest ground, the stone field inside the level core, stone pads as rounded rectangles on the level areas, berms, fence posts, lamp posts, camera towers and pipe supports standing in the ground under them, pipe runs lifted to clear it. A site with structures and no survey does not load. Unit test: every vertex of the ground model is fill over the upper bound or a foot under the lower one; game spec: 775 live terrain samples of the integration lab lie inside the survey's bounds (worst excess 0.000 m). Request 8 to the terrain (ground cover off the roads and the fence line) | `game-site-aerial`, `game-site-perimeter-road`, `game-site-farm-road`, `game-site-gate`, `game-site-fence-pad`, `game-site-tank-farm-low` |
| 2 | Base blankets are a printed lattice | The lattice came from a quilt texture on lathed discs (azimuth / radius coordinates): gone. Base close-outs of the stages and both lander stages are flat sheets with PLANAR coordinates in a new material (`blanket-base`: hand-laid panels in four unequal courses, slanted end joints, laced and taped seams, dull cloth at roughness 0.74). Engine boots are plain dark cloth, pleated twice as deep | `stage-lander-underside`, `stage-m3-aft-space`, `stage-m1-aft-space`, `stage-m2-aft-space` |
| 3 | The capsule is spotless at splashdown | The scorch was there but as a mask on the windward side only, cut off at a threshold. It is now a density over the whole back shell driven by the shield's ablation history in the snapshot (`ablatorFraction`: 0.58 after the nominal lunar return = full char): a veil everywhere, heavier to windward, thick at the shoulder, carried up the cone in streaks, gathered in the lee of windows and hatch; tape strips, frames, fairings and the forward bay take the shell's soot. Shown in the real simulation's state (scenario `qa-drogues`, nothing set by hand) | `game-chutes-capsule-flown`, `game-chutes-capsule-flown-lee`, `capsule-charred-back-shell` |
| 4 | Soot and scorch are flat grey cut-outs | Request 7 to the render core, resolved within the round (038cf6f): soot is a density (a thin deposit is a brown veil that lets paint, tiles and markings show, a thick one near black; streaks 6 cm x 1.5 m along the flow modulate it by a third). My weights are smooth density fields with no threshold of their own | `aft-sooted`, `engines-sooted`, `capsule-charred-back-shell`, `staging-02` to `staging-05` (flown stages) |
| 5 | Foam reads as cloth | Texture rebuilt: no ribs; popcorn at three scales whose coarseness drifts (sanded areas beside rough ones), spray lumps of every size, pass overlaps as level lines of finite length; tone in patches along the tank from pale ochre to dark rust, run marks, a few ragged repairs. Close-outs as geometry in older foam: a trowelled band at every flange and a pad at every feedline bracket foot (the white slivers were bright bracket feet) | `closeup-foam`, `stage-m2-space`, `stage-m2-foam-pad`, `game-pad-noon-300m` |
| 6, 13 | Frost is invisible; markings sit in windows | Measured first: sunlit white paint and frost both sit on the shoulder of the tone curve (barrel luma 175.5 bare, 181.4 frosted in the lab; a luma-ratio assertion of 1.08 that I first added to the spec could not hold and was replaced by one on structure: 93.5 % of the tank view's pixels change by more than ten levels between frosted and shed), so brightness cannot carry it. Frost now has structure: scalloped frost lines, rime rings on the weld lands, bare lanes a metre wide where sheets slid off, thick rime on the bare frames and on the feedlines, a patchy coat on the dark intertank between the tanks (the cue that reads from across the pad), and the stage's white is a flown white (albedo about 0.65) under it. One weight across the skin: the thinning over a marking fades out raggedly over most of a metre. Vapour and falling ice are particles: request 9 to vfx with the vent positions and frost bands the visual files declare | `frost-prelaunch` against `frost-shed`, `frost-line-prelaunch`, `pad-stack-300m`, `game-pad-noon-300m` |
| 7 | Night views dim and flat | Banks at 3e7 cd (the vehicle is the brightest surface, near white), a second wide spot on the apron from every pole (overlapping pools), 12 site lights, round searchlight lenses in drums instead of white squares, work lights at every corner of every tower level in every LOD (the structure is drawn by its lights), landing lamps with a soft cone (16 / 46 degrees) and a lens below bloom | `site-pad-night`, `site-overview-night`, `game-pad-night`, `lander-lights` |
| 8 | Stages are plain and showroom clean | A skin material at vehicle scale (`skin-white`, tile 12.8 m: tone drift, dirt runs, touched-up patches, stencil blocks; waviness of the sheet in the normal map) on M-1, the skirts, the fairing, the adapter and the boost cover; forward dome in gores with ring seams, helium bottles on tripods plumbed to the manhole and a lit crown; the staging sequence shows flown hardware (burnt engines carry their soot) | `stage-m1-space`, `stage-m2-space`, `stage-m3-space`, `interstage-interior`, `staging-00` to `staging-10` |
| 9 | Model railway | Road plan with a purpose (perimeter road with rounded corners that encloses pad and farms, access road from the gate past the support building to the hardstand, farm roads, a spur to the tower), chain-link fence with outriggers and gates at the access road and the crawlerway, road lamp posts, three tracking-camera towers, four parked vehicles, wheel tracks in the stone, fill as crushed dark basalt (it was tan on black lava), ragged field edge that thins into the ground; flame trench burnt by position (floor, wall skins with soot tongues and rust runs from the deluge fittings), blast stain, deluge wash and tyre lanes on the apron, scorch fans on the stone at the trench exits; pipe runs in weathered white on concrete plinths with a cable tray and flanged field joints | `game-site-aerial`, `game-site-gate`, `game-site-fence-pad`, `site-fence-gate`, `site-trench-burnt`, `site-apron`, `site-tank-farm` |
| 10 | Capsule is sheet metal pressed into bricks | Tiles are flat long trapezoids (0.18 x 0.42 m) in aligned columns up the cone's generators (columns halve where the cone has narrowed), joints as hairlines in roughness and occlusion, tint in broad zones (a third of the old range), tabs of fresh tape, a plug on one tile in four, a handful of long tape wrinkles across several tiles; close-out panels end on tile joints on all four sides; apex cover as a taped lid of the forward bay with gore seams | `stage-capsule-space`, `capsule-windows`, `capsule-hatch`, `game-orbit-capsule` |
| 11 | Ragged shadow beside the hatch rail | The handle is a solid pull bar on a base plate (no gap under it for the contact march to resolve as noise); request 10 to the core for thin stand-off casters in general | `capsule-hatch` |
| 14 | Thin members bead into dots | Lightning masts: the lattice only where its braces cover a pixel (1500 / 420 px), solid beyond; engines' LOD 0 only where its fasteners cover pixels (420 px) | `game-pad-noon-300m`, `engines-clean` |
| 19 | Silver blankets are liquid chrome | Fine crinkle (1 to 2 cm creases) over the laid-flat folds, roughness 0.56 | `lander-deployed`, `stage-ascent-space` |
| 20 | Charred shield salted with white dots | Pits in two sizes gathered in drifts, dark; a handful of large pale spalls | `capsule-heat-shield-charred`, `game-chutes-capsule-flown` |
| 21 | Specks on the bell bands, pale boot discs | Engine LOD 0 threshold (above); boots dark and pleated | `engines-clean`, `stage-m1-aft-space` |

Assertions changed in this round, and why (none is a budget or an acceptance line of the brief):
`looks.test.ts` asked for a frost coat on 98 % of a barrel's vertices with no hole; the critique asks for bare
lanes, so it now asks for 85 to 99.5 %, and counts an intertank as frosting; the open-component allow list of
`parts.test.ts` names the flat blanket sheets (`deck`, `closeout`); `site.test.ts` lets a parked vehicle stand
on its slab (0.05 to 0.36 m over the pad plane); `game.spec.ts` checks the origin gap only for the structures
that are not built on the survey (those are checked against the survey instead). New: the survey tests of
`site.test.ts` and `game.spec.ts`, the frost-structure assertion of `screens.spec.ts` (a luma-ratio assertion
I added first was wrong: see the frost row).

Perf after the round: section 4 (all lines pass in the last run; the CPU line failed once under load).

Also in this round: `resetTemporal()` on both features (frame-exact capture, NOTICE-core-5); neither feature
creates a pipeline, so there is nothing of theirs for `shaders.warm()`; `SiteFeature.siteIds()` and no spec
names a site id (the site was renamed to `ka-lae` during the round); request `sim-core-v2-2` against this
package resolved (a missing survey fails at load).

Not fixed, and why:

- **Windows are black voids** (18): no inner panes or cabin glow; the mesh system has no transparent
  materials and the cockpit package's glazing replaces the panes in the game (`exteriorGlass: false`).
- **Beams in the night air** (7): additive volumes need a transparent pass of this package's own or the
  atmosphere's local-light scattering; not started.
- **Docking hardware at the capsule's nose** (10): the apex cover is a taped lid now, not a mechanism.
- **Top of the stack** (17): boost cover and fairing have the stage's skin; panel joints, vents and
  separation rails on the fairing petals are still not modelled.
- **Tower weathering and bolt groups** (16), **launch mount finish** (12): unchanged in geometry; with the
  core's soot as a density the steelwork's grime now reads as a brown stain instead of charcoal.
- **Lander in the lab** (15): not looked at again (the game's lunar views are right).
- **Markings under soot**: a marking's soot is a constant over its quad (the shader's streaks are in texture
  space and a decal's coordinates are atlas coordinates), so a marking on the scorched capsule shows as a
  slightly darker or lighter label.
- **Ground cover beside the roads**: the terrain's shrubs and trees do not know the roads (request 8); none
  stands on the asphalt in today's pictures, some stand at its shoulder.
- **Vapour and falling ice**: request 9 (vfx).
- **Far masts** are solid red-and-white posts beyond about 450 m (a cut-out lattice would put the masts on
  the per-material shadow path, which cost 1.2 ms on the vessel in round 1).

## 11. Visual close-out, round 3 (2026-11-12)

Work list: `docs/qa/wave2/vehicle-pad.r2.combined.json` (photo 6/10, artifact 6/10; no blocker, 7 majors, 14
minors). One working session at the end of a long one: the majors were taken first and the round stops at
a committed green state with the minors below open.

| # (r2 finding) | Item | What was done | Shows in |
|---|---|---|---|
| 1 | Frost reads as grey whitewash, 4 % brighter than bare | The difference now survives the tone curve: the cryogenic tank barrels are painted light grey (`skin-grey`, albedo about 0.37; a working launcher's grey), so the coat is the brightest thing on the stage: barrel luma 180 frosted against 155 bare in the lab (ratio 1.16; it was 1.03). One coat across the skin (0.75 and above, bare lanes at 0.12), a solid rime on the intertank and its frames (the dashes were a half weight), lettering under an even veil. What is left is the core's: lane and frost-line edges still break into hard dashes because frost is drawn as a mask (request 11: frost as a thickness, as soot became a density), and vapour is the effects package's (request 9, open) | `frost-prelaunch` against `frost-shed`, `frost-line-prelaunch`, `pad-stack-300m`, `game-pad-noon-300m` |
| 2 | The flown capsule is a brass tint | Partly. The pristine film is a mirror of a dark sky, so a thin deposit read as bright as the film. The soot mask is thick now (mean 0.96 on the cone: the shader's near-black over most of the shell, dark brown streaks in the lee, three streak widths and a mottle), on the forward bay, window panels and round every fitting, and the markings are ink on the scorched tiles (no clean label). In the pictures the unlit side is black, but the side in direct low sun still reads brown-gold, not charcoal: the hue is the core's soot ramp (request 13) | `game-chutes-capsule-flown`, `game-chutes-capsule-flown-lee`, `capsule-charred-back-shell` |
| 3 | Furry shadow at the hatch rails | The two handrails are solid rails on a web that runs down to the skin (no gap for the contact march to resolve as noise), like the pull handle; request 10 stays open for thin casters in general | `capsule-hatch` |
| 4 | Markings are stickers | Markings on the stages and on the capsule are cut-out lettering: a cut-out copy of the atlas keyed to the ink (`decals_cut.png`, `tools/vehicle/decal-coverage.ts`, material `decal-cut`; the sheet's `skinColors` say which backgrounds are skin) on patches a hair above a continuous skin, in a model of their own that casts no shadow. The skin weathers, soots and frosts under and between the letters; plates with a colour of their own (caution placards) stay whole. Not converted: markings on the interstages, the boost cover and the fairing (dark or flat surfaces where the rectangle does not show) and the site's signs | `frost-shed`, `stage-m1-space`, `capsule-hatch`, `capsule-charred-back-shell` |
| 5 | The berm is a knife-edged prism with stretched cobbles | A pushed-up bank: cosine cross-section of 10 vertices with smooth normals, lumps at blade scale, ends that run out in height and width on a rounded plan; fill at a third of the river rock's size | `game-site-tank-farm-low`, `site-tank-farm-berm` |
| 6 | Night pad half lit | Three of the six banks aim at 0.8 of the stack's height with a tighter cone: the vehicle is lit from skirt to capsule. Beams in the air: request 12 (no transparent pass here) | `game-pad-night`, `site-pad-night` |
| 7 | Close-up hardware is clean primitives | Only the deluge system's finish: galvanised ring main and goose-necks with a rust-and-scale stain, darker oxide heads. Bolt groups, weld beads, clamp shoes, arm plates and hoses are NOT done | `pad-engine-section` |
| 8 | Windows are black voids | Panes are dark mirrors (metallic, roughness 0.03, a fifth to a quarter of what faces them): black only when they face empty space. No inner pane or cabin glow | `capsule-windows`, `game-orbit-capsule` |
| 17 | Landing lamps bloom, light lands to one side | Lens luminance a seventh of round 2's, cones aimed 9 degrees outward instead of 25: the pool lies under and round the vehicle | `lander-lights` |

Not done in this round, and why (working context ran out; all are stated in the critique with their
causes): the minors 9 (soot hue and heat tint on the bells: the hue is the core's ramp), 10 (trench floor
tone), 11 (blanket panels' stitching, powerheads), 12 (top of the stack), 13 (silver film at 10 to 30 m,
radiator, thruster quad), 14 (shield spalls and glow map), 15 (lander pads in the lab), 16 (comb edge
against cloud: not this package's), 18 (verges, crawlerway end: partly the terrain's, request 8), 19
(capsule nose hardware), 20 (foam at 40 m), 21 (dust on the foot pads); of major 7 everything but the
deluge finish; of major 6 the work lights' spill.

Assertions changed: `looks.test.ts` lets a frosting stage pose its `markings` model beside `body` (still
nothing dithered). Nothing else.

Perf after the round: section 4.
