# WebGPU browser test harness — research + proven spike

Spike code: `spikes/harness/` (own `package.json`; `npm install` there, no browser download needed).
Everything below was measured on this machine on 2026-11-09: Windows 11, RTX 5090 (driver 32.0.16.1088) + AMD iGPU,
4K 60 Hz display on the NVIDIA card, Chrome 156.0.8078.80, Edge 157.0.4341.42, Playwright 1.65.0, Node 24.

| Script | What it proves | Result |
|---|---|---|
| `node run-probe.mjs [filter]` | launch matrix (channel x headed/headless x flags) -> adapter | 14/16 configs give RTX 5090; see section 1 |
| `node run-all.mjs [chrome\|msedge] [headless\|headed]` | adapter assert, features/limits, screenshots, HDR/depth readback, input, audio, frame timing | PASS for chrome-headless, chrome-headed, msedge-headless |
| `node run-extra.mjs` | allocation limits, 4K/DPR screenshots, Edge diff, worker WebGPU | all ok |
| `node run-concurrent.mjs [N]` | N separate node processes + browsers at once, GPU lock, autoplay policy | 4x headless and 4x headed all correct |

Raw outputs land in `spikes/harness/out/` (git-ignored): `results-*.json`, `probe.json`, `gpu-*.txt` (chrome://gpu dumps), PNGs.

## TL;DR recommendations

1. **Use Playwright + `channel: 'chrome'` + `headless: true`** (new headless). It runs WebGPU on the RTX 5090 via D3D12,
   is pixel-identical to headed, needs no window, and is immune to occlusion/focus problems. Use `channel: 'msedge'` for the Edge pass.
   Do **not** use Playwright's bundled `chromium` headless (that is `chromium_headless_shell`: `requestAdapter()` returns `null`).
2. **Always assert the adapter** at the start of every browser test: `adapter.info.vendor === 'nvidia'`, `!isFallbackAdapter`,
   and (with `--enable-webgpu-developer-features`) `description` matches `/RTX 5090/`. There is no silent SwiftShader fallback
   for WebGPU on this setup, but a hard assert costs nothing.
3. **Perf tests: keep vsync ON and measure GPU time with `timestamp-query`** (plus CPU frame time and rAF p99).
   Uncapped rAF (`--disable-frame-rate-limit`) is *not* back-pressured by the GPU and reports nonsense FPS for heavy scenes (section 3).
4. **Screenshots: `page.screenshot()` just works** (55 ms at 720p, 115 ms at 4K) and is byte-identical to `canvas.toDataURL()` and
   deterministic when time is frozen through the test API.
5. **Concurrency is free** (`chromium.launch()` = unique temp profile + pipe transport; server on port 0). Only *perf* numbers need
   a machine-wide lock (`withGpuLock` in `lib/harness.mjs`).

## 1. Launching real Chrome/Edge with WebGPU on the RTX 5090

### Launch matrix (measured, `out/probe.json`)

| Config | Adapter (`adapter.info`) | rAF |
|---|---|---|
| chrome, headless, **no extra flags** | nvidia / blackwell (device+description empty without dev flag) | 60 |
| chrome, headless, baseline flags | nvidia / blackwell / 0x2b85 / "NVIDIA GeForce RTX 5090" | 60 |
| chrome, headed, no flags / baseline | same | 60 |
| msedge, headless / headed, baseline | same (Edge exposes 1 more feature: `atomic-vec2u-min-max`; limits identical) | 60 |
| chrome, any, `powerPreference: 'low-power'` or omitted | **still NVIDIA** | 60 |
| chrome, headless, `forceFallbackAdapter: true` | `requestAdapter()` -> `null` (no SwiftShader WebGPU, even though Playwright passes `--enable-unsafe-swiftshader`) | - |
| bundled chromium 158, headed | RTX 5090 | 60 |
| bundled chromium 158, headless (`chromium_headless_shell`) | **`requestAdapter()` -> `null`** | - |

Findings:

- Chrome prints `The powerPreference option is currently ignored when calling requestAdapter() on Windows (crbug.com/369219127)`.
  Adapter choice is whatever the GPU process picked. Here that is the NVIDIA card in all cases (it drives the display;
  chrome://gpu shows `GPU0 ... RTX 5090 *ACTIVE*`, `GPU1 AMD Radeon`). `--force_high_performance_gpu` is kept in the baseline as
  insurance; the app should still pass `powerPreference: 'high-performance'` (correct on other OSes / future Chrome) **and show a
  visible error if the adapter is not a discrete GPU**.
- Backend is D3D12 (Dawn error text references `ID3D12Device`); chrome://gpu: `WebGPU: Hardware accelerated`,
  ANGLE on D3D11 for the compositor. No `--enable-unsafe-webgpu`, `--ignore-gpu-blocklist`, `--use-angle`, or `--enable-gpu` needed.
- `adapter.info.device` / `.description` are **empty strings unless `--enable-webgpu-developer-features`** is passed.
  `vendor` ("nvidia") and `architecture` ("blackwell") are always available. Production code must not depend on `description`.
- Launch is fast: ~200 ms for chrome, ~250-290 ms for msedge. A fresh browser per test file is affordable.
- Playwright adds on its own (seen in chrome://version): `--headless` (new headless when a channel is used), `--mute-audio` and
  `--hide-scrollbars` (headless only), `--no-sandbox`, `--force-color-profile=srgb`, `--disable-background-timer-throttling`,
  `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, a unique
  `--user-data-dir=%TEMP%\playwright_chromiumdev_profile-XXXXXX`, and `--remote-debugging-pipe` (no TCP port).
- UA in headless contains `HeadlessChrome/156` — never UA-sniff.

### Baseline flags (`chromeArgs()` in `lib/harness.mjs`)

```js
const args = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion', // headed: overlapped windows keep rendering
  '--force_high_performance_gpu',                   // insurance on dual-GPU machines
  '--autoplay-policy=no-user-gesture-required',     // AudioContext starts 'running' at page load
  '--mute-audio',                                   // no sound from speakers; WebAudio graph still runs
  '--enable-webgpu-developer-features',             // un-quantised timestamp-query + adapter.info.description
];
// perf-uncapped variant only: '--disable-frame-rate-limit' (this alone uncaps), '--disable-gpu-vsync' (alone does nothing)
const browser = await chromium.launch({ channel: 'chrome', headless: true, args });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
```

Unverified detail: Playwright already passes its own `--disable-features=...` list and the baseline adds a second
`--disable-features=CalculateNativeWinOcclusion` later on the command line. Which occurrence Chrome honours was not isolated
here; every test passed either way (4 overlapping headed windows held 58-60 fps). If a feature toggle ever seems to be ignored,
this is the first thing to check.

### Adapter assertion (use in every browser test)

```js
const a = await page.evaluate(() => window.__harness.adapter);
if (a.vendor !== 'nvidia' || a.isFallbackAdapter || !/RTX 5090/.test(a.description)) throw new Error('wrong adapter ' + JSON.stringify(a));
```

In-page: `const info = adapter.info; ({vendor, architecture, device, description, isFallbackAdapter} = info)`.
`isFallbackAdapter` lives on `adapter.info` in Chrome 156 (the spike reads both places).

## 2. HDR scene + screenshots

The spike page (`page/main.js`, plain JS, no build step) renders 2 305 to 4 000 001 instanced lit boxes + procedural sky into an
`rgba16float` target with a `depth32float` **reversed-Z, infinite-far** depth buffer (clear 0, compare `greater`), then an ACES
tonemap + sRGB OETF pass to the `bgra8unorm` canvas (`navigator.gpu.getPreferredCanvasFormat()` returns `bgra8unorm` here).

Reversed-Z infinite projection used (column-major; `depth = near / distance`):

```js
const f = 1 / Math.tan(fovy / 2);
[f/aspect,0,0,0,  0,f,0,0,  0,0,0,-1,  0,0,near,0]
```

Verified by GPU readback (`__harness.readHDR()` copies both textures to buffers):

| Check | Value |
|---|---|
| HDR target max luminance, normal view | 21.5 (39 % of pixels > 1.0) -> float values survive, not clamped |
| HDR target max luminance, looking at sun disk | 3667.5, 0 NaN pixels |
| Depth buffer | sky fraction with depth exactly 0: 23 %; max 0.0037; centre pixel 0.001117 -> 89.5 m (camera is 95 m from target) |

Screenshot results (`out/results-*.json`), time frozen with `__harness.setTime(12.5)` then `waitFrames(4)`:

| Method | 1280x720 result |
|---|---|
| `page.screenshot()` | mean luma 201.7, std 33.7, 100 % non-black, 55 ms (headless) / 70 ms (headed) |
| `page.locator('#c').screenshot()` | byte-for-byte equal pixels to the above |
| in-page `canvas.toDataURL()` | **max abs diff 0** vs `page.screenshot()` |
| same shot twice | max abs diff 0 (deterministic) |
| headless vs headed vs Edge | identical statistics and centre pixels |
| 3840x2160 viewport (headless, bigger than needed) | PNG 115 ms, JPEG q85 73 ms, 640x360 `clip` 30 ms |
| `deviceScaleFactor: 2`, 960x540 CSS | canvas 1920x1080, screenshot 1920x1080 |

Gotchas:

- `canvas.toDataURL()` / `toBlob()` / `drawImage(canvas)` only see the WebGPU frame **in the same task that rendered it**
  (the canvas texture expires at end of task). `__harness.captureDataURL()` renders then reads synchronously. `page.screenshot()`
  has no such restriction (it captures the compositor output).
- Read the PNG back and assert on it (`pngStats` + `assertRealImage` in `lib/harness.mjs`: non-black fraction, luma std-dev,
  distinct-colour buckets). A black frame passes `fs.existsSync`.
- For golden-image tests the app needs a deterministic mode: fixed sim time, fixed camera, wait for N presented frames **and**
  for streaming to settle (expose `__test.isIdle()`: no pending tile fetches/uploads/pipeline compiles).
- Headless viewport is not limited by the physical screen (3840x2160 worked). Headed windows larger than the desktop work area
  were not tested and may be clamped by Windows; use headless for 4K captures.
- Playwright forces `--force-color-profile=srgb`, so captures are sRGB regardless of the monitor profile.
- HDR canvas output is available (`context.configure({format:'rgba16float', colorSpace:'display-p3', toneMapping:{mode:'extended'}})`
  validated OK) but screenshots are 8-bit sRGB; test through the SDR tonemap path and verify HDR values by texture readback.
- Favicon 404 shows up as a console error; serve one or filter it before asserting "no console errors".

## 3. Frame timing

`page/main.js` records rAF deltas, CPU encode time, and GPU pass durations via `timestampWrites` on both passes
(4-entry query set -> `resolveQuerySet` -> pooled `MAP_READ` buffers). 1280x720 unless noted; headless Chrome (headed and Edge
agree within noise).

| Scene | vsync rAF (fps / p50 / p99 ms) | GPU scene pass p50 / p99 ms (timestamp-query) | batch benchmark ms/frame | serial benchmark ms/frame | "uncapped" rAF fps (misleading) |
|---|---|---|---|---|---|
| 2 305 boxes (27 k tris) | 60.0 / 16.67 / 16.73 | 0.031 / 0.032 | 0.08-0.12 | 3.0 | 4 380 |
| 1 M boxes (12 M tris) | 60.0 / 16.67 / 16.73 | 8.02 / 8.41 | 7.92 | 9.51 | 465 (!) |
| 4 M boxes (48 M tris) | 32.0 / 33.33 / 83.3 | 31.7 / 32.7 | 31.46 | 33.14 | 418 (!!) |
| 1 M boxes at 3840x2160 | - | 7.91 / 8.65 (tonemap pass 0.019) | 8.13 | - | 118 |

Conclusions:

- **Vsync caps measurement**: both headless (synthetic 60 Hz) and headed (60 Hz monitor; `Win32_VideoController` reports 59) give
  rAF = 16.667 ms, p99 16.73, max 16.74. Under load rAF quantises to multiples of 16.67 (the 31.5 ms scene reports 33.33).
- **To uncap**: `--disable-frame-rate-limit` (alone is sufficient: 4 160-4 380 fps on the light scene).
  `--disable-gpu-vsync` alone changes nothing (still 60.0). The spike's `uncapped: true` passes both.
- **Uncapped rAF is not a GPU benchmark.** With `--disable-frame-rate-limit`, rAF callbacks fire every ~0.25 ms regardless of
  GPU load and frames pile up; back-pressure only arrives in bursts (p95 = one GPU frame). The 4 M scene "runs" at 418 fps by
  rAF count while the GPU completes 32 frames/s. Never assert on rAF fps in uncapped mode.
- **What to assert for "60 fps on the target GPU"** (run with vsync on, 3-10 s window, after warm-up):
  1. rAF delta p99 <= 17.5 ms and zero deltas >= 33 ms (no dropped frames);
  2. sum of GPU pass times (timestamp-query) p99 <= ~11 ms (leaves headroom; this is the real margin number, vsync hides it);
  3. CPU main-thread frame time (`performance.now()` around the frame function) p99 <= ~6 ms.
- **Headroom / throughput number without vsync**: `__harness.benchmark(n, 'batch')` renders n frames to an offscreen texture
  back-to-back and awaits `device.queue.onSubmittedWorkDone()` once; ms/frame matches the timestamp-query totals within 1 %
  (7.92 vs 7.90; 31.46 vs 31.43). `'serial'` mode awaits after every frame and adds 1.5-3 ms of IPC round trip per frame
  (3.0 ms floor on a 0.03 ms scene) — use it only for distributions, not absolutes. Both work with default (vsync) flags, so
  a separate uncapped browser launch is not required for perf tests.
- **timestamp-query precision**: default Chrome quantises to **65 536 ns** steps (raw deltas observed: 0, 65536, 327680 ns), useless
  below ~0.1 ms per pass. With `--enable-webgpu-developer-features` raw values are exact (e.g. 31136, 29632 ns). Keep the flag in
  the harness; production code must tolerate quantised values.
- Timestamp deltas are wall-clock on the GPU timeline: with 4 browsers rendering at once the same pass reads 13-18 ms instead of
  3.8 ms. Perf numbers are only valid when the test owns the GPU (section 7).
- `performance.now()` resolution is 5 us (observed: all CPU timings are multiples of 0.005 ms) because the spike server sends
  COOP/COEP headers (`crossOriginIsolated === true`); without isolation browsers coarsen it to 100 us (per spec, not measured here). The app's dev server and tile server should send the same headers
  (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`; cross-origin tile responses then need
  `Cross-Origin-Resource-Policy: cross-origin` or CORS) — this also enables `SharedArrayBuffer` for worker-based physics/streaming.
- First rAF delta after `page.setViewportSize` + navigation was ~2.4 s once (4K target reallocation + first present). Always discard warm-up frames
  (`waitFrames(20)` then `resetStats()`).
- CPU encode time in uncapped mode shows 8-31 ms spikes: `getCurrentTexture()`/`submit` block when the swap chain is full. Not seen with vsync.

## 4. Input + test API

Pattern: the page exposes `window.__harness` (the game should expose `window.__test`), with a `ready` promise, state getters and
deterministic controls. Playwright calls it with `page.evaluate`. Real input goes through CDP so the app's normal DOM listeners
are exercised — this satisfies "test scripts may drive the controls, no cheats".

Verified in headless + headed Chrome and Edge:

| Action | Observed |
|---|---|
| `keyboard.down('KeyD')`, wait 500 ms, `keyboard.up` | `keydown`/`keyup` with correct `event.code`; held-key set contained `KeyD`; camera yawed 0.60-0.62 rad (expected 0.60) |
| `keyboard.press('Shift+KeyZ')`, `press('Space')` | `d:ShiftLeft d:KeyZ u:KeyZ u:ShiftLeft`, `d:Space u:Space` |
| `mouse.move/down/move(steps:10)/up` 200 px drag | `pointermove` with `movementX` summing to exactly 200 -> yaw 1.000 rad |
| `mouse.wheel(0, 400)` | headless: `deltaY` 400. **headed: `deltaY` 600** (scaled by Windows display scaling) |
| `canvas.requestPointerLock({unadjustedMovement:true})` from `page.evaluate` | granted in headless and headed; `movementX/Y` keep arriving while locked (100, 60 for a 100x60 move) |

Gotchas:

- Use `event.code` (`KeyW`, `ShiftLeft`) in the game's input layer, and Playwright key names that are codes (`'KeyD'`, `'Space'`).
- Never assert on exact wheel deltas; drive throttle etc. with keys, or normalise wheel by sign.
- `page.evaluate` runs with a user activation (CDP `userGesture`), which is why pointer lock and `AudioContext.resume()` succeed
  from it. Code that runs on its own at page load has **no** activation (section 6).
- Key holds are wall-clock: `down -> waitForTimeout(ms) -> up` has a few ms of jitter (0.60 vs 0.62 rad above). For the scripted
  mission, close the loop on sim state instead of timing: `await page.waitForFunction(() => __test.state().apoapsis > 185e3)` then
  release the key. Polling `waitForFunction` defaults to rAF cadence, i.e. one frame of latency.
- Click the canvas (or `canvas.focus()`) before sending keys; the spike canvas has `tabindex=0`.
- The test API must be read-only with respect to physics (state getters, time-warp via the same code path as the UI keys,
  screenshot/determinism helpers). Do not add setters for vehicle state, or the mission proof is void.

## 5. Features and limits on this adapter (Chrome 156, D3D12, RTX 5090)

Requested everything with `requestDevice({ requiredFeatures: [...adapter.features], requiredLimits: {max...} })`: all granted.

Features (21): `bgra8unorm-storage`, `clip-distances`, `core-features-and-limits`, `depth-clip-control`, `depth32float-stencil8`,
`dual-source-blending`, `float32-blendable`, `float32-filterable`, `indirect-first-instance`, `primitive-index`,
`rg11b10ufloat-renderable`, `shader-f16`, `subgroup-size-control`, `subgroups`, `texture-component-swizzle`,
`texture-compression-bc`, `texture-compression-bc-sliced-3d`, `texture-compression-unaligned`, `texture-formats-tier1`,
`texture-formats-tier2`, `timestamp-query`. Edge 157 adds `atomic-vec2u-min-max`.

Not available (as expected on desktop D3D12): `texture-compression-etc2`, `texture-compression-astc`.

| Asked about | Status |
|---|---|
| timestamp-query | yes (quantised to 65.5 us without dev flag) |
| float32-filterable | yes (linear sampling of `r32float` validated by pipeline + bind group creation) -> float heightmaps can be filtered |
| float32-blendable | yes |
| texture-compression-bc | yes (`bc7-rgba-unorm-srgb`, `bc6h-rgb-ufloat` textures created) |
| depth32float-stencil8 | yes |
| indirect-first-instance | yes |
| dual-source-blending | yes (useful for atmosphere transmittance + inscatter in one pass) |
| shader-f16, subgroups, clip-distances, rg11b10ufloat-renderable | yes |
| rgba16float MSAA x4 render target, depth32float MSAA x4 | yes |
| compute pipelines + storage buffers | yes (executed, result verified) |
| WebGPU in a dedicated worker with transferred `OffscreenCanvas` | yes (same RTX 5090 adapter) |

Limits (adapter == device when requested):

| Limit | Value |
|---|---|
| maxTextureDimension1D / 2D | 16384 |
| maxTextureDimension3D | 2048 |
| maxTextureArrayLayers | 2048 |
| maxBufferSize | 2 147 483 648 (2 GiB) |
| maxStorageBufferBindingSize | 2 147 483 644 |
| maxUniformBufferBindingSize | 65 536 |
| maxStorageBuffersPerShaderStage | 16 (also 16 in vertex and fragment stages) |
| maxStorageTexturesPerShaderStage | 8 |
| maxSampledTexturesPerShaderStage | 48 |
| maxSamplersPerShaderStage | 16 |
| maxUniformBuffersPerShaderStage | 12 |
| maxBindGroups | 4 |
| maxBindingsPerBindGroup | 1000 |
| maxBindGroupsPlusVertexBuffers | 24 |
| maxVertexBuffers / maxVertexAttributes | 8 / 30 |
| maxColorAttachments / maxColorAttachmentBytesPerSample | 8 / 128 |
| maxInterStageShaderVariables | 28 |
| maxDynamicUniform / StorageBuffersPerPipelineLayout | 10 / 8 |
| min uniform / storage buffer offset alignment | 256 / 256 |
| maxComputeInvocationsPerWorkgroup, workgroup size X/Y/Z | 1024, 1024/1024/64 |
| maxComputeWorkgroupsPerDimension | 65535 |
| maxComputeWorkgroupStorageSize | 32768 |
| maxImmediateSize | 64 |

Design-relevant notes: `maxBindGroups` is only **4** (plan group layout: frame / pass / material / object). Most of these are
well above WebGPU defaults (default 2D size 8192, 256 layers, 256 MiB buffers, 8 storage buffers, 16 sampled textures), and
**defaults are what you get unless `requiredLimits` is passed** — the engine must request the raised limits it relies on and
fail loudly if the adapter is below them.

Allocation probes (`run-extra.mjs`, each wrapped in `out-of-memory` + `validation` error scopes):

| Allocation | Result |
|---|---|
| 2048x2048x256 rgba8 array (4 GiB single resource) | **out-of-memory** (`ID3D12Device::CreateCommittedResource`) |
| 2048x2048x120 rgba8 array (1.9 GiB) | ok |
| 1024x1024x2048 BC7 array (2 GiB) | ok |
| 512x512x2048 rgba8 array (2 GiB) | ok |
| 16384x16384 r8 / rgba8 (1 GiB) / rgba16float (2 GiB) | ok |
| 1 GiB buffer, 2 GiB buffer (= maxBufferSize) | ok |
| 24 x 1 GiB render-target textures, all cleared, held simultaneously | ok, no OOM (stopped at the 24 GiB cap) |

So single resources fail somewhere between 2 and 4 GiB; total VRAM use of at least 24 GiB is possible from one tab. Tile caches should
be several <= 2 GiB texture arrays. OOM is reported as an **uncaptured error unless an `out-of-memory` error scope is pushed**; the
device was not lost. The engine should wrap large allocations in OOM scopes and install `device.onuncapturederror` (tests should
fail on any uncaptured GPU error — `__harness.errors` does this in the spike).

WGSL language features: `buffer_view`, `immediate_address_space`, `linear_indexing`, `packed_4x8_integer_dot_product`,
`pointer_composite_access`, `readonly_and_readwrite_storage_textures`, `subgroup_id`, `subgroup_uniformity`,
`swizzle_assignment`, `texture_and_sampler_let`, `texture_formats_tier1`, `uniform_buffer_standard_layout`,
`unrestricted_pointer_parameters`.

Other: `navigator.hardwareConcurrency` 32, `navigator.deviceMemory` 32, `subgroupMinSize`/`MaxSize` 32.

## 6. Audio in the automated browser

| Case | `AudioContext.state` |
|---|---|
| Created by page script at load, **no flag**, headless or headed | `suspended` (stays suspended, `currentTime` 0) |
| Created by page script at load, `--autoplay-policy=no-user-gesture-required` | `running`, clock advancing |
| Created inside `page.evaluate(...)`, with or without the flag | `running` (evaluate carries a user gesture) — do not let this fool you |

- Keep the autoplay flag in the harness; the game itself must still create/resume its context on the first real key or click
  (real users have no flag). Test that path with `page.keyboard.press` before asserting on sound.
- `--mute-audio` (Playwright adds it in headless anyway; the baseline adds it for headed too) silences the speakers only. The graph
  keeps processing: sample rate 48 000, `baseLatency` 0.01 s, `outputLatency` 0.04 s, 2 channels.
- **Level verification with `AnalyserNode` on the master bus** (`fftSize` 8192, `smoothingTimeConstant` 0,
  `getFloatTimeDomainData` -> RMS/peak, `getFloatFrequencyData` -> dominant bin). Measured on a 220 Hz sine at gain 0.25:
  RMS 0.17684 (theory 0.17678), peak 0.2500, dominant 222.7 Hz (bin width 5.9 Hz). After switching to 880 Hz at 0.05:
  RMS 0.0353, 878.9 Hz. Gain 0: RMS exactly 0. Identical in headless, headed and Edge.
- **`OfflineAudioContext` for deterministic DSP tests**: 2 s stereo at 48 kHz rendered in 2.2 ms; open-path RMS 0.353566 vs
  theoretical 0.353553; after a scheduled lowpass sweep to 100 Hz the 440 Hz tone dropped to RMS 0.0188 (-25 dB). This is how to
  unit-test "muffled in vacuum" and throttle->rumble mappings: build the audio graph through a factory that accepts any
  `BaseAudioContext`, render offline with scripted parameter automation, assert band energies.
- Recommended app hook: `__test.audio()` returning `{ state, masterRms, masterPeak, bands: {low, mid, high}, perBus: {engine, wind, reentry, ui} }`
  from analysers on each bus, so the mission test can assert e.g. engine bus RMS rises with throttle and high band energy falls
  as ambient pressure goes to zero.
- Not tested here: `decodeAudioData` of real assets, `AudioWorklet`, and behaviour on a machine with no audio output device.

## 7. Running several harness instances concurrently

Proven with `node run-concurrent.mjs 4`: four separate node processes, each its own static server and its own Chrome, all at once.

- **Profiles**: `chromium.launch()` creates a unique `%TEMP%\playwright_chromiumdev_profile-XXXXXX` per browser and removes it on
  close (none of the ~60 browsers launched here left one behind; 7 older ones from 6-7 Nov, not from this work, were left untouched). Do not use `launchPersistentContext` with a shared dir, and never point at the user's real Chrome profile.
- **Ports**: Playwright uses `--remote-debugging-pipe` (no CDP port). The static server binds `127.0.0.1:0` and reports the
  OS-assigned port (`startServer()`); observed ports were all distinct. The real app's test runner must do the same: start Vite
  (or the built `dist` + tile server) on port 0 / `strictPort: false` and pass the URL to the test, never hard-code 5173.
- **Correctness under concurrency**: all 4 headless and all 4 headed (overlapping windows) instances got the RTX 5090 and produced
  the identical screenshot (mean luma 205.73, same centre pixel), zero errors, `visibilityState` `visible`.
- **Headed windows that overlap keep rendering** at 58-60 fps with the baseline flags (occlusion tracking disabled). Headed
  windows pop up on the user's desktop and can take focus; prefer headless for anything unattended.
- **Perf interference is large**: the 490 k-box scene costs 3.84 ms GPU alone, 13-14 ms with 4 headless instances
  (rAF p99 33 ms, 54 fps), 18 ms with 4 headed. Functional tests are fine concurrently; perf assertions are not.
- **`withGpuLock(fn)`** (`lib/harness.mjs`): machine-wide mutex via exclusive create of `%TEMP%\fable-gpu-perf.lock` containing
  the owner pid, with dead-owner detection. Verified: 4 contenders ran their measurement windows strictly one after another.
  Caveat seen in the same run: waiters whose pages were still rendering in the background polluted the holder's numbers
  (holder measured 8.7 and 5.9 ms instead of 3.8-4.0). So either take the lock **before launching the browser** for perf tests,
  or pause rendering (`__harness.pause()`) while waiting. Only the last, uncontended holder measured the solo value (4.05 ms).
- Output files: write to per-run directories (`out/<testname>-<pid>/`), not shared filenames.
- Vitest (headless physics) is CPU-only and does not interact with any of this.

## 8. Gotcha list

1. Bundled Playwright `chromium` in headless mode = headless shell = **no WebGPU adapter**. Always set `channel`.
2. `powerPreference` is ignored on Windows; assert the adapter instead of trusting the hint.
3. `adapter.info.description`/`device` are empty without `--enable-webgpu-developer-features`.
4. timestamp-query is quantised to 65 536 ns without that flag.
5. `--disable-frame-rate-limit` uncaps rAF but rAF then says nothing about GPU throughput; `--disable-gpu-vsync` alone is a no-op.
6. Vsync'd rAF quantises to 16.67 ms multiples; use GPU timestamps for margins.
7. `canvas.toDataURL()` must run in the task that rendered; `page.screenshot()` has no such limit.
8. `page.evaluate` grants user activation; page-load code does not. Autoplay flag needed for audio-at-load tests.
9. Headed `mouse.wheel` deltas are scaled by OS display scaling (400 -> 600 here).
10. GPU OOM arrives as an uncaptured error (device not lost) unless an OOM error scope is active; single resources above ~2 GiB fail.
11. Limits default to WebGPU minimums unless requested in `requiredLimits`.
12. `maxBindGroups` is 4.
13. Concurrent browsers triple or quadruple GPU pass times; serialise perf tests with the lock and keep other renderers paused.
14. Discard warm-up frames; the first frame after a resize to 4K took ~2.4 s once.
15. Favicon 404 appears as a console error.
16. Headless UA says `HeadlessChrome`.
17. A Git Bash heredoc containing JS template literals failed to parse once during this work; write source files with the Write tool.
18. Always `await browser.close()` in a `finally`; after all runs here no `chrome.exe`/`msedge.exe` with a Playwright profile remained.

## 9. Suggested shape for the real test suite

```
tests/
  browser/
    harness.ts        # startServer(port 0), launch({channel, headless}), chromeArgs(), assertAdapter(), pngStats(), withGpuLock()
    smoke.spec.ts     # boots app, asserts adapter, no GPU errors, non-black screenshot at pad
    visual/*.spec.ts  # deterministic screenshots at pad / ascent / orbit / lunar surface / deep space
    perf.spec.ts      # under withGpuLock: vsync on, rAF p99, GPU timestamp totals, CPU frame time at each viewpoint, 1080p and 4K
    mission.spec.ts   # drives keys only; closes loops on window.__test.state(); screenshots at milestones
    audio.spec.ts     # bus analysers respond to throttle / pressure; OfflineAudioContext graph tests
```

App-side `window.__test` contract proposed from this spike: `ready` (promise), `errors[]` (window errors, unhandled rejections,
`device.onuncapturederror`, WGSL compile errors, device lost), `adapter`, `state()` (read-only sim snapshot), `isIdle()`
(streaming/compile queue empty), `frameStats()` / `resetFrameStats()` (rAF, CPU, per-pass GPU ms), `waitFrames(n)`,
`setDeterministic({time, seed})` for visual tests only, `audio()`.

Plain `playwright` (library) was used rather than `@playwright/test`; both work with the same launch options. With
`@playwright/test`, set `use: { channel: 'chrome', headless: true, launchOptions: { args } }`, `workers: 1` for the perf and
mission projects, and `fullyParallel` only for functional/visual projects.
