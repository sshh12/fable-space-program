Status: open (the lab's half is in the tree, d637112, its run queued; the app's half is the lead's file: request core-5)
From: atmosphere-clouds
Owner path: labs/integration/main.ts (`guardFeature`), src/app/featureTiming.ts (`timedFeature`)
Blocking: yes   (request core-4's acceptance, `tests/browser/integration/exact.spec.ts` `leo-day` with `exact: true`, and with it the lead's reference images of every view with volumetric clouds: the core's `resetTemporal()` never reaches a feature on these two pages)

## Problem
The render core calls `resetTemporal?.()` on the feature objects it was given (`restartTemporal` in
renderer.ts: `for (const f of features) (f as RenderFeature & TemporalFeature).resetTemporal?.()`). On the
integration lab and in the app those objects are wrappers that copy `id`, `init`, `order`, `requires`, the
frame hooks, `isIdle` and `dispose` of the package's feature, and nothing else:

- `guardFeature` (labs/integration/main.ts: the switch that takes a throwing feature out);
- `timedFeature` (src/app/featureTiming.ts: the CPU time of each hook).

Neither has a `resetTemporal`, so the call ends at the wrapper. No feature of any package is restarted at
a frame-exact capture on these pages: not the clouds (request core-4), not the terrain, not the vehicle's
two features, which all implement it. What a capture then shows depends on the frames before it: the
clouds' history runs through the lead-in (with the terrain busy that is 144 frames whose exposure and
depth follow the terrain's fade), the cloud shadow map is not re-marched.

## Evidence
By the code: the two functions named above (`resetTemporal` appears nowhere under labs/integration or
src/app).

By measurement, before the lab's change (integration lab, `scene=lowOrbit&orbit=30,15,60&hud=0&governor=off&deterministic=1&paused=1`,
two captures one after the other on a fresh page, the scene depth and the half-resolution cloud buffers
read back after each; 2026-11-12, 16:40 to 20:20 UTC):

| features on the page | frames | scene depth | cloud radiance (921,600 values) | picture |
|---|---|---|---|---|
| atmosphere alone | 64 | identical | identical | identical |
| every package but the terrain | 64 | identical | identical | 0.07 % of the pixels, all on the vessel |
| terrain and atmosphere | 1 | identical | 9,450 differ | 0.40 % of the pixels, max 8 levels |
| terrain and atmosphere | 64 | identical | 7,971 differ; a third capture is the second to the bit | 0.74 %, max 7 |
| every package | 64 | identical | 7,934 to 15,269 differ | 0.74 to 1.65 %, max 7 to 13 |

One frame into the second capture the cloud buffers already differ from the first while everything the
clouds are marched against is the same: what differs is the clouds' history, which ran on through the
restart. With the terrain on the page the lead-in is three rounds (144 frames, the terrain fading in), and
those frames are in the history; without it the lead-in is 16 frames that are the same every time, which is
why the atmosphere alone, and this package's own lab (`tests/browser/atmosphere/exact.spec.ts`: three views,
four captures each, bit for bit), showed nothing.

After the lab's change (d637112; 21:50 UTC): every capture of the page comes back `idle: false`, because the
terrain is busy right after its own `resetTemporal`: request `atmosphere-clouds-13`.

## Requested change
Both wrappers forward it when the wrapped feature has one, as they do with `isIdle`:

```ts
const reset = (inner as RenderFeature & TemporalFeature).resetTemporal;
if (reset) feature['resetTemporal'] = () => reset.call(inner);
```

(`guardFeature`: only while `enabled`, like the hooks.) A wrapper that copies named members will drop the
next optional member of the contract in the same way; copying the hooks onto an object whose prototype is
the wrapped feature would not, if you prefer that.

Must not change: what the wrappers are for (the switch, the timing).

## Maintainer's note (core-support, 2026-11-12 21:05: the lab's half is in the tree, not yet run)

You are right, by the code: `guardFeature` copied named members and had no `resetTemporal`; the core's
restart ended at the wrapper on every page of the integration lab.

- `labs/integration/main.ts` (d637112): the guard forwards `resetTemporal` of the feature it wraps while
  the feature is switched on (a throw switches the feature off and reports it, like a hook's), and carries
  `quality`. In the tree now: your acceptance run of core-4 on the lab has it.
- `src/app/featureTiming.ts` is the lead's file, not mine: filed as request `core-5` with your two lines.
  Until the lead takes it, the app restarts no feature at a capture.
- My run of `tests/browser/integration/exact.spec.ts` with the guard's change is queued behind the GPU slot
  (out/core-support/batch10.log); its result goes here. `leo-day` is still `exact: false` in that spec: flip
  it with your part of core-4, it is your acceptance.

One consequence for what I wrote earlier: the measurements of the lab's captures in my hand-off (section
10: the low-orbit page idle after three lead-in rounds with the terrain busy, the pictures differing along
the clouds) were taken with no feature restarted. They describe the lab as it was, not the features'
`resetTemporal`.
