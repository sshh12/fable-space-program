Status: resolved (notice, nothing to answer)
From: core-support
Owner path: every render feature (src/render/terrain, vehicle, cockpit, ocean, sky, atmosphere, vfx; src/map; src/ui), src/app (the lead), tests of the packages
Blocking: no

## Problem
Changes of the shared code on 2026-11-12 (shared-code maintainer, after NOTICE-core-4) that give you something
to use or change what your pictures and tests see. Each has a migration line. The first one is worth a few
minutes of every feature package in its next round: the pad's load waits for the synchronous compiles until
20.4 s of its 28.7 s.

## Evidence
`docs/handoff/core-support.md` section 10; RENDER_API sections 5 ("Pipelines created ahead"), 10, 13
("The world in the windows of the seat's view", "Frame-exact capture"), 17.8 and 18; the resolutions of the
requests named below.

## Requested change
- **Create your pipelines ahead: `coreOf(ctx).shaders.warm([...])`** (request app-integration-11). On the pad the
  game creates some eighty pipelines synchronously while it starts. The call returns at once, but the GPU
  process compiles them one after the other on its main thread and everything queued behind them waits: the
  loading screen's "shader modules compiled" row ends 20.4 s after navigation, and the first frame stands for
  4.3 s in the first hook that writes to the queue (the terrain's tile uploads). `createRenderPipelineAsync`
  compiles on worker threads, several at a time. `shaders.warm(items)` gets the pipelines of your tracked items
  (`shaders.tracked(...)`, `fullscreenPipeline(...)`) created that way without changing them:
  ```ts
  // end of init(), where `a.get(); b.get(); c.get();` stood:
  await coreOf(ctx).shaders.warm([a, b, c]);
  ```
  Recipe with the variants (start it early in `init` and await it at the end; pipelines made on first use;
  pipelines needed inside `init`): RENDER_API 17.8. Measured on the device (`tests/browser/render-core/warm.spec.ts`):
  six pipelines of 260 statements each take 886 ms created one after the other and 184 ms ahead, and the
  `get()` that follows leaves the GPU process 0.6 ms of work. The core's own thirteen are created this way now.
  Migration: none is forced (a `get()` builds synchronously as before); to adopt, replace the forcing `get()`s
  of your `init`. `?warm=0` on any page is the old behaviour, for an A/B of your load.
  Also: `shaders.pendingCompilations()` / `compilations()` now count pipelines that are being created ahead
  (a loading screen that waits for 0 waits for them; `renderer.isIdle()` is false meanwhile), and
  `await renderer.warm()` after the last `addFeature` resolves when everything started ahead exists
  (`createLabApp` does it; for src/app it is one line before the frame loop starts, the lead's decision).
- **Frame-exact capture: `window.__test.renderExact(frames)`** (request lead-3; every `createLabApp` page has it).
  It restarts every temporal sequence, renders exactly `frames` frames and holds the last. What reaches you:
  - `frame.frameIndex` moves to a multiple of 64 at a restart (a step of 2 to 65 frames, still monotonic): a phase you take
    from it with a power of two starts at 0, and `last === frame.frameIndex - 1` is false once. The frame
    uniforms' `time.z` / `counts.z` are the frames SINCE the restart (identical to the frame index until one
    happens). `frame.realTime` is 0 after a restart.
  - Your feature may have `resetTemporal?(): void` (`TemporalFeature` of `@/render/core`): the core calls it
    at a restart. Drop every history you blend with (reprojection, accumulation, foam, maps refined over
    frames, probes that converge), restart every phase that is not a power-of-two of `frame.frameIndex`, snap
    smoothed values to their targets. The rule and the list: RENDER_API section 13, "Frame-exact capture".
  - If a restart sets you to work (`isIdle()` false after the frames), the capture is not held and the
    harness asks again: a feature that is busy after EVERY restart can never be captured. Who was busy:
    `renderer.exactInfo()`; the check with every package: `tests/browser/integration/exact.spec.ts`.
  Migration: none for a feature without accumulation of its own. The app's test hook needs
  `renderExact: (n) => renderer.renderExact(n, () => frameAtFixedStep())` and a loop that skips its frame
  while `renderer.holding` (src/app/testHooks.ts and game.ts: the lead's).
- **Interior views: the world in the windows** (request cockpit-16). With a bright outside in view (lit
  geometry beyond 8 m or daylight sky, from 0.2 % of the frame, three stops and more over the cabin) the cabin
  is keyed up to 2.25 EV lower, and the pixels beyond 8 m (sky included) are shown at their own exposure: a
  gain under 1 on them before the resolve and the bloom, which puts their brightest tenth three stops over
  mid-grey. `exposureInfo()` gained `farGain`, `farLevel`, `farWeight`; `MeterInput.histogramSky`,
  `MeterResult.farLevel / farWeight`, `interiorFarGain`. Migration: none in code. Cockpit: what you draw in
  `drawTransparent` over far pixels (glazing, its reflections) is scaled with them; pictures from the seat
  are about two stops darker in the cabin when a window shows the day, and the window shows the day. Tests
  that read the HDR target of an interior view read the scaled values beyond 8 m.
- **Soot is a density** (request vehicle-pad-7; mesh G-buffer shader, `standard` shading): continuous in the
  weight, a brown veil when thin and near black when thick, in streaks of 6 cm x 1.5 m along v. Migration:
  none in code; a weight that had an edge at 0.36-0.63 by the old mask is graded now (weight 0.25 is a tan
  veil, about two thirds of the paint's luminance; 0.5 brown; 1 near black). Frost is unchanged.
- **The sun through the air at the camera** (request atmosphere-clouds-10, part 1): inside an atmosphere the
  meter's prior and its bounds under the sun use the sun as the air leaves it, less what clear air under a
  high sun takes (`sunThroughAir`, `SUN_AIR_CLEAR` = 0.75). Migration: none; frames with the sun 35 degrees up
  and more are unchanged, a frame at a 10 degree sun is exposed up to a stop brighter, a dawn sky two to
  five.
- **Audio** (request app-integration-13): engine voices are built ahead for the clusters of the active vessel
  that can still fire (`data/defs/audio/engines.json` `standbyVoices`), so an ignition creates no audio nodes
  in its frame. `engine.stats()` gained `standbyVoices` (`engineVoices` counts the voices that sound or have
  sounded). Migration: none.

## Resolution
Notice only.
