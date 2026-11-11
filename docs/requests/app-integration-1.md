Status: open
From: app-integration-v1
Owner path: src/render/core/perf.ts and src/render/core/renderer.ts (render-core, shared-code maintainer)
Blocking: no   (the app measures its own frame time meanwhile: src/app/timing.ts, `window.__app.cpu()`)

## Problem
`PerfSnapshot.cpu` never contains the app's `'frame'` zone, although RENDER_API.md section 14 says it is
"the zone named 'frame' when the app brackets its frame function with ctx.perf.cpuBegin('frame') /
cpuEnd('frame') (the lab app does)". `PerfRecorder.resolve()` reads `cpuFrame.get('frame')` inside
`renderer.render()` (renderer.ts, `perf.resolve(encoder)` after `cpuEnd('core.render')`), while the app's frame
function is still running around that call, so the zone is still open there; `cpuEnd('frame')` then books it
into the map that the next `beginFrame()` throws away. The value used is always `core.render`: the renderer's
own CPU time, without the simulation, the HUD, the map, input and audio. The ARCHITECTURE 17 line "CPU main
thread per frame p99 <= 6 ms" cannot be read from `window.__perf` in the app or in any lab.

## Evidence
`src/render/core/perf.ts` lines 134-145 (`beginFrame` replaces `cpuFrame`), 183-186 (`resolve` reads
`cpu.get('frame') ?? cpu.get('core.render')`); `src/render/core/lab/labApp.ts` lines 149-155 bracket
`renderer.render` with `cpuBegin('frame')` / `cpuEnd('frame')`, which therefore has no effect.

## Requested change
Make `PerfSnapshot.cpu` the time of the caller's completed `'frame'` zone when one is used: e.g. keep the last
completed `'frame'` duration across `beginFrame()` and push it into the CPU window at the next `beginFrame()`
(one frame late is fine), falling back to `core.render` for pages that never open a `'frame'` zone. Must not
change: the GPU numbers, the per-feature CPU attribution, `core.render` as its own pass entry.
