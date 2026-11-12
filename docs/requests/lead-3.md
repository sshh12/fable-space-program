Status: open
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
