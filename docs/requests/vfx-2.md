Status: open
From: vfx
Owner path: src/core/fakes/fakeSim.ts
Blocking: no

## Problem
The FakeSim publishes `ignitionAge = 1/60 s` for every burning engine in every snapshot: the age is computed
from the stored module (which is never written back), so it never advances. The real sim passes through that
state for one step at each ignition; the FakeSim stays in it for as long as the engine burns. The vfx feature
draws what the contract says an engine 1/60 s after ignition looks like: the start-up flash at the nozzle and
a jet that ends at the start-up front (`ignition.frontSpeed x age`, 4 to 10 m from the nozzle). So every
plume in the integration lab on the FakeSim is a stub with a permanent flash, and cross-feature checks of
plumes (plume light on terrain and vehicle, plumes through clouds, exposure with a plume in view) do not
show a steady plume.

## Evidence
- `src/core/fakes/fakeSim.ts`, in `snapshot()`:
  `ignitionAge: thr > 0.02 ? Math.max(0, m.ignitionAge) + 1 / 60 : m.ignitionAge` with `m` the stored module
  state, whose `ignitionAge` stays at its initial value.
- `/labs/integration/?scene=lowOrbit&throttle=1` and `?scene=lunarSurface&throttle=0.4`: the plume is a
  short flash at the nozzle in every frame (review pictures `out/screens/vfx/dev/rv2-int-loworbit-burn.png`,
  `rv4-int-lunar-surface.png`). The vfx lab (its own LabSim, which advances the age) shows the steady plume.

## Requested change
Let the FakeSim keep time since ignition per engine: `ignitionAge` grows by the simulated step while
`throttleActual > 0.02` (starting at 0 on the step the engine lights), is -1 while the engine is off, and
`shutdownAge` counts up from 0 after the throttle falls back to 0 (it is -1 before the first shutdown), as
`ModuleState` documents and the real sim does. Nothing else about the FakeSim's engines needs to change.
No workaround in vfx paths: special-casing an age of exactly 1/60 s would hide the real start-up transient.
