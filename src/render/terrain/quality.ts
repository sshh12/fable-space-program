/**
 * The terrain feature's quality setting (ARCHITECTURE 18.8; frontend-ux 9.4; RENDER_API section 20), live:
 *  - terrain: the on-screen size of a terrain quad that the level-of-detail selection aims at, px (the
 *    feature's `lodK`): larger quads, fewer triangles and tiles. Ultra = 8, the value before the setting.
 * Cost model measured on the reference GPU (RTX 5090, 2560 x 1440, attribution mode, every other setting at Ultra; docs/handoff/capability-settings.md section 6), in the lift-off: the terrain follows the internal resolution almost linearly (its
 * level of detail is chosen per pixel of the render height as well).
 */
import type { FeatureQualityDecl } from '@/core/contracts/render';

export const TERRAIN_QUALITY: FeatureQualityDecl = {
  featureId: 'terrain',
  settings: [
    {
      id: 'terrain',
      label: 'Terrain detail',
      levels: [
        { name: 'low', params: { pxPerQuad: 14 } },
        { name: 'medium', params: { pxPerQuad: 11 } },
        { name: 'high', params: { pxPerQuad: 9 } },
        { name: 'ultra', params: { pxPerQuad: 8 } },
      ],
      apply: 'live',
      costModel: { exponent: 0.93, ratios: { low: 0.83, medium: 0.88, high: 0.98, ultra: 1 }, constantMs: 0 },
      weight: 3,
    },
  ],
};
