/**
 * The render core's quality registry (src/render/core/quality.ts): declarations, levels, what a profile
 * changes, the pixel cap and the governor's budget, and that Ultra is the renderer of before the settings
 * (every Ultra parameter equals the value the code used before; RENDER_API section 20).
 */
import { describe, expect, it } from 'vitest';
import type { FeatureQualityDecl, QualityProfile } from '@/core/contracts/render';
import { CORE_QUALITY, governorBudgetMs, legacyQualityView, paramsAt, QUALITY_LEVELS, QualityState, renderScaleCap } from '@/render/core/quality';
import { ATMOSPHERE_QUALITY } from '@/render/atmosphere/quality';
import { TERRAIN_QUALITY } from '@/render/terrain/quality';
import { VFX_QUALITY } from '@/render/vfx/quality';

const ALL: FeatureQualityDecl[] = [ATMOSPHERE_QUALITY, TERRAIN_QUALITY, VFX_QUALITY];
const profile = (levels: QualityProfile['levels'], o: Partial<QualityProfile> = {}): QualityProfile => ({ pixelCap: 3.7, renderScaleMin: 0.6, targetFps: 60, levels, ...o });

describe('quality declarations', () => {
  it('Ultra is the renderer as it was: every Ultra parameter is the value of before the settings', () => {
    const q = new QualityState(CORE_QUALITY);
    for (const d of ALL) q.register(d);
    expect(q.params('shadows')).toEqual({ mapSize: 2048 });
    expect(q.params('ambientOcclusion')).toEqual({ slices: 2, steps: 6 });
    expect(q.params('clouds')).toEqual({ steps: 96 });
    expect(q.params('atmosphere')).toEqual({ steps: 24 });
    expect(q.params('terrain')).toEqual({ pxPerQuad: 8 });
    expect(q.params('effects')).toEqual({ particles: 1, march: 1 });
    expect(legacyQualityView(q, 0.5, 1, { renderScaleMin: 0.5, renderScaleMax: 1, terrainPxPerQuad: 8, shadowResolution: 2048, cloudSteps: 96, atmosphereSteps: 24 })).toEqual({
      renderScaleMin: 0.5,
      renderScaleMax: 1,
      terrainPxPerQuad: 8,
      shadowResolution: 2048,
      cloudSteps: 96,
      atmosphereSteps: 24,
    });
  });
  it('every setting declares the four levels, monotonic in cost, with a cost model and a weight', () => {
    for (const d of [CORE_QUALITY, ...ALL]) {
      for (const s of d.settings) {
        expect(s.levels.map((l) => l.name)).toEqual([...QUALITY_LEVELS]);
        const r = QUALITY_LEVELS.map((l) => s.costModel.ratios[l]!);
        expect(r[3]).toBe(1);
        for (let i = 1; i < r.length; i++) expect(r[i]!).toBeGreaterThanOrEqual(r[i - 1]!);
        expect(s.weight).toBeGreaterThan(0);
      }
    }
  });
  it('refuses a setting declared differently twice and one without Ultra; shares an identical one', () => {
    const q = new QualityState(CORE_QUALITY);
    q.register(ATMOSPHERE_QUALITY);
    expect(() => q.register({ ...ATMOSPHERE_QUALITY, featureId: 'atmosphere-2' })).not.toThrow();
    expect(q.settings().filter((s) => s.setting.id === 'clouds')).toHaveLength(1);
    const other: FeatureQualityDecl = { featureId: 'x', settings: [{ ...ATMOSPHERE_QUALITY.settings[0]!, weight: 9 }] };
    expect(() => q.register(other)).toThrow(/already declared differently/);
    const noUltra: FeatureQualityDecl = { featureId: 'y', settings: [{ id: 'y', label: 'Y', levels: [{ name: 'low', params: { a: 1 } }], apply: 'live', costModel: { exponent: 0, ratios: {}, constantMs: 0 }, weight: 1 }] };
    expect(() => q.register(noUltra)).toThrow(/no 'ultra'/);
  });
  it('a feature added through a wrapper that drops its declaration still finds its parameters', () => {
    const q = new QualityState(CORE_QUALITY);
    expect(() => q.params('clouds')).toThrow(/no feature declares/);
    expect(q.params('clouds', ATMOSPHERE_QUALITY)).toEqual({ steps: 96 });
    expect(q.settings().some((s) => s.setting.id === 'clouds')).toBe(true);
  });
  it('a level a setting does not declare takes the next one above', () => {
    const s = { id: 's', label: 'S', levels: [{ name: 'high' as const, params: { a: 2 } }, { name: 'ultra' as const, params: { a: 3 } }], apply: 'live' as const, costModel: { exponent: 0, ratios: {}, constantMs: 0 }, weight: 1 };
    expect(paramsAt(s, 'low')).toEqual({ a: 2 });
    expect(paramsAt(s, 'ultra')).toEqual({ a: 3 });
  });
});

describe('a profile', () => {
  it('changes the levels and reports what is live and what is rebuilt; equal parameters change nothing', async () => {
    const q = new QualityState(CORE_QUALITY);
    for (const d of ALL) q.register(d);
    const rebuilt: number[] = [];
    q.onRebuild('shadows', (p) => void rebuilt.push(p['mapSize']!));
    expect(q.profile()).toBeNull();
    const low = q.set(profile({ shadows: 'low', clouds: 'low', terrain: 'medium', ambientOcclusion: 'high' }));
    expect(low.rebuild).toEqual(['shadows']);
    expect(low.live.sort()).toEqual(['clouds', 'terrain']);
    expect(q.params('clouds')).toEqual({ steps: 48 });
    expect(q.level('atmosphere')).toBe('ultra');
    await q.rebuild(low.rebuild);
    expect(rebuilt).toEqual([1024]);
    // High shadows are Ultra's map size: nothing to rebuild.
    expect(q.set(profile({ shadows: 'high' })).rebuild).toEqual(['shadows']);
    expect(q.set(profile({ shadows: 'ultra' })).rebuild).toEqual([]);
  });
  it('is validated', () => {
    const q = new QualityState(CORE_QUALITY);
    expect(() => q.set(profile({}, { pixelCap: 0 }))).toThrow(/pixelCap/);
    expect(() => q.set(profile({}, { renderScaleMin: 1.5 }))).toThrow(/renderScaleMin/);
    expect(() => q.set(profile({}, { targetFps: 5 }))).toThrow(/targetFps/);
    expect(() => q.set(profile({ clouds: 'epic' as never }))).toThrow(/level "epic"/);
  });
  it('caps the internal resolution by megapixels of the display and derives the governor budget from the frame rate', () => {
    expect(renderScaleCap(3.7, 2560, 1440)).toBe(1);
    expect(renderScaleCap(3.7, 3840, 2160)).toBeCloseTo(Math.sqrt(3.7 / 8.2944), 6);
    expect(renderScaleCap(0.9, 1280, 720)).toBeCloseTo(Math.sqrt(0.9 / 0.9216), 6);
    expect(renderScaleCap(0.9, 2560, 1440)).toBeCloseTo(0.494, 3);
    expect(governorBudgetMs(60)).toBeCloseTo(11, 9);
    expect(governorBudgetMs(120)).toBeCloseTo(5.5, 9);
  });
});
