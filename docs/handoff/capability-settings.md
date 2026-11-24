# capability-settings (wave 4.1): the capability gate, the calibration, feature-declared quality, the settings model

Status: built (2026-11-24); the full-quality gates of section 5 that wait for the look flip are in section 9.

## 1. What exists

| Piece | Where | What it does |
|---|---|---|
| Capability gate | `src/gate/*`, `index.html` | The ordered checks of ARCHITECTURE 24 into a `CapabilityReport` (structurally the contract's; reasons `mobile`, `noWebGpu`, `noAdapter`, `fallbackAdapter`, `missingFeature`, `lowLimits`, `deviceFailed`, `missingApi`); a static block page per reason with what to do, a copy-report control, Credits and the live player count from `/status.json` (`online`); non-blocking banners (small window, no Web Audio, a browser that is not Chrome/Edge). Runs BEFORE the main bundle: index.html's gate module loads `/src/app/main.ts` with a dynamic import only on a pass (in a build the app is a chunk only that import names). Hands `window.__fspGate = { report, warnings, safe, ms }` to the app. Imports nothing. |
| Gate plugin | `tools/server/gatePlugin.ts` | Bundles the gate (rolldown, Vite's own bundler) into one IIFE and inlines it in the page's head; the page's gate script then takes `startGate` from `window.__fspGateModule`. Not registered yet: request capability-settings-1 (the lead's vite.config.ts). |
| Adapter class | `src/core/gpu/device.ts` | `classifyAdapter(report)`: 'discrete' / 'integrated' / 'unknown' from vendor and architecture tables (the description only refines when the browser fills it); `GpuHandle.adapterClass`. `acquireGpu` keeps its hard failures (no WebGPU, no adapter, fallback adapter, missing features or limits) and no longer refuses an integrated GPU. |
| Quality in the render core | `src/render/core/quality.ts`, `renderer.ts` | `Renderer.setQuality(profile)`: live settings next frame, rebuild settings under a 1 s fade, no reload; pixel cap -> internal resolution cap per display; governor budget `0.66 x 1000 / targetFps`; `coreOf(ctx).quality` (params, onRebuild, settings, profile); the core's own settings `shadows` (rebuild) and `ambientOcclusion` (live). Measurement hooks `setPerfAttribution`, `setGovernor`, `onGpuFrame`. RENDER_API section 20. |
| Feature declarations | `src/render/{atmosphere,terrain,vfx}/quality.ts` | `clouds`, `atmosphere`, `terrain`, `effects`, each with four levels whose Ultra is the value the code used before (the ocean has none: section 6). |
| Calibration and settings | `src/bench/*` | The quality table, the cost model, the solver (frontend-ux 9.3), the calibration controller over a host page, the CPU score, the store per adapter fingerprint, the first minute (`startGraphics`), the settings screen's model (`GraphicsSettings`), the shots' needs and `residentFor`. |
| Data | `data/defs/render/quality.json`, `data/defs/scenarios/bench-pad-dawn.json`, `bench-leo-terminator.json` | Presets, class hints, solver numbers, the four shots, the attribution of passes to settings, the CPU reference, the needs. |
| Bench lab | `labs/bench` | The calibration host on the real renderer, every package and the real session; `?ballast=<iterations>` simulates a slower GPU. |

## 2. Public API

```ts
// src/gate (inline; imports nothing)
startGate(loadMain: () => Promise<unknown>): Promise<GateResult>
runGate(env: GateEnv): Promise<GateResult>            // GateResult { report: GateReport; missing: string[]; warnings: string[] }
window.__fspGate: { report: GateReport; warnings: string[]; safe: boolean; ms: number }

// src/core/gpu/device.ts
classifyAdapter(report: Pick<AdapterReport, 'vendor' | 'architecture' | 'description'>): AdapterClass
GpuHandle.adapterClass: AdapterClass                    // CapabilityReport['adapterClass']

// the render core (RENDER_API 20)
Renderer.setQuality(profile: QualityProfile): Promise<void>
coreOf(ctx).quality: CoreQuality                         // params(id, decl?), level(id), onRebuild(id, fn), profile(), settings()
CoreRenderer.setPerfAttribution(on: boolean): void
CoreRenderer.setGovernor(on: boolean): void
CoreRenderer.onGpuFrame(fn: ((f: GpuFrameRecord) => void) | null): void
CORE_QUALITY, QUALITY_LEVELS, renderScaleCap(pixelCapMp, w, h), governorBudgetMs(targetFps), paramsAt(setting, level)

// src/bench
parseQualityTable(json: unknown): QualityTable
presetProfile(table, name: PresetName, settingIds: readonly string[]): QualityProfile
seedPreset(table, adapterClass, safe: boolean): PresetName
startGraphics(input: GraphicsBootInput): GraphicsBoot   // { profile, preset, stored, calibrationDue, floorPrompt }
storeCalibration(input, result: CalibrationResult, wallMs: number): StoredGraphics
storeSkip(input, profile, preset): StoredGraphics
storeManual(input, base: StoredGraphics, profile, preset, predictedGpuMs): StoredGraphics
runCalibration(host: CalibrationHost, table, opts: CalibrationOptions): Promise<CalibrationResult>
progressLine(p: CalibrationProgress): string             // "shot 2 of 4 · lift-off · 14 s"
residentFor(needs: readonly ShotNeeds[], has: (path: string) => boolean): boolean
missingFor(needs, has): string[]
prefetchNeeds(needs, fetcher: (path) => Promise<boolean>, done: Set<string>, opts?): Promise<{ failed: string[] }>
solve(input: SolveInput): SolveResult
stepDown(input: SolveInput, profile, confirmShot: ShotMeasurement): QualityProfile | null
measureShot(...), predictShot(...), predictGroups(...), profilePixels(profile, displayPx)
cpuScoreOf(m: { frameP95Ms: number; simMs: number }, ref: CpuReference): number
new GraphicsSettings(table, settings, displayPx, profile, shots?, calibratedWallMs?)
  .model(): GraphicsModel   .contract(): SettingsModel['graphics']
  .setPreset(name) .setLevel(settingId, level) .setPixelCap(mp) .setTargetFps(fps)
readGraphics / writeGraphics / withFloorShare / wantsFloorPrompt   // localStorage['fsp.graphics.v1']
```

`CalibrationHost` (what the app implements; labs/bench is the reference implementation):
`settings()`, `displayPx()`, `resident()`, `runShot(shot, profile, { governor, settleS, measureS })` -> frames
(GPU passes per frame from `onGpuFrame`), main-thread frame times, internal pixels, device lost; `cpuProbe()`
-> ms of `cpuReference.simSteps` steps of a local session in the lift-off.

## 3. For the next packages

- **shell-menu**: the Settings screen renders `GraphicsSettings.model()` (preset, resolution with its caps,
  one row per declared setting with its levels, apply class and predicted ms, the estimated-GPU bar against
  the budget); a change calls `setLevel` / `setPreset` / `setPixelCap`, then `renderer.setQuality(profile)`
  and `storeManual`. 'rebuild' rows read "restarts view 1 s". The calibration's pre-flight check shows
  `progressLine(progress)`; "Calibration skipped · Run it in Settings" after `storeSkip`.
- **app-integration-1**: at boot read `window.__fspGate`, load the table (`/defs/render/quality.json`),
  `startGraphics(...)` and `setQuality(boot.profile)` before the title; stream `table.needs` behind the title;
  at the first Play (when `boot.calibrationDue` is 'firstRun' or 'benchVersion') and only when
  `residentFor(table.needs, has)` is true, run `runCalibration` with a host like labs/bench's, apply and
  `storeCalibration`; send `result.cpuScore` in hello; record the governor's floor share per session
  (`withFloorShare`) and offer the recalibration on `floorPrompt`.
- **session-switch**: the bench shots run on `createSession` as it is (World). Re-run as your gate:
  `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/bench --project=perf --project=functional`.
- **planet-render**: new terrain or atmosphere work keeps its Ultra parameters equal to the declaration's
  Ultra level, and a new knob is a level parameter of an existing setting or a new declared setting.
- **deploy-loadtest**: the cold-start line of ARCHITECTURE 29.2 ("calibration data resident before the
  benchmark starts") is `table.needs` (sizes in section 7).

## 4. How to run and verify

```
npx vitest run src/gate src/bench tests/unit/bench tests/unit/render-core/quality.test.ts   # gate tables, plugin, solver, controller, store, settings model, registry
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/gate --project=functional         # block pages, pass
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/bench --project=functional --project=perf   # Ultra exact, no leaks, calibration, ballast
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/quality-levels.perf.spec.ts --project=perf   # the table of section 6 (RUN_TAG=<tag> for a second run)
BUDGET_COMPARE=1 BUDGET_QUALITY=ultra node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/integration/budget.perf.spec.ts --project=perf
NEEDS_RECORD=1 node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/bench/calibration.perf.spec.ts --project=perf -g "reference GPU"   # re-record the shots' needs (then run again without it)
```

The bench lab by hand: `/labs/bench/` (seed preset), `window.__bench.warmUp()`, `window.__bench.calibrate()`;
`?ballast=<iterations>` for a slower GPU. Pictures: `out/screens/capability-settings/`; numbers:
`out/capability-settings/{calibration,levels,levels-check}.json`.

## 5. Acceptance, line by line

Machine: RTX 5090, 2560 x 1440 unless stated; numbers taken while other agents' jobs ran on the CPU slots
(the headless mission, vitest) are provisional under rule 16: every GPU number here was taken under the GPU
lock with no other browser on the GPU.

| Line | Result | Evidence |
|---|---|---|
| Ultra: every reference image within its tolerance | MET at the reference level on `pad-noon` (Ultra vs no profile 0 pixels, Ultra after Low 0 pixels, three runs); the full gate: see section 9 | `tests/browser/bench/settings.spec.ts`; the lead's gate ran on the tree with this package's core changes from 20:32 UTC |
| Ultra: every wave-2 perf line and the summed budget table within 3 % | see section 9 (`BUDGET_COMPARE=1 BUDGET_QUALITY=ultra`) | budget.perf.spec.ts |
| Unit: fake navigator.gpu lacking each feature or limit gives the right reason; mobile and iPadOS give mobile; an Intel adapter with an empty description is not integrated | MET (3 features, 9 limits, 6 mobile fixtures, 15 class fixtures, the gate and acquireGpu agree) | `tests/unit/bench/gate.test.ts` |
| Unit: solver on recorded 5090 timings gives Ultra at 1440p; x3 a valid profile under budget; the step-down loop terminates | MET (fixture: the four shots of the calibration run of 2026-11-24, `tests/unit/bench/fixtures/shots-5090.json`) | `tests/unit/bench/solver.test.ts` |
| Browser: block pages for mobile (emulation), noWebGPU (navigator.gpu deleted), missingFeature (wrapped adapter); no main bundle request | MET (pictures looked at: `gate-mobile.png`, `gate-noWebGpu.png`, `gate-missingFeature.png`) | `tests/browser/gate/gate.spec.ts` |
| Browser: calibration on the reference GPU under 30 s and chooses Ultra | MET: 23.1 s, Ultra, predicted worst shot 6.41 ms against the 9.35 ms limit, confirmation p95 6.50 ms of 11 | `calibration.perf.spec.ts` |
| Browser: with a GPU ballast flag a lower profile that then holds 60 fps in the confirmation shot | MET: 7.0 ms of ballast at 1440p -> a Custom profile at 0.9 MP (shadows medium, terrain low, the rest Ultra), predicted 9.32 ms, confirmation p95 8.61 ms of 11, no step-down | `calibration.perf.spec.ts` |
| Browser: every setting through every level leaves no GPU error and no leaked texture (counts reported) | MET: 238 live textures before, 238 after, no label changed; no error | `settings.spec.ts` |
| Browser: the title renders on the class-hint preset without calibration having run; calibration refuses while resident() is false | MET in the bench lab (the title is shell-menu's and its wiring app-integration-1's): the page opens on High (discrete) with every setting at High and 2.4 MP; `calibrate()` throws `CalibrationNotReady` before the needs are prefetched | `calibration.perf.spec.ts` |
| Each feature's predicted cost per level within 25 % of measured | PARTLY MET: 64 of the 72 cells of at least 0.05 ms within 25 % (73 of 90 cells in all), predicted in six scenes from each scene's Ultra measurement by the declared models (which are taken from the lift-off). Not met: clouds in low orbit at Low / Medium (predicted 0.42 / 0.49, measured 0.16 / 0.22 ms: from orbit the cloud march is step-bound), clouds in the cockpit at Low / Medium (0.22 / 0.25 against 0.35: cheaper predicted than measured, by 0.13 ms), the shadows at the lunar surface and the splashdown at Low (0.04 ms off), terrain in low orbit at Low (0.03 ms off), the atmosphere in the cockpit at Low (0.04 ms off). The per-level costs themselves are reproducible: a second run predicted from the first within 2 % at the lift-off and the splashdown | section 6; `out/capability-settings/levels-check.json`, `levels.json` |

## 6. The quality steps

What each setting changes, what it costs per level, what the picture loses. GPU ms are the mean per frame
of the setting's passes (attribution mode, 2560 x 1440, every other setting at Ultra), in the lift-off unless
stated; the exponent is how the cost follows the internal pixel count. Pictures: `levels-<scene>-<preset>.png`
and the 2 x 2 sheets `levels-<scene>.png` (top left Low, top right Medium, bottom left High, bottom right
Ultra), looked at.

| Setting | Low / Medium / High / Ultra | GPU ms per level | exp. | What the player loses |
|---|---|---|---|---|
| Resolution (pixel cap) | 0.9 / 1.6 / 2.4 / 3.7 MP (1440p: scale 0.494 / 0.659 / 0.807 / 1) | whole lift-off frame 3.36 / 4.18 / 5.17 / 6.55 | 0.5 (fixed part) | the biggest lever: Low and Medium soften every edge through the TAAU upscale (cables, truss members, the far shore and cumulus turn soft; cockpit display text loses legibility at Low); High is hard to tell from Ultra at 1440p |
| Shadows (`mapSize`) | 1024 / 1536 / 2048 / 2048 | 0.466 / 0.751 / 1.164 / 1.163 | 0.35 | softer, blockier shadow edges (the lander's shadow on the Moon, the tower on the pad); fine contact detail under small parts |
| Ambient occlusion (slices x steps) | 1x4 / 2x4 / 2x6 / 2x6 | 0.058 / 0.081 / 0.095 / 0.095 | 1.0 | slightly noisier, weaker crevice darkening; hard to see |
| Clouds (`steps`) | 48 / 64 / 80 / 96 | 0.643 / 0.705 / 0.763 / 0.810 (splashdown 0.484 / 0.502 / 0.517 / 0.531; low orbit at the presets 0.16 / 0.22 / 0.53 / 0.62) | 0.1 | small cumulus change shape and thin out, from orbit fewer and blurrier puffs; decks keep their look |
| Atmosphere (`steps`) | 12 / 16 / 20 / 24 | 0.459 / 0.506 / 0.559 / 0.607 (splashdown 0.451 / 0.497 / 0.539 / 0.587) | 0.55 | nothing visible at these levels in the six scenes (haze and limb unchanged to the eye) |
| Terrain detail (`pxPerQuad`) | 14 / 11 / 9 / 8 | 1.619 / 1.726 / 1.911 / 1.960 | 0.93 | coarser relief at grazing angles and in the distance; the regolith's small craters less crisp |
| Effects (`particles`, `march`) | 0.4, 0.6 / 0.6, 0.8 / 0.8, 1 / 1, 1 | 0.603 / 0.713 / 0.837 / 0.833 | 0.5 | grainier plume and smoke interiors (fewer march steps, more TAA noise), thinner dust and debris |

The ocean has no setting. A near-range knob (the near field's radii scaled 0.4 to 1) was built and measured to
change the ocean's cost by nothing at the splashdown (1.248 / 1.244 / 1.248 / 1.238 ms), so it was taken out
(4a18bf8): the near pass is per-pixel shading and follows the pixel cap (ocean 1.25 ms at Ultra, 0.45 at the
Low preset's cap). Its lead waiver ("until the near-patch pipeline and quality scaling") is answered by the
pixel cap alone; the pipeline half is the ocean's.

The presets, whole frame (mean of every setting's passes and the fixed cost, ms; the budget rows are p99 per
package in `levels-check.json`):

| Scene | Low | Medium | High | Ultra | Low / Ultra |
|---|---|---|---|---|---|
| pad at dawn | 2.32 | 3.09 | 4.27 | 5.60 | 0.41 |
| lift-off (engines lit) | 2.63 | 3.53 | 4.89 | 6.46 | 0.41 |
| low orbit | 0.88 | 1.10 | 1.66 | 2.11 | 0.42 |
| lunar surface (descent engine at 40 %) | 1.02 | 1.41 | 2.00 | 2.82 | 0.36 |
| splashdown | 1.94 | 2.54 | 3.37 | 4.68 | 0.41 |
| cockpit, low orbit | 1.11 | 1.31 | 1.54 | 1.82 | 0.61 |

## 7. What the scale reaches on slower GPUs, honestly

From the solver on the recorded shots scaled by a factor k (a GPU 1/k as fast as the 5090 on everything; the
budget 11 ms at 60 fps, the solver's limit 0.85 of it): at 1080p, 1440p and 2160p alike, k = 2 gives a 2.0-2.4 MP
custom profile (9.1 ms predicted), k = 3 a 0.9 MP profile (9.3 ms), k = 4 the Low preset (9.35 ms, at the limit),
k = 5 nothing fits: the Low preset's lift-off is 11.7 ms and the result says over budget. A mid-range discrete
card (roughly a quarter of the 5090 in rasterised frames) therefore reaches 60 fps at Low with the governor's
margin used up; one of a fifth or less does not reach 60 fps at the lift-off with these settings and runs on the
governor below the preset (quality scale down to 0.5, then the resolution floor of 0.5 of the cap). Below the
minimum (the Low preset over 33.3 ms in the lift-off: k of about 14) the player gets the warning with "try
anyway". These are predictions from the reference GPU's shots: the slow-GPU ballast run (a real 2.2x slower
frame on pixel work) is the one measured case, and it held 8.61 ms. Where the scale stops short: the fixed cost
(lighting, TAA, bloom, the vehicle, the sky: 0.71 ms at Ultra) follows the pixels by an exponent of only 0.5,
and the terrain (1.96 ms) and its shadows have no lower level that saves more than 17 % and 60 %; a cheaper
terrain material (the terrain package's material cache) and a terrain LOD bias would be the next levers.

## 8. The CPU score and the weak-client threshold

`cpuScore = 100 x sqrt((frameRef / frame) x (simRef / sim))` (`src/bench/cpuScore.ts`): `frame` the p95 of
the main thread's frame time in the confirmation shot (the lift-off), `sim` the wall time of 1,200 steps of a
local session flying the lift-off headless; the reference (quality.json `cpuReference`) is this machine
(Ryzen 9 9950X3D): 6.86 ms and 43.7 ms (median of three probes: 46.8, 43.7, 43.2; provisional under rule 16,
a headless mission ran on a CPU slot). The reference scores 100; half as fast in both scores 50.

Proposal for `UniverseRules.planning.weakClientCpuScore`: **40**. A heliocentric prediction takes up to 20 ms
in the planning worker on the reference (ARCHITECTURE 29.2) and the worker is used while the estimate is under
`workerMaxEstimateMs` (50 ms): a client 2.5 times slower (score 40) is at that limit, so below 40 the planning
goes to the server. The lead sets the field.

## 9. Known limits, not done

- Not implemented: the rows "other craft detail" (no remote-vessel LOD exists in the vehicle feature until
  fleet-models-pads) and "texture budget" (the core's texture manager loads every mip; a reduced-mip load is a
  texture-manager change); cascade count and PCF taps of the shadow row (the shadow chunk is compiled into every
  feature's pipelines; a variant would recompile all of them, so only the map size is a level).
- The calibration's needs are 6,203 files: the pad shot 4,897 files and 456 MB with everything the page
  loads before it (the Earth's terrain layers around the pad at full detail, 636 tiles of the Moon that the
  terrain preloads), the other shots 26 MB together: about three times ARCHITECTURE 29.2's 150 MB. The boot
  pack and the deferred-load layout (platform-delivery, app-integration-1) take the list from quality.json;
  the shots or the terrain's preload would have to shrink to meet 150 MB.
- The gate plugin is not registered (request capability-settings-1): the gate is one module request of a few
  kB before the app instead of inline in the page. It uses rolldown, Vite's own dependency, not a direct one.
- The calibration runs in the bench lab; in the app it is app-integration-1's to wire (section 3). The
  calibration's shots fly the session as it is this wave (World) on meridian-lunar.
- Below-minimum and the device-lost path are unit-tested through a fake host, not on a weak GPU.
- In the app at this commit nothing calls `setQuality`: the game runs at the renderer's defaults (Ultra, no
  pixel cap), as before this package.

## 10. Requests and contract changes

- `capability-settings-1` (open, the lead): register `gatePlugin(repoRoot)` in vite.config.ts; at the tighten
  after 4.3 retire `QualitySettings` / `RenderContext.quality` (kept equal to the resolved profile meanwhile)
  and make `Renderer.setQuality` required.
- `capability-settings-2` (resolved by presentation-sweep, lead decision): vehicles without art are not built
  or reported (`src/core/access/presentable.ts`); the bench lab uses `presentableLibrary`.
- No contract file was edited. The window global `window.__fspGate` (src/gate/index.ts `GateHandoff`) is the
  gate's hand-over to the app; it is not in the contracts.
