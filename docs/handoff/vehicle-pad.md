# Hand-off: vehicle-pad (vehicle models, launch complex, vessel and site render features)

Owner paths: `src/render/vehicle/**`, `data/defs/visuals/parts/**`, `data/defs/sites/ka-lae-lc1.structures.json`,
`public/assets/vehicle/**`, `tools/vehicle/**`, `labs/vehicle/**`, `tests/browser/vehicle/**`,
`tests/unit/vehicle/**`. Nothing outside these paths was changed; no request was filed.

## 1. What exists

Everything is generated in code at start-up from the part and site definitions; there are no model files.

| Piece | Where |
|---|---|
| Geometry kernel: mesh builder with components, lathe / tube / extrude / patch primitives, validation | `src/render/vehicle/geom/{builder,prims,validate}.ts` |
| Material library (38 materials) and the texture files they use | `src/render/vehicle/materials.ts`, `public/assets/vehicle/*.png` |
| Decal atlas layout (fictional livery only) | `src/render/vehicle/decals.ts`, baked by `tools/vehicle/bake-decals.ts` |
| 14 part generators, registry | `src/render/vehicle/parts/**` |
| 25 part visual files (parameters only) | `data/defs/visuals/parts/<partId>.json` |
| 12 launch-complex generators, registry | `src/render/vehicle/site/**` |
| Launch complex layout (25 structures) | `data/defs/sites/ka-lae-lc1.structures.json` |
| Vessel feature (id `vehicle`) and site feature (id `site`) | `src/render/vehicle/{vesselFeature,siteFeature}.ts` |
| Texture bakes (procedural, CPU) | `tools/vehicle/{texlib,bake-textures,bake-decals}.ts` |
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
materialDef(id): PbrMaterialDef   MATERIAL_IDS   materialTextureFiles()   DECALS   decalUv(name)   decalLayout()
nozzleEquilibrium(throttle): K     stepNozzleTemp(T, firing, throttle, dt): K
```

Integration: put both features in the app's feature list after the terrain (`createSiteFeature({ padElevation })`
needs the pad surface height when the site's elevation is `'terrain'`). Both use only `src/core` and the public
API of `src/render/core` (mesh system: one batch each). The vessel feature reads `SimSnapshot.vessels[].parts`
and module states only: engine throttle and gimbal (nozzle temperature model, glow of the radiative
extension), tank fill (frost), heat shield `ablatorFraction` (char), legs, lights, antenna, fairing panel ids
(`<id>#panel<k>`), clamps. A vessel that disappears from the snapshot fades out over `fadeSeconds` as a ghost.
Shadows: every vessel instance is a moving caster; `drawShadow` returns before submitting anything when
`!cascade.everyFrame` and counts the cascade (`staggeredCascades`), `staggeredSubmissions` stays 0.
The site's structures are body-fixed casters; swing arms, the crew arm and the tail service mast are moving
casters while they swing. Arms retract when the vessel standing on the pad ignites or no vessel stands there.

Conventions: part frame +Y nose, +X starboard, +Z dorsal; azimuth from +Z toward +X. Structure frame +Y up,
+X east, +Z south at heading 0. UVs are in metres; materials tile per metre. A generator returns named models
with 3 LODs each and a `pose` that emits them for the part's module state (engine gimbal, leg deployment,
antenna, one fairing petal, clamp arm).

## 3. How to run and verify

```
npm run typecheck:paths -- src/render/vehicle labs/vehicle tests/browser/vehicle tests/unit/vehicle tools/vehicle
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/vehicle tests/unit/vehicle src/core/defs tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vehicle --project=functional
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vehicle --project=perf
node tools/dev/heavy.mjs --class=bake -- npx tsx tools/vehicle/bake-textures.ts [recipe ...]     # 2 s for all
node tools/dev/heavy.mjs --class=gpu  -- npx tsx tools/vehicle/bake-decals.ts                    # canvas text in Chrome
```

Lab query (`/labs/vehicle/?...`): `scene=pad|lowOrbit|lunarSurface`, `stage=<n>` (stages already fired),
`stages=<n>&coast=<s>&hold=1` (fire n more, drift, freeze), `focus=<text>` and `solo=1` (aim at / show alone
the vessel whose id or part instance id contains the text), `eye=x,y,z&at=x,y,z` (vessel frame, nose up),
`sun=az,el` or `sunv=x,y,z`, `env=`, `planet=0`, `glass=0`, `ballast=<iterations>`, `hud=0`.
`window.__veh = { app, sim, vehicle, site, env, setSun, setView }`; `sim.fireStage()` uses public.ts
`splitForStage`. Two tools are kept on purpose: `tests/browser/vehicle/adhoc.spec.ts` (skipped unless
`VEH_ADHOC` is set; ad-hoc screenshots) and `tests/unit/vehicle/modelReport.test.ts` (prints triangle counts).

## 4. Acceptance, measured (2026-11-10, this machine)

| Criterion | Result |
|---|---|
| Every part def has a generator and a visual file | 25 of 25 (`parts.test.ts`) |
| Meshes: unit normals, consistent tangents, no degenerate triangles, closed components watertight, none inside-out | pass for every model and LOD of the parts and of the complex |
| Bounds within 5 % of `PartDef.bounds` | pass (legs tested deployed) |
| Mated attach interfaces meet within 5 mm | 33 interfaces, gap 0 to 1.24 mm, no overlap |
| Capsule skin on the shared mould line within 2 mm; openings at the file's azimuth / y / size | 1.46 mm worst; openings exact (the test reads the file) |
| Triangles, full stack | LOD0 1,102,484 (1.0 to 1.6 M), LOD1 262,580, LOD2 29,020 (< 60 k) |
| Launch complex triangles | LOD0 108,538, LOD1 52,778, LOD2 7,868 |
| No vessel caster in a staggered cascade | 765 staggered cascades offered, 0 submissions (`staging.spec.ts`) |
| Staging sequence with `splitForStage` | all 10 stages; 13 vessels at the end; 119 instances before and after every split; expired debris fades in 70 frames |
| Vehicle G-buffer < 0.8 ms | 0.018 ms (stack filling the view), 0.057 ms (from the tower at 15 m) |
| Vehicle shadows < 0.4 ms | 0.265 ms, 0.291 ms |
| Site G-buffer + shadow < 0.5 ms | 0.048 ms, 0.077 ms |
| CPU instance update < 0.3 ms | 0.110 ms p50, 0.160 ms p95 (site 0.06 ms) |
| `expectNoErrors` | in every browser test |

Perf: 2560 x 1440, `perf=features&scale=1&governor=off`, ballast 6.9 ms, p99 of timestamp queries, best of
three 240-frame windows, under `withGpuLock`. Unit run: 41 tests in 6 files. Browser: 9 functional tests
(7 screenshot tests with 35 views, staging, shadows), 1 perf test. Screenshots are in `out/screens/vehicle/`.
The whole renderer feature costs `perf.features.vehicle.cpuMs` about 0.65 ms on the CPU per frame in
attribution mode (instance update plus the draw calls of the G-buffer and of every cascade); the 0.3 ms
criterion is measured on the instance update alone (`stats.updateMs`).

Generated assets: 19 MB in 41 files under `public/assets/vehicle` (limit 120 MB). No API key was used and no
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
   cockpit package's own glazing).
6. Flat slabs (apron, crawlerway), the catenary wires and the pipe runs cast no sun shadow. With them the
   site's shadow pass was 0.38 to 0.6 ms p99 (the apron alone fills the near cascades); without them 0.05 ms.
7. `SiteFeature.override` pins a state immediately; the swing animation is driven by the vessel on the pad.
8. In the lab the pad surface is the reference sphere (`padElevation: () => 0`, the lab planet has no relief)
   and the sky, probe and ambient are the lab's analytic stand-ins, not the atmosphere package's.

## 6. Known weaknesses (stated plainly)

- "Photoreal" is not reached everywhere. It holds best for the painted tanks, brushed steel, engine bells,
  the fairing interior and the complex at night. It is weaker for: the MLI foil (reads as wrinkled foil but
  the wrinkles are a tiling normal map, visibly regular over a whole stage); the capsule's tile grid (too
  even, and the tiles narrow toward the apex because u is angular); the foam bands on M-2 (tone steps are
  clean rings); rainbirds, deluge pipes and the tank farm (simple shapes); the hold-down clamps (plausible,
  not engineered). Lab lighting is flat (analytic sky), which flatters nothing; judge again under the real
  atmosphere and terrain.
- I did not look at every acceptance view in its final state. Inspected after the last texture bake and
  model change: engine section, hold-down clamp, brushed steel, M-3, interstage interior, ascent stage,
  lander deployed, MLI close-up, lander lights, heat shield charred, windows, hatch, fairing petal inside,
  escape motor. Inspected earlier in the work, before the last re-bake of the brushed, galvanised, carbon and
  tile textures: pad from 300 m and from the tower, complex at noon and at night, pad at night, M-2 aft,
  clear-coated paint, heat shield pristine, fairing petal outside, foot pad, two staging frames. Produced by
  the passing run but never opened in their final form: tank farm, tower looking up, M-1 and M-2 side
  views, M-1 aft, lander stowed, lander and capsule alone in space, foam close-up, charred back shell, the
  other eight staging frames, arms retracted, the two perf frames.
- The hatch picture is in shade (ambient only). In low orbit the planet eclipses a sun that is below the
  local horizon even when the lab does not draw the planet (`planet=0`), so some `sunv` directions give night.
- Stack LOD0 is 10 % above the 1.0 M floor: removing detail needs care.
- Char and frost are per-vertex weights: streaks and patches are as fine as the mesh (2.5 degrees of azimuth).
- No hoses or cables between the arms and the vehicle; umbilical plates meet the skin, nothing flexes.
- Frost amount, soot and nozzle heat are presentation models inside the feature (documented in
  `vesselFeature.ts`), not simulation outputs.
- Site lights are capped at 8 per frame (vessel 4) of the core's 16; with more lamps in view the nearest win.
- Not tested: more than one site, a site whose elevation comes from terrain, vehicles other than the one
  defined, behaviour at very low frame rates.

## 7. Requests

None filed. No open request in `docs/requests` is against these paths (`ocean-3`, resolved, says this package
needs no change).
