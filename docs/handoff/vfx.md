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

No open requests against vfx paths.
