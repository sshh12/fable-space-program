/**
 * The generic models: registered under their keys, strict about their parameters, identical in output to the
 * lunar-regolith algorithm they derive from, and the crater split between the run-time model and the bake
 * (procedural bodies) draws every crater exactly once.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TerrainAmplificationDef } from '../../core/contracts/defs';
import { CraterField, type CraterRecord } from '../craters';
import { smootherstep01 } from '../util';
import { bakeCraterWeight, genericCraterParams, runtimeCraterLog2MaxD } from './generic';
import { lunarCraterParams } from './lunarRegolith';
import { amplificationModelNames, createAmplificationModel } from './registry';
import type { BodyServices, ModelContext } from './types';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (name: string): TerrainAmplificationDef =>
  JSON.parse(readFileSync(path.join(REPO, 'data/defs/terrain', `${name}.amplification.json`), 'utf8')) as TerrainAmplificationDef;

const R = 252100;
const G = 3;
const lambda0 = (Math.PI * R) / 256;

function ctx(id: string): ModelContext {
  const services: BodyServices = {
    bodyId: id,
    radius: R,
    seaLevel: null,
    flattenAt: () => 0,
    effectiveLevelAt: () => G,
    landcoverAt: () => 0,
    dataGeneration: () => 0,
    markIncomplete: () => undefined,
  };
  return { services, globalMaxLevel: G, log2FinestLambda: Math.log2((Math.PI * R) / 2 / 2 ** 16 / 128), lambda0 };
}

describe('generic amplification models', () => {
  it('are registered beside the existing models', () => {
    expect(amplificationModelNames()).toEqual(expect.arrayContaining(['none', 'lunar-regolith', 'earth-landcover', 'rocky-generic', 'icy-generic']));
  });

  it('reject a missing or an unknown parameter', () => {
    const def = read('icy-generic');
    const rest = Object.fromEntries(Object.entries(def.params).filter(([k]) => k !== 'hurstMaria'));
    expect(() => createAmplificationModel({ ...def, params: rest }, ctx('x'))).toThrow(/missing parameters hurstMaria/);
    expect(() => createAmplificationModel({ ...def, params: { ...def.params, typo: 1 } }, ctx('x'))).toThrow(/unknown parameters typo/);
    expect(() => createAmplificationModel(read('rocky-generic'), ctx('x'))).not.toThrow();
  });

  it('give exactly the lunar-regolith output for the same parameters and seed (derived, not re-implemented)', () => {
    for (const name of ['rocky-generic', 'icy-generic']) {
      const def = read(name);
      const gen = createAmplificationModel(def, ctx('g'));
      const lun = createAmplificationModel({ ...def, model: 'lunar-regolith' }, ctx('l'));
      expect(gen.name).toBe(name);
      const m1 = new Float64Array(3);
      const m2 = new Float64Array(3);
      const lam = new Float64Array([Math.log2(0.5), Math.log2(8), Math.log2(64)]);
      for (let i = 0; i < 40; i++) {
        const a = (i * 0.61803398875) % 1;
        const b = (i * 0.41421356237) % 1;
        const th = Math.acos(1 - 2 * a);
        const ph = 2 * Math.PI * b;
        const px = R * Math.sin(th) * Math.cos(ph);
        const py = R * Math.sin(th) * Math.sin(ph);
        const pz = R * Math.cos(th);
        const pt = { px, py, pz, E: G, log2LambdaData: Math.log2(lambda0) - G, dataHeight: 0, dataSlope: 0.05, landcover: null };
        gen.modulators(pt, m1, 0);
        lun.modulators(pt, m2, 0);
        const o1 = new Float64Array(3);
        const o2 = new Float64Array(3);
        gen.add(px, py, pz, m1, 0, lam, 3, o1, Infinity, true);
        lun.add(px, py, pz, m2, 0, lam, 3, o2, Infinity, true);
        expect(Array.from(o1)).toEqual(Array.from(o2));
      }
    }
  });

  it('the bake extends the crater classes without changing the run-time ones', () => {
    const def = read('icy-generic');
    const rtField = new CraterField(lunarCraterParams(def, R, G, lambda0));
    const bakeField = new CraterField(genericCraterParams(def, R, G, lambda0, 0.4 * R));
    expect(bakeField.classes.length).toBeGreaterThan(rtField.classes.length);
    const byK = new Map(bakeField.classes.map((c) => [c.k, c]));
    for (const c of rtField.classes) {
      const b = byK.get(c.k)!;
      expect(b.dLo).toBe(c.dLo);
      expect(b.cell).toBe(c.cell);
      const l1: CraterRecord[] = [];
      const l2: CraterRecord[] = [];
      c.cellCraters(3, -2, 7, l1);
      b.cellCraters(3, -2, 7, l2);
      expect(l2).toEqual(l1);
    }
  });

  it('run time (CraterField.add at E = globalMaxLevel) and bake (bakeCraterWeight, as procedural.ts uses it) together draw every crater exactly once', () => {
    for (const name of ['rocky-generic', 'icy-generic']) {
      const def = read(name);
      const lmax = runtimeCraterLog2MaxD(def, lambda0, G);
      // the helper is the limit the real model passes to CraterField.add (its longest scale at E = G is the crater limit)
      const model = createAmplificationModel(def, ctx('w'));
      expect(model.maxLengthLog2(Math.log2(lambda0) - G)).toBeCloseTo(lmax, 12);
      const rtField = new CraterField(lunarCraterParams(def, R, G, lambda0));
      const bakeField = new CraterField(genericCraterParams(def, R, G, lambda0, 0.4 * R));
      const ext = bakeField.p.extentRadii;
      for (const log2Lambda of [Math.log2(lambda0) - G - 3, Math.log2(lambda0) - G, Math.log2(lambda0) - G + 2]) {
        const lam = new Float64Array([log2Lambda]);
        let checked = 0;
        for (let i = 0; i < 400; i++) {
          const a = (i * 0.61803398875) % 1;
          const b = (i * 0.41421356237) % 1;
          const th = Math.acos(1 - 2 * a);
          const ph = 2 * Math.PI * b;
          const px = R * Math.sin(th) * Math.cos(ph);
          const py = R * Math.sin(th) * Math.sin(ph);
          const pz = R * Math.cos(th);
          const rt = new Float64Array(1);
          rtField.add(px, py, pz, lmax, lam, 1, rt, Infinity);
          let bake = 0;
          let all = 0;
          for (const c of bakeField.classes) {
            const h = c.heightAt(px, py, pz, ext);
            bake += bakeCraterWeight(c, lmax, log2Lambda) * h;
            all += smootherstep01(c.log2DLo - log2Lambda) * h;
          }
          if (all !== 0) checked++;
          expect(rt[0]! + bake).toBeCloseTo(all, 6);
        }
        expect(checked).toBeGreaterThan(50);
      }
    }
  });
});
