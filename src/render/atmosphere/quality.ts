/**
 * The atmosphere feature's quality settings (ARCHITECTURE 18.8; frontend-ux 9.4; RENDER_API section 20), both
 * live (read every frame):
 *  - clouds: the step budget of a cloud ray (clouds.ts `stepBudget`), before the governor's quality scale;
 *  - atmosphere: the samples of a shell that fills the view (select.ts `baseSteps`).
 * Ultra holds the values the feature used before the settings existed (96 and 24), so Ultra is the same
 * picture. Cost models: measured on the reference GPU (docs/handoff/capability-settings.md).
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
      costModel: { exponent: 1, ratios: { low: 0.55, medium: 0.7, high: 0.85, ultra: 1 }, constantMs: 0 },
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
      costModel: { exponent: 1, ratios: { low: 0.6, medium: 0.75, high: 0.88, ultra: 1 }, constantMs: 0 },
      weight: 3,
    },
  ],
};
