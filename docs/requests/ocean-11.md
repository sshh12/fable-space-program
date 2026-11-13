Status: open
From: ocean
Owner path: src/render/core/shaders/chunksFrame.ts (FrameUniforms), src/render/core/renderer.ts (the frame uniform's writer), docs/RENDER_API.md (render core)
Blocking: no        (request lead-7 asks that every wave phase of the sea come from simulation time; two phases of the shared chunk cannot without this)

## Problem
The shared water shading (`brdf_water`, compiled into the core's deferred lighting and into the ocean's forward
pass) has two clocks of its own: the far-wave bank on the far sheet (fourteen plane waves whose phase is
`phase0 - omega t`) and the redraw of the glitter cells (14 times a second). Both take `frame.time.x`, which is
`realTime`: the presentation clock. So two clients at the same universe time see the far sea's wave pattern at
different phases, and a paused game still moves its far waves and twinkles. Everything else of the sea is on the
snapshot's time (the swell, the FFT, the surf, an impact's rings and foam, the foam map's ageing).
The chunk can only read what the deferred pass binds, and the frame uniforms carry no simulation time. The forward
pass could hand it in, but the two passes must agree at the hand-over to the bit, so it has to be one source.

## Evidence
`src/render/ocean/shaders/waterBrdf.ts`: `let time = frame.time.x;` (far waves) and
`let tk = frame.time.x * WATER_GLINT_RATE;` (glitter). `src/render/core/shaders/chunksFrame.ts`:
`time: vec4f, // realTime (s), realDt (s), frameIndex, animate (1 or 0)`. In a frame-exact capture `realTime` is 0,
so captures are the same picture on every load (tests/browser/ocean/exact.spec.ts); only the running game differs
from client to client.

## Requested change
A simulation clock in the frame uniforms, additive:

```wgsl
simTime: vec4f,   // x = the snapshot's ut modulo SIM_TIME_PERIOD (s; formed in float64), y = ut of the previous
                  // frame's snapshot modulo the same, z = SIM_TIME_PERIOD (s), w = 0
```

with `SIM_TIME_PERIOD = 3600` exported next to `WATER_DEPTH_ENCODE_MAX` (float32 holds a value below 3600 to a
quarter of a millisecond). The ocean then quantises the far waves' angular frequencies to multiples of
2 pi / SIM_TIME_PERIOD (as it does for the FFT with its own repeat period, the same 3600 s), so the phase is exact
across the wrap, and takes both clocks from `frame.simTime.x`.

Must not change: `frame.time` (realTime stays what TAA, noise rotations and the labs use).
