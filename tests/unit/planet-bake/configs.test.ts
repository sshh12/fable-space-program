/**
 * The planet bake's configs (tools/bake/planet/bodies/*.json) and credits: one config for every body the brief
 * names, radii, levels within the caps, sources with checksums and a redistributable licence, amplification
 * models that the registry builds with the resolved parameters. Runs without any baked data.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAmplificationModel } from '../../../src/terrain/amplification/registry';
import { GENERIC_PARAMS } from '../../../src/terrain/amplification/generic';
import type { BodyServices } from '../../../src/terrain/amplification/types';
import { configs, GIANTS, readJson, REPO_ROOT, resolvedAmplification, SOLID_BODIES } from './shared';

const all = configs();
const solids = all.filter((c) => c.kind === 'solid');
const credits = readJson<Record<string, { licence: string; attribution: string; url: string }>>(path.join(REPO_ROOT, 'tools/bake/planet/credits.json'));

function services(id: string, radius: number): BodyServices {
  return {
    bodyId: id,
    radius,
    seaLevel: null,
    flattenAt: () => 0,
    effectiveLevelAt: () => 3,
    landcoverAt: () => 0,
    dataGeneration: () => 0,
    markIncomplete: () => undefined,
  };
}

describe('planet-bake configs', () => {
  it('there is exactly one solid config for every body of the brief, and one giant config per giant', () => {
    expect(solids.map((c) => c.name).sort()).toEqual([...SOLID_BODIES].sort());
    expect(all.filter((c) => c.kind === 'giant').map((c) => c.name).sort()).toEqual([...GIANTS].sort());
    for (const c of all) expect(c.id).toBe(c.name.toLowerCase());
  });

  it('radii: mean between the smallest and the largest semi-axis; a >= b >= c', () => {
    for (const c of all) {
      const { mean, a, b, c: cc } = c.radii;
      expect(a, c.id).toBeGreaterThanOrEqual(b);
      expect(b, c.id).toBeGreaterThanOrEqual(cc);
      expect(mean, c.id).toBeLessThanOrEqual(a + 1e-6);
      expect(mean, c.id).toBeGreaterThanOrEqual(cc - 1e-6);
    }
  });

  it('levels stay within the caps of solar-system.md 5.2 (albedo <= 6, height <= 5)', () => {
    for (const c of solids) {
      expect(c.albedo!.maxLevel, c.id).toBeLessThanOrEqual(6);
      expect(c.height!.maxLevel, c.id).toBeLessThanOrEqual(5);
      expect(c.height!.residentLevel, c.id).toBeLessThanOrEqual(c.height!.maxLevel);
    }
  });

  it('every source has an https URL, a size and its provider checksum, and a credit with a redistributable licence', () => {
    for (const c of all) {
      for (const [k, s] of Object.entries(c.sources)) {
        expect(s.url.startsWith('https://'), `${c.id}.${k}`).toBe(true);
        expect(s.bytes, `${c.id}.${k}`).toBeGreaterThan(0);
        expect(c.credits, `${c.id}.${k}`).toContain(s.credit);
      }
      for (const id of c.credits) {
        const e = credits[id];
        expect(e, `${c.id}: credit ${id}`).toBeDefined();
        expect(/public domain|cc by/i.test(e!.licence), `${id}: ${e!.licence}`).toBe(true);
        expect(e!.attribution.length).toBeGreaterThan(10);
      }
    }
  });

  it('bodies with no global map are procedural and carry a crater population; the others have landmark tests', () => {
    for (const c of solids) {
      if (c.albedo!.procedural) expect(c.height!.craters, c.id).not.toBeNull();
      else expect(c.landmarks!.length, c.id).toBeGreaterThan(0);
    }
  });

  it('every amplification definition resolves to a complete generic parameter set and builds through the registry', () => {
    for (const c of solids) {
      const def = resolvedAmplification(c);
      expect(['rocky-generic', 'icy-generic'], c.id).toContain(def.model);
      for (const k of GENERIC_PARAMS) expect(Number.isFinite(def.params[k]), `${c.id}.${k}`).toBe(true);
      const R = c.radii.mean;
      const model = createAmplificationModel(def, {
        services: services(c.id, R),
        globalMaxLevel: c.height!.maxLevel,
        log2FinestLambda: Math.log2((Math.PI * R) / 2 / 2 ** 20 / 128),
        lambda0: (Math.PI * R) / 256,
      });
      expect(model.name).toBe(def.model);
    }
  });

  it('seeds are distinct per body', () => {
    const seeds = solids.map((c) => c.amplification!.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});
