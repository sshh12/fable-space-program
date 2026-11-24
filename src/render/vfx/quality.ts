/**
 * The vfx feature's quality setting (ARCHITECTURE 18.8; frontend-ux 9.4; RENDER_API section 20), live:
 *  - effects: `particles` multiplies the emission rates of the director's and the fireballs' particles (dust,
 *    ice, ablation, debris), `march` the step counts of every ray-marched volume (plumes, smoke, plasma,
 *    dust sheets, fireballs, splashes); both on top of the governor's quality scale, the same way it is
 *    applied (the image converges to the same picture, noisier or thinner). Ultra = 1 and 1: the feature as
 *    it was before the setting.
 * Cost model: measured on the reference GPU (docs/handoff/capability-settings.md).
 */
import type { FeatureQualityDecl } from '@/core/contracts/render';

export const VFX_QUALITY: FeatureQualityDecl = {
  featureId: 'vfx',
  settings: [
    {
      id: 'effects',
      label: 'Effects',
      levels: [
        { name: 'low', params: { particles: 0.4, march: 0.6 } },
        { name: 'medium', params: { particles: 0.6, march: 0.8 } },
        { name: 'high', params: { particles: 0.8, march: 1 } },
        { name: 'ultra', params: { particles: 1, march: 1 } },
      ],
      apply: 'live',
      costModel: { exponent: 1, ratios: { low: 0.6, medium: 0.8, high: 0.95, ultra: 1 }, constantMs: 0 },
      weight: 2,
    },
  ],
};
