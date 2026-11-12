/**
 * Main-thread time of every render feature's hooks, measured at the contract: `timedFeature` returns a
 * RenderFeature that forwards each hook of the feature it wraps and books the time of the call to the app's
 * frame timings (timing.ts). The wrapped feature is untouched and is called with itself as `this`; a hook the
 * feature does not have is absent from the wrapper as well, so the core sees the same set of hooks.
 * Cost: two clock reads per hook call (a few microseconds per frame over all features).
 */
import type { RenderContext, RenderFeature } from '@/core/contracts/render';

/** The per-frame hooks of the RenderFeature contract, in the order the core calls them. */
const FRAME_HOOKS = ['prepare', 'compute', 'drawShadow', 'drawGBuffer', 'drawWater', 'drawBackground', 'compositeAtmosphere', 'preTransparent', 'drawTransparent', 'drawOverlay'] as const;

/** `key` is `<featureId>.<hook>`. */
export type HookSink = (featureId: string, key: string, ms: number) => void;

export function timedFeature(feature: RenderFeature, sink: HookSink): RenderFeature {
  const id = feature.id;
  const timed: Record<string, unknown> = {
    id,
    init: (ctx: RenderContext) => feature.init(ctx),
  };
  if (feature.order !== undefined) timed['order'] = feature.order;
  if (feature.requires !== undefined) timed['requires'] = feature.requires;
  for (const hook of FRAME_HOOKS) {
    // Every hook of the contract takes at most three arguments (frame, encoder or pass, cascade or target).
    const fn = feature[hook] as ((a: unknown, b: unknown, c: unknown) => void) | undefined;
    if (fn === undefined) continue;
    const key = `${id}.${hook}`;
    timed[hook] = (a: unknown, b: unknown, c: unknown): void => {
      const t0 = performance.now();
      try {
        fn.call(feature, a, b, c);
      } finally {
        sink(id, key, performance.now() - t0);
      }
    };
  }
  if (feature.isIdle) timed['isIdle'] = () => feature.isIdle!();
  if (feature.dispose) timed['dispose'] = () => feature.dispose!();
  return timed as unknown as RenderFeature;
}
