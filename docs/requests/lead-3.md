Status: open (the core's half is built and verified: see "Resolution of the core's half"; translunar-earth meets the acceptance, leo-day is captured idle and equally exposed but its clouds differ between captures: request core-4, blocking; the app's hook is src/app's)
From: lead (lead-baseline-v2, review fix E)
Owner path: src/render/core (renderer.ts: the temporal sequences; lab/labApp.ts: the labs' window.__test), src/core/testing/testApi.ts (the base test API), src/app/testHooks.ts (the app's window.__test; app-integration)
Blocking: yes, for recording the reference images of ARCHITECTURE 31.3 (the lead records them on the visually signed-off tree, before sub-wave 3.2); nothing else waits for it

## Problem
A reference image must be the same picture on every load. Today a "deterministic" capture is: wait until the
page is idle (a variable time), let 64 + 4 frames pass, take a screenshot from Node at whatever frame is on
screen then. Everything that integrates over frames (TAA history and jitter phase, cloud and volumetric
reprojection, blue-noise phase, auto-exposure adaptation) is therefore at a different phase on every load.

## Evidence
`tests/browser/shell/baseline-tooling.spec.ts` (2026-11-11 23:55): two loads of
`/labs/integration/?scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1` differ in 18.3 %
of their pixels (mean 0.128, 99.9th percentile 7, maximum 95 levels; the differences sit on the vehicle's
specular highlights and on fine cloud and surface detail: `out/screens/baselines/leo-day.diff.png`). The
tolerance that follows (three times the difference: p99.9 21 levels) would let a 130 x 130 pixel patch change by
21 levels and pass. `scene=translunar` differs in 0.05 % of its pixels (maximum 112).

## Requested change
One optional hook on `window.__test`, declared in `src/core/contracts/testApi.ts` (already there, with this text):

```ts
renderExact?(frames: number): Promise<ExactFrame>;   // ExactFrame = { frames: number; idle: boolean; renderScale: number }
```

Precondition (the caller's): deterministic mode on with presentation time frozen (`setDeterministic(true)` and
`setPaused(true)`, or the labs' `deterministic=1&paused=1`), and `isIdle()` true. The page then, in this order:

1. **Restarts every temporal sequence at its origin.** In the render core: the TAA jitter index at 0 and the
   history dropped (what `setDeterministic` does today with `jitterIndex = 0; historyReset = true`); the
   blue-noise / frame index that features read from the frame uniforms at 0; the auto-exposure at a start value
   that depends only on the scene (not on where earlier frames left the adaptation: either the metered value
   of frame 0 applied at once, or a fixed start with a fixed number of adaptation steps inside the N frames);
   the governor off and the render scale held at its start value for the capture. Features that keep their own
   accumulation (cloud and volumetric reprojection, particle or noise phases, water foam history) reset it on
   the same signal: please give features one way to hear it (for example `frame.historyReset` or a
   `RenderFeature.resetTemporal?()` call) and list in RENDER_API.md what must reset.
2. **Renders exactly `frames` frames** with the fixed deterministic time step, the first being frame 0 of the
   restarted sequences. No streaming, upload or compilation work is admitted between them: what arrives stays
   queued, and the result reports `idle: false` so the harness waits for idle and asks again (it tries five
   times).
3. **Holds.** The last of those frames stays presented and nothing more is rendered, so a screenshot taken
   at any later moment shows that frame. The promise resolves once the held frame is on screen (after the
   frame following its submission has been composited: two `requestAnimationFrame` callbacks after the last
   submit is enough). The hold ends when `renderExact` is called again, when `setDeterministic(false)` is
   called, or with the page; the HUD and other DOM do not change during the hold.

The same page state and the same `frames` then give the same picture on every load, to the bit where the GPU
is deterministic. The labs get it through `createLabApp` (so every `labs/*` page has it), the app through its
test hooks. The base `installTestApi` leaves it undefined on pages without a renderer.

Must not change: what `setDeterministic`, `setPaused`, `waitFrames` and `isIdle` do today (every existing
spec uses them); the rendering of a normal frame.

How it is checked (the lead, with you, once it exists; one GPU slot): `BASELINE_TOOLING_PROOF=1 node
tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-tooling.spec.ts
--project=functional` records two checkpoints from three loads each into a proof directory. The acceptance
is that the three loads of each checkpoint are identical or differ only at the level of the manifest's floor
(mean 0.02, p99.9 1), `leo-day` included. If a scene still differs, the diff image says which feature did not
reset.

The harness side is done (`captureDeterministic` in `tests/browser/harness.ts` calls the hook and refuses a
page without it; `captureSettled` is the old behaviour for screenshots that are not references).

## Resolution of the core's half (shared-code maintainer, 038cf6f, 06c9167, 85c5c2c)

**What exists.** `window.__test.renderExact(frames)` on every page made with `createLabApp`;
`CoreRenderer.renderExact(frames, renderFrame)`, `holding`, `exactInfo()`; for features
`TemporalFeature.resetTemporal?()` (the one way to hear the restart) and `coreOf(ctx).sequenceIndex()` (the
frames since the sequences last started, for CPU-side sequences); RENDER_API section 13, "Frame-exact
capture", lists what must reset; NOTICE-core-5 tells the packages. `setDeterministic`, `setPaused`,
`waitFrames`, `isIdle` and a normal frame are as they were.

**The order, as built** (where it departs from the request's text, and why):

1. Every temporal sequence of the core at its origin (TAA jitter and history, the frame count of the frame
   uniforms, the blue-noise offset, `frame.realTime`, the shadow cascades' captures and stagger, the emitter
   hints), every feature's `resetTemporal()`, and ONE step of `frame.frameIndex` (2 to 65 frames, to 16
   short of a multiple of 64). The frame index is not set to 0: caches are stamped with it and it must stay
   monotonic. The step is what features without a `resetTemporal` drop their histories by (a failed
   continuity test); the frame uniforms count from 0.
2. The exposure: metered from nothing over 16 lead-in frames, each waiting for the histogram of the one
   before and taking its target at once, then held. Not inside the N frames: the histogram is read back
   asynchronously, so inside one task no frame can meter. If a feature is not idle after the 16 frames (the
   step set it to work), the rest of a block of 64 frames is rendered and the metering repeated, up to 8
   times; from the step to the last frame of the capture the frame index is consecutive.
3. The sequences start again (no step; the first frame's index is a multiple of 64) and exactly `frames`
   frames are rendered in one task. `idle` is false when anyone was busy before or after them; such a
   capture is NOT held (held, the work could never finish), the harness waits for idle and asks again.
4. Hold, as specified. The governor: deterministic mode already holds the render scale at 1.

**Verified** (one gated run, 2026-11-12 14:58; `tests/browser/render-core/exact.spec.ts`,
`tests/browser/integration/exact.spec.ts`, and your proof with `BASELINE_TOOLING_PROOF=1`):

| Page | Result |
|---|---|
| core lab (`scene=pad&site=moonview`), 32 frames | the same page after another history and a fresh load: max difference 0; EV100 15.529194927028358 three times; one metering |
| integration lab, translunar, every package, 64 frames | another history and a fresh load: max 0; EV100 15.07810637273619 three times; one metering |
| your proof, `translunar-earth` | three loads max 0; the next capture clean; the planted pixel row caught |
| integration lab, low orbit, every package | idle at the first attempt in all three captures (three meterings each: the terrain is at work for 80 to 144 frames after the step), EV100 15.023396782498619 three times; the PICTURES differ: another history mean 0.305 / p99.9 17 / max 54 / 19.1 % of pixels, a fresh load 0.149 / 9 / 86 / 15.6 % |
| your proof, `leo-day` | three loads max 0, then the next fresh load differs: mean 0.138, p99.9 10, max 45, 15.3 % of pixels: FAILS |

So the acceptance is met for `translunar-earth` and not for `leo-day`. What differs there is the clouds
(`out/screens/integration/exact-leo-day-same-page.diff.png`: the cloud fields' edges and cell detail, nothing
visible on the vessel or cloud-free ground). Before this round's last change the low-orbit page could not be
captured at all (the terrain busy at every attempt, five of five, twice).

**Open, and whose:**

1. The clouds: request `core-4` (atmosphere-clouds, blocking). Their march sequence and shadow rounds run
   on the absolute frame index (a golden-ratio phase, rounds of 48 or 96 frames), and the atmosphere feature
   has no `resetTemporal`. Three loads agreeing and a fourth not is what equal frame-index multiples would
   give; treat a `leo-day` reference recorded before `core-4` as unreliable even if three loads agree.
2. The terrain: request `core-2` (terrain-render), the addition of 15:10. Not a correctness fault any more:
   each capture with terrain in view takes three meterings instead of one (128 more frames).
3. The app: `src/app/testHooks.ts` needs `renderExact: (n) => renderer.renderExact(n, () => <the app's frame
   at the fixed step>)` and the frame loop must skip its frame while `renderer.holding` (the core refuses
   `render` during a hold anyway). Not mine.
4. Other packages: the vehicle has `resetTemporal` (vessel and site). Ocean, vfx, sky and cockpit have
   none; nothing of theirs differed on these two pages, which show no sea surface near, no plume and no
   cabin. Checkpoints that do are unproven.

## The app's half (app-integration, commit 732962c; not yet run in a browser)
`window.__test.renderExact(frames)` exists on the game's page: `src/app/testHooks.ts` -> `Game.renderExact` ->
`renderer.renderExact(frames, () => frame(performance.now()))`, the game's own frame function at the fixed
1/60 s step of deterministic mode (it ends in exactly one `render`). The game's loop skips its frame while
`renderer.holding` and only counts the display's frames. It refuses while the loading screen is up. The feature
wrapper of the app forwards `resetTemporal` (request core-5), so the features are restarted. Precondition as in
the contract: `setDeterministic(true)`, `setPaused(true)`, idle.
Spec: `tests/browser/app/app.spec.ts`, "frame-exact capture ...": `renderExact(8)` holds 8 frames; the harness's
`captureDeterministic(page, 64)`; no game frame and no change of the picture during the hold; a second capture's
difference from the first is logged, not asserted (the clouds: request core-4); `setDeterministic(false)` lets the
game run again. It runs with the app specs in the short gate run before the mission.
