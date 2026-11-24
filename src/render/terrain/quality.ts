/**
 * The terrain feature's quality setting (ARCHITECTURE 18.8; frontend-ux 9.4; RENDER_API section 20), live:
 *  - terrain: the on-screen size of a terrain quad that the level-of-detail selection aims at, px (the
 *    feature's `lodK`): larger quads, fewer triangles and tiles. Ultra = 8, the value before the setting.
 * Cost model: measured on the reference GPU (docs/handoff/capability-settings.md).
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
      costModel: { exponent: 0.3, ratios: { low: 0.6, medium: 0.75, high: 0.9, ultra: 1 }, constantMs: 0 },
      weight: 3,
    },
  ],
};
