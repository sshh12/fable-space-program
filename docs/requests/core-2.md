Status: open
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
