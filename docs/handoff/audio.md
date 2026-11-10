# Hand-off: audio

Audio engine (`src/audio`), sound assets (`public/assets/audio`, built by `tools/audio`), audio sections
(`data/defs/audio`), lab (`labs/audio`), specs (`tests/browser/audio`, `tests/unit/audio`).

Everything the player hears is decided by a pure, deterministic **sound model** (`SoundModel`, frame in,
targets out) and played by a Web Audio **graph** built by a factory over any `BaseAudioContext`, so the very
same code runs live and offline. Recorded material (36 ElevenLabs takes, processed into seamless loops and
loudness-normalised one-shots) is layered with seeded procedural noise (rumble, hiss, wind, buffet, crackle,
turbulence modulation), so throttle response is continuous and nothing audibly loops.

## Public API (`import ... from '@/audio'`)

```ts
createAudioEngine(options?: AudioEngineOptions): FableAudioEngine        // implements AudioEngine (src/core/contracts/audio.ts)

interface AudioEngineOptions {
  createContext?: (opts: AudioContextOptions) => AudioContext;            // default new AudioContext({ latencyHint: 'interactive' })
  onError?: (message: string) => void;                                     // model problems (part without definition...), resume failures
}
interface FableAudioEngine extends AudioEngine {
  readonly config: AudioConfig | null;      // validated audio sections (after init)
  readonly bank: AssetBank | null;          // decoded assets (reuse for offline renders)
  readonly defs: DefLibrary | null;
  readonly status: AudioEngineStatus;       // { output: 'device' | 'none' | 'unavailable'; message: string | null }
  readonly context: AudioContext | null;
}
// AudioEngine: init(defs, assetsUrl): Promise<void>; resume(): Promise<void>; update(frame: AudioFrame): void;
//              setMasterVolume(v: number): void; probe(): AudioProbe; dispose(): void

parseAudioConfig(defs: DefLibrary): AudioConfig                            // throws DefError naming file + field
createAudioGraph(ctx: BaseAudioContext, bank: AssetBank, config: AudioConfig, opts?: { onProblem?; startTime? }): AudioGraph
class SoundModel { constructor(config: AudioConfig, defs: DefLibrary); update(frame: AudioFrame): ModelOutput }
renderOffline(config, defs, bank, spec: OfflineRenderSpec): Promise<OfflineRender>   // every bus + path on its own channel
loadAssetBank(ctx: BaseAudioContext, config: AudioConfig, assetsUrl: string, onProgress?): Promise<AssetBank>
TAP_NAMES: TapName[]          // 'master' | <bus> | '<bus>.air' | '<bus>.body' | '<bus>.direct'
audioAnalysis.*  audioMapping.*  noiseBank / generateNoise / crackleWeights   // pure helpers (unit-tested)
```

`AudioProbe` (from `probe()`): `state` is the context state (`'uninitialised'` before `init`, `'closed'` when no
context could be created), `buses.<bus>` for `engines aero reentry events cabin ui master` with `rms` and
`peak` (linear amplitude over the last 2048-sample analyser window) and `low` / `mid` / `high` = RMS amplitude
of the bands < 250 Hz / 250-2000 Hz / > 2000 Hz (low^2 + mid^2 + high^2 = rms^2). `assetsLoaded/assetsTotal`
(36/36), `activeVoices` (running engine clusters + playing one-shots and transients + audible environment
voices + alarm).

### Wiring it in `src/app` (lead)

```ts
const audio = createAudioEngine({ onError: testApi.reportError });
await audio.init(defs, '/assets/audio');                       // safe before any gesture: context held suspended
// first real gesture (the input system's first keydown/pointerdown): void audio.resume();
// every frame, after the camera rig:
audio.update({ snapshot, listener, realDt, warpFactor: snapshot.warp.factor, paused });
testApi.extend({ audio: () => audio.probe() });
```

Listener from the `CameraState` and the active vessel `v`:
`positionVes = rotateInv(v.q, camera.positionRoot - v.rRoot)`; `forwardVes = rotateInv(v.q, rotate(camera.qViewToRoot, -Z))`;
`upVes = rotateInv(v.q, rotate(camera.qViewToRoot, +Y))`; `kind`/`mode`/`insideVesselId` copied from the camera;
`ambientPressure` = static pressure of the body's atmosphere at the camera position (0 in vacuum; for the
cockpit: the outside pressure at the hull). For `kind: 'map'` pass the chase camera's position (the contract
comment's suggestion): the map camera itself is 100 km+ away and would hear nothing.

## Sound model (what is heard)

- **Engines.** One voice per (vessel, sound profile) cluster: the nine Atlas-9M are ONE source at the
  thrust-weighted nozzle centroid. Level `L = level.levelDb + efficiencyDb + 10 log10(refThrust / 1 MN) +
  10 throttleExponent log10(thrust per engine / refThrust) + 10 log10(n running)` (dB re the layers' -20 dBFS).
  Layers: recorded **core** loop (playback rate and low-pass follow `throttleActual`, slow turbulence AM),
  brown-noise **rumble** (cutoff lower for bigger clusters), pink **hiss** band, **crackle** (seeded Poisson
  N-wave train whose density follows throttle; level x `(nozzle ambientPressure / 101325)^e`, exactly 0 in
  vacuum), **ignition** transient (once per cluster within `clusterWindow`, started `ignitionAge` into the
  asset), **shutdown** tail (after `minRunTime`). Ignition/shutdown are detected from `ModuleState`
  `ignitionAge`/`shutdownAge`, not from `engineIgnition`/`engineShutdown` events. RCS modules (no `sound`
  field) use `rcsModuleProfile`: level from the firing thrusters' `levels[]`.
- **Two paths per source.** Airborne: gain `(p_listener / 101325)^0.6` (exactly 0 at p = 0) x inverse distance
  beyond the source's near-field radius, low-pass from pressure (250 Hz-18 kHz) combined with air absorption
  (4.5 kHz at 300 m, ~1.2 kHz at 2 km), propagation delay `d / (340 + recession speed)` on a delay line
  (Doppler for free, positive playback rate even for supersonic recession), equal-power panning in listener
  axes, faded to 0 between 5.5 and 6.5 km; a camera cut ducks 20 ms and jumps the delay line instead of
  sweeping it. Structure-borne: only from sources on the vessel the listener is coupled to, no delay,
  2x low-pass (engines 160-240 Hz) + hull resonance, attenuated 0.15 dB/m along the vessel (floor -24 dB).
  `kind: 'interior'` = cabin mix: full structure-borne path, airborne only through the hull (-19 dB, 2.4 kHz).
  `'external'`/`'map'` = outside listener: airborne path, plus a -30 dB structure-borne share near the active
  vessel (full within 60 m of its bounding sphere, none beyond 250 m; see request audio-1). `mode` is never read.
- **Aero:** wind loop + pink-noise band (level `20 log10(q / 30 kPa)`, brightness with Mach) and a transonic
  buffet (brown noise, AM, Gaussian in Mach around 1.0). Cabin: hull-borne (1.4 kHz).
- **Reentry:** roar loop ∝ `plasmaIntensity`, plasma hiss ∝ `plasma^1.6`, crackle density follows plasma,
  buffet rumble ∝ plasma x sqrt(g / 5). Cabin: hull-borne (3.5 kHz); outside: airborne + the faint attach share.
- **Events** (`data/defs/audio/events.json`): one-shots for stageFired (feedback click), clampsReleased,
  decoupled, fairingJettisoned, lesFired, legsToggled, chuteDeployed/Inflated/Cut/Failed, rcsPulse,
  touchdown (land; variant and level by speed), splash (level by speed), partDestroyed, jointBroken,
  explosion (level by energy, positioned at `posRoot`). Airborne copy starts `delay` later; structure-borne
  copy at once for the listener's own vessel. Suppressed on rails warp and while paused; dropped while the
  context is suspended.
- **Cabin** (interior only): fans/pumps loop, airflow noise, 400 Hz power hum; creaks with a seeded Poisson rate
  from g-load, its rate of change and sunlight changes. **UI:** switch click when a watched snapshot field
  changes (SAS, RCS, lights, gear, fine control, navball mode, warp, target); master alarm (procedural
  750 Hz / 2 kHz tone pair) while any condition holds (max temperature fraction > 0.92, g-dose > 80 % of the
  limit, ablator < 8 %, mission failed), at least 2.5 s per trigger.
- **Time:** engines/aero/reentry buses ramp to exact silence over 0.5 s when `warpFactor > 4`; `paused`
  ramps the master to 0 over 0.3 s. Cabin ambience and UI keep playing during warp.
- **Master:** compressor (-14 dB, 3:1, its built-in makeup cancelled), limiter (-5 dB, 20:1), then a soft
  ceiling (exactly linear below 0.8, tanh knee, never above 0.97, no oversampling so nothing can overshoot).

## Data (`data/defs/audio/`, read only via `DefLibrary.sections` + `getSection`)

`assets.json` (id -> file, loop), `engines.json` (level law, `rcsModuleProfile`, profiles keyed by the engine
`sound` id), `events.json` (per SimEvent type), `environment.json` (aero, reentry, cabin), `mix.json` (buses,
master, propagation, warp, pause, smoothing), `ui.json` (clicks, alarm). Validation (`parseAudioConfig`) names
file and field (`audio/engines.json: profiles.engine.solid.core.asset: unknown asset "x"`), checks asset
references and loop/one-shot kind, event types against the contract (exhaustive list), snapshot paths
against `Readouts`/`NavballState`/`WarpState`/`mission`, and every engine `sound` in `data/defs/parts` (error
against `parts/<id>.json`). **A new engine sound = one profile entry (+ asset files listed in assets.json).**
All six ids the parts use today exist: `engine.methalox-booster`, `engine.hydrolox-vacuum`,
`engine.lander-descent`, `engine.lander-ascent`, `engine.solid`, `rcs.thruster`.

## Assets

36 FLAC files, 48 kHz 16-bit (mono; `aero-wind`, `cabin-fans`, `reentry-roar` stereo), **7.45 MiB** total.
Generated with the ElevenLabs sound-effects API (`eleven_text_to_sound_v2`, prompt influence 0.45, PCM
48 kHz) on the account's paid (Starter) plan, whose terms grant commercial use of the output; no third-party
recordings. Total spend: **1,937 credits** (about 2.5 % of the plan's monthly allowance; no extra purchase),
plus a few cents of OpenAI audio-model calls (see limits). The API has no seed parameter: a take is
reproduced from its cached raw file and identified by `rawSha256` in `tools/audio/manifest.json` (prompt,
model, duration, loop flag, request cost per take). Exact prompts: `tools/audio/prompts.json`;
per-file numbers: `tools/audio/assets-report.json`.

| id | kind | s | integrated / max momentary LUFS | peak dBFS | prompt (abridged) |
|---|---|---|---|---|---|
| engine-booster-core | loop | 11.3 | -20.0 / -18.8 | -10.2 | nine methane engines at full thrust, thunderous roar, ragged crackle, deep rumble |
| engine-hydrolox-core | loop | 9.8 | -20.0 / -19.1 | -8.5 | close test firing, bright roaring hiss, turbopump whine |
| engine-lander-core | loop | 9.8 | -20.0 / -19.3 | -10.2 | small throttleable lander engine, breathy hissing roar |
| engine-solid-core | loop | 8.3 | -20.0 / -19.4 | -10.4 | solid rocket motor, harsh ragged crackling roar |
| rcs-hiss | loop | 6.3 | -20.0 / -19.9 | -11.3 | attitude thruster firing continuously, gas jet hiss |
| aero-wind | loop, stereo | 9.8 | -23.0 / -22.4 | -13.4 | violent wind against a fast fuselage |
| reentry-roar | loop, stereo | 11.3 | -23.0 / -20.9 | -7.4 | inside a capsule during reentry, deep roar and vibration |
| cabin-fans | loop, stereo | 12.8 | -23.0 / -21.2 | -12.7 | spacecraft cabin room tone, fans and pumps |
| ignition-booster / -upper / -small | one-shot | 5 / 3 / 2 | max -14 | -8.2 / -5.2 / -4.2 | engines igniting: crack + building roar / whump / pop |
| shutdown-booster / -small | one-shot | 4 / 2 | max -14 | -4.9 / -5.0 | roar cut off into decaying rumble / hiss stop with puff |
| pyro-bang, clamp-release, fairing-jettison, les-motor | one-shot | 2.5-3.5 | max -14 | -2.3 ... -6.1 | explosive bolts; hold-down clamps; fairing separation; LES blast |
| legs-deploy, chute-mortar, chute-inflate, chute-fail, chute-cut | one-shot | 1-3 | max -14 ... -24 | -1 ... -2.7 | actuator + latch; mortar thump; canopy snap; lines tearing; cutter snap |
| touchdown-hard / -soft, splashdown | one-shot | 2.5 / 1.2 / 4 | -16 / -21 / -14 | -1 / -1 / -4.3 | pads on rock; gentle footpads; capsule hitting the ocean |
| explosion, part-destroyed, joint-broken | one-shot | 6 / 2 / 1.5 | -14 / -14 / -24 | -3.4 / -4.4 / -1 | rocket explosion; structure tearing; strut snapping |
| creak-1..3, switch-click-1..3, rcs-puff-1..2 | one-shot | 0.2-2 | -14 ... -27 | -1 ... -5.6 | hull creaks and squeals; panel toggle clicks; thruster puffs |

Loops: edge-trimmed, equal-power crossfaded into themselves (1.5-3 s), integrated loudness -20 LUFS
(BS.1770-4; stereo loops -23 per channel sum), sample peak <= -1 dBFS. One-shots: silence-trimmed with short
fades, maximum momentary loudness -14 LUFS, peak cap -1 dBFS. All takes are first high-passed at 28 Hz
(zero phase). Loop seam check (`seam.rmsRatio`, RMS across the wrap / median, 1.0 = invisible): 0.93-1.10 for
all loops except `engine-lander-core` at 0.76 (a -2.4 dB dip lasting 60 ms; masked by the procedural layers).

### Regenerate

```
node tools/audio/account.mjs                     # tier and credits left (no key material printed)
node tools/audio/generate.mjs --dry-run          # what is missing + credit estimate
node tools/audio/generate.mjs [--only id,id] [--force id] [--max-credits N]
node tools/audio/process.mjs [--all]             # raw takes -> public/assets/audio/*.flac + assets-report.json
node tools/audio/spectrogram.mjs out/audio/*.wav # PNG spectrograms + level traces for review
node tools/dev/check-secrets.mjs                 # before every commit
```

`generate.mjs` is idempotent: it skips an id whose raw take exists in `data/cache/audio/elevenlabs/`
(git-ignored) or whose manifest take matches the prompt and whose processed files exist. Needs ffmpeg only
for non-PCM output formats; `process.mjs` uses ffmpeg (on PATH) for FLAC encoding.

## How to verify

```
npm run typecheck:paths -- src/audio labs/audio tests/browser/audio tests/unit/audio tools/audio
npx vitest run src/audio tests/unit/audio          # 52 tests: mapping, section validation, model, noise
npx vitest run tools/dev/boundaries.test.ts
npx playwright test tests/browser/audio --project=functional    # 13 specs, ~4.5 min on the loaded machine
```

Lab: `/labs/audio/?scene=pad&stack=booster&kind=external` (stacks: booster, upper, tli, lander, ascent,
capsule, `vehicle:<id>` for real vehicles). Press any key or click to start sound. Sliders for throttle,
pressure, q, Mach, plasma, g-load, max temperature, listener kind / mode / distance / azimuth / height, warp,
pause, volume; buttons for ignition, solids, shutdown and every event; live meters per bus; "record" buttons
download the clips. `window.__audioLab` runs the offline checks; `window.__audioLabLive` drives the live scene.

Outputs: `out/audio/acceptance.json`, `out/audio/live.json`, `out/audio/clips.json`,
`out/audio/<clip>.wav`, `out/audio/spectrograms/<clip>.png`, `out/screens/audio/lab-live-meters.png`.

## Acceptance, measured (offline renders of the real graph in Chrome, 48 kHz)

| criterion | measured | target |
|---|---|---|
| engine bus vs throttle (booster cluster, external ~100 m, sea level) | 10/25/50/75/100 %: -23.0 / -17.2 / -12.5 / -9.8 / -7.5 dBFS, monotonic, **+15.5 dB** | monotonic, >= 12 dB |
| engine class at equal distance (booster cluster vs Lyra-D, 99 m) | -7.5 vs -45.7 dBFS: **38.3 dB** | >= 10 dB |
| vacuum, external listener: airborne energy | `engines.air` max \|sample\| = **0** (exactly) | exactly 0 |
| vacuum, cabin: structure-borne engine sound | engines bus -28.0 dBFS RMS (TLI burn) | present |
| vacuum cabin band > 2 kHz vs sea-level cabin | -137.5 vs -57.6 dBFS: **79.9 dB** lower | >= 25 dB |
| 50 m -> 2 km external | -> **31.6 dB** quieter | >= 25 dB |
| ignition onset delay 50 m -> 2 km | 5.736 s vs (2000-50)/340 = 5.735 s: **error 0.7 ms** | within 50 ms |
| reentry bus vs plasmaIntensity 0 / 0.1 / 0.3 / 0.6 / 1 | cabin: 0 (silent) / -34.5 / -24.8 / -18.6 / -13.9 dBFS; chase: 0 / -68.4 / ... / -47.9 (faint attach share in thin air) | tracks plasma |
| every event type -> events-bus one-shot | 16 types, each rendered alone, bus silent before; onset **6-8 ms** after the event frame | <= 50 ms |
| clipping, everything at maximum | master peak **0.969** outside (booster at 25 m + explosion, splash, every bang, q 60 kPa, plasma 1, 9 g, alarm), 0.835 cabin | < 0.98 |
| warp 10x at t = 1.5 s | engines bus RMS **exactly 0** from t = 2.5 s (ramp 0.5 s) | silent within 1 s |
| unknown mode ('eva-third-person', kind external) vs chase | model targets **bit-identical** for all 375 frames; rendered taps differ by -97.8 dB re signal = the renderer's own re-render difference (-98.1 dB) | sounds exactly like chase |
| probe reports assets decoded | 36 / 36 | all |
| context life cycle (Chrome without the autoplay flag) | `suspended` after init; `running` after `page.keyboard.press` | resumes on a real key press |
| no output device (AudioContext throws unless `sinkId: {type:'none'}`) | init OK, `status.output 'none'`, resumes and renders | tolerated |
| live meters | lander throttle 100 % -> 10 %: -9.6 dB; pause -> master peak 0 | react |
| console errors | none (every spec ends with `expectNoErrors`) | none |
| main-thread cost of `update()` (booster + aero + cabin live) | p50 0.23 ms, p99 0.63 ms (another run: 0.09 / 0.20) - provisional, machine busy with bakes | - |

Listen-proof clips (10 s each, master output, `out/audio/*.wav`):

| clip (listener) | peak (dBFS) | RMS dBFS | centroid Hz | low / mid / high dBFS |
|---|---|---|---|---|
| liftoff-pad (pad camera 445 m, hears it 1.3 s late) | 0.739 (-2.6) | -17.5 | 467 | -19.0 / -24.3 / -28.7 |
| liftoff-cabin | 0.760 (-2.4) | -13.7 | 126 | -13.8 / -29.9 / -38.7 |
| max-q (chase 80 m, 11 km, q 33 kPa, Mach 0.95-1.35) | 0.741 (-2.6) | -14.4 | 236 | -14.9 / -26.1 / -30.8 |
| staging (cabin, 62 km: shutdown, pyro, ullage, M-2 ignition) | 0.805 (-1.9) | -17.2 | 151 | -17.6 / -28.4 / -41.5 |
| vacuum-burn-cabin (TLI burn, RCS pulses, SAS click) | 0.457 (-6.8) | -23.0 | 132 | -23.1 / -38.9 / -48.1 |
| reentry (cabin, plasma 0.15-0.95, 0.5-5.5 g) | 0.806 (-1.9) | -17.3 | 293 | -17.7 / -31.4 / -29.8 |
| chute-deploy (cabin, drogue then main) | 0.806 (-1.9) | -22.2 | 518 | -26.0 / -24.8 / -37.7 |
| splashdown (chase 35 m) | 0.544 (-5.3) | -24.3 | 1412 | -27.8 / -28.8 / -31.2 |

## Known limits (honest)

- **Not listened to by a human.** Mix levels were calibrated from measurements (bus/master RMS, band levels,
  spectrograms of every clip, which I inspected) against intended targets, not by ear. A blind description
  by an audio LLM (gpt-audio-1.5) was tried on the assets and discarded as unreliable: it described a 0.2 s
  click as a three-second engine swell. A reviewer should listen to `out/audio/*.wav`.
- **Generated content.** ElevenLabs takes match their prompts by band analysis (e.g. clicks are > 2 kHz, the
  booster core is dark and broadband, creaks were regenerated once because the first takes were 35 Hz
  thumps), but individual takes may contain artefacts a listener would reject; regeneration is one command.
  The cabin-fans loop is mostly a 100-150 Hz hum (airflow noise is added procedurally).
- **AudioWorklet not used.** The first implementation generated noise in an AudioWorklet; Chrome's offline
  renders were then not reproducible (processors created mid-render). Seeded noise buffers (21-47 s,
  per-voice offsets, crossfaded crackle densities) are explicitly allowed by the brief and render identically
  live and offline.
- **Chrome offline renders of the full graph are not bit-reproducible**: re-rendering the same scene differs
  at about -95 dB (float rounding; small graphs are bit-exact). The unknown-mode criterion is therefore proved
  bit-exactly on the model's targets and, on audio, against that noise floor.
- **External structure-borne share** is a distance heuristic until the listener says which vessel a camera
  follows (request audio-1). A chase camera beyond 250 m in vacuum hears nothing.
- `ambientPressure` of an interior listener is taken as the OUTSIDE static pressure (request audio-1).
- Memory: each continuous voice owns a 20 s delay line (3.8 MB mono, 7.7 MB stereo); with the booster, M-2,
  solids, aero and reentry voices alive that is ~35 MB of delay buffers, plus ~20 MB of shared noise buffers.
- In the extreme "everything at maximum" case the soft ceiling engages (peak 0.969): soft saturation, not
  clipping. Normal scenes peak at 0.46-0.81.
- No ocean or surface ambience after splashdown / on the Moon (not in the brief); after splashdown the chase
  camera hears only the decaying splash and light wind.
- The lab places real vehicle parts with an approximate attach-node walk (it may not import the vessel
  facade); good enough for listening, not a vehicle model.
- Engine ignition/shutdown transients come from `ModuleState` ages; `engineIgnition` / `engineShutdown` /
  `crewLost` / `soiChange` / `vesselRemoved` / `activeVesselChanged` / `warpChanged` (heard as the warp click
  through the watched `warp.index`) / `nodeCompleted` / `milestone` / `missionFailed` (alarm condition) have
  no events-bus one-shot of their own.

## Requests

- `docs/requests/audio-1.md` (non-blocking, `src/core/contracts/audio.ts`): add
  `AudioListener.attachedVesselId` and document `ambientPressure` for interior listeners.
