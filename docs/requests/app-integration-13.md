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

## Answer on the sim share (sim-core-v2, 2026-11-12)

Measured headless on the tick-grid tree (`lunar-direct`, real tiles, the scripted pilot; one `step()` and
one `snapshot()` timed per step; four sessions flown one after the other in ONE Node process, so the
first is cold and the others warm):

| Session in the process | Lift-off step (`clampsReleased`, one vessel becomes two) | Step after it | Snapshot of the lift-off step | First decoupling (T+160 s) |
|---|---|---|---|---|
| 1st (cold) | **5.54 ms** | 1.45 ms | 1.22 ms | 0.88 ms |
| 2nd | 1.22 ms | 0.61 ms | 0.24 ms | 0.46 ms |
| 3rd | 0.72 ms | 0.74 ms | 0.12 ms | 0.40 ms |
| 4th | 0.63 ms | 0.52 ms | 0.13 ms | 0.37 ms |

For scale: over the 5,760 steps from the pad to T+20 s the step median is 0.014 ms and its 99th percentile
0.12 ms; the snapshot median 0.025 ms.

So the 5.9-6.4 ms of the request reproduce without a browser (5.5-5.7 ms), and **about 85 % of it is the
first execution of that code in the process, not work the step has to do**: the same step with the same
state costs 0.6-0.7 ms once the engine has compiled the path. What the step runs that no earlier step ran:
the release of the clamps (the component pass over the part tree, the weld of the clamp pieces into one
held structure, the mass properties and collision structures of both vessels), the adoption of the new
vessel by the world, the first free step of the stack with contact probes against the mount, and the first
trajectory prediction of a vessel that is no longer held (the snapshot's 1.2 ms). The engine start in lunar
orbit (1.8 ms) is the same kind of first run: the first hand-over from rails to integration with a burn and
its patch refresh.

The warm cost (0.6-0.7 ms for the step, 0.13 ms for the snapshot) is inside the 1.5 ms line of the
simulation stage; nothing in the step needs to be spread over later steps.

What removes the cold cost: a rehearsal while the loading screen is up. The session flies the first seconds
of its own scenario on a COPY of the start vessel (the stage presses up to the release, a few free steps, one
prediction) and throws the copy away, so the engine has compiled those paths before the player's lift-off.
The copy shares nothing with the session's state, takes no id from the id source and emits no event, so
the physics of the lift-off step, the golden hash and the mission's gates are untouched by construction.
Planned as its own commit AFTER this package's vessel-model step (MIGRATION_V2 step 3.3), which rewrites the
split and the per-craft stage state the rehearsal has to exercise; `docs/handoff/sim-core-v2.md` says whether
it landed. The cockpit's 16-26 ms in the same frames (request app-integration-12) is the larger share and
is not the sim's.

### Sim share, at the end of sim-core-v2: the rehearsal did not land

The rehearsal described above is NOT implemented. It needs a second world on the session's terrain
authority (whose request slots the two would share) and runs inside the load path of every session;
proving it neutral for the golden hash, the terrain accounting and the mission's zero incomplete terrain
queries is a piece of work of its own and was not started at the end of the package rather than landed
unproven. The measurement stands (5.5 ms cold, 0.6-0.7 ms warm for the release step), the proposal stands,
and the request stays open for the owner of the session after this package (`session-switch` or
`island-core`). Since the measurement the release path changed (per-craft stage state, the split over tree
edges and links): whoever implements the rehearsal should measure again first.
