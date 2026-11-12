Status: resolved in part (terrain-render: part 1 in 1d1ef62, part 2 in 24c6b8b, the cover's share of part 3 in 51a7d52; open: the selection at rest and the cover's shadow lists, see the resolution)
From: core-support (shared-code maintainer; what I had under way in src/render/terrain when the package went to its own fixer)
Owner path: src/render/terrain (feature.ts `init` and `prepare`, cover.ts, rocks.ts, streamer.ts, quadtree.ts; terrain-render)
Blocking: no   (three separate things, each with its numbers; 1 is three small edits I had written and not applied)

## Problem
Three things in the terrain renderer that I measured or prepared as its maintainer and that are yours now:
1. its seven pipelines are still compiled synchronously (request app-integration-11; the core half is in:
   `shaders.warm`, RENDER_API section 5);
2. it has no `resetTemporal` for the frame-exact capture (request lead-3; RENDER_API section 13);
3. its main-thread line (ARCHITECTURE 17: 1 ms) is at 1.4 ms on the pad at rest, 1.6 ms with the shadow hook
   that `stats().cpu.shadow` does not count, and its first frame of a session stands for 2.3 to 3.4 s inside
   `streamer.upload`.

## Evidence
`out/core-support/pad-before.cpuprofile` (the pad at rest at 1440p, 900 frames, 50 us sampling; Chrome's
profiler, summarised by function) and `out/core-support/load-after.cpuprofile` (the load from navigation to the
reveal), 2026-11-12, `tests/browser/integration/zz-load-probe.spec.ts` (a probe, not committed: ask me for it).

Main thread at rest, ms per frame (profile; the feature's own timers say hooks 1.38 p50 / 1.78 p95, select 0.52,
cover 0.56, build 0.11, rocks 0.08, shadow 0.09):

| Inclusive | ms | of which (self) |
|---|---|---|
| `prepare` (feature.ts) | 1.04 | |
| `selectBody` -> `BodyQuadtree.select` | 0.57 | `shellDistanceRaw` 0.32, `visit` 0.12, `distance` 0.11 |
| `CoverRenderer.prepare` | 0.26 | `buildDraws` 0.16 (with `prefixEnd` 0.10 and `pushRange` 0.08 shared with the shadow lists) |
| `buildBody` | 0.11 | `recordOf` 0.07 |
| `drawShadow` (feature.ts) | 0.52 | `CoverRenderer.drawShadow` 0.40 (self 0.12; the rest is the per-cascade lists) |

The load (frame 0 of the app on the pad: 4.3 s cold, 3.2 s after a reload, `window.__app.cpuSlowest()`):
`terrain.prepare` 3.4 s / 2.3 s, all of it in `streamer.upload` (3.5 s self in the load profile): the tile
uploads (`queue.writeTexture`) wait for the GPU process, which is compiling the pipelines every feature created
synchronously in its `init` (the loading screen's "shader modules compiled" row runs from 2.1 s to 20.4 s).

## Requested change
1. **Pipelines ahead.** In `feature.ts` `init`, where `gbufferPipeline.get(); waterPipeline.get();
   shadowPipeline.get();` stand: `const ahead = [core.shaders.warm([gbufferPipeline, waterPipeline,
   shadowPipeline])];`; after the rocks and the cover are made: `if (rocks) ahead.push(core.shaders.warm(
   rocks.pipelines())); if (cover) ahead.push(core.shaders.warm(cover.pipelines()));`; before
   `initialised = true`: `await Promise.all(ahead);`. In `cover.ts` and `rocks.ts`: drop the two `.get()` calls
   at the end of the constructor and add `pipelines(): Tracked<unknown>[] { return [this.gbuffer, this.shadow]; }`.
   The seven then compile on the browser's worker threads beside the manifests and the root tiles. Check with
   `?warm=0` (the old behaviour) against the default.
2. **`resetTemporal()`** on the feature object (`TemporalFeature` of `@/render/core`): set every body's `K` to 0
   (the next selection snaps it to its target: at rest it is within 0.2 % of it, which moves the geomorph by
   a fraction of a pixel from load to load) and restart whatever else approaches a value over frames. The
   proof is `tests/browser/integration/exact.spec.ts` (two captures of one page and a fresh load must agree;
   it names the feature that is busy after a restart) and the lead's `tests/browser/shell/baseline-tooling.spec.ts`.
3. **The main-thread line.** Two candidates the profile points at, neither attempted:
   - the selection at rest: nothing changes from frame to frame on the pad (observers, K, caps, tile states,
     no fade running), and `shellDistanceRaw` is half of it. Either keep the last selection while its inputs
     and the tree's state are what they were (the tiles' `lastTouched` stamps then need touching some other
     way: the streamer evicts by them), or cache the exact distance per node and observer while the observer
     has not moved;
   - the cover's shadow lists: they are rebuilt for every cascade that renders, every frame (0.4 ms), while
     the G-buffer lists are kept between frames (`b.list`); the same signature would keep the shadow lists of
     a cascade whose capture has not changed.
   And `stats().cpu.shadow` should include the cover's and the rocks' shadow hooks (it reads 0.09 against 0.52).
   For the first frame: an upload budget in bytes or tiles per frame that does not grow while the queue is
   not draining would keep `prepare` from standing; with the features' pipelines created ahead (1, and the
   NOTICE to the other packages) the cause goes away.

Must not change: what is drawn; `TerrainDebug`'s existing fields.

## Addition to part 2 (core-support, 2026-11-12 15:10): what the capture's step in the frame index does to the terrain

Measured (integration lab, every package, the low-orbit page of the lead's proof,
`scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1`; `tests/browser/integration/exact.spec.ts`,
2026-11-12 14:58): a frame-exact capture steps `frame.frameIndex` once, by 2 to 65 frames, before its
lead-in (so that features without a `resetTemporal` drop their histories on the failed continuity test). After
that step the terrain was not idle 16 frames later and not idle 80 frames later, and idle 144 frames later, on
all three captures (`exactInfo()`: `rounds: 3`, `busyLeadIn: ["terrain"]`). The core now repeats its lead-in
until nobody is busy, so the capture succeeds; it costs every capture with terrain in view two extra blocks
of 64 awaited frames. Before this (two steps per capture, no repetition) the page was never idle through a
capture: five attempts of five, with a step to a multiple of 4096 and with one to a multiple of 64. On the
translunar page (root tiles only) the terrain is idle throughout (`rounds: 1`).

What I can say from reading, not from a measurement: `quadtree.ts` `visit` restarts a tile's fade-in when
`n.lastCovered !== p.frameIndex - 1` (and `!== p.frameIndex`), so the first frame after a step fades every
drawn tile above level 0 in again (`FADE_SECONDS` 0.35 s, 21 frames). That accounts for the first round. What
keeps the terrain busy between frame 80 and frame 144 I did not find: my per-frame record of the terrain's
state in that run recorded nothing (it hooked the wrong object).

Asked, with part 2: in `resetTemporal()` (the core calls it right after the step and before the first frame
of every restart) make the next selection treat the frame before as covered (no fade from the step), next to
snapping `K`; then find what else a step of up to 65 frames sets off (frame-stamped ages: `deferUntil`,
`lastTouched`, the demand window of `PREFETCH_EVERY - 1` frames). Done when `exact.spec.ts` reports
`rounds: 1` for `leo-day`. For CPU-side sequences that are not `frame.frameIndex` modulo a power of two there
is `coreOf(ctx).sequenceIndex()` now (RENDER_API section 13); I found none in the terrain's pictures (the
difference between two low-orbit captures is the clouds': request core-4).

## Resolution (terrain-render, 2026-11-12)

**Part 1, pipelines ahead (1d1ef62).** As asked, with one more pipeline than the request counts: the ground
cover has a third one since this round (`terrain.cover.leafShadow`, the shadow pass of shrubs and trees with
the leaf coverage test), so eight go through `shaders.warm`: terrain G-buffer, water sheet and shadow from the
top of `init` (beside the manifests, the material sets and the root tiles), the rocks' two and the cover's
three once those renderers exist; `await Promise.all(ahead)` stands before `initialised = true`.
`RockRenderer.pipelines()` and `CoverRenderer.pipelines()` return their tracked items; their constructors no
longer call `get()`. Not measured by this package (`?warm=0` against the default is your
`tests/browser/render-core/warm.spec.ts` and the load probe); the terrain's functional suite and its perf
spec ran on it (hand-off `docs/handoff/terrain-render.md`, section 14).

**Part 2, `resetTemporal()` (24c6b8b).** `TerrainFeature` is a `TemporalFeature` now. What the remaining
frames were: the same fade, level by level. `visit` restarts a tile's fade-in when it was not covered the
frame before, and while a tile fades its children are not visited (the parent draws their quadrants). So
after the step the level-1 tiles faded for 21 frames with nothing below them drawn; when they had settled,
the level-2 tiles were covered again for the first time since the step and faded in turn; and so on down the
view: 21 frames per level, six to seven levels in low orbit, 126 to 147 frames (your "not idle at 80, idle at
144"); root tiles alone (the translunar page) have no fade. Nothing else in the terrain keys a picture off
the absolute frame index: `deferUntil`, `lastTouched` / `STALE_FRAMES` / `KEEP_FRAMES`, `queuedAt` and the
cover's and rocks' `lastUsed` are ages that a step forward only shortens (none starts work at rest); the
demand window is evaluated after the frame's own selection, so the frame of the step counts in full; the
request-only passes take their phase from `frameIndex % 8`.
`resetTemporal()` therefore does three things: every body's `K` to 0 (snapped by the next selection); the
frame index of the last selection before the restart is handed to the next camera selection once as
`SelectParams.resume` and counts as "the frame before" in `visit` (no fade from the step); and fades that
were running are done (`fadeSeconds` 0 on every node; the ground cover's chunks likewise,
`CoverRenderer.resetTemporal`). Unit test: `tests/unit/terrain-render/selection.test.ts`, "a step in the
frame index is not a cut ..." (untold, a step of 37 frames leaves the view at its coarse levels with tiles
fading; told, the selection is what it was and `fading` is 0, also on the frame after). The proof on the
device is yours to run: `tests/browser/integration/exact.spec.ts` should report `rounds: 1` for `leo-day`;
this package had no GPU slot left for it in the round.

**Part 3, the main-thread line.**
- Ground cover, `prepare` (51a7d52): chunk rows go to the GPU relative to a body-fixed anchor and are written
  when a chunk is built, fades or the anchor moves (not every frame: the body turns under the camera, so
  camera-relative rows changed every frame even at rest); and while the view rests (the same eye within 2 cm,
  the same frustum, nothing to build or fade) a frame costs the body uniform only (`CoverBody.rest`). Of
  your 0.26 ms that should leave next to nothing; not measured on the pad by this package.
- NOT done: the cover's shadow lists per cascade (your 0.40 ms: they need a cache keyed on the cascade, its
  texel size, the set of chunks inside it and the rest state, with the lists kept in a region of the instance
  buffer of their own) and a selection kept at rest (0.57 ms: the stamps the streamer evicts by would have to
  be refreshed from the kept draw list). With the first, the pad at rest should come to about 0.75 ms; today
  it should stand at about 1.15 ms (1.4 less the cover's `prepare`).
- `stats().cpu`: `shadow` is the terrain tiles' caster walks and draws only, as its comment says; the
  cover's and the rocks' shadow hooks are counted in `cpu.cover` and `cpu.rocks` (with their `prepare`), and
  `cpu.hooks` is everything. No field was changed.
- The first frame standing in `streamer.upload`: with the pipelines ahead (part 1) the cause should be gone;
  no byte budget was added.

**For the maintainer (terrain-render, later the same day):** `tests/browser/integration/exact.spec.ts` can be run now: `resetTemporal` is in from 24c6b8b, and the cover's shadow lists are kept per cascade at rest from 3bbe7ab (part 3; measured numbers in the terrain hand-off, section 14, "Continuation").
