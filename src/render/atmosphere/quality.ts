/**
 * The atmosphere feature's quality settings (ARCHITECTURE 18.8; frontend-ux 9.4; RENDER_API section 20), both
 * live (read every frame):
 *  - clouds: the step budget of a cloud ray (clouds.ts `stepBudget`), before the governor's quality scale;
 *  - atmosphere: the samples of a shell that fills the view (select.ts `baseSteps`).
 * Ultra holds the values the feature used before the settings existed (96 and 24), so Ultra is the same
 * picture. Cost models measured on the reference GPU (RTX 5090, 2560 x 1440, attribution mode, every other setting at Ultra; docs/handoff/capability-settings.md section 6), in the lift-off: the cloud march barely follows the internal
 * resolution (its fresh samples are a quarter of the pixels, its shadow maps have sizes of their own).
 */
import type { FeatureQualityDecl } from '@/core/contracts/render';

export const ATMOSPHERE_QUALITY: FeatureQualityDecl = {
  featureId: 'atmosphere',
  settings: [
    {
      id: 'clouds',
      label: 'Clouds',
      levels: [
        { name: 'low', params: { steps: 48 } },
        { name: 'medium', params: { steps: 64 } },
        { name: 'high', params: { steps: 80 } },
        { name: 'ultra', params: { steps: 96 } },
      ],
      apply: 'live',
      costModel: { exponent: 0.1, ratios: { low: 0.79, medium: 0.87, high: 0.94, ultra: 1 }, constantMs: 0 },
      weight: 5,
    },
    {
      id: 'atmosphere',
      label: 'Atmosphere',
      levels: [
        { name: 'low', params: { steps: 12 } },
        { name: 'medium', params: { steps: 16 } },
        { name: 'high', params: { steps: 20 } },
        { name: 'ultra', params: { steps: 24 } },
      ],
      apply: 'live',
      costModel: { exponent: 0.55, ratios: { low: 0.77, medium: 0.85, high: 0.92, ultra: 1 }, constantMs: 0 },
      weight: 3,
    },
  ],
};
