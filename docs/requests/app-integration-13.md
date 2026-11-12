Status: open
From: app-integration-v1
Owner path: src/sim/world (the step in which a stage fires or the stack leaves the pad; sim-world-pilot), src/render/vfx (first frame of a plume; vfx), src/audio (engine start; audio)
Blocking: no   (single frames: they do not move a window's p99, but they are the frames nearest to the 33 ms line)

## Problem
The frames in which an engine starts and in which the stack leaves the pad cost several subsystems one large
step each, in the same frame. With the cockpit's share (request app-integration-12) the lift-off frame is 28-34 ms
of main thread: the one place in the flight where a frame of 33 ms or more is measured (ARCHITECTURE 17: none in
steady flight; the browser mission of 2026-11-11 had its two long frames at ignition and in the LOI coast).

## Evidence
`tests/browser/app/app.perf.spec.ts` (traces of consecutive frames through `window.__app.startCpuTrace` /
`takeCpuTrace`, stages and every feature hook per frame; nothing else on the GPU; `out/app/perf-1440p.json`,
`perf-720p.json`, `perf-burn.json`, key `ignition` / `trace`):

| Frame | whole frame | sim stage | vfx hooks | audio stage | HUD stage | rest |
|---|---|---|---|---|---|---|
| ignition on the pad (first frame with thrust), 1440p | 12.73 ms | 1.00 | 2.72 | 1.85 | 0.83 | terrain 2.08, cockpit 1.07 |
| ignition on the pad, 720p (first run) | 11.43 | 1.00 | 2.79 | (not split) | (not split) | terrain 1.74 |
| lift-off (one vessel becomes two), 1440p | 29.96 | **5.85** | 0.80 | 0.41 | 0.61 | cockpit 16.03, terrain 4.26 |
| lift-off, 720p | 16.15, then 31.91 two frames later | **6.38** | 0.91 | 0.43 | 0.65 | cockpit 25.55 in the later frame |
| engine start in lunar orbit (descent engine), 1440p | 7.64 | 1.84 | 1.53 | 1.54 | 0.40 | cockpit 0.82 |

For comparison the steady values in the same runs: sim 0.2-0.4 ms (pad, orbit) and 0.7-0.8 ms p99 in the climb,
vfx 0.04-0.09 ms without a plume and 0.26-0.29 ms with one, audio 0.08-0.17 ms, HUD 0.2-0.3 ms.

## Requested change
sim-world-pilot: the step in which the stack leaves the pad (the snapshot goes from one vessel to two) takes
5.9-6.5 ms against the 1.5 ms line of the simulation stage; an engine start in orbit 1.8 ms. Find what that step
builds (vessel split, part graph, snapshot of the new vessel, trajectory patches) and bound it or spread it
over the following steps.
vfx: the first frame of a plume costs 1.5-2.8 ms in `prepare` against 0.3 ms afterwards (buffers, bind groups or
pipelines made on first use): make them at `init`, or when the stage is armed.
audio: the engine-start frame costs 1.5-1.9 ms against 0.1-0.2 ms (voices and nodes created on the event): create
the voices ahead, or schedule the node graph work off the frame.

Must not change: the physics of the lift-off step (the mission's gates: surface speed at lift-off, the golden
hash of the headless mission), the plume's and the sound's start as seen and heard.
