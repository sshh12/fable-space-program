Status: resolved (commit 732962c; not yet run in a browser: see the last line)
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

## Resolution (app-integration)
`src/app/featureTiming.ts` (commit 732962c). The wrapper is no longer a list of copied names: it is built from
`MEMBERS`, a table typed `Record<keyof Required<RenderFeature & TemporalFeature>, 'value' | 'call' | 'timed'>`, so a
member added to either contract does not compile until the table says how it is carried:
- `value` (`id`, `order`, `quality`, `requires`): a getter on the wrapper that reads the feature's member (a value
  the feature changes later is seen);
- `call` (`init`, `isIdle`, `dispose`, `resetTemporal`): forwarded with the feature as `this`, untimed;
- `timed` (the ten frame hooks): forwarded and timed, as before.
A member the bare feature does not have is absent from the wrapper (`f.resetTemporal?.()`, `f.isIdle ? ... : true`
and `if (f.drawShadow)` see what they would see without it). `quality` and `resetTemporal` therefore reach the core.

Unit test, `src/app/featureTiming.test.ts` (`npx vitest run src/app`): a feature with every member wraps to exactly
the contract's keys and nothing of the package's own; a feature with three members wraps to those three; values
are read through, also after the feature changes them; every call arrives at the feature itself with its
arguments and its result (`init`'s promise, `isIdle`'s boolean, `resetTemporal`); the frame hooks and only they
are timed, also when one throws.

Not verified: no browser run in this phase (the GPU was with the fix rounds). The app's `renderExact` hook is in
the same commit; `tests/browser/app/app.spec.ts`, "frame-exact capture ...", will run it in the short gate run
before the mission.
