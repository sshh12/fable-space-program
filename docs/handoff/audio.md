# Hand-off: audio

Audio engine (`src/audio`), sound assets (`public/assets/audio`, built by `tools/audio`), audio sections
(`data/defs/audio`), lab (`labs/audio`), specs (`tests/browser/audio`, `tests/unit/audio`).

Everything the player hears is decided by a pure, deterministic **sound model** (`SoundModel`, frame in,
targets out) and played by a Web Audio **graph** built by a factory over any `BaseAudioContext`, so the very
same code runs live and offline. Recorded material (38 ElevenLabs takes, processed into seamless loops and
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
  stats(): AudioGraphStats | null;          // resource load: { engineVoices, nodes, delayLines, delayLineSeconds, oneShots }
}
// AudioEngine: init(defs, assetsUrl): Promise<void>; resume(): Promise<void>; update(frame: AudioFrame): void;
//              setMasterVolume(v: number): void; probe(): AudioProbe; dispose(): void

parseAudioConfig(defs: DefLibrary): AudioConfig                            // throws DefError naming file + field
createAudioGraph(ctx: BaseAudioContext, bank: AssetBank, config: AudioConfig, opts?: { onProblem?; startTime? }): AudioGraph
  // AudioGraph: output, preCeiling (master after compressor + limiter), masterInput, taps, apply, setMasterVolume,
  //             activeVoices(), stats(), dispose()
class SoundModel { constructor(config: AudioConfig, defs: DefLibrary); update(frame: AudioFrame): ModelOutput }
renderOffline(config, defs, bank, spec: OfflineRenderSpec): Promise<OfflineRender>
  // every bus + path on its own channel (spec.stereoTaps: as stereo pairs), master and preCeiling in stereo, maxStats
loadAssetBank(ctx: BaseAudioContext, config: AudioConfig, assetsUrl: string, onProgress?): Promise<AssetBank>
TAP_NAMES: TapName[]          // 'master' | <bus> | '<bus>.air' | '<bus>.body' | '<bus>.direct'
ambienceAssetIds(config), audioAnalysis.*, audioMapping.*, noiseBank / generateNoise / slowModulator / crackleWeights
```

`AudioProbe` (from `probe()`): `state` is the context state (`'uninitialised'` before `init`, `'closed'` when no
context could be created), `buses.<bus>` for `engines aero reentry events cabin ui master` with `rms` and
`peak` (linear amplitude over the last 2048-sample analyser window) and `low` / `mid` / `high` = RMS amplitude
of the bands < 250 Hz / 250-2000 Hz / > 2000 Hz (low^2 + mid^2 + high^2 = rms^2). `assetsLoaded/assetsTotal`
(38/38), `activeVoices` = allocated engine voices (also while they drain) and their transients + playing
one-shots + audible environment voices (aero, reentry, surface ambience, cabin) + alarm. `stats()` gives the
real node and delay-line load.

### Wiring it in `src/app` (lead)

```ts
const audio = createAudioEngine({ onError: testApi.reportError });
await audio.init(defs, '/assets/audio');                       // safe before any gesture: context held suspended
// every real user gesture (keydown / pointerdown) - not only the first: void audio.resume();
// every frame, after the camera rig:
audio.update({ snapshot, listener, realDt, warpFactor: snapshot.warp.factor, paused });
testApi.extend({ audio: () => audio.probe() });
```

Call `resume()` on every gesture: it is cheap when the context runs, and it is the moment the engine brings
back an output device that failed earlier (it also retries on `navigator.mediaDevices` `devicechange`).

Listener from the `CameraState` and the active vessel `v` (what `src/camera/listener.ts` already does):
`positionVes = rotateInv(v.q, camera.positionRoot - v.rRoot)`; `forwardVes = rotateInv(v.q, rotate(camera.qViewToRoot, -Z))`;
`upVes = rotateInv(v.q, rotate(camera.qViewToRoot, +Y))`; `kind`/`mode`/`insideVesselId` copied from the camera;
`ambientPressure` = static pressure of the body's atmosphere at the camera position (0 in vacuum; for the
cockpit: the outside pressure at the hull). **`kind: 'map'`**: the engine ignores the map listener's position,
orientation and pressure (the map camera is 100 km+ away in vacuum and would hear nothing) and places it where
the last outside flight camera of the active vessel was (VES), in the vessel's own ambient pressure; before any
outside camera was seen, at `mix.json propagation.mapListener.positionVes`. So the existing producer can stay
as it is.

## Sound model (what is heard)

- **Engines.** One voice per (vessel, sound profile) cluster: the nine Atlas-9M are ONE source at the
  thrust-weighted nozzle centroid. Level `L = level.levelDb + efficiencyDb + 10 log10(refThrust / 1 MN) +
  10 throttleExponent log10(thrust per engine / refThrust) - throttleRangeDb (1 - lever) + 10 log10(n running)`
  (dB re the layers' -20 dBFS), where **lever** = `(throttleActual - minThrottle) / (1 - minThrottle)` of the
  part's engine module, thrust-weighted over the cluster: the player's throttle by the sim's law
  (`throttleTarget`), 1 for solids, fixed burns and engines that cannot throttle. `throttleRangeDb` (methalox
  booster and hydrolox Vela-2 / Vela-2V 13 dB, Lyra-D 6, Lyra-A 8, solid and RCS 0) makes an engine that can only go down to 50 % thrust still
  sound clearly throttled. Layers: recorded **core** loop (playback rate and low-pass follow the lever, slow
  turbulence AM), brown-noise **rumble** (cutoff lower for bigger clusters), pink **hiss** band, **crackle**
  (seeded Poisson N-wave train whose density follows the lever; level x `(nozzle ambientPressure / 101325)^e`,
  exactly 0 in vacuum), **ignition** transient (once per cluster within `clusterWindow`, started `ignitionAge`
  into the asset), **shutdown** tail (after `minRunTime`). Ignition/shutdown come from `ModuleState`
  `ignitionAge`/`shutdownAge`, not from `engineIgnition`/`engineShutdown` events. RCS modules (no `sound`
  field) use `rcsModuleProfile`: level from the firing thrusters' `levels[]`.
- **Voices exist only while they sound.** A cluster gets a voice when it first produces thrust or a
  transient and keeps it for `engines.json voiceHold` (1 s) after it last did; the graph then releases the
  voice and disposes it once its delay line and transients have drained (a cluster that fires again revives
  a draining voice). The Meridian stack on the pad has **0** engine voices (128 nodes, 2 delay lines for aero
  and reentry); with every throttleable engine of it lit, 4 voices (284 nodes, 6 delay lines).
- **Two paths per source.** Airborne: gain `(p_listener / 101325)^0.6` (exactly 0 at p = 0) x inverse distance
  beyond the source's near-field radius, low-pass from pressure (250 Hz-18 kHz) combined with air absorption
  (4.5 kHz at 300 m, ~1.2 kHz at 2 km), equal-power panning in listener axes, faded to 0 between 5.5 and 6.5 km.
  The **delay is the exact retarded time of a source moving with its vessel's air-relative velocity**
  (`mapping.retardedDelay`): a static source gives d / 340 s, a listener riding with the vessel a constant
  delay, Doppler comes from the delay line, and a supersonic source reaches only listeners inside its Mach
  cone (faded over `coneEdge`). So above Mach 1 the crew and a chase camera ahead of the nozzles lose the
  airborne roar while the structure-borne path stays; a chase camera trailing behind keeps hearing it. A
  camera cut ducks 20 ms and jumps the delay line instead of sweeping it. Structure-borne: only from sources
  on the vessel the listener is coupled to, no delay, 2x low-pass (engines 160-240 Hz) + hull resonance,
  attenuated 0.15 dB/m along the vessel (floor -24 dB). `kind: 'interior'` = cabin mix: full structure-borne
  path, airborne only through the hull (-19 dB, 2.4 kHz). `'external'`/`'map'` = outside listener: airborne
  path, plus a faint structure-borne share from the vessel the camera is attached to
  (`AudioListener.attachedVesselId`, request audio-1, resolved by the lead): -12 dB re the cabin's coupling, full
  within 60 m of that vessel's bounding sphere about its VES origin, none beyond 250 m; a free or ground-fixed
  camera (`attachedVesselId: null`) hears none; after the outside
  bus gain it is about 17 dB below what the crew hears. `mode` is never read.
- **Aero:** wind loop + pink-noise band (level `20 log10(q / 30 kPa)`, brightness with Mach) and a transonic
  buffet (brown noise, AM, Gaussian in Mach around 1.0). Cabin: hull-borne (1.4 kHz).
- **Reentry:** roar loop ∝ `plasmaIntensity`, plasma hiss ∝ `plasma^1.6`, crackle density follows plasma,
  buffet rumble ∝ plasma x sqrt(g / 5). Cabin: hull-borne (3.5 kHz); outside: airborne + the faint attach share.
- **Surface ambience** (`environment.json ambience`): a bed per surface - `land` (a breeze, -26 dB) while the
  active vessel is within 150 m of the ground (faded out by 1.5 km of radar altitude), `water` (waves against
  the hull, -12 dB, plus a fainter breeze) when it floats - scaled by the listener's air like any airborne
  sound (silent in vacuum, so nothing on the Moon), heard through the hull (-16 dB, 900 Hz) in the cabin.
  It plays on the aero bus. Nothing is digital silence on Earth's surface any more.
- **Events** (`data/defs/audio/events.json`): one-shots for stageFired (feedback click), clampsReleased,
  decoupled, fairingJettisoned, lesFired, legsToggled, chuteDeployed/Inflated/Cut/Failed, rcsPulse,
  touchdown (land; variant and level by speed), splash (level by speed), partDestroyed, jointBroken,
  explosion (level by energy, positioned at `posRoot`, at rest in the air). Airborne copy starts `delay`
  later; structure-borne copy at once for the listener's own vessel. Suppressed on rails warp and while
  paused; dropped while the context is suspended.
- **Cabin** (interior only): fans/pumps loop (broadband ventilation whoosh and pump whirr), airflow noise,
  400 Hz power hum; creaks with a seeded Poisson rate from g-load, its rate of change and sunlight changes.
  **UI:** switch click when a watched snapshot field changes (SAS, RCS, lights, gear, fine control, navball
  mode, warp, target); master alarm (procedural 750 Hz / 2 kHz tone pair) while any condition holds (max
  temperature fraction > 0.92, g-dose > 80 % of the limit, ablator < 8 %, mission failed), at least 2.5 s.
- **Turbulence modulation** (`slowModulator`): the average of two seeded value-noise buffers of 127 and 173
  knots (coprime), played at `turbulenceHz`; bounded to [-1, 1], RMS 0.35. The combined pattern repeats only
  after 127 x 173 / Hz s (41 min at the fastest rate the data uses, 9 Hz). Every noise buffer is
  wrap-continuous (tail equal-power crossfaded into the head; value noise ends on its first knot), so no
  looping source steps at its loop point (unit-tested).
- **Time:** engines/aero/reentry buses ramp to exact silence over 0.5 s when `warpFactor > 4`; `paused`
  ramps the master to 0 over 0.3 s. Cabin ambience and UI keep playing during warp.
- **Mix and master** (`mix.json`): bus gains differ outside (`gainDb`: engines -21, aero +2, reentry -7,
  events -16 dB) and in the cabin (`interiorGainDb`: -13, -3, -7, -6 dB), ramped on a view change. Master:
  compressor (-32 dB, 2:1, 8 dB knee) followed by +12 dB makeup (the DynamicsCompressorNode's automatic makeup
  is cancelled exactly, `mapping.compressorMakeupDb`, so the small-signal gain is exactly +12 dB), limiter
  (-4 dB, 20:1, 1 ms, makeup also cancelled), then a soft ceiling (exactly linear below 0.8, tanh knee,
  never above 0.97). In every tested scene - including everything at once at maximum - the buses peak below
  0 dBFS and the limiter keeps the signal inside the ceiling's linear range: nothing is shaped or clipped.
  The compressor lifts quiet scenes (cabin hum, beds) by up to 12 dB and halves level differences above
  -32 dBFS; the bus-level criteria below are measured before it.

## Data (`data/defs/audio/`, read only via `DefLibrary.sections` + `getSection`)

`assets.json` (id -> file, loop), `engines.json` (level law, `voiceHold`, `rcsModuleProfile`, profiles keyed by
the engine `sound` id), `events.json` (per SimEvent type), `environment.json` (aero, reentry, ambience beds,
cabin), `mix.json` (buses, master, propagation, warp, pause, smoothing), `ui.json` (clicks, alarm). Validation
(`parseAudioConfig`) names file and field (`audio/engines.json: profiles.engine.solid.core.asset: unknown
asset "x"`), checks asset references and loop/one-shot kind, event types against the contract (exhaustive
list), ambience surfaces, snapshot paths against `Readouts`/`NavballState`/`WarpState`/`mission`, and every
engine `sound` in `data/defs/parts` (error against `parts/<id>.json`). **A new engine sound = one profile entry
(+ asset files listed in assets.json).** All six ids the parts use today exist: `engine.methalox-booster`,
`engine.hydrolox-vacuum`, `engine.lander-descent`, `engine.lander-ascent`, `engine.solid`, `rcs.thruster`.

## Assets

38 FLAC files, 48 kHz 16-bit (mono; `aero-wind`, `cabin-fans`, `reentry-roar`, `ambience-outdoor`,
`ambience-ocean` stereo), **10.48 MiB** total. Generated with the ElevenLabs sound-effects API
(`eleven_text_to_sound_v2`, prompt influence 0.45, PCM 48 kHz) on the account's paid (Starter) plan, whose
terms grant commercial use of the output; no third-party recordings. Total spend: **2,417 credits** (about 3 %
of the plan's monthly allowance; no extra purchase): 1,937 for the first 36 takes, 480 for the regenerated
cabin-fans take and the two ambience beds. Plus a few cents of OpenAI audio-model calls (see limits). The API
has no seed parameter: a take is reproduced from its cached raw file and identified by `rawSha256` in
`tools/audio/manifest.json` (prompt, model, duration, loop flag, request cost per take). Exact prompts:
`tools/audio/prompts.json`; per-file numbers: `tools/audio/assets-report.json`.

| id | kind | s | integrated / max momentary LUFS | peak dBFS | prompt (abridged) |
|---|---|---|---|---|---|
| engine-booster-core | loop | 11.3 | -20.0 / -18.8 | -10.2 | nine methane engines at full thrust, thunderous roar, ragged crackle, deep rumble |
| engine-hydrolox-core | loop | 9.8 | -20.0 / -19.1 | -8.5 | close test firing, bright roaring hiss, turbopump whine |
| engine-lander-core | loop | 9.8 | -20.0 / -19.3 | -10.2 | small throttleable lander engine, breathy hissing roar |
| engine-solid-core | loop | 8.3 | -20.0 / -19.4 | -10.4 | solid rocket motor, harsh ragged crackling roar |
| rcs-hiss | loop | 6.3 | -20.0 / -19.9 | -11.3 | attitude thruster firing continuously, gas jet hiss |
| aero-wind | loop, stereo | 9.8 | -23.0 / -22.4 | -13.4 | violent wind against a fast fuselage |
| reentry-roar | loop, stereo | 11.3 | -23.0 / -20.9 | -7.4 | inside a capsule during reentry, deep roar and vibration |
| cabin-fans | loop, stereo | 12.8 | -23.0 / -22.3 | -9.7 | broadband whoosh of ventilation fans through ducts, whirring and gurgling coolant pumps (centroid 593 Hz) |
| ambience-outdoor | loop, stereo | 12.8 | -23.0 / -18.3 | -6.5 | gentle breeze across open ground at a coastal launch site, distant surf |
| ambience-ocean | loop, stereo | 12.8 | -28.8 / -22.1 | -3.8 | waves lapping and slapping against a floating capsule, sloshing, light breeze (peak-limited) |
| ignition-booster / -upper / -small | one-shot | 5 / 3 / 2 | max -14 | -8.2 / -5.2 / -4.2 | engines igniting: crack + building roar / whump / pop |
| shutdown-booster / -small | one-shot | 4 / 2 | max -14 | -4.9 / -5.0 | roar cut off into decaying rumble / hiss stop with puff |
| pyro-bang, clamp-release, fairing-jettison, les-motor | one-shot | 2.5-3.5 | max -14 | -2.3 ... -6.1 | explosive bolts; hold-down clamps; fairing separation; LES blast |
| legs-deploy, chute-mortar, chute-inflate, chute-fail, chute-cut | one-shot | 1-3 | max -14 ... -24 | -1 ... -2.7 | actuator + latch; mortar thump; canopy snap; lines tearing; cutter snap |
| touchdown-hard / -soft, splashdown | one-shot | 2.5 / 1.2 / 4 | -16 / -21 / -14 | -1 / -1 / -4.3 | pads on rock; gentle footpads; capsule hitting the ocean |
| explosion, part-destroyed, joint-broken | one-shot | 6 / 2 / 1.5 | -14 / -14 / -24 | -3.4 / -4.4 / -1 | rocket explosion; structure tearing; strut snapping |
| creak-1..3, switch-click-1..3, rcs-puff-1..2 | one-shot | 0.2-2 | -14 ... -27 | -1 ... -5.6 | hull creaks and squeals; panel toggle clicks; thruster puffs |

Loops: edge-trimmed, equal-power crossfaded into themselves (1.5-3 s), integrated loudness -20 LUFS
(BS.1770-4; stereo loops -23 per channel sum; `ambience-ocean` stops at -28.8 because its wave slaps reach the
-1 dBFS peak cap), sample peak <= -1 dBFS. One-shots: silence-trimmed with short fades, maximum momentary
loudness -14 LUFS, peak cap -1 dBFS. All takes are first high-passed at 28 Hz (zero phase). Loop seams: the
60 ms window across the wrap sits at the 7th-55th percentile of the loop's own 60 ms windows (outdoor 7 %,
with equal gust dips elsewhere in the take; ocean 25 %; cabin-fans 20 %; aero-wind 55 %), i.e. inside the
take's natural level variation; `engine-lander-core` has a slow 2-3 dB level wander across its wrap (masked by
the procedural layers).

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

## How to verify (through the heavy-job gate)

```
node tools/dev/heavy.mjs --class=cpu -- npm run typecheck:paths -- src/audio labs/audio tests/browser/audio tests/unit/audio tools/audio
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/audio tests/unit/audio tools/dev/boundaries.test.ts   # 66 + 7 tests
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/audio --project=functional            # 16 specs, ~1 min
```

Lab: `/labs/audio/?scene=pad&stack=booster&kind=external` (stacks: booster, upper, tli, lander, ascent,
capsule - built from the real part definitions in `data/defs/parts` - and `vehicle:<id>` for real vehicles).
Press any key or click to start sound. Sliders for throttle (the lever), pressure, q, Mach, plasma, g-load, max
temperature, listener kind / mode / distance / azimuth / height, warp, pause, volume; buttons for ignition,
solids, shutdown and every event; live meters per bus; the status line shows voices, engine voices, nodes and
delay lines; "record" buttons download the clips. `window.__audioLab` runs the offline checks;
`window.__audioLabLive` drives the live scene. The lab synthesises engine module states with a copy of the
sim's engine law (`labs/audio/labVehicle.ts`: `throttleTarget`, exact spool lag, ignition/shutdown thresholds
and ages; unlimited propellant), because labs of this package may not import `src/sim`.

Outputs: `out/audio/acceptance.json`, `out/audio/live.json`, `out/audio/clips.json`,
`out/audio/<clip>.wav`, `out/audio/spectrograms/<clip>.png`, `out/screens/audio/lab-live-meters.png`.

## Acceptance, measured (offline renders of the real graph in Chrome, 48 kHz; 2026-11-10, Earth bake running)

"Throttle" is the player's **lever**: every spec drives the real part definitions through the sim's
lever -> throttleActual law (Atlas-9M minThrottle 0.5: lever 10 % = 55 % thrust; Lyra-D 0.1: 19 %).

| criterion | measured | target |
|---|---|---|
| engines bus vs lever, Atlas-9M x9 (chase ~100 m, sea level) | 10/25/50/75/100 %: -40.0 / -37.1 / -32.6 / -28.7 / -24.4 dBFS, monotonic, **+15.7 dB** | monotonic, >= 12 dB |
| engines bus vs lever, Lyra-D (chase 64 m, sea level) | -78.2 / -73.9 / -69.1 / -65.5 / -62.5 dBFS, monotonic, **+15.7 dB** | monotonic, >= 12 dB |
| live meters, lever 100 % -> 10 % | Lyra-D from the cabin in vacuum **17.1 dB**; Atlas-9M cluster outside at 120 m **19.0 dB** (spec asserts >= 12 for both) | >= 12 dB |
| engine class at equal distance (booster cluster vs Lyra-D, 99 m) | -24.3 vs -63.4 dBFS: **39.1 dB** | >= 10 dB |
| vacuum, external listener: airborne energy | `engines.air` max \|sample\| = **0** (exactly) | exactly 0 |
| vacuum, cabin: structure-borne engine sound | engines bus -40.8 dBFS RMS (Vela-2V burn) | present |
| vacuum cabin band > 2 kHz vs sea-level cabin | -150.4 vs -70.6 dBFS: **79.8 dB** lower | >= 25 dB |
| 50 m -> 2 km external | -16.4 -> -46.4 dBFS: **30.0 dB** quieter | >= 25 dB |
| ignition onset delay 50 m -> 2 km | 5.736 s vs (2000-50)/340 = 5.735 s: **error 0.7 ms** | within 50 ms |
| reentry bus vs plasmaIntensity 0 / 0.1 / 0.3 / 0.6 / 1 | cabin: 0 (silent) / -41.1 / -31.5 / -25.3 / -20.6 dBFS; chase 40 m at 8 Pa: 0 / -57.1 / -47.5 / -41.3 / -36.6 | tracks plasma |
| every event type -> events-bus one-shot | 16 types, each rendered alone, bus silent before; onset **6-8 ms** after the event frame | <= 50 ms |
| nothing clips: everything at maximum (booster cluster at 25 m or the cabin, every loud event at once, q 60 kPa, Mach 1, plasma 1, 9 g, alarm) and the loudest realistic scenes (booster at 25 / 50 m, its ignition at 25 m, from the cabin, every loud event at once outside and inside) | highest bus true peak **-1.8 dBFS** (events, everything outside); master fed to the soft ceiling at most **0.746** (linear below 0.8), **0** samples shaped; master peak 0.746 | buses < 0 dBFS, ceiling never engaged, master < 0.98 |
| master small-signal gain | 12.00 dB measured vs 12 configured (built-in makeups cancelled) | exact |
| warp 10x at t = 1.5 s | engines bus RMS **exactly 0** from t = 2.5 s (ramp 0.5 s) | silent within 1 s |
| unknown mode ('eva-third-person', kind external) vs chase | model targets **bit-identical** for all 375 frames; rendered taps differ by -73.9 dB re each tap (chase re-rendered vs itself: -72.9 dB), master -84.9 dB (self -83.0 dB): the renderer's own float-rounding floor | sounds exactly like chase |
| probe reports assets decoded | 38 / 38 | all |
| context life cycle (Chrome without the autoplay flag) | `suspended` after init; `running` after `page.keyboard.press` | resumes on a real key press |
| no output device (AudioContext throws unless `sinkId: {type:'none'}`) | init OK, `status.output 'none'`, resumes and renders | tolerated |
| device slow to open (first resume takes 4.5 s) | status "waiting for the audio device to open", output stays `device`, then `running`, message cleared | waited for, not abandoned |
| device error while running | null sink (`output 'none'`), still rendering; back on the device at the next key press | recovers |
| engine voices on the pad (Meridian, real parts) | 0 before ignition; 4 with every throttleable engine lit | only clusters that sound |
| console errors | none (every spec ends with `expectNoErrors`) | none |
| main-thread cost of `update()` (booster + aero + bed live) | p50 0.05 ms, p99 0.21 ms, max 0.76 ms - provisional, Earth bake running | - |

Listen-proof clips (10 s each, master output, `out/audio/*.wav`; spectrograms with level traces in
`out/audio/spectrograms/`):

| clip (listener) | peak | RMS dBFS | centroid Hz | low / mid / high dBFS |
|---|---|---|---|---|
| liftoff-pad (pad camera 445 m, hears it 1.3 s late; breeze -37 dBFS before, roar -23 dBFS after) | 0.268 (-11.5) | -24.5 | 300 | -25.5 / -32.4 / -39.4 |
| liftoff-cabin (fans -39 dBFS before ignition, -18 after) | 0.411 (-7.7) | -18.9 | 148 | -19.2 / -31.3 / -42.9 |
| max-q (chase trailing 96 m below, 11 km, q 33 kPa, lever 0.4 then 1, Mach 0.95-1.35) | 0.336 (-9.5) | -21.2 | 376 | -22.1 / -30.4 / -33.7 |
| staging (cabin, 62 km, Mach 6.5: shutdown, pyro, ullage, M-2 ignition) | 0.674 (-3.4) | -20.6 | 350 | -21.5 / -28.7 / -35.7 |
| vacuum-burn-cabin (TLI burn, RCS pulses, SAS click) | 0.643 (-3.8) | -26.6 | 258 | -27.1 / -37.1 / -43.8 |
| reentry (cabin, plasma 0.15-0.95, 0.5-5.5 g) | 0.679 (-3.4) | -18.4 | 348 | -18.9 / -30.8 / -30.4 |
| chute-deploy (cabin, drogue then main) | 0.672 (-3.4) | -22.2 | 937 | -26.5 / -24.9 / -32.6 |
| splashdown (chase 35 m: descent -35 dBFS, splash -20, sea afterwards -32 ... -29) | 0.369 (-8.7) | -27.4 | 881 | -30.3 / -31.6 / -37.0 |

## Review fixes (wave-1 review, finished after the 2026-11-10 crash)

1. Clipping check could not fail and the mix saturated: re-staged bus gains, cancelled both dynamics nodes'
   automatic makeup, added the `preCeiling` tap; the spec asserts bus true peaks < 1, pre-ceiling < 0.8 and
   no shaped sample (it did fail once during calibration: events bus +1.2 dBFS, fixed by -3 dB on the outside
   events bus).
2. Throttle measured with impossible engine states: the level law follows the lever (`throttleRangeDb`),
   all specs and the lab drive real parts through the sim's law, live checks assert >= 12 dB.
3. Noise buffers stepped at their loop point and the turbulence pattern repeated every 5-16 s: wrap-continuous
   buffers, two coprime slow buffers, unit tests for both.
4. Idle engine voices for every engine on the vessel: lazy voices with `voiceHold`, drained release, mono
   airborne branch (halves stereo delay lines), real load in `stats()` and the lab status line.
5. `resume()` abandoned a slow device for the null sink forever: waits for it; the null sink only on real
   failure, and the device is retried on every gesture and `devicechange`.
6. Attach distance measured from the CoM: now from the bounding sphere about the VES origin (unit test with a
   displaced CoM).
7. Map view silent: the engine places a `map` listener at the last outside flight camera (above).
8. Digital silence outside and a 120 Hz cabin hum: surface ambience beds (new takes) and a broadband cabin-fans
   take.
9. Airborne sound ignored the airflow: exact convected retarded delay with Mach-cone reach (unit tests for the
   crew above Mach 1 and trailing / beside chase cameras).

## Known limits (honest)

- **Not listened to by a human.** Mix levels were calibrated from measurements (bus/master RMS and peaks,
  band levels, spectrograms with level traces of every clip, which I inspected) against intended targets, not
  by ear. A blind description by an audio LLM (gpt-audio-1.5) was tried on the assets and discarded as
  unreliable: it described a 0.2 s click as a three-second engine swell. A reviewer should listen to
  `out/audio/*.wav`.
- **Generated content.** ElevenLabs takes match their prompts by band analysis, but individual takes may
  contain artefacts a listener would reject; regeneration is one command. `ambience-outdoor` was a very quiet
  take normalised by +30.8 dB (its own noise floor came up with it) and is a low (200 Hz centroid), gusty
  breeze; `ambience-ocean` is peak-limited at -28.8 LUFS. The creaks contain high harmonic squeals.
- **Master compression.** The master's 2:1 compression above -32 dBFS (+12 dB makeup) narrows the audible
  contrast between scenes compared with the bus levels in the table (e.g. pad breeze vs lift-off roar at
  445 m: 14 dB at the master). Lowering the makeup and raising bus gains trades this against bus headroom.
- **Surface ambience follows the active vessel**, not the listener: a ground camera loses the breeze once the
  rocket is 1.5 km up; there is no ambience in vacuum (the Moon outside is silent, by design).
- **External structure-borne share** is heard only by a camera attached to the vessel
  (`AudioListener.attachedVesselId`, request audio-1 resolved) and still fades with distance
  (`propagation.attach`): a chase camera beyond 250 m in vacuum hears nothing. The range may be widened in
  `data/defs/audio/mix.json` now that a ground camera no longer receives the share.
- `ambientPressure` of an interior listener is the OUTSIDE static pressure (now stated in the contract).
- **Memory:** each continuous voice owns one mono 20 s delay line (3.8 MB at 48 kHz): 7.7 MB for aero and
  reentry, +3.8 MB per sounding engine cluster (4 clusters lit at once: 23 MB in all); plus ~23 MB of shared
  noise buffers (19 MB audio-rate, 3.6 MB slow modulation).
- **Chrome offline renders of the full graph are not bit-reproducible** (re-rendering the same scene differs
  at about -73 dB re each tap, float rounding; small graphs are bit-exact). The unknown-mode criterion is
  therefore proved bit-exactly on the model's targets and, on audio, against that noise floor.
- **AudioWorklet not used.** Chrome's offline renders were not reproducible with processors created
  mid-render; seeded noise buffers (allowed by the brief) render identically live and offline.
- The lab places real vehicle parts with an approximate attach-node walk and runs a copy of the sim's engine
  law without propellant or flame-out (labs of this package may not import `src/sim`); good enough for
  listening, not a vehicle model.
- Engine ignition/shutdown transients come from `ModuleState` ages; `engineIgnition` / `engineShutdown` /
  `crewLost` / `soiChange` / `vesselRemoved` / `activeVesselChanged` / `warpChanged` (heard as the warp click
  through the watched `warp.index`) / `nodeCompleted` / `milestone` / `missionFailed` (alarm condition) have
  no events-bus one-shot of their own.
- Timings (`update()` cost, render times) were measured while the Earth bake ran: provisional.

## Requests

- `docs/requests/audio-1.md` (resolved by the lead between the waves, see its Resolution): add
  `AudioListener.attachedVesselId`, document `ambientPressure` for interior listeners, and document that the
  audio engine places a `kind: 'map'` listener itself (its position and pressure are not used).

## Changes by the lead between the waves (2026-11-10)

- `audio-1` resolved: `AudioListener.attachedVesselId: string | null` (required). `src/audio/model.ts` gives
  the faint structure-borne share only for sources on that vessel, faded with the listener's distance from
  that vessel's bounding sphere (`propagation.attach`, unchanged values); a free or ground-fixed camera
  hears none; a `kind: 'map'` listener inherits the attachment of the last outside flight camera (the
  stand-in before any is attached to the active vessel). The contract documents `ambientPressure` of an
  interior listener (outside static pressure) and the map-listener rule. Lab: `ListenerSpec.attachedVesselId`
  (default: the active vessel for external listeners; the `liftoff-pad` scene's pad camera passes null).

Full list: `docs/handoff/lead-baseline.md`.
