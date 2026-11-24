/**
 * The ocean feature's quality setting (ARCHITECTURE 18.8; frontend-ux 9.4; RENDER_API section 20), live:
 *  - ocean: `nearRange` scales the radii of the near field (the body's nearFieldFadeStartM and
 *    nearFieldFadeEndM, ARCHITECTURE 18.2): the forward wave surface, its FFT detail and foam end nearer
 *    the camera and the far sheet (deferred, the same brdf_water) takes over there, with the same
 *    hand-over rules. Fewer surface patches and forward-shaded pixels: the near pass of the budget
 *    table. Ultra = 1, the near field as the data states it.
 * Cost model: measured on the reference GPU (docs/handoff/capability-settings.md).
 */
import type { FeatureQualityDecl } from '@/core/contracts/render';
import type { OceanTunables } from './params';

export const OCEAN_QUALITY: FeatureQualityDecl = {
  featureId: 'ocean',
  settings: [
    {
      id: 'ocean',
      label: 'Ocean',
      levels: [
        { name: 'low', params: { nearRange: 0.4 } },
        { name: 'medium', params: { nearRange: 0.6 } },
        { name: 'high', params: { nearRange: 0.8 } },
        { name: 'ultra', params: { nearRange: 1 } },
      ],
      apply: 'live',
      costModel: { exponent: 1, ratios: { low: 0.6, medium: 0.75, high: 0.9, ultra: 1 }, constantMs: 0 },
      weight: 2,
    },
  ],
};

const scaled = new WeakMap<OceanTunables, { k: number; t: OceanTunables }>();

/** A body's tunables with the near field's radii scaled by `k` (the same object at 1; one copy per body and level). */
export function withNearRange(t: OceanTunables | null, k: number): OceanTunables | null {
  if (!t || k === 1) return t;
  const hit = scaled.get(t);
  if (hit && hit.k === k) return hit.t;
  const copy: OceanTunables = { ...t, fadeStart: t.fadeStart * k, fadeEnd: t.fadeEnd * k };
  scaled.set(t, { k, t: copy });
  return copy;
}
