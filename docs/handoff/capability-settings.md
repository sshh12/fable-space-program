# capability-settings (wave 4.1): the capability gate, the calibration, feature-declared quality, the settings model

Status: IN PROGRESS (2026-11-24). Sections 1-4 describe what exists; the measured sections are filled as
the runs come in; section 9 is the running state.

## 1. What exists

| Piece | Where | What it does |
|---|---|---|
| Capability gate | `src/gate/*`, `index.html` | The ordered checks of ARCHITECTURE 24 into a `CapabilityReport` (structurally the contract's; reasons `mobile`, `noWebGpu`, `noAdapter`, `fallbackAdapter`, `missingFeature`, `lowLimits`, `deviceFailed`, `missingApi`); a static block page per reason with what to do, a copy-report control, Credits and the live player count from `/status.json` (`online`); non-blocking banners (small window, no Web Audio, a browser that is not Chrome/Edge). Runs BEFORE the main bundle: index.html's gate module loads `/src/app/main.ts` with a dynamic import only on a pass (in a build the app is a chunk only that import names). Hands `window.__fspGate = { report, warnings, safe, ms }` to the app. Imports nothing. |
| Gate plugin | `tools/server/gatePlugin.ts` | Bundles the gate (rolldown, Vite's own bundler) into one IIFE and inlines it in the page's head; the page's gate script then takes `startGate` from `window.__fspGateModule`. Not registered yet: request capability-settings-1 (the lead's vite.config.ts). |
| Adapter class | `src/core/gpu/device.ts` | `classifyAdapter(report)`: 'discrete' / 'integrated' / 'unknown' from vendor and architecture tables (the description only refines when the browser fills it); `GpuHandle.adapterClass`. `acquireGpu` keeps its hard failures (no WebGPU, no adapter, fallback adapter, missing features or limits) and no longer refuses an integrated GPU. |
| Quality in the render core | `src/render/core/quality.ts`, `renderer.ts` | `Renderer.setQuality(profile)`: live settings next frame, rebuild settings under a 1 s fade, no reload; pixel cap -> internal resolution cap per display; governor budget `0.66 x 1000 / targetFps`; `coreOf(ctx).quality` (params, onRebuild, settings, profile); the core's own settings `shadows` (rebuild) and `ambientOcclusion` (live). Measurement hooks `setPerfAttribution`, `setGovernor`, `onGpuFrame`. RENDER_API section 20. |
| Feature declarations | `src/render/{atmosphere,terrain,ocean,vfx}/quality.ts` | `clouds`, `atmosphere`, `terrain`, `ocean`, `effects`, each with four levels whose Ultra is the value the code used before. |
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
  benchmark starts") is `table.needs` (sizes in section 6).

## 9. Running state

- `4eeb9e0` the gate (committed).
- In the working tree: everything else above; first browser runs queued behind the lead's image gate.
