# Hand-off: vfx

Visual effects as one `RenderFeature`: engine plumes (ray-marched analytic jets with shock cells), exhaust
trails and contrails, launch-pad smoke and steam (advected grid), GPU particles (dust, ice, gas, sparks,
debris, spray), dust sheets on airless ground, the reentry shock layer, wake and trail, fireballs with
burning fragments, ring-sail parachutes with lines, the splash crown and foam. Everything is driven by the
`SimSnapshot`, the sim events and `data/defs/visuals/plumes.json`; there are no textures on disk
(`public/assets/vfx` does not exist: the two noise volumes are generated on the GPU at start-up).

State on 2026-11-11, after the review round (section 0): 41 unit tests and 33 functional browser tests pass;
the perf spec's means are well inside every budget but its p99 windows failed in both final runs on a loaded
machine (section 4.1). Section 6 says plainly which looks I still do not consider photoreal.

**Later the same day the package changed hands and went through the first visual close-out (two critics,
28 items, `out/qa/wave2/vfx.md`); that owner ran out of budget before committing the close-out and a third
owner finished round 1 (section 8.7: reentry wake, fireball smoke, night lift-off hull, cabin view of the
plasma, the specs). Section 8, "Visual close-out, round 1", is the current state: what each
item got, what is still open, the new data fields, the new spec, and the perf numbers of the final build.
Where sections 0 to 7 and section 8 disagree, section 8 is right** (the plume field, the plume lights, the
exposure hints, the fireball, the reentry layer, the splash, the dust sheet and the reefed canopies were
rewritten; 37 functional tests now).

**Round 2 of the visual close-out is section 9, and it is the current state**: the booster flame (three times
brighter, with an edge), the particle streaks (measured in simulated time), flakes and sparks, the canopies
(smooth domes, cut-away canopies that settle on the water), the night exposure of a launch and of an entry, the
dust sheet, the base flow of the reentry, `'vfx.plasmaWindow'`, the spec that flies the real game
(`appshots.spec.ts`). Where section 9 disagrees with the sections before it, section 9 is right.

**Round 3 of the visual close-out is section 10, and it is the current state** where it differs: the pad
cloud (two low jets out of the trench, no level edge along the horizon, a sharpened outline), the splash crown
(a sheet at full resolution), the lunar dust sheet (bounded, single scattering), the reentry layer (a crescent
with an edge), plume lights that follow what the plume emits in vacuum, two new specs (`lunar.spec.ts`, the
level-edge test in `liftoff.spec.ts`), requests `vfx-9` (ocean: ring waves and foam at a splash, open) and
`vfx-10`.

## 0. What the review round changed

An independent review of the first build found three blockers, seven majors and three minors. What was done:

| Finding | What changed |
|---|---|
| Lift-off plume buried in the pad cloud for 7 s (blocker) | The smoke flow has the jet in it: a free jet from the nozzles to the pad that carries no smoke, clears what strays into it and draws the surrounding air in; buoyancy is held down near the jet and inside the fast wall jet; sources sit at the far end of the flame trench while the vehicle is over it and move under the jet as it climbs (`padSmoke.jet`, `buoyancy` 20 -> 5.5). The plume light is a line along the jet, and the cloud is lit from two points of it. New spec `liftoff.spec.ts`: engines on minus engines off on the jet axis, T+2 to T+8 s, pad and chase camera, day and night (section 4). |
| Lift-off GPU budget not met, quietest window asserted (blocker) | The smoke march runs at quarter resolution inside the screen rectangle of the cloud, with two depth cuts per ray, and is brought to the half-resolution image by a depth-aware combine pass; only the box of grid cells the cloud has reached is simulated; plume march 40 -> 30 steps (down to 18 when the plume fills the frame) with a per-nozzle reject cone and bounds that know the vacuum gain. The perf spec asserts EVERY window and the mean, and measures lift-off from 430 m, from a chase camera at 150 m and from inside the cloud. Means are now 0.48 / 0.74 / 0.56 ms against 1.3; the p99 windows are not reliably under budget on this loaded machine (section 4.1). |
| Reentry broken from every chase view (blocker) | The shock layer is wrapped on the real shape (`reentryShape`: spherical cap + back shell; `reentryProxy` rewritten) with streaks advected along the wall by a two-phase flow map; a sheath leaves the shoulder and necks into a streaked wake core, no gap; emission within a few body radii of the eye is left out (no veil when the camera rides in the wake); the trail fades in from its newest end over the length of the wake volume and is not drawn where the eye is inside its tube; luminance goes with heat flux^1.3 and intensity shapes layer, sheath and wake length. Checked from the side, front and behind, and in the integration lab. |
| Plumes not convincing at chase distance (major) | Core luminance at the photometric target (booster 1e6 cd/m^2: clips and blooms by day), streak-shaped noise with a small footprint plus two fine octaves at the mean emission depth, shock cells shifted and flickering per nozzle, a near-nozzle core that stays bright in vacuum (`core.vacuumCoreRe`), ragged halo edge. |
| Pad smoke artefacts: slabs, ledges, stipple, no ground shadow (major) | The light volume is looked up at the same noise-displaced position as the density (the slabs were the undisplaced light field showing through displaced billows); quarter-resolution march + bilinear combine instead of half-resolution stipple; the cloud multiplies the sun's share of the light of the opaque scene under it by its sun transmittance (`padSmoke.groundShadow`). The night T+0 burn-out was the exposure meter (request vfx-3, resolved by core-support). |
| Particles ignore the volumes they are in (major) | The volume pass publishes its image and the distances of what it shows; the particle fragment shader hides what lies behind that by its opacity and does not cover its glow. |
| Explosion placeholder quality (major) | Fireball rewritten: shape bent by slow noise, three to six lobes that shoot out and are swallowed, three octaves of boiling surface that end inside the bound (no clipped disc), flame colour with white-hot cells, a cloud that lengthens upwards as it rises, secondary fireballs, burning fragments on ballistic arcs with smoke trails (trail system) and sparks. |
| Splash without a crown sheet (major) | The crown is a marched thin sheet (`splash.ts`): rises ballistically, leans out, thins, tears from the rim into ligaments, falls back; mist cut to a trace; foam decal lies on water only (forward water in front of the opaque depth, or `MATERIAL_WATER`) within +-6 m of the entry level, so it follows the swell and never paints a hull. |
| RCS firings invisible in sun, glare in shadow (major) | `plume.rcs` is a 10 degree cone of condensing exhaust that scatters sunlight (new `smoke.halo`, `smoke.lengthRe`) with a dim flame; its exposure hint holds it at the meter's white instead of three stops over. |
| Lunar dust: no sheets (major) | New `dust.ts`: a ground-hugging volume per jet, integrated in closed form over the height, with radial streaks that stream outwards, sun shadow of the lander and plume light; reaches to 30 m and more (`maxHeightRe` 45 -> 110). Dust particles are soft streaks that thin out towards both ends. |
| Start-up flash cut by the bounding cone (minor) | Flash is a Gaussian ball on the bulk radius, cut at the start-up front; the cone and the jet's own reject are sized for 3.2 of its widths while it lasts. FakeSim's frozen `ignitionAge`: request vfx-2, resolved by core-support. |
| Parachutes: no flutter, tubes when reefed, taut lines after cut-away, colour in code (minor) | Breathing and flutter raised, travelling cloth waves, pleats gore by gore when slack; lines of a cut canopy sag into a loose swinging bundle; `lineColor` in the data. |
| Tests and hand-off overstated (minor) | Canopies are in the frame of the splashdown perf scene; retro motors framed by `framePlume`; temporal test: mean bound 0.6 -> 0.5 and a new bound of 20 / 255 on the 99.99th percentile, the single-pixel maximum stays at 72 (section 4); living particles are counted in a readback (the "262,144 alive" of the first hand-off was the ring window: 21,022 live in that scene); the live window follows each batch's lifetime. |

Nothing was rejected. Two things the review asked for were solved elsewhere than suggested: the night T+0
burn-out is an exposure-meter matter (request vfx-3), and "sample count at thin fringes" became the
quarter-resolution march with a bilinear combine.

## 1. Where things are

```
data/defs/visuals/plumes.json     every number of the package: 5 plume looks, rcs, lights, trail, padSmoke,
                                  particles, frost, staging, reentry, explosion, parachutes, splash
src/render/vfx/
  index.ts          public API (section 2)
  feature.ts        createVfxFeature: hooks, effect clock, lights, exposure hints, debug interface
  data.ts           VfxData types, schema validation (DefError with '$.path'), loadVfxData
  plumeModel.ts     gas dynamics on the CPU: Prandtl-Meyer, jetShape, boundary, Prandtl-Pack spacing, light
  clusters.ts       gatherPlumeClusters: engines and RCS of a vessel -> clusters of nozzles, bounds, merge
  plumes.ts         PlumeRenderer: instance/nozzle buffers, PLUME_FIELD_WGSL, march, density slices
  volumes.ts        VolumePass: half-resolution emit + moment targets, combine, depth-aware composite,
                    the image and its distances for the particles, HDR ceiling
  common.ts         VfxCommon: group-1 layout shared by every vfx pipeline, chunk 'vfx_common', light probes
  noise.ts          64^3 rgba8 tileable noise (5 mips) and 32^3 curl noise, made by compute at init
  domain.ts         EffectDomain: float64 frame of the particles ('surface' | 'space'), rebase
  particles.ts      ParticleSystem: 262,144 x 96 byte ring pool, emit + simulate + light in compute, streak quads
  director.ts       EffectDirector: snapshot + events -> emitters, fireballs, splashes, dust sheets, flashes
  smoke.ts          SmokeSystem: 160 x 96 x 160 warped grid, flow with the jet in it, light volume, quarter-
                    resolution march, combine with the emitters, ground shadow
  trail.ts          TrailSystem: body-fixed polylines, Gaussian tubes with closed-form optical depth
  plasma.ts         PlasmaRenderer: shock layer, sheath and wake around the reentry proxy, cabin light
  fireball.ts       FireballRenderer: fireballs, secondary bursts, burning fragments
  dust.ts           DustSheetRenderer: sheets of dust along airless ground
  canopyModel.ts    ring-sail geometry from inflation (CPU, unit-tested)
  chutes.ts         ChuteSystem: canopies in the G-buffer (MATERIAL_CLOTH) and shadow passes, lines, drift, shred
  splash.ts         FoamRenderer: the crown sheet (volume) and the foam decal on the water
labs/vfx/           lab page: index.html, main.ts (window.__vfx), labSim.ts, scenes.ts, props.ts
tests/unit/vfx/     model.test.ts, effects.test.ts (41 tests with src/core/defs and the boundaries test)
tests/browser/vfx/  plumes.spec.ts, effects.spec.ts, atmosphere.spec.ts, liftoff.spec.ts, matrix.spec.ts,
                    vfx.perf.spec.ts, shots.spec.ts (ad-hoc shots, skipped unless VFX_SHOTS is set), helpers.ts
```

## 2. Public API (exact signatures)

`import { ... } from '@/render/vfx'`:

```ts
createVfxFeature(ctx?: RenderContext | null, options?: VfxOptions): VfxFeature
VFX_FEATURE_ID = 'vfx'
interface VfxOptions { id?: string; order?: number; debugSkipAtmosphere?: boolean }
interface VfxFeature extends RenderFeature { readonly debug: VfxDebug }
interface VfxDebug {
  clusters(): VfxClusterInfo[];            // plume clusters drawn in the last frame, in instance order
  lights(): LocalLight[];                  // lights this feature pushed into frame.lights
  plumeSlice(instance, nozzle, x0, x1, rMax, width?, height?): Promise<PlumeSlice>;
  readParticles(): Promise<Float32Array>;  // the whole pool, PARTICLE_FLOATS (24) floats per particle; life (index 7) > 0 = alive
  stats(): Record<string, number>;         // plumeInstances, lights, particles (ring window: an upper bound of the
                                           // living), spawned, smoke, smokeBox, trailSegments, plasma, fireballs,
                                           // dustSheets, canopies, foam, crowns, volumes, ...
  domainKind(): string | null;             // 'surface' | 'space'
}
loadVfxData(defs: DefLibrary): VfxData     // getSection(defs, 'visuals/plumes'), validated; also checks that
validateVfxData(raw: unknown): VfxData     //   every engine module's `plume` id names a look
jetShape(look, nozzle: NozzleGeometry, throttle, ambientPressure, options?): JetShape
jetBoundaryRadius(shape, exitRadius, x), prandtlMeyer(mach, gamma), machFromPressureRatio(ratio, gamma),
shockCellSpacing(jetMach, jetDiameter), plumeLightIntensity(look, thrust), engineEmissionState(...)
gatherPlumeClusters(defs, data, vessel: VesselSnapshot, exposure?): PlumeCluster[]
```

The signatures did not change in the review round. Not exported from the index but used by the unit tests:
`reentryProxy(defs, vessel, windVes): ReentryProxy` (now `{ centreVes, axisVes, radius, noseRadius,
afterLength, tipRadius, shaped }`: the centre of the shoulder plane, the axis from the windward cap to the lee
end), `capHeight`, `plasmaLuminance`, `plasmaColor` (`plasma.ts`), `crownHeight` (`splash.ts`),
`trailRadius` / `trailState` / `contrailFactor` (`trail.ts`).

Hooks used: `prepare`, `compute` (light probes, smoke advection + light volume, particles), `drawShadow`
(canopies, only in `cascade.everyFrame` cascades), `drawGBuffer` (canopies), `preTransparent` (the
half-resolution volume pass, the quarter-resolution smoke march and its combine), `drawTransparent` (smoke
ground shadow, composite, foam, lines, particles, HDR ceiling). Scene bindings required: `sceneDepth`,
`sceneDepthHalf`, `transparency`, `shadow`, `atmosphereLuts`, `env`, and for the foam `sceneDepthOpaque` and
`gbuffer` (in a group of their own, bound in `drawTransparent` only). At most `lights.maxLights` (8) of the 16
`frame.lights`, strongest first. GPU pass names for the perf recorder: `vfx.probe`, `vfx.particles.sim`,
`vfx.smoke.sim`, `vfx.volumes`, `vfx.smoke.march`, `vfx.smoke.combine`, plus the hook passes.

Inputs it reads from the snapshot: engine modules (`throttleActual`, `ignitionAge`, `shutdownAge`, `gimbal`,
`thrust`, `massFlow`, `ambientPressure`), rcs modules (`levels`), parachute modules (`state`, `inflation`,
`lineDir`, `deployAge`), `aero` (`pressure`, `airDensity`, `temperature`, `airVelocity`, `plasmaIntensity`,
`heatFlux`), `readouts.altitudeRadar`, `situation`, and the events `clampsReleased`, `decoupled`,
`fairingJettisoned`, `chuteDeployed`, `chuteCut`, `chuteFailed`, `partDestroyed`, `explosion`, `splash`.

The effect clock is the snapshot's `ut` (step clamped to 0.1 s): pausing the sim freezes every effect, time
warp speeds them up. The noise that makes plumes and smoke boil advances only while `frame.animate`.

## 3. How to run and verify

```
npm run typecheck:paths -- src/render/vfx labs/vfx tests/browser/vfx tests/unit/vfx
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/render/vfx tests/unit/vfx src/core/defs tools/dev/boundaries.test.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vfx --project=functional   # 33 tests, 8.5 min
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vfx/vfx.perf.spec.ts --project=perf   # 8 tests, 2.5 min + waiting for the lock
```

The last run of the functional suite, on the code as committed: 33 of 33 in 6.8 min. Two things seen in
the runs before it that are not vfx failures but will be met again in a shared tree: three matrix sheets
failed once on writing their PNG (`UNKNOWN: unknown error, open ...png`, a file lock on Windows) and passed
on the retry the matrix spec allows; and one page never initialised within 60 s (the particle determinism
test, which passed alone straight afterwards; the first build saw the same once, when another agent's edit
restarts the dev server under an open page).

Lab: `/labs/vfx/?scene=<name>`; scenes and their parameters are documented at the top of each case in
`labs/vfx/scenes.ts`: `engine` (`engine=<part def>`, `altkm=0|10|30|60|200`, `throttle=<n>|min`, `p=`,
`span=`), `pad` (ignition at 1 s, lift-off at 4 s of lab time; `dist=`, `tz=` target height, `yaw=`, `pitch=`),
`ascent`, `lunar` (`h=`, `night=1`), `vacuum`, `rcs` (`all=1`), `staging`, `reentry` (`plasma=`, `far=1`),
`chutes` (`chute=drogue|main`, `inflation=`), `splash` (`dist=`, `tz=`), `explosion`. Common: `night=1 |
sun=<deg>`, `ev=`, `paused=1`, `hud=0`, `overcast=<m>`, `haze=<m>`, `noatmo=1`, `hide=<part ids>`,
`ballast=<n>`, `perf=features&scale=1&governor=off`. `window.__vfx` gives specs `runTo(t)`, `step(frames)`,
`renderExact(frames, advance)`, `setCamera`, `project`, `sunEnu`, `nozzleEnu(id)`, `plumeAxisEnu(id)`,
`framePlume(id, length)`, `scene.controls` (the pad scene: `engines(on)` switches the booster off and on with
the scene stopped), `feature.debug`.

A quick look at anything: write `[{ "name": "x", "url": "/labs/vfx/?scene=pad&paused=1&hud=0", "runTo": 7 }]`
to a JSON file and run `VFX_SHOTS=<file> node tools/dev/heavy.mjs --class=gpu -- npx playwright test
tests/browser/vfx/shots.spec.ts --project=functional`; the picture lands in `out/screens/vfx/dev/`. `"live":
true` takes it with animated noise and the temporal filter; a url of another lab (`/labs/integration/?scene=
reentry&orbit=150,12,22`) is opened as it is.

The lab's vehicle, pad, sky and ocean are stand-ins (lathes of `PartDef.bounds`, flat colours). They are
not part of the package and say nothing about the real vehicle or terrain.

## 4. Acceptance criteria: measured

| Criterion | Result | Where |
|---|---|---|
| Boundary half-angle within 10 % of the Prandtl-Meyer value, three pressure ratios, from rendered density slices | eta 0.362: -7.65 deg vs -8.00 (the clamp); eta 0.725: -0.62 vs -0.65; eta 2.648: 13.05 vs 13.20 | `plumes.spec.ts` |
| Shock-cell spacing within 10 % of Prandtl-Pack, same three ratios | 5.214 m vs 5.213; 8.187 vs 8.187; 18.635 vs 18.634 (mean of four cells; each nozzle's cells are shifted by up to a third of a cell, the spacing is not) | `plumes.spec.ts` |
| Integrated plume luminance monotonic with throttle | 0, 276k, 350k, 430k, 513k, 593k, 690k (pre-exposed sum) at 0, 50 ... 100 % | `plumes.spec.ts` |
| Plume light proportional to thrust | 6.4910 cd/N at every throttle (equal to six decimals); one capsule light per cluster | `plumes.spec.ts` |
| No pixel above HDR_MAX, nanPixels 0 at EV100 -3 with nine plumes in view | HDR max exactly 60,000, 0 NaN, in the HDR target and in the TAA output (nine plumes, pad smoke, 3131 particles) | `plumes.spec.ts` |
| Particles deterministic for the same event stream, presentation time frozen | staging (2087 alive: ice, gas, sparks) and lunar dust (20,859 alive): identical state hash over two runs of 200 frames; a 201st frame changes it | `effects.spec.ts` |
| Canopy area follows `inflation` | rendered area / full area 0.208, 0.430, 0.631, 0.821 at inflation 0.2, 0.4, 0.6, 0.8 | `effects.spec.ts` |
| Plume hidden by this frame's geometry, fast occluder, no one-frame lag | slab crossing the jet at 150 m/s: behind the slab the plume signal is at most 2.8e-3 against 91-139 in the open; where the slab was one frame earlier the jet is back (17.5-40.6) | `effects.spec.ts` |
| Temporal stability at half resolution | static camera, live noise: mean frame-to-frame difference 0.38 / 255 (engine) and 0.38-0.39 / 255 (pad), asserted below 0.5 (first build: 0.6); 99.99 % of the channels change by at most 6-7 / 255 (engine) and 11-14 / 255 (pad), asserted below 20 (new); largest single channel 14-20 (engine) and 39-51 (pad) over seven runs, asserted below 72 as in the first build. The largest jump is one pixel of plume-lit smoke against its own shadow at the foot of the jet and I did not get it lower: with a 40-step smoke march it read 67 once. Before sub-pixel particles were widened to a pixel it was 43 to 71 on ice particles beside the hull | `effects.spec.ts` |
| Default atmosphere inputs: bit-exact against a build without applyAtmosphere | identical hash of the rgba16f HDR target after 440 frames (plume, smoke, 3268 particles, trail) | `atmosphere.spec.ts` |
| Synthetic overcast deck: plume and trail hidden above it, visible below | plume above the deck 6.39 -> 0.056 (the deck transmits 2 %), below 10.5 -> 8.64; trail above 0.227 -> 0.0045, below 0.038 -> 0.038 | `atmosphere.spec.ts` |
| Trail 50 km away takes the colour of a synthetic aerial-perspective volume | chroma 0.706 / 0.234 / 0.060 against the haze's 0.692 / 0.231 / 0.077; without haze 0.350 / 0.332 / 0.318 | `atmosphere.spec.ts` |
| Lift-off: the jets are in the picture (review blocker 1) | section 4.3 | `liftoff.spec.ts` |
| expectNoErrors | in every spec, after every page | all |
| Review matrix | 19 sheets, 144 pictures (section 4.2) | `matrix.spec.ts` |

### 4.1 GPU time at 1440p internal resolution

`vfx.perf.spec.ts`, under `withGpuLock`, attribution mode, governor off, scale 1, a ballast pass of 7.0 ms
(`labs/vfx/props.ts`, `createLabBallast`). The figure is `PerfSnapshot.features.vfx.gpuMs`, the p99 of the
per-frame sum of all vfx passes, in four windows of 110 frames. The spec asserts every window against the
budget and the mean against 80 % of it.

Two full runs of the final build (run B is the exact final build; run A is the same with a 40-step smoke
march and a 14-stretch dust sheet instead of 48 and 10). Both were taken with two or three other agents'
GPU jobs running (ocean, terrain and atmosphere perf and functional specs held the other gate slots).

| Scenario | Budget (ms) | Mean A / B | p99 of the four windows, run A | p99 of the four windows, run B |
|---|---|---|---|---|
| Lift-off worst case, pad camera 430 m (nine plumes, pad smoke, ice, trail) | 1.3 | 0.451 / 0.481 | 0.620, 0.720, 0.678, 0.784 | 0.743, **1.350**, 0.703, 1.150 |
| Lift-off, chase camera at 150 m | 1.3 | 0.660 / 0.743 | 0.816, 0.872, 0.917, 1.061 | **1.570**, **1.426**, 1.004, 1.097 |
| Lift-off, camera inside the cloud | 1.3 | 0.553 / 0.558 | 0.772, 0.917, 0.908, 0.812 | 0.776, 0.828, 0.887, 1.027 |
| Ascent (12 km, trail and contrail) | 1.0 | 0.137 / 0.137 | 0.345, 0.130, 0.365, 0.450 | 0.381, 0.366, 0.377, 0.374 |
| Vacuum burn (six engines, ullage motors) | 0.6 | 0.204 / 0.213 | 0.298, 0.525, 0.400, 0.389 | 0.496, 0.560, 0.166, 0.410 |
| Lunar descent with dust (21,022 particles alive, one dust sheet) | 0.9 | 0.511 / 0.447 | 0.743, 0.829, 0.838, 0.835 | **1.324**, **1.374**, **1.370**, 0.771 |
| Reentry (plasma, trail, ablation sparks) | 1.2 | 0.393 / 0.334 | 0.665, **2.852**, 1.109, 1.166 | 0.563, **1.278**, 0.552, 0.806 |
| Chutes and splash (three mains in the frame, crown, foam) | 0.9 | 0.083 / 0.113 | 0.318, **1.136**, 0.376, 0.037 | 0.860, **0.958**, 0.267, 0.035 |

Bold = over the budget. **The spec failed in both runs**: 2 of 8 scenarios in run A, 5 of 8 in run B, and not
the same ones. Every scenario has had a run with all four windows under its budget (the two above and three
earlier ones of the review round), none has in every run. What is stable from run to run is the mean: 9 to
57 % of the budget. What I can say about the windows: the frames over budget are spikes of 0.25 to 2 ms on
single passes, and they sit on passes that cannot cost that (the light-probe pass, a compute dispatch of eight
invocations, has a mean of 0.002 to 0.03 ms and a p99 of 0.24 ms in the same windows; "chutes and splash"
has a mean of 0.1 ms and windows of 0.9 ms). I read them as other processes' work landing between a pass's
two timestamps. I could not get a quiet machine to show it; by PACKAGE_RULES 16 these p99 figures are
provisional and have to be taken again without other GPU jobs. The assertion is left strict (every window,
and the mean under 80 % of the budget): it will fail on a busy machine.

For comparison, the first build's means in the review: lift-off 0.93 to 1.09 ms from 430 m, 2.06 to 2.18 from
150 m, 1.22 to 1.53 inside the cloud. Where the time goes now at lift-off from 150 m: smoke march 0.44, plume
volumes 0.26, smoke simulation 0.07, composite and particles 0.06, combine 0.01.

### 4.2 The review matrix

`out/screens/vfx/<sheet>.png` are half-size contact sheets in reading order; the full-size pictures are in
`out/screens/vfx/<sheet>/`.

- `engine-atlas-9m`, `engine-vela-2`, `engine-vela-2v`, `engine-lyra-d`, `engine-lyra-a`: 100 % (left) and
  minimum throttle (right) at sea level, 10, 30, 60 km and vacuum (top to bottom). `engine-solids`: escape
  motor and retro motors (solids do not throttle).
- `liftoff`: T+0, T+3 s, T+10 s by day (left) and at night (right) from the pad camera. `liftoff-chase`: T+0,
  T+3 s, T+6 s, T+10 s from a chase camera at 150 m. `plumes-close`: the booster at 45 m and 110 m, ascent
  at 12 km from 90 m, six vacuum engines from 60 m, staging from 70 m. `ascent`: 2, 12, 30, 60 km.
- `vacuum-ignition`, `lunar` (30 m by day, 30 m with the sun down = plume-lit regolith, 10 m, 3 m, 30 m and
  5 m close), `rcs` (26 m and 12 m, sunlit and in shadow), `staging`, `reentry` (plasma 0.3 and 1.0 from the
  chase camera by day and night, trail from 50 km), `reentry-views` (front, behind, close from the side at 1.0
  and 0.3), `chutes` (drogues reefed and full, mains at 8 %, 30 % and full against the light, full with the
  light), `splash` (ten moments, two from 20 m, one with the cut-away canopies), `explosion` (six moments by
  day, two at night, two from 350 m).
- `liftoff-probe/`: the eight frames of `liftoff.spec.ts` at T+2 and T+6. `overcast-plume-below-deck`,
  `overcast-plume-above-deck`, `haze-trail-50km`, `perf-*`: pictures of the test scenes.

I looked at the sheets after each round of changes and at the close-ups in `out/screens/vfx/dev/` (`f1-` to
`f9-`, and `sheet-f*.png`) while tuning; after the very last change (the exposure hint for emitters in front
of a body) I looked again at the pictures it could affect (lunar night, lift-off at night, staging, vacuum
ignition, retro motors, ascent), not at all 144. In the integration lab (all packages, real vehicle, real
Earth and Moon, FakeSim) I looked at reentry from the side and from behind, a burn in low orbit, the lander
burning over the lunar surface and the ascent (`out/screens/vfx/dev/f7-int-*.png`, `f9-int-*.png`).

### 4.3 Lift-off: plume signal on the jet axis

`liftoff.spec.ts`: scene stopped, engines on minus engines off, median of 5 x 5 pixels of the HDR target on
the jet axis 5 m and 20 m below the nozzle exits, in cd/m^2. The first build had 43 (T+4), 2 (T+6), 114,000
(T+8) at night from 150 m, 20 m below. Asserted above 30,000 (a sunlit white surface): 5 m below from T+2,
20 m below from T+4 (at T+2 that point is behind the launch mount).

| Camera | Point | T+2 s | T+4 s | T+6 s | T+8 s |
|---|---|---|---|---|---|
| day, pad camera (430 m) | 5 m below | 294,000 | 300,000 | 172,000 | 183,000 |
| | 20 m below | (42,000) | 281,000 | 256,000 | 195,000 |
| day, chase camera (150 m) | 5 m below | 270,000 | 315,000 | 199,000 | 195,000 |
| | 20 m below | (0) | 278,000 | 245,000 | 200,000 |
| night, pad camera | 5 m below | 294,000 | 331,000 | 182,000 | 187,000 |
| | 20 m below | (42,000) | 296,000 | 258,000 | 188,000 |
| night, chase camera | 5 m below | 264,000 | 304,000 | 190,000 | 192,000 |
| | 20 m below | (0) | 271,000 | 237,000 | 199,000 |

The nozzles are 25, 43, 74 and 117 m above the pad at those moments. With the engines off the same points
read 0 to 72,000 cd/m^2 (the sunlit or plume-lit cloud behind them). All 16 asserted values pass.

## 5. Deviations from the brief and decisions worth knowing

1. **`createVfxFeature(ctx?)`.** The context argument is optional and unused: the feature gets its
   `RenderContext` in `init`, like every other feature. `labs/integration/features.ts` passes `env.ctx`,
   which works.
2. **Mixing layer.** The design asked for a boundary of `r = re + L tan(theta)(1 - e^(-x/L)) + 0.09 x`. A
   constant 0.09 slope at the lip is 5 degrees on top of the Prandtl-Meyer angle and fails the 10 % test at
   every pressure ratio. The mixing term is `0.09 (x - x0 (1 - e^(-x/x0)))` with `x0 = 30 re`: zero slope at
   the lip, 0.09 far downstream.
3. **Data fields beyond the brief** (all in `plumes.json`, all validated): per look `maxExpansionDeg`,
   `core.vacuumGain` and `core.vacuumCoreRe` (the core is as bright as at sea level at the exit and falls to
   the gain over that many exit radii in vacuum: without the gain a vacuum plume is a searchlight, without
   the near core it is a smudge), `smoke.halo` and `smoke.lengthRe` (how the particulates fill the jet and how
   far they last: an RCS puff is a filled cone, booster soot a core); `padSmoke.jet`, `padSmoke.groundShadow`;
   `trail.taperRadii`; `particles.dust.sheet*`; `reentry.streakSpeed`; `explosion.secondaries`, `fragments`,
   `fragment*`; `parachutes.*.lineColor`; `splash.foamSwell`, `splash.crown`.
4. **Ground under a plume** comes from `readouts.altitudeRadar` and the lowest point of the vessel, or the
   pad plane of the site, not from a depth probe: the plume foot, the dust source and the smoke source are
   placed with it. Particles follow terrain through last frame's depth buffer; the dust sheet lies on the
   terrain the ray ends on (this frame's depth). No dust is emitted over a pad.
5. **Gimbal** rotates the nozzle about the part origin (the part defs carry no pivot).
6. **Shock-cell window.** Cells are drawn for 0.25 < eta < 4 as the brief says, fading at both ends; below
   about 1 kPa the afterburning ring and brush go out (no oxygen).
7. **Pad smoke is one grid at one site at a time**, chosen by distance (`padSmoke.activationRange`); it
   lingers for `padSmoke.linger` (240 s) after the last engine and is then cleared.
8. **The smoke march is at quarter resolution** (ARCHITECTURE 10.3 says half). It is brought to the
   half-resolution volume image by a combine pass with depth-aware weights, each ray carrying two results
   (cut at the nearest and at the farthest depth of its 2 x 2 half-resolution pixels), and from there to
   full resolution by the core's upsample like every other volume. This is what makes the lift-off budget;
   the cloud is a little softer than at half resolution. Plumes, plasma, fireballs, crowns, dust and trails
   are at half resolution.
9. **Light volume of the smoke** stores transmittances, not optical depths, and a dilated occupancy field
   that the march uses to find gas; the march reads it at the noise-displaced position it reads the density
   at. The plume light is a segment along the jet, sampled at its nearest point and near its top.
10. **The cloud's shadow on the ground** is not in the brief: a multiplicative pass over opaque pixels in
    `drawTransparent` (sun's share of the light x smoke transmittance towards the sun). It darkens whatever
    is in the HDR target at those pixels, the vehicle inside the cloud included; it is not a shadow map and
    nothing else can read it.
11. **HDR ceiling.** Blended draws add to what is already in the HDR target, so two values under HDR_MAX can
    sum over it. The feature ends its transparent hook with a fullscreen `min` blend against HDR_MAX (only
    when it drew something).
12. **Exposure hints** (`CoreApi.addEmissiveHint`, request vfx-1). Plume clusters, reentry plasma, glowing
    trails and fireballs report themselves when their centre is seen against the sky; in front of a body they
    do not (what they light is geometry and metered). Coverage is "as the image shows it". Engine plumes: an
    eighth of their luminance, at most 12,000 cd/m^2 (by day a plume leaves the exposure where the sun puts
    it and clips; at night the camera is stopped down for it); RCS puffs: their luminance (they keep their
    shape); the rest: an eighth. The resolution of request vfx-3 suggests sending the hint for small emitters
    in front of a body as well; I tried it and took it out again: it stops the camera down for the flame of
    a lander at night and the plume-lit regolith goes dark.
13. **Particle drag** is quadratic with a drag area per mass per kind (dust 40, mist 7, ice 0.6, sparks
    0.15, droplets 0.09, chips 0.03 m^2/kg) and scales with air density, so everything is ballistic in vacuum.
14. **Particles and volumes.** Particles are drawn after the half-resolution image. Each fragment reads the
    image's opacity and the mean distance of what it shows: behind that, the particle is dimmed by the
    opacity and does not cover the glow. One layer of distance per pixel: a particle between two volumes on
    one ray is treated as behind both or in front of both.
15. **Canopy translucency** is written as emissive by the feature (inside faces lit through one layer,
    outside faces away from the sun through two) and the G-buffer translucency is 0. The core's cloth
    transmission term is shadowed by the canopy's own far wall, so a canopy seen against the light came out
    black. The mesh is wound clockwise seen from outside; the shader treats front-facing as the inside.
16. **Reentry luminance** follows `heatFlux` (`reentry.fluxExponent` 1.3, `referenceFlux` 3 MW/m^2), the shape
    of the effect follows `plasmaIntensity`. With the real sim's `plasmaIntensity = smoothstep(0.05, 1.0
    MW/m^2)` a low-orbit return (about 1 MW/m^2) is a quarter as bright as a lunar return at 3 MW/m^2.
17. **Trails**: at most `trail.maxTrails` (16) of `maxNodes` (96); burning fragments of an explosion use the
    same trails (thin, with their own diffusivity). A seventeenth trail takes the slot of the one that was
    fed longest ago.

## 6. Known weaknesses (plainly)

The bar was "photoreal". These are not there:

- **Staging**: retro and ullage motors are still the weakest picture. From 70 m each motor has a bright root
  and a short cone, but together they read as a glowing ring around the interstage, not as separate jets.
- **Solid motors in air** (`engine-solids`): the plume is a cone of sunlit smoke; the incandescent core is
  hidden inside it instead of shining through, and the cone edges are nearly straight.
- **Plumes**: the fine structure is two octaves of streak noise laid on at the mean emission depth. It moves
  with the gas and holds up at 45 to 110 m; it is a texture, not turbulence, and a slow pan along the jet
  shows it repeat. Vacuum fans have a visible cell pattern from the same noise.
- **Reentry**: the wake is streaks in a tube; there are no shed vortices, no sparks torn off in bursts, and
  the cap seen exactly edge-on is a bright lens. From directly behind, what is left of the wake around the
  camera after the near-eye cut is a faint haze on one side.
- **Explosion**: fragments leave straight-ish smoke lines with little turbulence; the fire has no dark smoke
  mixed in while it burns (it turns to smoke as a whole), and secondary bursts near the edge of the first
  ball read as separate small balls for a moment.
- **Pad smoke**: softer than the first build's by day (quarter resolution). The cloud's shadow is a screen-
  space multiply: it is right under the cloud, but it cannot fall on anything outside the smoke grid and it
  darkens emissive pixels too. At night the cloud far from the jet is dark (single bounce of the plume light).
- **Splash**: the crown is a sheet with ligaments but no secondary jet in the middle and no collapse splash;
  on the real ocean its foot stands on the entry level, not on the wave under it (the foam does follow the
  water).
- **Lunar dust**: sheets are radial streaks of haze; they do not hide the horizon as Apollo footage shows
  at 10 m and below, and there is no self-shadowing between streaks.
- **RCS in shadow**: a dim warm cone, small on screen at 26 m; whether it should be brighter is a judgement.
- **Parachutes**: the cloth waves are analytic ripples on the inflated shape, not cloth; a cut canopy keeps
  its dome as it collapses.

Not verified:

- The integrated game beyond the five integration-lab pictures above: the lift-off on the real pad (the pad
  cloud, its shadow on real terrain, the plume light on the real mount and tower), canopies, crown and foam
  over the real ocean, dust on real lunar terrain from close up, and everything on the real sim are unseen.
- The GPU p99 budgets on a quiet machine (section 4.1).
- Performance with two vessels burning at once, and with the reentry or explosion volumes filling the frame.
- Temporal stability is asserted on a static camera only; a moving camera was looked at in live shots, not
  measured.
- The foam's water test (`scene.depth` in front of `scene.depthOpaque`, or `MATERIAL_WATER`) was exercised on
  the lab planet's far sheet only, not on the ocean package's near field.

## 7. Requests filed

- `docs/requests/vfx-1.md`: the exposure meter ignores emissive transparents over the sky. Resolved by
  core-support (03242a3) with `CoreApi.addEmissiveHint(luminance, coverage)`.
- `docs/requests/vfx-2.md`: the FakeSim's `ignitionAge` never advanced, so every plume in the integration lab
  was a permanent start-up flash. Resolved by core-support (0f1979d).
- `docs/requests/vfx-3.md`: a night launch burned out for seconds after ignition. Resolved by core-support
  (aa8fd79): not the adaptation speed but the target (a lit area brighter than the prior now takes the target
  over from 2 % of the frame). The extra hint the resolution suggests is not sent (section 5.12).

- `docs/requests/vfx-4.md` (round 1): the exposure followed the effects. Resolved by core-support (5d3e0ee):
  the histogram is taken before the transparent pass, and while the sun lights the scene the target is
  bounded at sunny 16 + 0.5 EV.
- `docs/requests/vfx-5.md` (round 1): a source radius on `LocalLight`. **Open** when this note was written;
  section 8 says what waits for it (the hull above the engines at night, bells and legs next to a flame).
- `docs/requests/vfx-6.md` (round 1): the blue-noise offset in deterministic mode. Resolved by core-support
  (f52f358) as an opt-in, `window.__lab.setDeterministic(true, { cycleNoise: true })`; the matrix uses it.

No open requests against vfx paths.

## 8. Visual close-out, round 1

The work list is `out/qa/wave2/vfx.md` (28 items: 8 blockers, 13 major, 7 minor; both critics at 3.5 / 10).
This section is what was done to each item, by its cause, and what is still wrong. Pictures are under
`out/screens/vfx/`; all of them were re-shot with the final code (37 of 37 functional tests, 10 min).

### 8.1 What is different in the package

- **Plume field rewritten** (`plumes.ts`, `plumeModel.ts`, `clusters.ts`). One jet now has three regimes that
  blend by the pressure ratio: the column held by the ambient air (unchanged geometry, the two formula tests
  measure it as before), the turbulent flame (fills the jet below the translucent core, is pushed about by
  eddies as large as the jet in coordinates in which the jet is a cylinder, cools from a white-yellow heart
  to deep orange, ends in a ragged tip at `afterburn.lengthRe`, which is now a LENGTH and not an e-folding
  length), and the free expansion (`JetShape.far`, from 4 to 40 times the ambient pressure: gas spread by
  angle from a point one exit radius inside the nozzle, density ~ `farAmp (re/R)^2 cos^k`, a small brilliant
  core from density squared, a fan of condensate that scatters sunlight and has no edge). A strongly
  under-expanded jet balloons to about 1.3 re sqrt(eta) (30 km: ten exit radii, 60 km: seventy, vacuum:
  nothing holds it). Solid motors: incandescent particulates (`smoke.glow`) as the source function of the
  smoke, smoke that stays opaque as the jet widens (`smoke.dilution`), billows on the jet's own scale, a lit
  and a shaded side (optical depth of the chord towards the sun). Start-up: a soft puff that leaves the
  nozzle and expands in all directions (`ignition.reachRe`), exactly gone after `flashTime`.
- **New data fields** in `plumes.json` (all validated): per look `farField { exponent, scatter, striation }`,
  `smoke.glow / glowColor / glowLengthRe / dilution`, `ignition.reachRe`; `reentry.trail.trainLuminance /
  trainLifetime`; `splash.crown.mist`. Changed meaning: `afterburn.lengthRe` (flame length), `reentry.trail.
  luminance / lifetime` (the hot head: 180,000 cd/m^2, 0.6 s), `particles.gas` (a thin fast sheet).
- **Plume lights** (`feature.ts`): the intensity of a cluster (still proportional to thrust: 15.27 cd/N for
  the booster look, the test sums the lights) is spread over three lines along the luminous length (4 %, 26 %,
  70 %), starting six exit radii below the nozzles; where the jet meets the ground the line ends above it
  and 60 % of what is cut off shines from a point above the foot. A thruster's light is a line along its
  puff. Reentry has a second light behind the body.
- **Exposure hints**: sent only when the sun does not light the camera (the core's `sunVisibilityAt`), for
  every emitter whether geometry is behind it or not, capped at 1,500 cd/m^2 (12,000 towards twilight), and
  counted with at least the size of the glare of a small emitter (8 % of the frame's height). By day nothing
  is reported: the meter exposes for what is lit (request vfx-4) and effects clip. This replaces section 5.12.
- **Composite** (`volumes.ts`): after the core's depth-aware upsample, what the volume image shows clearly
  behind the pixel's own surface (mean distance from the moment target, ratio 1.1 to 1.35) is not drawn on
  it. **Smoke combine**: each quarter-resolution ray is composed with the pixel's emitters BEFORE the rays
  are mixed (cubic B-spline over 4 x 4 rays).
- **Lab** (`labs/vfx`): sea scenes by day hold the camera at EV 13 (`minEv100`; the lab's sea is a dark
  Lambert sheet that does not mirror the sky, and the meter alone opens to EV 10.4 over it; `?minev=`
  overrides). `shots.spec.ts`: `"after"` prints an expression evaluated after the settle (exposure, lights).
- **Matrix**: shot with the cycling blue-noise offset (`window.__lab.setDeterministic(true, { cycleNoise:
  true })`, request vfx-6), plus live frames (`*-live.png`) and the views the critics missed: inside the pad
  cloud, booster at 45 m at night, the splash close-up live, the cut-away one second after release, the
  explosion from 350 m at night, the escape motor from close up. 22 sheets, 185 pictures.
- **New spec** `tests/browser/vfx/exposure.spec.ts` (4 tests): see 8.3. `liftoff.spec.ts` probes 12 m and 30 m
  below the nozzles (the first metres are the dim translucent core by design).

### 8.2 The 28 items

| # | Item | What was done | Picture | State |
|---|---|---|---|---|
| 1 | Exposure follows the effects (blocker) | Request vfx-4, resolved by core-support: histogram before the transparent pass, target bounded at sunny 16 + 0.5 EV by day. In the package: no hints by day, crown / foam / droplets at sunlit white. | `liftoff/t3-day.png`, `splash/impact-*.png`, `explosion/day-*.png` | Fixed. Sky by day: 0.43 EV between engines off and on (plume-lit ground, inside the bound), within 2 % through the splash once the capsule is in the water, within 1 % through the fireball. The step of 0.25 EV at the moment of impact (meter left to itself) is the white hull going under, not the effect. |
| 2 | Night lift-off is a black frame (blocker) | Lights along the flame and above the foot, efficacy 8.5 -> 20 cd/N, hints capped at night, fireball light 10 x. | `liftoff/t10-night.png`, `liftoff-chase/t3-night.png`, `plumes-close/booster-45m-night.png` | Mostly fixed: EV 12.65 at T+10 s, ground 2,200 / 540 / 190 cd/m^2 at 100 / 200 / 300 m (0.29 / 0.07 / 0.025 of display white), cloud lit, flame clipped. Hull above the engines: the light the ground cuts off now shines from three points on a ring about the foot (8.7), so at T+0 the hull is lit, warm (`liftoff/t0-night.png`, `liftoff-chase/t0-night.png`); from T+3 s, with the jet clear of the ground, it is a silhouette with a lit base again, as in the Atlas V night photograph. A hull lit by the flame beside it still waits for vfx-5. From the chase camera the meter sits at its upper clamp (EV 16.5) because the lab's white mount next to the flame is the brightest 1 % of the lit pixels. |
| 3 | Separation is a glow ball (blocker) | Gas: 240 particles in a thin sheet at 140 to 360 m/s, gone in 0.36 s; the retro and ullage motors are jets with a white-yellow root (item 7) and thin sunlit smoke. | `plumes-close/staging-separation-70m.png`, `staging/2.9s-retro.png` | Fixed. |
| 4 | Ignition is a flat disc (blocker) | Puff instead of a ball cut by a plane (8.1). | `vacuum-ignition/ignition-0.05s.png`, `ignition-0.3s.png` (gone) | Fixed. |
| 5 | Reentry lens, pinwheel, dusty wake (blocker) | Shock layer filled through its depth, windward factor from a point inside the body (no jump of the normal), flow map with unnormalised velocity (no pole), band-limited low-contrast noise (no glitter ring), a faint envelope; wake three times brighter with a ramp white -> gas colour -> dull red, continuous into the trail (same radius 0.55 Rb); lights front and rear (efficacy 0.015 -> 0.05). | `reentry-views/front-1.0.png`, `side-close-0.3.png`, `reentry/plasma-0.3-day.png` | Fixed in kind, **not at the bar**. Round 1 takeover (8.7): the wake glows at `wakeGain` 0.05 of the layer (it was a second head), streaks round the axis in the sheath, sheath width grows 2.5 x slower: pink-salmon streaming wake behind a clipped head (`reentry/plasma-0.3-day.png`, `plasma-1.0-day.png`, `reentry-views/side-close-0.3.png`). Still: at 1.0 and 11 m the wake is near white with the bloom of the head over it (`side-close-1.0.png`); from behind, a bright ring with haze on one side (`behind-1.0.png`); no shed streamers, no ablator flashes beyond the sparks. |
| 6 | Splash: disc, lampshade, confetti, decal (blocker) | Crown: height, lean and foot differ round the rim, lumpy thickness, ligaments, self-shadow, a torus of mist that lingers; spray in 10 to 15 fingers biased by the drift; drop sizes 1 to 13 cm (log, few large), lit as the crown with glints; foam with a wandering soft outline, band-limited, over turquoise aerated water. | `splash/impact-0.4s.png`, `close-0.4s.png`, `close-1s.png`, `impact-5s.png` | Much better, **not at the bar**: rim at three scales and shaded lumps since 8.7, but the lower crown still reads as a bowl, the spray as a field of white dots, the mist as soft clumps; no ring waves and no change of the water itself (ocean package; not requested, see 8.5). |
| 7 | Solid motors are sand-coloured wedges (blocker) | 8.1: glowing particulates, opaque billowing smoke, shading. | `engine-solids/sl-les.png`, `sl-les-close-live.png`, `sl-retro.png` | Fixed in kind: clipped flame root (about 20 m of a 190 m frame, less than the third asked for), billows; the smoke is soft (half resolution) and cream rather than white-grey with hard shadows. |
| 8 | Explosion: matte ochre ball (blocker) | 1.2e6 cd/m^2, white flash in the first 50 ms, temperature per sample (white, yellow, orange, dull red), soot where the gas is cold from the start, two finer octaves limited to the pixel, hard edge, thin fragments (0.2 to 0.5 m). | `explosion/day-0.03s.png`, `day-0.6s.png`, `day-1.5s.png`, `close-0.6s.png`, `night-0.2s.png` | Fixed. 8.7: billows on billows (Perlin-Worley at four scales, no cellular facets), an edge a few hundredths of a radius thick, two-point soft self-shadow, soot that takes over as the heat goes: flash, fire, fire inside black smoke, dark grey billowing cloud (`explosion/day-0.2s.png`, `day-0.6s.png`, `day-1.5s.png`, `day-3.5s.png`). Still open: fragments are thin straight lines from 1.3 km, the close view at 2.5 s is soft (half resolution). |
| 9 | Booster plume: lilac column, beads (major) | Core 60,000 cd/m^2 (translucent blue-violet), Mach discs as thin plates with diamonds behind them (gain 14), cells end before the jets merge, flame about one vehicle length (100 m) with eddies and a ragged tip. | `liftoff/t10-day.png`, `plumes-close/booster-45m.png`, `booster-110m.png`, `ascent/2km.png` | Fixed in kind. At 45 m the separate jets are thin bright streaks for 15 m before the flame; diamonds are small. The 12 km blob was not looked for separately (the field that drew it is gone; `ascent/12km.png` shows none). |
| 10 | Vacuum: closed bulb with scales (major) | Free expansion (8.1), noise off in vacuum. | `engine-atlas-9m/30km-full.png`, `60km-full.png`, `vac-full.png`, `plumes-close/vacuum-60m.png` | Fixed: 30 km < 60 km < vacuum in width, no outline, no cells. The fan's half-density angle is about 25 degrees; the reference shows wider. |
| 11 | Pad cloud: soft mound with holes (major) | Dense gas gets a surface (threshold on field + billow noise, 3 x denser inside, haze outside), no erosion inside the cloud, relief shading from the noise towards the sun and from the cells of the detail noise, glow as heat^6 x 0.3, detail limited to the ray's footprint, B-spline combine. | `liftoff/t10-day.png`, `liftoff-chase/t6-day.png` | Better, **not at the bar**: lumpy and lit from the pad camera; from 150 m it is still soft (quarter resolution) with a few small dark gaps at its thin edge; size and height were not raised (the flow was left alone). |
| 12 | Hairlines beside the jet (major) | Per-ray composition before the mix (8.1). | `liftoff-chase/t6-day.png`, `t6-night.png` | Fixed: not seen in any chase picture. No separate spec was added for "a plume faded to zero equals no plume". |
| 13 | Bells and legs flat white (major) | Light starts six exit radii downstream, 4 % of it in the first tenth. | `plumes-close/booster-45m.png` | Bells are shaded metal by day. The lander's legs at night still clip: waits for vfx-5. |
| 14 | RCS: grey shafts, nothing lit (major) | Free expansion with exponent 3.5, scatter 3, gone within 40 exit radii; core 60,000 cd/m^2; light 60 cd/N along the puff. | `rcs/all-sun-12m.png`, `pulse-shadow.png` | Sunlit: short wide puffs. In shadow: the hull is lit round the thruster, the frame is otherwise dark and with all thrusters firing darker still (the meter protects the bright patches). Weak. |
| 15 | Lunar dust: sunburst, dark blot (major) | No hole, streaks 3 : 1 at finer scales that break along the radius, brighter (as bright as lit ground), depth ~ strength^1.6, particles 30,000 -> 6,000 per second and larger. | `lunar/30m-day.png`, `10m-day.png`, `5m-day-close.png`, `3m-night.png` | Fixed in kind: a continuous bright sheet. The horizon is not veiled and the sheet has no visible thickness against the sky. |
| 16 | Trails: ruler line, stick (major) | Hot head + faint train, colour by age, exponential interpolation, beads on a 1.3 km scale, kinked axis, ragged old end, the sub-pixel head counted in its pixel. | `reentry/trail-50km-day.png`, `trail-50km-night.png`, `haze-trail-50km.png` | Fixed: bright head, tail fading to dull red. 8.7: the trail glows at 6,000 cd/m^2 (it starts where the dimmer wake ends; 180,000 made a bright tube behind a dim wake) and its sub-pixel head counts 2 per metre of fade-in, so the far views keep a clipped head. |
| 17 | Cut-away canopies stay domed (major) | Collapse in 0.45 s, keels over at 0.9 rad/s, sinks at 11 m/s, each line hangs by itself. | `splash/cut-away-1s.png`, `cut-away-6s.png` | Fixed in kind (a bending streamer, not cloth). |
| 18 | Canopies intersect (major) | Spacing by radius x (1.1 + 0.22 slack). No contact pass. | `chutes/mains-reef2-backlit.png`, `mains-full-backlit.png` | Fixed (they stand apart; they do not press on each other). |
| 19 | Reefed mains are corn cobs (major) | Reefed meridian: swollen crown on a nearly straight tube with an open mouth (0.72 a), pleats 0.42, full translucency. | `chutes/mains-reef1-backlit.png` | Fixed in kind. |
| 20 | Volume image eats hull edges (major) | Rejection by the moment target (8.1); the glow that caused it is gone. | `plumes-close/staging-separation-70m.png` | Fixed for volumes clearly behind the surface; a volume within 10 % of the surface's distance is untouched. |
| 21 | Secondary bursts as separate balls (major) | Spawned at 0.25 to 0.55 radii, 0.5 to 0.75 of the size. | `explosion/close-0.6s.png` | Better: lobes that break out of the ball. 8.7: a later burst flashes at a fifth of the first and burns at 0.82 of its temperature: yellow-orange lumps on the fire, no longer white balls (`explosion/close-0.6s.png`); still distinct lumps. |
| 22 | Ice and debris are equal dots (minor) | Sizes spread over a factor of 30 (log, few large), fewer of them, faster; pixel floor varies per particle. | `liftoff-chase/t3-day.png`, `staging/3.6s-coast.png` | Better; no plates, no tumbling shapes. |
| 23 | Lander plume at night is a white cone (minor) | Core 900 cd/m^2, vacuum gain 0.003, no noise; smooth. | `lunar/30m-night.png` | Better: a soft pale cone, still seen (the frame is exposed for 13 cd/m^2 of regolith). |
| 24 | 2 px lattice in single frames (minor) | Request vfx-6 (resolved, opt-in); matrix with cycling noise; live frames. No vfx-owned spatial filter. | `plumes-close/booster-45m.png` vs `booster-45m-live.png` | Fixed for the matrix; after a camera cut the first frames still carry it. |
| 25 | Lines light against the sun, pattern aliases (minor) | Lines lit by the share of the visible half that faces the sun; pattern and tapes filtered by `fwidth`. | `chutes/mains-full-backlit.png`, `drogues-reefed.png` | Fixed. |
| 26 | Debris in columns, dark bar (minor) | Directions even over the solid angle (they crowded along the emitter axis). | `explosion/close-0.6s.png` | Columns fixed. The dark bar was not looked for. |
| 27 | Inside the cloud: flat fill (minor) | The ground-shadow multiply fades for an eye inside the cloud (no wedge). | `liftoff-chase/inside-cloud-t6-day.png`, `-night.png` | Wedge gone; still a flat tan (day) or orange (night) fill. |
| 28 | Canopy shadows stippled (minor) | Nothing. | - | Not done (not checked on the real ocean). |

### 8.3 Measured

`exposure.spec.ts`, final run: pad by day at T+3 s EV100 15.00 with nine engines on, 14.57 off (sky 0.43 EV,
asserted under 0.5); splash with the meter left to itself: sky 1.872 before, 2.225 / 2.196 / 2.163 / 2.173 /
2.184 at +0.1 / +0.4 / +1 / +1.8 / +2.5 s (asserted within 5 % from +0.1 s on, the step at impact under 0.4
EV); fireball by day: sky 0.1764 to 0.1777 (within 5 %); pad at night, T+10 s: figures in item 2 (asserted
above 300 / 100 / 40 cd/m^2 and 0.006 of white). The other acceptance figures (section 4) are unchanged in
kind: half-angles -7.65 / -0.62 / 13.05 deg against -8.00 / -0.65 / 13.20, cell spacings 5.214 / 8.187 /
18.635 m, luminance monotonic with throttle (40k ... 178k), light 15.2729 cd/N at every throttle, HDR max
60,000 with 0 NaN at EV -3, particles deterministic, canopy area 0.198 / 0.426 / 0.635 / 0.815, temporal
difference mean 0.40 (engine) and 0.38 (pad) of 255, 99.99 % within 14 and 10, maxima 35 and 33.

**GPU time at 1440p** (`vfx.perf.spec.ts`, final build; run A before the last trim of the free-expansion
steps, run B after it). Both runs were taken with all four GPU slots of the gate busy (other agents'
suites); single frames of 70 ms and more are in the windows. Means are the per-frame vfx sums.

| Scenario | Budget (ms) | Mean A / B | Steady sum of the pass means (B) | p99 of the four windows, A | p99 of the four windows, B |
|---|---|---|---|---|---|
| Lift-off, pad camera | 1.3 | 0.603 / 0.720 | 0.55 | **1.920**, 0.724, 0.730, 1.104 | 0.769, 0.712, 0.729, 1.212 |
| Lift-off, chase camera at 150 m | 1.3 | 1.262 / 0.993 | 0.96 | **71.0**, 1.111, 1.217, **1.378** | **2.792**, 1.091, **1.456**, **2.986** |
| Lift-off, inside the cloud | 1.3 | 0.769 / 0.866 | 0.55 | **1.389**, **1.472**, 1.126, 0.824 | **2.650**, 1.127, **1.454**, **1.423** |
| Ascent | 1.0 | 0.177 / 0.176 | 0.18 | 0.186, 0.195, 0.190, 0.189 | 0.185, 0.194, 0.192, 0.192 |
| Vacuum burn | 0.6 | 0.342 / 0.331 | 0.23 | **0.608**, 0.511, 0.240, 0.243 | 0.566, 0.473, 0.242, 0.244 |
| Lunar descent with dust | 0.9 | 0.451 / 0.439 | 0.45 | **1.420**, 0.884, **2.072**, **1.959** | **0.947**, 0.745, **1.194**, 0.738 |
| Reentry | 1.2 | 0.528 / 0.739 | 0.36 | 0.829, **2.860**, **2.641**, **2.308** | 1.011, 1.081, **70.6**, 0.660 |
| Chutes and splash | 0.9 | 0.309 / 0.117 | 0.09 | **1.577**, **6.052**, **3.289**, 0.090 | 0.323, 0.370, 0.450, 0.090 |

Bold = over the budget. **The spec failed in both runs** (7 of 8 scenarios in run A, 4 of 8 in run B), as it
did for the first build, on windows with spikes on passes that cannot cost that (the smoke simulation: mean
0.08, p99 0.5 to 2.1 ms; the particle simulation: mean 0.05, p99 0.36 to 2.0). What is stable: the means and
the steady sums, all inside their budgets. What changed against the first build: the chase lift-off is
dearer (steady 0.96 against 0.74: flame with eddies, relief shading of the cloud), the vacuum burn about the
same after the trim (its first two windows hold the ullage motors: 0.57 and 0.47), lunar and reentry about
the same. The chase lift-off has the least room: 0.96 of 1.3. By PACKAGE_RULES 16 the p99 figures are
provisional and have to be taken again on a quiet machine.

### 8.4 Requests of this round

- `vfx-4` (blocking; exposure meter): resolved by core-support, commit 5d3e0ee.
- `vfx-5` (source radius on `LocalLight`): **open**. With it: give the plume lines the radius of the flame
  and the ground light the radius of the foot (the fields are ready to take it in `plumeLights`), then check
  the hull above the engines at T+3 s at night, the lander's legs, and the thruster patches in shadow.
- `vfx-6` (noise offset in deterministic mode): resolved by core-support, commit f52f358 (opt-in).
- `cockpit-9` (against `plasma.ts`: the plasma seen from the cabin): **resolved** in this round (8.7).

### 8.5 Not done, and why

- **Ring waves and a change of the water at the entry point** (item 6): belongs to the ocean package. No
  request was filed: I did not get to specifying it, and the foam decal and the aerated patch are the cue the
  brief asks of this package.
- **The meter over a dark sea**: in the lab the meter opens to EV 10.4 over the Lambert sea and the white
  water clips to a blob; the lab now holds its sea scenes at EV 13. Whether the real ocean gives the meter
  enough (it mirrors the sky) was not checked in the integration lab. If it does not, that is a request to
  core-support (a lower bound on the target while the sun lights the scene), not a vfx matter.
- **Pad cloud size and height** (item 11), a contact pass between canopies (18), plates of ice (22), the
  dark bar (26), structure inside the cloud (27), canopy shadows (28), a vfx-owned spatial filter (24), the
  spec "a plume faded to zero equals no plume" (12): not done for lack of time, in that order of weight.
- **Nothing was looked at in the integration lab in this round** (real vehicle, pad, ocean, Moon): every
  picture is from the vfx lab with its stand-ins. The night lift-off on the real pad with its tower and the
  splash on the real ocean are the two that matter most.

### 8.6 My own score

Photo lens 5.5 / 10, artifact lens 6 / 10. No picture is a placeholder shape any more and the exposure holds,
but several effects are right in kind and still short of a photograph: the pad cloud from 150 m, the reentry
wake at full intensity and from behind, the splash crown, RCS in shadow, the dark hull at a night lift-off.

### 8.7 Round 1, finished by the next owner

The second owner of round 1 stopped (spend limit) with sections 8.1 to 8.6 written and uncommitted. The third
owner reviewed every sheet against the reference photographs, committed that work (one change kept back: see
the splash spec below) and fixed what still read as CGI first. All pictures under `out/screens/vfx/` were
re-shot with the final code (37 functional tests; the two failing ones are below).

What changed:

- **Reentry wake** (`plasma.ts`, data `reentry.wakeGain` 0.05, new, validated): the wake and the sheath glow at
  a twentieth of the shock layer once they have left the shoulder (smoothstep from -0.3 to 1.2 shoulder
  radii; physically the gas cools by thousands of kelvin round the shoulder and air radiates far faster than
  its temperature falls). It was as bright as the head: a clipped white tube. The sheath carries streaks
  that are a pattern round the axis (two sets, 1.7 and 5.5 texture units round, drawn out along the flow,
  streaming at different speeds, band-limited to the pixel); a pattern in all three directions averaged
  away along each ray, which is why the old wake was smooth. The sheath widens 0.012 radii per radius (was
  0.03: a soft blur far down the wake). Its colour is the gas colour, cooling to orange; only the first 1.5
  radii of sheath mix towards white. Intensity scales the wake only through the layer's luminance (the
  extra factors made 1.0 nine times 0.3). Pictures: `reentry/plasma-0.3-day.png`, `plasma-1.0-day.png`,
  `reentry-views/side-close-0.3.png`, `front-0.3.png`.
- **Reentry trail** (`trail.ts`, data `reentry.trail.luminance` 180,000 -> 6,000): it starts where the wake
  ends and must not be brighter than it; its sub-pixel head is counted with 2 per metre of fade-in (was 0.06),
  so the 50 km views keep a clipped head on a fading line (`reentry/trail-50km-night.png`).
- **The plasma from the cabin** (request `cockpit-9`): with the eye inside the shape proxy nothing is left out
  around the eye; scene depth limits the rays to the windows. New export `plasmaWindowRadiance(data,
  heatFlux, intensity, speed)` (610 / 1,540 / 3,020 cd/m^2 at 0.3 / 0.6 / 1.0, pink-magenta) for the cabin
  light; unit test. Integration-lab pictures `out/screens/vfx/dev/int-reentry-cabin-windows.png`,
  `int-reentry-cabin-lean.png`: the panes, black before, are filled with the sheath (they clip at the
  cabin's exposure).
- **Fireball** (`fireball.ts`): the surface is Perlin-Worley billows at four scales (0.62 / 0.3 / 0.16 / 0.08
  radii); the Worley channel that made cellular facets ("crumpled paper", "low-poly rock") is gone from the
  surface, the temperature cells and the lumps. The edge is 0.08 radii thick (was 0.24: a blurred ball).
  Self-shadow from two looks towards the sun (0.1 radii with two octaves, 0.33 with one), soft. Gas below
  about half the temperature scale is soot, not dim orange fire; the fire lights only the smoke next to it
  (the old term lit every bit of smoke orange: the "tan cotton ball"). Soot is a fifth of its later amount
  while the ball is young. A later burst flashes at 0.2 of the first and burns at 0.82 of its temperature.
  Pictures: `explosion/day-0.2s.png` (fire with soot), `day-0.6s.png` (fire inside black smoke),
  `day-1.5s.png`, `day-3.5s.png`, `day-7s.png` (dark grey billowing cloud), `close-0.6s.png`.
- **Night lift-off** (`feature.ts`): the light the ground cuts off from the flame shines from three points on
  a ring about the foot, at a radius equal to their height (at least the nozzle spread plus four exit
  radii), instead of one point on the axis, which the hull walls above the engines face away from. Booster
  light warmer, (1, 0.64, 0.34) at 22 cd/N (same 15.3 cd/N of luminous intensity). `liftoff/t0-night.png`,
  `liftoff-chase/t0-night.png`: the hull stands lit, orange-white, in its cloud.
- **Splash crown** (`splash.ts`): the rim at three scales round the axis (where the wall stands, tongues,
  fingers; the proxy is 1.8 rim heights tall to hold them), and the lumps shade the white water (0.6 to 1.2).
  Small effect: `splash/close-0.4s.png`.
- **Specs**: `atmosphere.spec.ts` overcast test probes 40 m below the nozzles (the flame now ends within a
  vehicle length; 125 m below was sky) over a 9 x 9 block. Thresholds unchanged. `exposure.spec.ts`: the
  previous owner had widened the step allowed at the moment of impact from 0.4 to 0.75 EV; that is undone
  (see below).

Not passing:

- `exposure.spec.ts`, splash: the step between the frame before impact and the first in the water is 0.415
  EV (EV100 10.79 -> 10.38; asserted under 0.4). Every frame from +0.1 s to +2.5 s is within 2.8 % of the
  first in the water (asserted 5 %). The previous owner measured 0.25 at the same step; the "before" value
  moves between runs (1.669 now, 1.872 then) while the in-water values repeat to 0.1 %: it is the meter
  losing the sunlit white hull (and how far it had adapted to it at 1.9 s), not the effects, which the
  meter no longer sees (vfx-4). Left failing rather than loosened. A clean fix is in the lab or the spec
  (measure "before" after the meter has settled, or hide the hull), not in the package.
- `vfx.perf.spec.ts`: 6 of 8 failed, run with all four GPU slots of the gate busy; see the table.

**GPU time at 1440p**, final build, run C (loaded machine, as runs A and B in 8.3):

| Scenario | Budget (ms) | Mean | p99 of the four windows | Steady passes of the last window (mean) |
|---|---|---|---|---|
| Lift-off, worst case (pad camera) | 1.3 | 0.559 | 0.812, 0.897, 0.894, 0.798 |
| Lift-off, chase camera at 150 m | 1.3 | 0.764 | 0.910, 1.067, 1.088, 1.156 |
| Lift-off from inside the cloud | 1.3 | 0.737 | 1.169, 1.118, 1.172, 0.901 |
| Ascent | 1 | 0.197 | 0.210, 0.212, 0.209, 0.216 |
| Vacuum burn | 0.6 | 0.297 | 0.377, 0.351, 0.270, 0.270 |
| Lunar descent with dust | 0.9 | 0.261 | 0.556, 0.453, 0.492, 0.561 |
| Reentry | 1.2 | 0.455 | 0.738, 0.736, 0.742, 0.743 |
| Chutes and splash | 0.9 | 0.087 | 0.358, 0.376, 0.036, 0.034 |

The steady costs are those of run B (the plasma march is about 0.04 ms dearer: the streaks of the sheath
and the test for an eye in the body). The pad-camera mean is over its 0.8 x budget line because one window
holds a 102 ms frame; its steady passes sum to 0.58 ms. The p99 failures are spikes on passes that cannot
cost that much (the particle simulation 0.95 ms mean in a reentry window with 32.8 ms at p99, the smoke
simulation 0.12 mean / 0.8 p99). Provisional by PACKAGE_RULES 16; to be taken again on a quiet machine.

My score after this round: **photo 6 / 10, artifact 6.5 / 10**, short of the bar of 8. What a critic will
still see first: the reentry close-ups at intensity 1.0 (a near-white wake under the bloom of the head, a
ring from behind); the splash crown (a bowl in a field of white dots); the pad cloud from 150 m (soft) and
the flat fill inside it; the solid-motor smoke (soft, cream); RCS puffs that barely show; the explosion's
secondary bursts as lumps and its soft close view. What should no longer be raised: the faceted fireball
smoke, the clipped white reentry wake at 0.3, the black hull at T+0 of a night lift-off, the black cabin
windows during entry.

## 9. Visual close-out, round 2

Work list of the round: what the mission flown in the game showed (`out/screens/mission/`), then the two
round-1 lists (`docs/qa/wave2/vfx.r1.photo.json`, 4.5 / 10 with 3 blockers; `vfx.r1.artifact.json`, 5 / 10
with 2 blockers), then the requests. A second owner began it (`1665ac9`: plume lights with a source radius,
shock cells seen near the nozzle only, reentry layer concentrated at the stagnation point with a narrowing
wake, particle streaks behind the particle, a denoise pass over the half-resolution image, fireball with a
smooth temperature field, foam as lace, curved slack lines, dust sheet) and was cut off by a machine crash;
its uncommitted tuning is `b8edf91`. A third owner finished the round: this section. Where it disagrees with
sections 0 to 8, it is right.

### 9.1 What the game showed (work item 1)

New tool: `tests/browser/vfx/appshots.spec.ts` flies the real game with the test pilot (`/?pilot=1&hud=0`)
and takes pictures at conditions over `window.__app.brief()` (a JSON list of steps in `VFX_APP_SHOTS`; the
header of the spec has an example). Pictures `out/screens/vfx/dev/a4-*.png`; integration lab
`out/screens/vfx/dev/i4-*.png`.

| Finding | Cause | What was done | Picture |
|---|---|---|---|
| No flame at the nozzles at lift-off, only smoke | The flame measured 0.2 to 0.3 million cd/m^2 12 m below the nozzles: at a daylight exposure it sat on the shoulder of the tone curve, a cream column of the same value as the sunlit steam behind it, with no glare. (In the milestone picture the HUD's speed read-out also covers the nozzles.) | `afterburn.luminance` 0.9 -> 2.8 million cd/m^2, Mach discs to match (`diamonds.gain` 14 -> 32), a flame with an edge (it ended over 70 % of its radius: a glow) that starts 3 exit radii below the nozzles so that the first disc shows in the translucent core. Measured 1.8 to 2.5 million cd/m^2 at 12 m, 1.3 to 1.9 million at 30 m (`liftoff.spec.ts`, which now asserts 240,000: three stops over a sunlit white surface). The flame also fades more slowly with altitude (square root of the pressure down to 9 kPa; nothing left at 1.5 kPa, where the old law left an orange bulb with a hard end at 30 km once the flame was bright). | `a4-liftoff-t3.png`, `a4-liftoff-t6.png`, `a4-liftoff-t10.png`; lab `liftoff-chase/t6-day.png`, `plumes-close/booster-45m.png` |
| White streaks across the frame at the first stage separation | A particle's streak is its path relative to the eye during the shutter. The motion of the effect domain past the eye was divided by the REAL frame time: under the pilot's 4 x physics warp every particle that rides with a vehicle at 2.4 km/s was drawn with three times the vehicle's speed, a hairline of the largest length. With the clock stopped (every stopped lab picture) the term vanished and a particle at reentry speed was a line ahead of the capsule: the "hairline" of round 1 (photo 13) and, very likely, the red streak of request flight-ui-4. | The domain's velocity relative to the eye is measured over SIMULATED time and held while the clock stands still (`VfxGlobals.domVel`, `feature.ts`). | `a4-sep-0.png` .. `a4-sep-2.png`; lab `reentry/plasma-1.0-night.png` |
| Separation particles are hard-edged white rectangles | Ice and chips were flat-topped capsules a few pixels across, up to a metre in size. | Flakes: a soft irregular outline with a Gaussian profile, tumbling (seen flat, then edge-on), 1.2 to 18 cm (`particles.ice.size`); sparks are tapered streaks; spray is finer and streaked. | `staging/3.6s-coast.png`, `a4-sep-1.png` |
| An orange ball of glow at the separation (seen in the game in this round) | The start-up puff of the hydrolox upper-stage engines: orange, 40 exit radii across. | Pale blue-white, 24 radii, a third as bright (`plume.hydrolox-vacuum.ignition`). | `a4-sep-0.png`, `vacuum-ignition/ignition-0.05s.png` |
| The canopies look blotchy | Alternate gores were pleated in and out by 4 to 6 % of the radius even when full, each gore bulged by 5 %, every ring left 7 % of its width open (dark joints: a wall of bricks) and the tapes were lines of 40 % grey. | Full canopies are smooth domes: scallops of 2 %, pleats only while slack (and shallower), slots only round the vent (`buildCanopyMesh`), faint tapes. | `chutes/mains-full-frontlit.png`, `chutes/mains-reef2-backlit.png`, `i4-chutes.png` |

### 9.2 The round-1 lists, by cause

P = `vfx.r1.photo.json`, A = `vfx.r1.artifact.json` (finding numbers in file order); "open" items of round 0
are folded into the finding that carries them. Lab pictures are under `out/screens/vfx/<sheet>/`.

| Finding | Cause | What was done (second owner = 2, third = 3) | Picture | State |
|---|---|---|---|---|
| Reentry: lens, hose, ellipse, eclipse ring, dark back shell (P1, A2 blockers; A21) | A thin shell at the standoff; a wake as bright as the head; at night the meter was told of a 1,500 cd/m^2 emitter (the flame cap), so a 900,000 cd/m^2 layer was 600 times over and its glare filled a quarter of the frame; nothing glowed behind the back shell. | 2: layer concentrated at the stagnation point with a Gaussian fall beyond the standoff, hot shoulder skirt, a wake that narrows, cools (white, gas colour, orange, dull red) and carries streamers at three scales, lights with a radius. 3: the layer sets the night exposure (hint without the flame cap, three stops over white): a compact clipped head, a coloured layer round it, a lit capsule; the base flow behind the back shell glows at peak heating (`BASE_GLOW`, with the square of the intensity), so that from behind the capsule is seen through a streaming glow, not as a black disc in a ring. | `reentry/plasma-1.0-night.png`, `plasma-0.3-day.png`, `reentry-views/behind-1.0.png`, `front-1.0.png`, `side-close-1.0.png`; in the integration lab `dev/i4-reentry.png` | Much better; not at the bar from the front (a clipped white ellipse with little structure) and from behind (a soft bright rim round a mauve disc). |
| A hairline ahead of the capsule (P13) | The particle streak bug of 9.1 (ablation sparks in a stopped frame). | 3: fixed at its cause. | `reentry/plasma-0.3-night.png` | Fixed. |
| Splash: bowl in a snow globe, foam disc (P2 blocker, A8) | Round drops of a few sizes, evenly spread; a symmetric crown; a disc of foam. | 2: foam as lace with a wandering outline, drop sizes weighted to the fine end. 3: finer still (4 mm to 9 cm), fewer large ones, drawn as streaks along their flight. | `splash/close-0.4s.png`, `close-1s.png`, `impact-5s.png` | Better: a ragged white burst with spray. The crown is still a soft mass at half resolution, there are no ring waves (ocean package; not requested). Not at the bar. |
| Explosion: glitter, rods, square secondary, sepia night (P3 blocker, A9, P16, A22) | A product of noise octaves at a high power; trails that glowed for a tenth of a second (a rod twenty metres long per fragment); later bursts drawn over the first ball at their own noise scale. | 2: smooth temperature field, fire inside soot from the start, fragments with varied drag and thin trails. 3: the fragment glow lasts 0.03 s (a bright head on a line of smoke), no secondary bursts (`explosion.secondaries` 0: one fireball that evolves reads better than balls in a ball), sparks as tapered streaks. | `explosion/day-0.2s.png`, `day-0.6s.png`, `close-0.6s.png`, `day-3.5s.png`, `night-0.2s.png` | Fire, fire in smoke, dark billowing cloud: good. The pale smoke lines of the fragments are straight for the first half second; the dark bar on one trail (A22) was not found. |
| Night lift-off: cream cloud, dark hull, no glare (P4) | The meter exposed for the lit ground (EV 12.6): the cloud next to the flame was several times over white and lost its colour; the far side of the cloud kept a third of the light by "multiple scattering". | 2: lights with a source radius (vfx-5): the hull is lit at T+0 to T+3. 3: a night launch is exposed for the cloud (hint at the luminance of steam 50 m from the flame: EV 13.5 at T+10 s from the pad camera), the far side of the cloud is darker, the flame is three times brighter and blooms. | `liftoff/t3-night.png`, `t10-night.png`, `liftoff-chase/t3-night.png`, `t6-night.png` | Orange cloud with a dark far side, burnt-out flame, lit hull and mount, dark ground beyond the pad: as the night photographs. No glow in the air round the flame beyond the bloom. |
| Booster flame does not clip, no glare, parallel column (P5, A7) | See 9.1. | 3: see 9.1. | `plumes-close/booster-45m.png`, `booster-45m-night.png`, `engine-atlas-9m/sl-full.png` | Fixed: 10 % of the engine tile clips; a white heart in an orange skin with a ragged outline. Still smooth at half resolution from 45 m; the discs are small. |
| Plume cut into detached copies at 10 and 30 km (A1 blocker, P6) | Shock cells drawn at full brightness hundreds of exit radii out, where the jet has ballooned. | 2: the cells are seen within 22 exit radii of the nozzle only. 3: no afterburning above 28 km. | `engine-vela-2v/30km-min.png`, `engine-lyra-d/30km-min.png`, `engine-atlas-9m/10km-full.png` | Fixed. The "seam along the horizon" is the same faint glow over a dark sky and over bright ground: left. |
| Staging and vacuum ignition read as sprites (P7, A17, A18) | Soft cones, flat capsules for sparks and ice, an orange puff larger than the stage. | 2: isotropic puff. 3: flakes, tapered sparks, pale small hydrolox puff, crisper edge for dense smoke. | `staging/2.56s-separation.png`, `2.9s-retro.png`, `vacuum-ignition/ignition-0.05s.png` | Better; the motor jets are still smooth cones. |
| Pad cloud: low, soft, cream, ink-blot holes, flat fill inside (P8, A6, A20) | Plume light at 22 cd/N made daylight steam cream; holes show the cloud's own shadow on the ground. | 2: density floor between billows. 3: plume light 12 cd/N (white steam by day), ground shadow 0.6. | `liftoff-chase/t6-day.png`, `liftoff/t10-day.png` | White billowing steam with shaded sides; still soft (quarter resolution), size and the inside view unchanged. |
| Solid motors: soft cream cone, grainy fans (P9, A15) | The column ended over the whole mixing layer. | 2: denoise pass. 3: dense smoke ends within a third of the layer, on the outline of its eddies. | `engine-solids/sl-les.png`, `vac-les.png` | Partly: the outline is firmer; the smoke is still lit evenly along its length. |
| Canopies: quilt, dull, clusters touch; cut-away sausages and rain (P10, P11, A11, A12) | See 9.1; a cut canopy shut into a tube in 0.45 s, keeled over and fell at 11 m/s with its lines as rods. | 2: wider cluster spacing, curved slack lines. 3: see 9.1; a cut canopy stays half open, sinks at 6.5 m/s rocking, and on the water spreads and lies flat while its lines sink; slack lines are smooth shallow curves. | `chutes/mains-full-backlit.png`, `mains-reef1-backlit.png`, `splash/cut-away-1s.png`, `cut-away-6s.png` | Full canopies at the bar. Reefed ones are still ribbed bulbs; a drifting canopy with its hanging lines still reads as a jellyfish for the seconds it is in the air. No contact between canopies. |
| Canopy shadows on the sea near black (P18, A16) | The lab's sea is a Lambert sheet. | Nothing in vfx. | `splash/before.png` | Not a vfx matter in the lab; on the real ocean not checked. |
| Lunar dust painted on the ground, razor horizon, dashes in the sky (P12, A13, A19) | A sheet that thinned as 1 / r and ended 160 m out: nothing along a level line of sight. | 3: thins as r^-0.7, reaches 320 m, translucent from above (depth 1.4 at the foot): the horizon is veiled below about 10 m, the ground and the lander's shadow show through; grains slower, lower, fainter. | `lunar/5m-day-close.png`, `10m-day.png`, `30m-day.png` | Better; on the lab's flat pale ground it is a haze with faint streaks. In the integration lab (real lander and terrain, 8 m hover, a low sun ahead of the camera: `dev/i4-lunar-hover.png`) the sheet and the sun's glare washed the frame out; the sheet's forward scattering was halved after that picture and not looked at again there. |
| Trails: ruler line at night, stick in haze (P14, A10) | One glow term. | 2: hot head and faint train, colour by age, narrower. | `reentry/trail-50km-night.png` | Fixed for the reentry trail (a clipped head on a line that thins and reddens). The ascent trail in synthetic haze was not touched. |
| RCS barely shows (P15, A14) | A faint near field. | 2: thruster light with a radius. 3: brighter, longer core (`plume.rcs.core`). | `rcs/all-sun-12m.png`, `all-shadow-12m.png` | Visible flashes at the ports in sun and shadow; soft glows rather than cones. |
| Exposure follows the pad cloud; deterministic and live differ (A3); splash step 0.415 EV (P19) | The meter. | Requests vfx-7 and vfx-8 (9.4). | `exposure.spec.ts` | See 9.3. |
| Grain of the half-resolution volumes (A4, P17) | One jitter per pixel, no spatial filter. | 2: a depth-aware denoise pass before the composite. | `plumes-close/booster-45m.png` against `booster-45m-live.png` | Much reduced; the translucent core at the nozzles is still mottled. |
| Surfaces near a flame lit as by a point (A5) | Zero-radius lights. | 2: `LocalLight.radius` on every plume, thruster and reentry light (vfx-5). | `plumes-close/booster-45m-night.png`, `lunar/30m-night.png` | Fixed for the bells and the hull; the lander's legs at night still clip. |

### 9.3 Measured

Final full run of the round (`tests/browser/vfx`, functional and perf projects in one gate slot, 51 tests, 15.0
min, 2026-11-12 00:06; one GPU slot on the machine, so nothing else used the GPU): 47 passed, 4 failed (two
exposure tests, two perf scenarios). What became of each is below: after the short run with the final code the
suite stands at one failure, the first window of the vacuum burn (0.616 ms against 0.6). All pictures under
`out/screens/vfx/` are from this run (the sheets of the solid motors, the lunar scenes, staging, the close-ups
and the vacuum ignition from the short run after it, with the final code: 15 tests, 14 passed, 00:34; the RCS
sheet once more at 00:51, since the tighter bound of smoky jets in vacuum also holds the thruster puffs).

| What | Result | Spec |
|---|---|---|
| Flame luminance on the jet axis (engines on minus off), 12 m / 30 m below the nozzles | by day, pad camera: 3.07 / (0.02) million cd/m^2 at T+2 s, 2.73 / 1.68 at T+4, 2.56 / 0.99 at T+6, 2.60 / 0.94 at T+8; chase camera 2.80, 2.49, 2.43, 2.39 at 12 m; at night the same within 5 %. Asserted above 240,000 (30 m from T+4 s) | `liftoff.spec.ts` |
| Half-angle and cell spacing against the formulas | -7.65 deg vs -8.00, -0.62 vs -0.65, 13.05 vs 13.20; 5.214 m vs 5.213, 8.187 vs 8.187, 18.635 vs 18.634 (unchanged) | `plumes.spec.ts` |
| Luminance monotonic with throttle; light proportional to thrust | 0, 513k, 759k, 1061k, 1418k, 1838k, 2370k (pre-exposed sum); 7.5653 cd/N at every throttle | `plumes.spec.ts` |
| HDR ceiling at EV -3, nine plumes | max 60,000, 0 NaN, in the HDR target and resolved | `plumes.spec.ts` |
| Particles deterministic | staging, 170 frames: 517 alive (456 ice, 26 gas, 35 sparks), hash equal over two runs, different after 171; lunar, 200 frames: 1,129 dust grains, the same | `effects.spec.ts` |
| Canopy area follows inflation | 0.184, 0.393, 0.597, 0.797 at 0.2, 0.4, 0.6, 0.8 | `effects.spec.ts` |
| Temporal stability, static camera | mean 0.369 (engine) and 0.380 (pad) of 255; 99.99 % within 7; maxima 16 and 29 | `effects.spec.ts` |
| Default atmosphere inputs bit-exact; overcast deck; haze | identical hash; plume above the deck 4.17 -> 0.069, below 24.2 -> 20.3; trail chroma 0.712 / 0.232 / 0.055 against the haze's 0.692 / 0.231 / 0.077 | `atmosphere.spec.ts` |
| Exposure by day, pad camera, engines on / off | EV 15.02 / 14.58, sky 0.45 EV (asserted under 0.5) | `exposure.spec.ts` |
| Exposure through the splash | sky within 2.8 % from just before the impact to +2.5 s (2.156 before, 2.216 / 2.198 / 2.157 / 2.173 / 2.187 after): the step at the impact that failed in round 1 (0.415 EV) is gone since vfx-7 | `exposure.spec.ts` |
| Night pad, T+10 s | EV 13.52; ground 1,143 / 286 / 103 cd/m^2 at 100 / 200 / 300 m, shown at 0.081 / 0.020 / 0.007 of white (asserted above 300 / 100 / 40 and 0.006: the 300 m figure has little room, the price of exposing for the cloud) | `exposure.spec.ts` |
| Exposure by day through the lift-off, chase camera (new test) | Full run: EV 15.58, 15.58, 15.52 at T+0, 3, 6 s and 15.01 at T+10 s, 0.57 EV: failed (asserted under 0.5). Request vfx-8; the core's first change (`6a2fb76`) did not move it, its second (`81d7b95`, the highlight term under the sun) did: short run EV 15.40, 15.51, 15.45, 15.01, sky 0.0716 / 0.0662 / 0.0685 / 0.0922 = 0.48 EV between the extremes: passes, with no room | `exposure.spec.ts` |
| Fireball by day (failed in the full run; the test was then corrected) | sky 0.1464 before, 0.1774 / 0.1772 / 0.1764 / 0.1767 / 0.1775 from the flash to the smoke: the fireball frames agree within 0.6 %; the frame BEFORE is 0.28 EV darker because it holds the sunlit vehicle, which is the evidence the lower daylight bound of vfx-7 needs, and the explosion removes it. The test now compares the fire with the same scene after it (5 %) and asserts that no frame is darker than the one before; passed in the short run | `exposure.spec.ts` |

**GPU time at 1440p internal** (`vfx.perf.spec.ts`, attribution mode, governor off, ballast 7 ms; the machine's
one GPU slot, nothing else on the GPU: the first measurement of this package without other agents' jobs):

| Scenario | Budget (ms) | Mean | p99 of the four windows | Steady passes of the last window (mean) |
|---|---|---|---|---|
| Lift-off, pad camera (nine plumes, pad smoke, ice, trail) | 1.3 | 0.538 | 0.826, 0.771, 0.754, 0.899 | smoke.march 0.21, volumes 0.17, smoke.sim 0.10, transparent 0.05, combine 0.03, denoise 0.01 |
| Lift-off, chase camera at 150 m | 1.3 | 0.792 | 0.886, 0.992, 1.044, 1.268 | smoke.march 0.42, volumes 0.37, smoke.sim 0.09, transparent 0.05, combine 0.03, denoise 0.01 |
| Lift-off, inside the cloud | 1.3 | 0.701 | 0.861, 1.062, 1.138, 0.966 | volumes 0.34, smoke.march 0.08, smoke.sim 0.07, transparent 0.05, combine 0.03 |
| Ascent | 1.0 | 0.196 | 0.412, 0.404, 0.425, 0.208 | volumes 0.15, transparent 0.04, denoise 0.01 |
| Vacuum burn (six engines, ullage motors) | 0.6 | 0.367 | **0.616**, 0.522, 0.268, 0.268 | volumes 0.22, transparent 0.04, denoise 0.01 |
| Lunar descent with dust | 0.9 | 0.450 | 0.649, 0.759, 0.746, 0.749 | volumes 0.34, particles.sim 0.07 (p99 0.36), transparent 0.04 |
| Reentry | 1.2 | 0.466 | 0.752, 0.746, 0.750, 0.746 | volumes 0.35, particles.sim 0.07, transparent 0.04 |
| Chutes and splash | 0.9 | 0.140 | 0.359, 0.490, 0.440, 0.105 | transparent 0.04, volumes 0.04, gbuffer 0.01 |

Bold = over the budget (the table is the short run with the final code; the full run before it read the same
within 0.1 ms except as said below). **Seven of eight scenarios hold their line in every window**; in rounds
0 and 1 none did in every run, with other agents' GPU jobs beside them. Still over:

- **Vacuum burn**: the first window, in which the ullage motors still burn, reads 0.616 ms against 0.6 (0.57
  in round 1). In the full run the first two windows read 0.613 and 0.715: smoky jets in vacuum were bounded
  by the boundary of a column that nothing holds (a box three times as wide as the fan); bounding them by the
  fan (`plumeModel.ts`) brought the second window to 0.52 and the steady burn from 0.28 to 0.27, not the
  first under the line. What is left is four small motors each marched over a fan 400 exit radii long;
  shortening that reach (`FAR_REACH_RE`) changes every vacuum picture and was not done without looking.
- The chase lift-off has the least room (worst window 1.27 of 1.3; mean 0.79).
- Lunar descent read 0.911 in one window of the full run (a 0.50 ms spike on the particle simulation over
  steady passes of 0.48); with the sheet at 12 stretches (was 14) the short run reads 0.76 at most.

### 9.4 Requests

- `vfx-5` (source radius on `LocalLight`): resolved by core-support; used by every plume, thruster, ground and
  reentry light since `1665ac9`.
- `vfx-7` (a lower bound on the daylight exposure): resolved by core-support (`3e95313`).
- `vfx-8` (new in this round; by day the plume-lit pad held the meter on the upper sunlit bound through a
  lift-off, 0.57 EV between T+6 s and T+10 s from the chase camera): answered by core-support twice.
  `6a2fb76` (what is brighter than the sun can light anything moves a daylight exposure by a quarter of a stop
  at most) left the sequence where it was; I re-opened the request with the re-measurement; `81d7b95` (the
  highlight term under the sun) brings it to 0.48 EV and the new test passes, without room. Resolved.
- `cockpit-9` (the plasma from a camera inside the vessel): resolved in round 1 (`c3568bf`), unchanged.
- `cockpit-13` / `NOTICE-core-1` (publish the window radiance): done. `PlasmaRenderer` publishes
  `'vfx.plasmaWindow'` (16-byte uniform: rgb = colour of the gas x `plasmaWindowRadiance(...)` of the active
  vessel in cd/m^2, a = its plasmaIntensity; zero without a sheath) and writes it in `prepare` when it changes.
  With the base flow of this round the value is 280 / 1,536 / 6,875 cd/m^2 at plasmaIntensity 0.3 / 0.6 / 1.0
  (7.6 km/s, the lab's heat flux): the cabin light of the cockpit follows it. Not looked at from the cabin in
  this round.
- `vfx-cs-1` (core-support, routing flight-ui-4: single ablation sparks drawn as dull orange lines in the sky
  far from the capsule): resolved in this round, see the request. Three causes, all removed: the streak of a
  particle was computed against the real frame time (9.1); a spark against the still air is stopped at once at
  hypersonic speed and left kilometres behind the capsule (ablation sparks are now sheltered from 97 % of
  that drag, `EmitterDesc.shelter`, fly at 10 to 60 m/s and live 0.15 to 0.5 s: a few capsule diameters); and
  a spark's streak is never longer than 40 radii plus half a metre.
- The other notices of `NOTICE-core-1` and `-2`: the vfx light loop (`vfxLocalLights`, `common.ts`) honours
  `LocalLight.radius` (its own code, not the core's `localLightSample`; a spot is a point of its axial
  intensity there, and no vfx light is a spot); `sampleSunShadow` callers need no change; nothing to do for the
  per-channel aerial transmittance.

### 9.5 Not fixed, and why

- **Reentry from the front and from straight behind** are short of the bar (9.2). A face-on shock layer that
  is not one clipped ellipse needs structure at a scale the half-resolution march does not hold at 18 m, and
  from behind the rim of the layer is physically the brightest thing in the frame; I ran out of rounds.
- **Splash crown and ring waves**: the crown is a soft mass; ring waves and a change of the water at the
  entry point belong to the ocean package and were not requested (the foam decal and the aerated patch are
  what the brief asks of this package).
- **Pad cloud softness, size, the view from inside it**: the march runs at a quarter of the resolution; a
  sharper cloud is a budget question (the chase lift-off has the least room). Flow and yields were left alone.
- **Solid-motor smoke** is firmer at its edge but still evenly lit along its length; **reefed mains** are
  ribbed bulbs; **a drifting canopy** in the air with its lines hanging reads as a jellyfish; no contact
  between canopies of a cluster.
- **The lander's plume and legs at night** (photo 12, artifact 19), **the dark bar on a fragment trail**
  (artifact 22), **the ascent trail in synthetic haze** (artifact 10), **the horizon "seam"** of a faint
  plume over ground and sky (photo 6): not worked on.
- **Not looked at in the game**: everything after the first stage separation (the pilot needs 45 minutes for
  the mission; the pictures of this round are lift-off to staging: `dev/a4-*.png`). Reentry, canopies and the
  lunar hover were looked at in the integration lab with the FakeSim (`dev/i4-reentry.png`, `i4-chutes.png`,
  `i4-lunar-hover.png`: the last one is not good, see the dust row of 9.2); the splash and the cut-away
  canopies on the real ocean were not.

### 9.6 What changed in code, data and specs (for the next owner)

- `common.ts`: `VfxGlobals.domVel` (was `reserved0`): velocity of the effect domain's origin relative to the
  eye, ROOT axes, metres per SIMULATED second; `feature.ts` measures it from the two frames' origins over
  `snap.ut - prevSnapshot.ut`, holds it while the clock stands still, and before the first step assumes a
  camera that travels with the focus vessel. `particles.ts` uses it for the streak.
- `particles.ts`: flakes (`KIND_ICE`, `KIND_CHIP`: lobed Gaussian outline, tumbling, glints 12 x the sun's
  illuminance on a facet), sparks as tapered streaks no longer than 40 radii + 0.5 m, drops streaked 3.5 x
  their shutter path; `EmitterDesc.shelter` (0..1, stored in `Particle.aux.w`): share of the still air's drag
  a particle is spared.
- `plumes.ts` / `plumeModel.ts`: the flame begins between 3 and 12 exit radii and has an edge (0.66 to 1.1 of
  its radius); dense smoke (`smoke.extinction` towards 3 and more) ends within 30 % of the mixing layer;
  `oxygen = sqrt(p / p0) x smoothstep(1.5 kPa, 9 kPa, p)`.
- `smoke.ts`: `SmokeSystem.hint` (the plume-lit cloud for the meter, sent by `feature.ts` when the sun does
  not light the scene: luminance of steam 50 m from the flame, uncapped); the cloud's multiple-scattering
  floor is `0.25 g^0.55` of the direct plume light.
- `plasma.ts`: the hint of the shock layer is uncapped and sits two stops over the meter's white (so the
  stagnation region, at twice the reported luminance, clips by three); `BASE_GLOW` (0.05 per shoulder radius
  at intensity 1, with its square) inside the converging sheath, counted in `plasmaWindowRadiance`;
  `'vfx.plasmaWindow'` published.
- `chutes.ts` / `canopyModel.ts`: scallops 1.2 to 2.4 %, pleats `0.2 x slack` with `slack = 1 - 0.94
  smoothstep(0.02, 0.6, inflation)`; slots `slotFraction x (1 - 5/6 smoothstep(0.2, 0.55, ring position))`;
  a cut canopy: inflation falls to 0.3 of what it was (not to a tube), sinks at `cutDrift.sinkSpeed`, tips by
  at most 37 degrees, and once down spreads to 0.7 of its inflation with its axis scaled to 7 % over 2.5 s
  (`Drifting.downAt`), its lines fading with it; slack lines are 8-segment curves; `MAX_LINES` 2048.
- `dust.ts`: sheet amount `(r0 / r)^0.7`. `trail.ts`: fragment glow 0.03 s. `fireball.ts`: unchanged in this
  half of the round (second owner: temperature contrast, soot from the start).
- Data (`plumes.json`): booster `diamonds.gain` 32, `shear.luminance` 160,000, `afterburn.luminance`
  2,800,000, `light.efficacy` 12; hydrolox `ignition` flash 3.5, pale, reach 24; `plume.rcs.core` luminance
  400,000, `vacuumLengthRe` 18, `vacuumGain` 0.22, `vacuumCoreRe` 6; `padSmoke.groundShadow` 0.6;
  `particles.dust` rate 2000, speed 30 to 500, elevation 0.4 to 4 degrees, life 0.3 to 1, opacity 0.12,
  `sheetDepth` 1.4, `sheetMinReach` 320, `sheetReachRadii` 80; `particles.ice.size` 0.012 to 0.18;
  `particles.spray` count 1800, size 0.004 to 0.09; `particles.ablation` rate 450, speed 10 to 60, life 0.15
  to 0.5; `reentry.trail.radiusScale` 0.25; `explosion.secondaries` 0; `parachutes.drogue.slotFraction`
  0.12; `parachutes.cutDrift` fade 40 s, collapse 0.9 s, sink 6.5 m/s.
- Specs: `appshots.spec.ts` (new; skipped unless `VFX_APP_SHOTS` is set); `exposure.spec.ts`: new test for the
  chase camera through the lift-off by day (within half a stop: it needed vfx-8), the fireball test takes its
  reference after 240 settled frames like the splash test (after 60 the meter was still on its way from the
  page's first frame: the 21 % "step" was that); `liftoff.spec.ts` asserts 240,000 cd/m^2 in the flame (was
  30,000); `effects.spec.ts` hashes the staging particles after 170 frames, while the sheet of gas is still
  alive (after 200 only 473 particles were, under the test's own bound of 500); unit test for the canopy slots.

### 9.7 My own score

Photo lens **6.5 / 10**, artifact lens **6.5 / 10**: short of the bar of 8, no blocker left that I can see.
What a critic will find first: the reentry from the front (a clipped ellipse) and from straight behind (a
bright rim round a mauve disc); the splash crown (a soft mass) and the missing ring waves; the pad cloud (soft at
a quarter of the resolution, flat from inside); the solid-motor smoke (soft, evenly lit); reefed mains (ribbed
bulbs) and a drifting canopy with its hanging lines; RCS flashes as soft glows; the lunar sheet as a haze on the
lab's flat ground. What should no longer be raised: no flame at lift-off, the flame that does not clip, the
streaks across the frame and the line ahead of the capsule, white rectangles, quilted canopies, the cream cloud
and the black hull of a night launch, the white ball of a night entry, detached plume copies, the glitter and
the rods of the explosion, the dust painted on the ground.

## 10. Visual close-out, round 3

Work list of the round: `docs/qa/wave2/vfx.r2.combined.json` (photo 5.5 / 10, artifact 6 / 10; 3 blockers, 13
majors, 6 minors). Same owner as section 9. Where this section disagrees with sections 0 to 9, it is right.
Pictures: the sheets under `out/screens/vfx/` (matrix), `out/screens/vfx/dev/a8-*.png` (the real game, flown by
the test pilot), `out/screens/vfx/dev/i8-*.png` (integration lab), `out/screens/vfx/lunar-probe/`,
`out/screens/vfx/liftoff-probe/horizon-*.png`.

### 10.1 The three blockers

**Pad cloud cut along the horizon (finding 3).** Cause found, not one of the three candidates as such: the
quarter-resolution march of the cloud keeps the scene depth of every ray (to mix the rays of a pixel only with
rays that ended on the same surface), and so did the combine, the denoise filter and the composite. Next to
the horizon the depth of the ground behind the cloud doubles from one row of pixels to the next and the sky
above it has none, so the rows of rays there were never mixed with each other: where the top of the cloud lay
at eye level (it does in `liftoff/t10-*`, by coincidence of the lab camera's height) it was drawn in level
steps four pixels high, the sharpest of them on the row where the ground ends. Diagnosis by the critic's test
(`out/screens/vfx/dev/d1..d5-cut-*.png`): the edge follows the horizon row when the camera is lowered, stays
without the atmosphere, and the flame is untouched by it. Fix: scene depths behind what a volume shows are one
background to it. In `smoke.ts` the march and the combine clamp every depth to the far end of the cloud's
cylinder (`SmokeU.misc.z`); in `volumes.ts` the composite has its own depth-aware upsample (`volumeUpsample`)
and the denoise filter its own depth weights, both with depths clamped to 1.5 times the distance of what the
image shows at that pixel (the image's moment); the smoke behind a flame now has a distance in that moment
too (without it the edge stayed beside the flame, found in the second run). New spec in `liftoff.spec.ts`,
"the pad cloud has no level edge along the horizon": at night, from the camera of the finding (yaw 152) and
from 26 m lower, no row of the picture holds 24 or more columns with a one-pixel level edge, nor a run of 12
(before: 67 columns / run 25 at eye level, 41 / 7 from below; after: 10 columns / run 4 at eye level, 18 / 6 from below).

**Lunar dust (finding 2).** Two different things. (a) The haze above the horizon in the vfx lab was the dust
sheet's exponential height profile (an endless tail). The sheet now has a top: nothing above the cone of the
steepest grain (`dust.elevationDeg[1]`, 4 degrees), a profile 3 (1 - h / H)^2 / H integrated in closed form
over each stretch of the ray, a column that falls as 1 / r^1.5 and faster than 1 / r^3 beyond ten radii of
the scoured spot, a cap of one half on the veil along any line of sight, and it is lit as what it is: single
scattering by dark grains (albedo 0.36 -> x phase / 4 pi; it was lit like a white Lambert surface without the
cosine, six times brighter than the ground under a low sun). `out/screens/vfx/lunar.png`: black sky down to
the horizon in every tile, the ground and its shadows seen through radial streaks. (b) The "full grey-out in
the integration-lab hover" is not dust: it is there with the engine off. The lab's lunar scene lay in the
dark at its epoch (terrain under 0.5 cd/m^2, the meter at EV100 -0.58: a night exposure that looks like a
grey day), a camera that looked towards the sun below that horizon was washed out by the lens flare of the
hidden sun (`dev/i6-lunar-off-a.png`: all white, engine off), and with the engine on the lander's own plume
light decided the exposure (EV100 +2.5: the terrain went black, `dev/i6-lunar-on-b.png`). Request `vfx-10`
(resolved within the round: the scene has a morning sun by default; the flare of a hidden sun went on to the
sky package as `core-3`). On the vfx side the light a plume casts now follows what the plume emits: a
`light.vacuum` share per look (0.12 for the lander's engine: its jet is all but invisible on the Moon and
must not light the legs like neon tubes), and the thrusters' light is 20 cd/N, not 140. New spec
`tests/browser/vfx/lunar.spec.ts` (integration lab, real terrain and lander, pinned low sun, engine on against
engine off): with the engine on the sky 5 to 10 degrees above the horizon is at 0.04 % of white (0.05 % with it off; bound 2 %), 2,064 of 2,358 blocks of ground keep at least half of their local contrast (88 %; bound 50 %), the ground is 4 % brighter on average and the meter does not move (EV100 12.64 on and off; terrain 2,060 / 2,036 cd/m^2, the ground under the lander 1,617 / 934). `lunar-probe/hover-engine-on.png`, `dev/i8-lunar-on-upsun.png` (against the sun: the sheet shines in radial streaks, the ground shows through).

**Splash (finding 1).** The crown's sheet of water is drawn at full resolution in the transparent pass
(`SHEET_WGSL` in `splash.ts`): a surface with a thickness, followed along the view ray in 36 steps of the
signed distance to its middle, the water crossed in each step being the closed-form integral of the sheet's
bell profile (erf), so there is no march noise to filter and no half-resolution blur; rim, tears and ligaments
are thresholds on noise at the resolution of the screen, lit by which face the eye sees. The half-resolution
volume keeps only the fine spray, which is gone within 1.1 flight times of the rim (`MIST_LIFE`, was 3): no
puffs hanging at +5 s. Spray drops are smaller (4 to 50 mm), clear water rather than white paint (a third of
the sunlit white, with glints), the long-lived mist sprites are a tenth of what they were and live under a
second. `out/screens/vfx/splash/close-0.4s.png`, `impact-0.4s.png`, `impact-1s.png`, `impact-1.8s.png`: a
crown of sheets and ligaments that has collapsed by +1.8 s, then the foam patch. What must move the water
itself is the ocean package's: request `vfx-9` (ring waves, cavity and rebound, a foam patch in the ocean's
own foam at the `'splash'` event, with the numbers; vfx's side is built: `splash.foamDecal` in `plumes.json`
switches the vfx foam decal off once the ocean draws the foam). Open at the end of the round: the sea still
does not move.

### 10.2 The other findings

| Finding | What was done | Where to look |
|---|---|---|
| 4 Reentry (airbrushed lobe, white ellipse, ring) | The layer glows from the bow shock inwards: nothing in front of the shock (a clean outer edge the standoff from the wall, standoff 0.045 nose radii), brightest right behind it; it wraps the windward face as a crescent from shoulder to shoulder; turbulence drawn out six to one along the flow; white-hot at the stagnation point, the gas colour over the face, towards orange round the shoulder; held one stop over the meter's white (was three: everything clipped); wake glow 0.12 of the layer (was 0.05) with stronger fine streaks | `reentry-views.png`, `reentry.png`, `dev/i8-reentry*.png` |
| 5, 15 Pad cloud in the game | The exhaust leaves the trench both ways (double wedge) as two collimated, low, fast sheets that lift off and billow only beyond the exits (`away` in `smokeVelocity`): the space round the vehicle is clear and the flame is seen from the default chase camera, which looks along the trench; sources at the exits (`trenchLength` 78 m, the site's); the trench keeps the jet while the vehicle is low (focus fades over 150 m of nozzle height, was 40); the gas a jet draws in dries out what rises beside its column (the space round the hull stays clear); sunlit steam as bright as a white surface in the sun with a floor of scattered light (no brown folds); thin gas keeps no hard lumps (the detached arcs and puffs); the outline is sharpened at half resolution in the combine (the ramp of eight pixels between rays steepened to about three about a noise threshold that rides with the cloud); gas between the eye and the flame glows more; marched in 30 steps (was 42). The game's default chase view stood on the trench axis, where the fan-shaped front of the far jet was an arch of cloud behind the vehicle at T+5 to T+8 s; request `vfx-11` was resolved within the round (the default view now stands 70 degrees off the trench) and the `a8` pictures of the last run are from it: two banks of steam to the left and right, the vehicle and its flame clear between them | `dev/a8-liftoff-*.png` (game: default camera at T+1, +3, +6; from the side at +6, +10), `liftoff.png`, `liftoff-chase.png` |
| 6 Booster flame a white stick | Brightest in its first third, falling by most of a stop towards a ragged tip (large eddies move it by a quarter of its length, no detached islands), narrower eddies at its edge | `engine-atlas-9m.png`, `dev/a8-liftoff-t6.png` |
| 7 Cut-away canopies as jellyfish | Collapse to 8 % of the inflation within 0.6 s, keel over at 0.6 rad/s, sink at 9 m/s, lines trail above the cloth | `splash/cut-away-1s.png`, `cut-away-6s.png` |
| 8 Mains: no light through the cloth | Cavity light through the cloth raised by a half (outside face) and a third (inside face against the sun). Reefed shape and cluster spacing unchanged (see 10.5) | `chutes.png`, `dev/i8-chutes.png` |
| 9, 10 Solid motors: cream, even; grain in the fans | Smoke albedo 0.96 (was 0.9), glow confined to 26 exit radii (was 60); in a free expansion no turbulence and striation 0.04 (was 0.3): the fans at 30 km, 60 km and in vacuum are smooth | `engine-solids.png` |
| 11 Point-lit surfaces | Plume lights follow what the plume emits (`light.vacuum`), solid motors 10 cd/N (was 22), thrusters 20 (was 140), the line of light starts 9 exit radii down (was 6) with 2.5 % of the intensity in its first stretch (was 4 %) | `engine-solids.png` (capsule base), `lunar.png` (night tiles), `rcs.png` |
| 12 RCS as blobs | Cone of 30 degrees (was 40), core a third as bright and 3 exit radii long, more of the light in the fan | `rcs.png` |
| 13 Explosion fire weak | Peak luminance 3.5 million cd/m^2 (was 1.2), fragments with four times the drag (curved trails) | `explosion.png` |
| 16 Splash drops as sprites | See 10.1 | `splash/close-*.png` |
| 20 Inside the cloud a flat fill | For an eye inside the cloud the scattered light comes from above and from the sun's side (the gas towards the ground less than half as bright) and the flame's glow is a forward lobe; still no shapes in it | `liftoff-chase/inside-cloud-t6-*.png` |

### 10.3 Measured

Runs of the round (all through the one GPU slot; waits of 19, 57, 78, 98, 78 minutes and more): `out/vfx-r3/run1.log` .. `run6.log`. The first whole run that was green but for one test: `tests/browser/vfx`, functional and perf projects, 56 tests, 17.5 min, 2026-11-12 05:17: 55 passed, 1 failed (the sheet of the chase-camera lift-off: its tile from inside the cloud by day was one flat colour, 3 colour buckets where the sheet asks for more than 6; fixed after the run, see the note under the tables).
The functional rows of the table are from that run; the GPU times are from the last run of the round (see the note under the tables).

| What | Result | Spec |
|---|---|---|
| Flame luminance on the jet axis (engines on minus off), 12 m / 30 m below the nozzles | by day, pad camera: 2.38 / (0.01) million cd/m^2 at T+2 s, 2.56 / 0.47 at T+4, 2.41 / 0.78 at T+6, 2.55 / 0.80 at T+8; chase camera 1.83 to 1.97 / 0.50 to 0.78; at night the same within 3 % (bound 0.24 million; at T+2 the point 30 m down is in the mount) | `liftoff.spec.ts` |
| Pad cloud, level edge along the horizon | 10 columns (run 4) at eye level, 18 (run 6) from 26 m lower; bounds 24 and 12; before the fix 67 (25) and 41 (7) | `liftoff.spec.ts` |
| Lunar hover, integration lab | sky 0.04 % of white (bound 2 %), 88 % of the ground blocks keep half of their contrast (bound 50 %) | `lunar.spec.ts` |
| Exposure by day: pad, nine engines lit | EV100 15.02 on, 14.58 off (0.45 EV; bound 0.5) | `exposure.spec.ts` |
| Exposure by day: chase camera, T+0 to T+10 s | EV100 15.39, 15.49, 15.47, 15.02 (0.47 EV; bound 0.5) | `exposure.spec.ts` |
| Sky through the splash and beside a fireball | within 3 % (bound 5 %) | `exposure.spec.ts` |
| Night pad, T+10 s | EV100 13.52; ground 739 / 283 / 456 cd/m^2 at 100 / 200 / 300 m (the jets of the trench light the ground beside them now) | `exposure.spec.ts` |
| Half-angle and cell spacing against the formulas | unchanged: -7.65 deg vs -8.00, -0.62 vs -0.65, 13.05 vs 13.20; 5.214 m vs 5.213, 8.187 vs 8.187, 18.635 vs 18.634 | `plumes.spec.ts` |
| Light proportional to thrust; HDR ceiling at EV -3 | 7.5653 cd/N at every throttle; max 60,000, 0 NaN | `plumes.spec.ts` |
| Particles deterministic; canopy area follows inflation | staging 517 alive, lunar 1,129, hashes equal over two runs; 0.184, 0.393, 0.597, 0.797 | `effects.spec.ts` |
| Half-resolution volumes stable under a static camera | engine: 99.99 % of the channels within 6 / 255; pad: within 8 / 255 | `effects.spec.ts` |

GPU time at 2560 x 1440 (`vfx.perf.spec.ts`; p99 of each of the four windows, ms):

| Scenario | Budget | Mean | p99 of the four windows |
|---|---|---|---|
| Lift-off, worst case (pad camera) | 1.3 | 0.622 | 0.877, 0.894, 0.925, 0.848 |
| Lift-off, chase camera at 150 m | 1.3 | 0.833 | 1.153, 0.989, 1.075, 1.235 |
| Lift-off from inside the cloud | 1.3 | 0.723 | 0.889, 1.083, 1.262, 0.891 |
| Ascent | 1.0 | 0.198 | 0.206, 0.211, 0.213, 0.212 |
| Vacuum burn | 0.6 | 0.290 | 0.380, 0.344, 0.265, 0.268 |
| Lunar descent with dust | 0.9 | 0.266 | 0.491, 0.562, 0.569, 0.563 |
| Reentry | 1.2 | 0.443 | 0.633, 0.741, 0.631, 0.977 |
| Chutes and splash | 0.9 | 0.098 | 0.366, 0.375, 0.036, 0.034 |

The vacuum burn's first window, the one line over budget at the end of round 2 (0.616), is at 0.377: smoky jets in
vacuum are followed 160 exit radii instead of 400. The crown's sheet at full resolution costs under 0.38 ms in the
windows that hold the splash.

After that run (commit `5d0ea70`): the light scattered about inside the cloud comes from above and from the
sun's side for an eye inside it, and the gas a jet draws in dries out what rises beside the jet column. The
whole suite again at 07:15 (56 tests, 16.7 min): 53 passed, 3 failed.

- The sheet of the chase-camera lift-off again: the tile from inside the cloud by day still had 3 colour
  buckets. The fill was clipped: inside sunlit steam the gas was as bright as the cloud's outside. Since
  `0e36eb6` an eye inside the cloud sees graded fog (less than half as bright towards the ground as overhead,
  none of it over white).
- `atmosphere.spec.ts`, "behind a synthetic overcast deck ...": 0.38316 against a bound of 0.38308 (5 % of the
  clear reading). The probe sat 40 m below the nozzles, which since this round's flame (narrower, dimmer
  towards the tip) is its ragged end above the deck: the clear reading there was 4.7, 18.6 and 7.7 in three
  runs. The probe now sits 25 m down, in the body of the flame, as its comment always said.
- Perf, chase camera: p99 1.335 ms in one of the four windows (1.060, 1.151, 1.177, 1.335; budget 1.3; the
  05:17 run had 1.235 as its worst). The two jets cover more of that frame than the old cloud did. The pad
  cloud is marched in 34 steps now (`padSmoke.steps`, was 42).

The tests these changes touch and the perf spec again at 08:52 (19 tests: 18 passed) and, after one more change (`839845c`: the flame's glow seen from inside the cloud as a forward lobe, the cloud marched in 30 steps), at 10:40 (19 tests, 6.0 min: 18 passed, 1 failed). The GPU times of the table above are from this last run, with the final code: every window of every scenario is inside its budget. What still fails: the sheet of the chase-camera lift-off, on its tile from inside the cloud by day (see 10.5). The functional tests that the commits after 07:15 do not touch were last run at 07:15 and passed there.

### 10.4 Requests

- `vfx-9` (filed, open): ocean, ring waves and a foam patch at a splash. The interface is in the request; vfx's
  side is the switch `splash.foamDecal`.
- `vfx-10` (filed, resolved in part within the round): the integration lab's lunar scene has a morning sun by
  default; the lens flare of a sun the terrain hides was passed on to the sky package as `core-3`.
- `cockpit-13` (vfx part): what the published `'vfx.plasmaWindow'` values mean (cd/m^2, not pre-exposed,
  radiance of the pane as a light source, a = plasma intensity and "there is a sheath" flag, how it scales),
  and the values after this round's wake change: 317 / 1,664 / 7,288 cd/m^2 at intensity 0.3 / 0.6 / 1.0.
- `vfx-11` (filed, resolved within the round, `98b39b0` and `6f2bd6e`): camera, the default chase view at a pad
  stands 70 degrees off the axis of the flame trench.

### 10.5 Not fixed, and why

- The water at a splash does not move (ocean, `vfx-9`). Not checked on the real ocean either: a splash in the
  game needs the whole mission flown, which does not fit a slot of the one GPU gate this round (waits of 20 to
  57 minutes per run), and the integration lab's chute scene does not reach the water in the time tried.
- Reefed mains (finding 8: "gourds", a third canopy "in the mouth of another"): the reefed profile and the
  cluster geometry are as in round 2. The canopies do not intersect (centres 1.27 projected diameters apart);
  what the critic saw is the perspective of a cluster of three. A cloth simulation of the reefed stage is
  beyond this round.
- Solid-motor smoke is still lit without a shadow march of its own (finding 9: brighter and whiter, the glow
  confined, but one side of a trail is not darker than the other).
- Staging jets and the ignition puff (finding 14): only what the changes to the solid looks and to the lights
  do for them. Not looked at closely.
- Half-resolution volumes beside sharp geometry (finding 15): done for the pad cloud's outline only; flames
  and trails are as they were.
- The minors 17 (half-stop exposure step), 18 (lone puff in the lyra tiles), 19 (dark bar on a fragment
  trail), 21 (haze trail, hydrolox wake) and 22 (night halo, canopy polish): not touched.
- The crown's drops are still particles drawn over the sheet, not attenuated by it.
- The view from inside the pad cloud by day: one tan fill, and the sheet of the chase-camera lift-off fails on
  that tile (5 colour buckets, the sheet asks for more than 6; it passed before this round). The lab's camera
  for it stands on the trench axis 75 m north of the pad, which is inside a jet since this round. Three
  attempts (light from above for an eye inside the cloud, the flame's glow as a forward lobe, both dimmer) did
  not move the picture at all: the fill is not the term I took it for. Not found; the next thing to look at is
  whether `eyeIn` in the march is ever above zero there, and what else draws at that camera (trail, plume
  haze).
- A first guess at the arch in the game's old default view (a ring rolled up by the flow about the foot of the
  jet) was wrong: drying the gas beside the jet column did not touch it. It was the far jet seen end-on; the
  drying stays (it keeps the space round the hull clear) and the camera moved (`vfx-11`).

### 10.6 What changed in code, data and specs (for the next owner)

- `smoke.ts`: `padSmoke.steps` 30; the eye-inside-the-cloud terms (`eyeIn`, `fromLight`); drying beside the jet
  column in the advection; `SmokeU.misc.z` (view depth of the far end of the cloud; march and combine clamp scene depths to
  it); two-sided, collimated trench flow with `away` (low near the pad); sources at the exits; `hard` gated by
  the gas's own density; the combine tracks the smoke's own opacity and steepens its outline; the moment of
  the image counts the smoke behind the emitters; focus decay 150 m; forward scattering of the plume light.
- `volumes.ts`: `volumeUpsample` (the core's depth-aware upsample with a cap on depths) and capped depths in
  the denoise filter.
- `dust.ts`: bounded sheet, closed-form height integral, 1 / r^1.5 column, veil cap, single-scattering light.
- `splash.ts`: `CROWN_SHARED_WGSL`, `SHEET_WGSL` and its pipeline (drawn in `FoamRenderer.draw`, after the
  foam decals); the volume is mist only; `splash.foamDecal`.
- `plasma.ts`: layer profile, face law, streak anisotropy, colour by temperature, hint one stop over white;
  `plasmaWindowRadiance` follows (`wakeGain`, streamer mean 0.99).
- `plumes.ts` / `plumeModel.ts`: flame grading and tip; no turbulence in a free expansion; smoky jets in
  vacuum followed 160 exit radii (was 400).
- `feature.ts`: plume lights scaled by `look.light.vacuum` and the air; `LIGHT_START_RE` 9; first light
  stretch 2.5 %.
- `chutes.ts`: cut-away canopies (collapse, keel, lines above), more cavity light.
- `data.ts` / `plumes.json`: `light.vacuum` per look, `splash.foamDecal`, the values named above.
- `labs/vfx/scenes.ts`: the pad camera stands east-south-east of the pad (yaw 112, was 152): beside the
  trench, where both jets and the flame between them are seen (a camera on the trench axis stands in a jet).
- Specs: `liftoff.spec.ts` (level edge), `lunar.spec.ts` (new), `atmosphere.spec.ts` (the overcast probe 25 m
  below the nozzles, was 40).

### 10.7 My own score

Photo lens **6.5 / 10**, artifact lens **7 / 10**: still short of the bar of 8. Of the three blockers of the
round-2 critique two are gone as I see them (the level edge of the pad cloud, the lunar haze and grey-out);
the splash is half done: the crown is a crown now, the sea still does not move, and a critic who holds to
"the water never moves" will keep it a blocker until `vfx-9` is answered. What a critic will find first: the
static water and the drops drawn over the crown; the pad cloud's softness at a quarter of the resolution
away from its outline; the reentry from the front (a mottled, nearly white disc) and from
straight behind; the solid-motor smoke (white now, still lit without a shadow of its own); reefed mains;
staging jets; the lunar sheet seen down-sun (faint: it is as bright as the ground it veils); the view from
inside the pad cloud by day (one tan fill; its sheet's sanity check fails on that tile). What should no longer be raised: the ruler-straight edge along the
horizon, haze above the Moon's horizon and the grey-out of the hover, the blurred bowl and the puffs that hung
for five seconds, the airbrushed lobe of the entry, grey blobs round the hull at lift-off, grain in the
solid-motor fans at altitude, neon legs on the Moon, the vacuum burn over its budget.
