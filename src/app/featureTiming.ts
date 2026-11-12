/**
 * Main-thread time of every render feature's hooks, measured at the contract: `timedFeature` returns a
 * RenderFeature that stands in for the feature it wraps and books the time of each frame hook to the app's
 * frame timings (timing.ts). The wrapped feature is untouched and every call reaches it with itself as `this`.
 *
 * The wrapper carries EVERY member of the contract (`RenderFeature`, and `TemporalFeature`: the core's
 * `resetTemporal` call before a frame-exact capture), each in the way `MEMBERS` says:
 *   value   read through (a getter on the wrapper: `id`, `order`, `quality`, `requires`);
 *   call    forwarded untimed (`init`, `isIdle`, `dispose`, `resetTemporal`);
 *   timed   forwarded and timed (the ten frame hooks).
 * A member the feature does not have is absent from the wrapper as well, so the core sees the same set of
 * hooks and the same optional calls as without the wrapper. `MEMBERS` is typed by the contract's keys: a
 * member added to the contract does not compile until it is listed here (request core-5: a wrapper that copied
 * named members dropped `resetTemporal` and `quality`).
 * Cost: two clock reads per hook call (a few microseconds per frame over all features).
 */
import type { RenderFeature } from '@/core/contracts/render';
import type { TemporalFeature } from '@/render/core';

type Contract = RenderFeature & TemporalFeature;

/** How each member of the contract is carried by the wrapper. */
export const MEMBERS: Record<keyof Required<Contract>, 'value' | 'call' | 'timed'> = {
  id: 'value',
  order: 'value',
  quality: 'value',
  requires: 'value',
  init: 'call',
  isIdle: 'call',
  dispose: 'call',
  resetTemporal: 'call',
  // The per-frame hooks, in the order the core calls them.
  prepare: 'timed',
  compute: 'timed',
  drawShadow: 'timed',
  drawGBuffer: 'timed',
  drawWater: 'timed',
  drawBackground: 'timed',
  compositeAtmosphere: 'timed',
  preTransparent: 'timed',
  drawTransparent: 'timed',
  drawOverlay: 'timed',
};

/** `key` is `<featureId>.<hook>`. */
export type HookSink = (featureId: string, key: string, ms: number) => void;

export function timedFeature(feature: RenderFeature, sink: HookSink): RenderFeature {
  const bare = feature as unknown as Record<string, unknown>;
  const id = feature.id;
  const timed: Record<string, unknown> = {};
  for (const [name, how] of Object.entries(MEMBERS)) {
    if (bare[name] === undefined) continue;
    if (how === 'value') {
      Object.defineProperty(timed, name, { get: () => bare[name], enumerable: true });
      continue;
    }
    // No member of the contract takes more than three arguments (frame, encoder or pass, cascade or target).
    const fn = bare[name] as (a: unknown, b: unknown, c: unknown) => unknown;
    if (how === 'call') {
      timed[name] = (a: unknown, b: unknown, c: unknown): unknown => fn.call(feature, a, b, c);
      continue;
    }
    const key = `${id}.${name}`;
    timed[name] = (a: unknown, b: unknown, c: unknown): void => {
      const t0 = performance.now();
      try {
        fn.call(feature, a, b, c);
      } finally {
        sink(id, key, performance.now() - t0);
      }
    };
  }
  return timed as unknown as RenderFeature;
}
