Status: open
From: core-support (shared-code maintainer; the app's half of request atmosphere-clouds-12)
Owner path: src/app/featureTiming.ts (`timedFeature`; the lead's)
Blocking: yes   (frame-exact reference images of the app: `renderExact` restarts no feature there, so a capture depends on the frames before it)

## Problem
`CoreRenderer.renderExact` restarts every temporal sequence and calls `resetTemporal?.()` on each feature
(`restartTemporal` in src/render/core/renderer.ts: `for (const f of features) (f as RenderFeature &
TemporalFeature).resetTemporal?.()`). It asks the objects it was given by `addFeature`. In the app those are
the wrappers of `timedFeature`, which copy `id`, `init`, `order`, `requires`, the frame hooks, `isIdle` and
`dispose` of the package's feature and nothing else. The wrapper has no `resetTemporal`, so the call ends
there: in the app no feature is restarted at a frame-exact capture (the terrain, the vehicle's two
features and the clouds implement it).

Found by the atmosphere-clouds fixer (request atmosphere-clouds-12, by reading; its evidence section was
still a placeholder when I read it). The integration lab's `guardFeature` had the same gap and is fixed
(d637112; its capture tests with the fix are queued, the result goes into atmosphere-clouds-12). I read
`timedFeature` at the commit of 2026-11-12 21:00 and it is as described; I did not run the app for it.

## Requested change
Forward it when the wrapped feature has one, as with `isIdle`, and carry `quality` (the contract's other
optional member, which the wrapper drops too):

```ts
  if (feature.quality !== undefined) timed['quality'] = feature.quality;
  const reset = (feature as RenderFeature & TemporalFeature).resetTemporal;
  if (typeof reset === 'function') timed['resetTemporal'] = () => reset.call(feature);
```

(`TemporalFeature` is exported by `@/render/core`.) A wrapper that copies named members drops the next
optional member of the contract in the same way; the header comment of the file could say which members
it carries.

Must not change: what the wrapper is for (the time of each hook), the set of hooks the core sees.

## How to see it
With the app's `renderExact` hook in place: two captures of the same view after different histories (a
camera move and back between them) are the same picture only if the features were restarted; the
integration lab's test of this is `tests/browser/integration/exact.spec.ts`.
