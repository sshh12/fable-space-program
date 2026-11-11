/**
 * State-dependent looks and content rules of the vehicle package:
 *  - the decal sheet is data: its section loads, packs into its atlas, and no marking, vehicle, part or site
 *    of the definition library is named in the package's source;
 *  - engines take soot inside only, and only all or nothing (no half-sooted metal); an engine that burns
 *    clean takes none and soots nothing;
 *  - the barrels of a frosting tank carry frost weights between their frost lines (no dithered layer);
 *  - a broken landing leg is posed broken.
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { ModuleState } from '@/core/contracts/sim';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { DECAL_SECTION, decalSheetOf } from '@/render/vehicle/decals';
import { generatePart, type PartVisual, type PoseOpts } from '@/render/vehicle/parts';
import { brokenLegPose, legPose } from '@/render/vehicle/parts/lander';
import { NEUTRAL_ANIM } from '@/render/vehicle/parts/types';
import { assembleVessel, vesselPartSnapshots } from '@/sim/vessel/public';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
});

interface Item {
  model: string;
  pos: Vec3Tuple | null;
  rot: QuatTuple | null;
  opts: PoseOpts | undefined;
}

function posed(visual: PartVisual, defId: string, modules: readonly ModuleState[], anim: Partial<typeof NEUTRAL_ANIM> = {}): Item[] {
  const out: Item[] = [];
  visual.pose({ def: defs.parts[defId]!, modules, panel: null, anim: { ...NEUTRAL_ANIM, ...anim } }, (model, pos, rot, opts) => void out.push({ model, pos, rot, opts }));
  return out;
}

const launchModules = (defId: string): readonly ModuleState[] => {
  for (const vehicleId of Object.keys(defs.vehicles)) {
    const p = vesselPartSnapshots(assembleVessel(defs, vehicleId)).find((x) => x.def === defId);
    if (p) return p.modules;
  }
  throw new Error(`no vehicle uses part "${defId}"`);
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('content lives in the definition library', () => {
  it('the decal sheet is a section of the library and packs into its atlas', () => {
    const sheet = decalSheetOf(defs);
    expect(defs.sections[DECAL_SECTION]).toBeDefined();
    expect(sheet.def.decals.length).toBeGreaterThanOrEqual(10);
    const rects = Object.values(sheet.layout);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(sheet.def.padding);
      expect(r.x + r.w).toBeLessThanOrEqual(sheet.def.size - sheet.def.padding);
      expect(r.y + r.h).toBeLessThanOrEqual(sheet.def.size - sheet.def.padding);
    }
    // No two decals overlap.
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const c = rects[j]!;
        expect(a.x + a.w <= c.x || c.x + c.w <= a.x || a.y + a.h <= c.y || c.y + c.h <= a.y, `decals ${i} and ${j} overlap`).toBe(true);
      }
    }
    for (const d of sheet.def.decals) {
      const [u0, v0, u1, v1] = sheet.uv(d.name);
      expect(u1).toBeGreaterThan(u0);
      expect(v1).toBeGreaterThan(v0);
      expect(sheet.aspect(d.name)).toBeCloseTo(d.w / d.h, 9);
    }
    expect(() => sheet.uv('no-such-decal')).toThrow(/unknown decal/);
  });

  it('the package source names no marking text, vehicle, part or site of the library', () => {
    const root = path.resolve(__dirname, '..', '..', '..', 'src', 'render', 'vehicle');
    const files = sourceFiles(root);
    expect(files.length).toBeGreaterThan(20);
    const sheet = decalSheetOf(defs);
    const texts = sheet.def.decals.map((d) => d.text).filter((t): t is string => typeof t === 'string' && t.length >= 5);
    const ids = [...Object.keys(defs.parts), ...Object.keys(defs.vehicles), ...Object.keys(defs.sites)];
    expect(texts.length).toBeGreaterThan(5);
    expect(ids.length).toBeGreaterThan(25);
    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const t of texts) if (text.includes(t)) hits.push(`${path.relative(root, file)}: marking text "${t}"`);
      for (const id of ids) if (new RegExp(`['"\`/]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`./]`).test(text)) hits.push(`${path.relative(root, file)}: id "${id}"`);
    }
    expect(hits).toEqual([]);
  });

  it('every structure of every site names its markings itself (a site without names has none)', async () => {
    const { generateStructure } = await import('@/render/vehicle/site');
    for (const site of Object.values(defs.sites)) {
      for (const s of site.structures) {
        // Strip every parameter that names a decal: the structure must still build, without the 'decal' materials.
        const params = Object.fromEntries(Object.entries(s.params ?? {}).filter(([k]) => !/decal|sign|label/i.test(k)));
        const v = generateStructure(defs, site, s.model, params);
        for (const [name, m] of Object.entries(v.models)) expect(m.materials.some((x) => x.name === 'decal' || x.name === 'decal-ground'), `${s.model}.${name} without marking parameters`).toBe(false);
      }
    }
  });
});

describe('soot, frost and damage', () => {
  it('engines soot inside only, all or nothing; a clean-burning engine takes none', () => {
    let engines = 0;
    let sooting = 0;
    for (const def of Object.values(defs.parts)) {
      if (def.visual?.generator !== 'engine.liquid') continue;
      engines++;
      const v = generatePart(defs, def);
      const clean = !v.sootSeconds;
      if (!clean) sooting++;
      let full = 0;
      for (const [name, model] of Object.entries(v.models)) {
        for (const mesh of model.lods) {
          const m = mesh.masks!;
          for (let i = 0; i < m.length / 4; i++) {
            const w = m[i * 4 + 2]!;
            if (w !== 0 && w !== 255) throw new Error(`${def.id}.${name}: partial soot weight ${w} at vertex ${i}`);
            if (w === 255) full++;
          }
        }
      }
      // A clean engine has soot only on its heat-shield boot (cloth), if it has one; a sooting one inside its bell.
      if (clean) expect(full, `${def.id}: sooted vertices of a clean engine`).toBeLessThan(4000);
      else expect(full, `${def.id}: sooted vertices`).toBeGreaterThan(500);
    }
    expect(engines).toBeGreaterThanOrEqual(3);
    expect(sooting).toBeGreaterThanOrEqual(1);
    expect(sooting).toBeLessThan(engines);
  });

  it('the barrels of a frosting tank carry frost weights from frost line to frost line; nothing is drawn as a dithered layer', () => {
    let frosting = 0;
    for (const def of Object.values(defs.parts)) {
      if (def.visual?.generator !== 'stage.tank') continue;
      const v = generatePart(defs, def);
      // Frost is surface shading of the skin (the instance's frost amount times these weights): a stage is
      // one model whatever its frost, and no item is ever emitted with partial (dithered) coverage.
      for (const frost of [0, 0.4, 1]) {
        const items = posed(v, def.id, launchModules(def.id), { frost });
        expect(items.map((x) => x.model)).toEqual(['body']);
        expect(items[0]!.opts?.fade).toBeUndefined();
      }
      const amount = Number(def.visual.params['frost'] ?? 1);
      if (!(amount > 0)) continue;
      frosting++;
      const tanks = (def.resources ?? []).filter((r) => r.tankHeight > 1).map((r) => ({ y0: r.tankBottomY, y1: r.tankBottomY + r.tankHeight }));
      const R = def.bounds.radius;
      for (const mesh of v.models['body']!.lods.slice(0, 2)) {
        let onBarrel = 0;
        let frosted = 0;
        let stray = 0;
        const shell = mesh.meta.tags.indexOf('shell');
        const seen = new Uint8Array(mesh.positions.length / 3);
        for (let t = 0; t < mesh.indices.length / 3; t++) {
          if (mesh.meta.triComponent[t] !== shell) continue;
          for (let c = 0; c < 3; c++) {
            const i = mesh.indices[t * 3 + c]!;
            if (seen[i]) continue;
            seen[i] = 1;
            const y = mesh.positions[i * 3 + 1]!;
            const r = Math.hypot(mesh.positions[i * 3]!, mesh.positions[i * 3 + 2]!);
            const w = mesh.masks![i * 4 + 3]! / 255;
            if (r < R - 1e-3) {
              // Domes and skirt interiors never frost.
              expect(w).toBe(0);
              continue;
            }
            const inside = tanks.some((k) => y > k.y0 + 0.05 && y < k.y1 - 0.05);
            const outside = tanks.every((k) => y < k.y0 - 0.2 || y > k.y1 + 0.2);
            if (inside) {
              onBarrel++;
              // A coat everywhere on the barrel (thinner over markings), nowhere a hole in it.
              if (w >= 0.25 * amount) frosted++;
            }
            if (outside && w > 0) stray++;
          }
        }
        expect(onBarrel).toBeGreaterThan(100);
        expect(frosted / onBarrel, `${def.id}: share of the barrel vertices with a frost coat`).toBeGreaterThan(0.98);
        expect(stray, `${def.id}: frost beyond the frost lines`).toBe(0);
      }
    }
    expect(frosting).toBeGreaterThanOrEqual(1);
  });

  it('a broken landing leg is posed broken: strut splayed, piston kinked at the knee, foot still near the ground', () => {
    let checked = 0;
    for (const def of Object.values(defs.parts)) {
      if (def.visual?.generator !== 'lander.legs') continue;
      const legsIndex = def.modules.findIndex((m) => m.type === 'legs');
      const legsDef = def.modules[legsIndex]!;
      if (legsDef.type !== 'legs') continue;
      const v = generatePart(defs, def);
      const base = launchModules(def.id).map((m) => (m.type === 'legs' ? { ...m, deploy: 1 } : m));
      const withBroken = (broken: boolean[]): readonly ModuleState[] => base.map((m) => (m.type === 'legs' ? { ...m, broken } : m));
      const n = legsDef.legs.length;
      const intact = posed(v, def.id, withBroken(new Array<boolean>(n).fill(false)));
      const broken = posed(v, def.id, withBroken(legsDef.legs.map((_, i) => i === 0)));
      // A broken leg shows one thing more: the crushed core spilling from the mouth of its upper tube.
      expect(broken.filter((x) => x.model === 'crushed').length).toBe(1);
      expect(intact.some((x) => x.model === 'crushed')).toBe(false);
      const rest = broken.filter((x) => x.model !== 'crushed');
      expect(rest.length).toBe(intact.length);
      // Items are emitted leg by leg: body, then per leg upper, lower, pad and the brace pairs.
      const perLeg = (intact.length - 1) / n;
      expect(Number.isInteger(perLeg)).toBe(true);
      const differs = (a: Item, c: Item): boolean => JSON.stringify([a.pos, a.rot]) !== JSON.stringify([c.pos, c.rot]);
      for (let i = 1; i < intact.length; i++) {
        const leg = Math.floor((i - 1) / perLeg);
        if (leg === 0) continue;
        expect(differs(intact[i]!, rest[i]!), `leg ${leg} item ${intact[i]!.model} moved`).toBe(false);
      }
      const moved = intact.slice(1, 1 + perLeg).filter((it, k) => differs(it, rest[1 + k]!)).map((it) => it.model);
      expect(moved).toEqual(expect.arrayContaining(['upper', 'lower', 'pad']));
      // Geometry of the break.
      const lp = legPose(legsDef.legs[0]!, 1, 0);
      const br = brokenLegPose(lp, 2.7, 2.25);
      const cosKnee = br.upperDir[0] * br.lowerDir[0] + br.upperDir[1] * br.lowerDir[1] + br.upperDir[2] * br.lowerDir[2];
      // The break reads at a glance: a knee of more than 35 degrees, the tube swung up by more than 25.
      expect(Math.acos(cosKnee) * (180 / Math.PI)).toBeGreaterThan(35);
      const cosSplay = br.upperDir[0] * lp.dir[0] + br.upperDir[1] * lp.dir[1] + br.upperDir[2] * lp.dir[2];
      expect(Math.acos(cosSplay) * (180 / Math.PI)).toBeGreaterThan(25);
      // The piston still stands at the height the foot stood at, within the reach of the leg.
      expect(Math.abs(br.foot[1] - lp.foot[1])).toBeLessThan(0.25);
      expect(Math.hypot(br.foot[0] - lp.foot[0], br.foot[2] - lp.foot[2])).toBeLessThan(1.6);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(1);
  });
});
