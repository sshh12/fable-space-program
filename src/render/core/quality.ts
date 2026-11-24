/**
 * Feature-declared quality (ARCHITECTURE 18.8 and 24; frontend-ux 9.4-9.5): the render core's own settings,
 * the registry of every declared setting, and the arithmetic of a `QualityProfile`.
 *
 * - A feature declares its settings in `RenderFeature.quality` (a `FeatureQualityDecl`): per setting its
 *   levels with the feature's own parameters, `live` or `rebuild`, a cost model and a perceptual weight. The
 *   core registers the declaration when the feature is added (before its `init`) and refuses a setting id
 *   that another feature already declared.
 * - A feature reads its parameters through `coreOf(ctx).quality.params(settingId)` whenever it uses them (a
 *   live setting is read every frame: a new level applies on the next frame), and for a `rebuild` setting
 *   registers `coreOf(ctx).quality.onRebuild(settingId, fn)`: `Renderer.setQuality` calls it under the core's
 *   1 s fade and resolves when it has finished.
 * - With no profile (the renderer as created) every setting is at 'ultra' and the internal resolution is
 *   not capped: exactly the renderer of before this module. The Ultra levels' parameters are the values the
 *   features used before (RENDER_API section 20 has the table), so Ultra is today's picture.
 * - The profile's top-level members: `pixelCap` (megapixels) caps the internal resolution at
 *   min(1, sqrt(pixelCap / display megapixels)) of the display, `renderScaleMin` is the governor's floor, and
 *   the governor's budget is 0.66 x 1000 / targetFps (11 ms at 60 fps, the budget it always had).
 */
import type { FeatureQualityDecl, QualityLevelName, QualityProfile, QualitySettings } from '@/core/contracts/render';

/** The levels from the lowest to the highest. */
export const QUALITY_LEVELS: readonly QualityLevelName[] = ['low', 'medium', 'high', 'ultra'];

/** Fraction of the frame period the governor spends on the GPU (ARCHITECTURE 18.8): 11 ms at 60 fps. */
export const GOVERNOR_FRAME_SHARE = 0.66;

export const governorBudgetMs = (targetFps: number): number => (GOVERNOR_FRAME_SHARE * 1000) / targetFps;

/** The internal resolution scale (of the display) that a pixel cap allows: at most 1, never upscaled. */
export function renderScaleCap(pixelCapMp: number, displayW: number, displayH: number): number {
  const displayMp = (Math.max(1, displayW) * Math.max(1, displayH)) / 1e6;
  return Math.min(1, Math.sqrt(Math.max(1e-3, pixelCapMp) / displayMp));
}

/** One declared setting, with the feature that declared it. */
export type QualitySetting = FeatureQualityDecl['settings'][number];
export interface RegisteredSetting {
  featureId: string;
  setting: QualitySetting;
}

/**
 * The render core's own settings (featureId 'core'). Ultra = the values of before this module:
 *  - shadows (rebuild): the side of the sun-shadow cascade array, 2048 (shadows/shadowSystem.ts);
 *  - ambientOcclusion (live; every variant's pipeline is created ahead): GTAO slices x steps per side, 2 x 6
 *    (lighting/ao.ts).
 * Cost models: measured on the reference GPU (docs/handoff/capability-settings.md, the table of quality
 * steps); `ratios` are the cost of a level against Ultra, `exponent` how it follows the internal pixels.
 */
export const CORE_QUALITY: FeatureQualityDecl = {
  featureId: 'core',
  settings: [
    {
      id: 'shadows',
      label: 'Shadows',
      levels: [
        { name: 'low', params: { mapSize: 1024 } },
        { name: 'medium', params: { mapSize: 1536 } },
        { name: 'high', params: { mapSize: 2048 } },
        { name: 'ultra', params: { mapSize: 2048 } },
      ],
      apply: 'rebuild',
      costModel: { exponent: 0, ratios: { low: 0.7, medium: 0.85, high: 1, ultra: 1 }, constantMs: 0 },
      weight: 3,
    },
    {
      id: 'ambientOcclusion',
      label: 'Ambient occlusion',
      levels: [
        { name: 'low', params: { slices: 1, steps: 4 } },
        { name: 'medium', params: { slices: 2, steps: 4 } },
        { name: 'high', params: { slices: 2, steps: 6 } },
        { name: 'ultra', params: { slices: 2, steps: 6 } },
      ],
      apply: 'live',
      costModel: { exponent: 1, ratios: { low: 0.55, medium: 0.8, high: 1, ultra: 1 }, constantMs: 0 },
      weight: 1,
    },
  ],
};

/** A setting's parameters at a level: the level's own, or, when the setting does not declare it, the nearest declared level above it. */
export function paramsAt(setting: QualitySetting, level: QualityLevelName): Readonly<Record<string, number>> {
  for (let i = QUALITY_LEVELS.indexOf(level); i < QUALITY_LEVELS.length; i++) {
    const found = setting.levels.find((l) => l.name === QUALITY_LEVELS[i]);
    if (found) return found.params;
  }
  throw new Error(`quality: setting "${setting.id}" declares no level at or above "${level}"`);
}

/** What a feature sees of the quality state (`coreOf(ctx).quality`). */
export interface CoreQuality {
  /**
   * Parameters of a declared setting at its current level ('ultra' until a profile says otherwise). A feature
   * passes its own declaration: it is registered here when the page added the feature through a wrapper
   * that did not forward `RenderFeature.quality`.
   */
  params(settingId: string, decl?: FeatureQualityDecl): Readonly<Record<string, number>>;
  level(settingId: string): QualityLevelName;
  /**
   * For a 'rebuild' setting: what to do when its level changes. Called by `Renderer.setQuality` while the
   * frame is faded out, with the new level's parameters; the promise it returns is awaited before the fade
   * in. One callback per setting.
   */
  onRebuild(settingId: string, rebuild: (params: Readonly<Record<string, number>>) => void | Promise<void>): void;
  /** The profile in force, or null for the renderer's defaults (every setting at 'ultra', no pixel cap). */
  profile(): QualityProfile | null;
  /** Every setting declared so far, the core's first, then the features' in the order they were added. */
  settings(): readonly RegisteredSetting[];
}

/** What changing to a profile does. */
export interface QualityChange {
  /** Settings whose level changed, by apply class. */
  live: string[];
  rebuild: string[];
}

/** Validate a profile: finite positive numbers, known level names (unknown setting ids are allowed: a page may not load every feature). */
export function validateProfile(p: QualityProfile): void {
  if (!(Number.isFinite(p.pixelCap) && p.pixelCap > 0)) throw new Error(`quality: pixelCap ${p.pixelCap} is not a positive number of megapixels`);
  if (!(Number.isFinite(p.renderScaleMin) && p.renderScaleMin > 0 && p.renderScaleMin <= 1)) throw new Error(`quality: renderScaleMin ${p.renderScaleMin} is not in (0, 1]`);
  if (!(Number.isFinite(p.targetFps) && p.targetFps >= 20 && p.targetFps <= 360)) throw new Error(`quality: targetFps ${p.targetFps} is not in 20..360`);
  for (const [id, level] of Object.entries(p.levels)) if (!QUALITY_LEVELS.includes(level)) throw new Error(`quality: level "${level}" of "${id}" is not one of ${QUALITY_LEVELS.join(', ')}`);
}

/** The registry and the levels in force. */
export class QualityState implements CoreQuality {
  private readonly registered: RegisteredSetting[] = [];
  private readonly byId = new Map<string, RegisteredSetting>();
  private readonly levels = new Map<string, QualityLevelName>();
  private readonly rebuilders = new Map<string, (params: Readonly<Record<string, number>>) => void | Promise<void>>();
  private current: QualityProfile | null = null;

  constructor(core: FeatureQualityDecl) {
    this.register(core);
  }

  /** Register a feature's declaration (`addFeature`, before the feature's `init`). */
  register(decl: FeatureQualityDecl): void {
    for (const s of decl.settings) {
      const other = this.byId.get(s.id);
      // A second instance of the same feature (two atmosphere features, each with its own id) shares the setting.
      if (other && JSON.stringify(other.setting) === JSON.stringify(s)) continue;
      if (other) throw new Error(`quality: setting "${s.id}" of "${decl.featureId}" is already declared differently by "${other.featureId}"`);
      if (!s.levels.some((l) => l.name === 'ultra')) throw new Error(`quality: setting "${s.id}" of "${decl.featureId}" has no 'ultra' level`);
      const entry = { featureId: decl.featureId, setting: s };
      this.registered.push(entry);
      this.byId.set(s.id, entry);
    }
  }

  settings(): readonly RegisteredSetting[] {
    return this.registered;
  }

  level(settingId: string): QualityLevelName {
    return this.levels.get(settingId) ?? 'ultra';
  }

  params(settingId: string, decl?: FeatureQualityDecl): Readonly<Record<string, number>> {
    // A page that wraps a feature without its `quality` member still has the feature's own declaration.
    if (!this.byId.has(settingId) && decl) this.register(decl);
    const entry = this.byId.get(settingId);
    if (!entry) throw new Error(`quality: no feature declares the setting "${settingId}"`);
    return paramsAt(entry.setting, this.level(settingId));
  }

  onRebuild(settingId: string, rebuild: (params: Readonly<Record<string, number>>) => void | Promise<void>): void {
    const entry = this.byId.get(settingId);
    if (!entry) throw new Error(`quality: onRebuild("${settingId}"): no feature declares it`);
    if (entry.setting.apply !== 'rebuild') throw new Error(`quality: onRebuild("${settingId}"): the setting is applied live`);
    if (this.rebuilders.has(settingId)) throw new Error(`quality: onRebuild("${settingId}") is registered twice`);
    this.rebuilders.set(settingId, rebuild);
  }

  profile(): QualityProfile | null {
    return this.current ? { ...this.current, levels: { ...this.current.levels } } : null;
  }

  /** Take a profile: the levels change at once (live settings are read from the next frame on); returns what changed. */
  set(profile: QualityProfile): QualityChange {
    validateProfile(profile);
    const change: QualityChange = { live: [], rebuild: [] };
    for (const { setting } of this.registered) {
      const before = this.level(setting.id);
      const after = profile.levels[setting.id] ?? 'ultra';
      if (before === after) continue;
      const a = paramsAt(setting, before);
      const b = paramsAt(setting, after);
      this.levels.set(setting.id, after);
      const same = Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
      if (same) continue;
      (setting.apply === 'rebuild' ? change.rebuild : change.live).push(setting.id);
    }
    this.current = { ...profile, levels: { ...profile.levels } };
    return change;
  }

  /** Run the rebuilds of these settings (each with its current parameters), in the order given. */
  async rebuild(ids: readonly string[]): Promise<void> {
    for (const id of ids) await this.rebuilders.get(id)?.(this.params(id));
  }
}

/**
 * The six fields of the deprecated `QualitySettings` (RenderContext.quality), kept as the resolved view of
 * the profile for any reader of the contract until the lead retires it (request capability-settings-1).
 */
export function legacyQualityView(q: CoreQuality, renderScaleMin: number, renderScaleMax: number, legacy: QualitySettings): QualitySettings {
  const has = (id: string): boolean => q.settings().some((s) => s.setting.id === id);
  return {
    renderScaleMin,
    renderScaleMax,
    terrainPxPerQuad: has('terrain') ? q.params('terrain')['pxPerQuad']! : legacy.terrainPxPerQuad,
    shadowResolution: q.params('shadows')['mapSize']!,
    cloudSteps: has('clouds') ? q.params('clouds')['steps']! : legacy.cloudSteps,
    atmosphereSteps: has('atmosphere') ? q.params('atmosphere')['steps']! : legacy.atmosphereSteps,
  };
}
