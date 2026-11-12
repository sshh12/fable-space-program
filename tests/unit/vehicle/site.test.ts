/**
 * Launch-complex structures: every structure listed for a site has a generator, its meshes are valid at
 * every LOD, it stands on the pad surface, and its moving pieces (swing arms, crew arm) move away from the
 * vehicle when they retract. Also the nozzle temperature model of the vessel feature.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import type { QuatTuple, Vec3Tuple } from '@/core/math';
import { checkMesh } from '@/render/vehicle/geom/validate';
import { isMatId } from '@/render/vehicle/materials';
import { generateStructure, siteGeneratorIds, type SiteState, type SiteVisual } from '@/render/vehicle/site';
import { siteGround, siteSurvey, structureGround } from '@/render/vehicle/site/survey';
import { nozzleEquilibrium, stepNozzleTemp } from '@/render/vehicle/vesselFeature';

let defs: DefLibrary;
const visuals: { site: string; index: number; model: string; offset: Vec3Tuple; visual: SiteVisual }[] = [];

beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
  for (const site of Object.values(defs.sites)) {
    site.structures.forEach((s, index) => {
      visuals.push({ site: site.id, index, model: s.model, offset: [s.offsetEnu[0], s.offsetEnu[1], s.offsetEnu[2]], visual: generateStructure(defs, site, s.model, s.params ?? {}, s) });
    });
  }
});

function rotate(q: QuatTuple, x: number, y: number, z: number): Vec3Tuple {
  const tx = 2 * (q[1] * z - q[2] * y);
  const ty = 2 * (q[2] * x - q[0] * z);
  const tz = 2 * (q[0] * y - q[1] * x);
  return [x + q[3] * tx + (q[1] * tz - q[2] * ty), y + q[3] * ty + (q[2] * tx - q[0] * tz), z + q[3] * tz + (q[0] * ty - q[1] * tx)];
}

interface Extent {
  yMin: number;
  yMax: number;
  /** Smallest horizontal distance of a vertex above `above` metres from the point `axis` (x, z). */
  nearest: number;
  triangles: number;
  items: number;
}

/** Bounds of a posed structure at one LOD in its model frame. */
function extent(v: SiteVisual, state: SiteState, lod: number, only: (name: string) => boolean, axis: [number, number] = [0, 0], above = 0): Extent {
  const e: Extent = { yMin: Infinity, yMax: -Infinity, nearest: Infinity, triangles: 0, items: 0 };
  v.pose(
    state,
    (name, pos, rot) => {
      const model = v.models[name];
      if (!model) throw new Error(`posed an unknown model "${name}"`);
      if (!only(name)) return;
      const mesh = model.lods[Math.min(lod, model.lods.length - 1)]!;
      e.items++;
      e.triangles += mesh.indices.length / 3;
      const p = mesh.positions;
      for (let k = 0; k < p.length; k += 3) {
        let c: Vec3Tuple = [p[k]!, p[k + 1]!, p[k + 2]!];
        if (rot) c = rotate(rot, c[0], c[1], c[2]);
        if (pos) c = [c[0] + pos[0], c[1] + pos[1], c[2] + pos[2]];
        e.yMin = Math.min(e.yMin, c[1]);
        e.yMax = Math.max(e.yMax, c[1]);
        if (c[1] > above) e.nearest = Math.min(e.nearest, Math.hypot(c[0] - axis[0], c[2] - axis[1]));
      }
    },
    { arms: false, crewArm: false },
  );
  return e;
}

const REST: SiteState = { night: 0, arms: 0, crewArm: 0 };
const all = (): boolean => true;

describe('launch complex structures', () => {
  it('every structure of every site has a generator and at least three LODs of every model', () => {
    expect(visuals.length).toBeGreaterThanOrEqual(15);
    const known = new Set(siteGeneratorIds());
    for (const s of visuals) {
      expect(known.has(s.model), `${s.site}[${s.index}] ${s.model}`).toBe(true);
      const names = Object.keys(s.visual.models);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const m = s.visual.models[name]!;
        // Three LODs; a wire has a fourth gauge so that it holds a pixel out to where its masts fade.
        expect(m.lods.length, `${s.model}.${name}`).toBeGreaterThanOrEqual(3);
        for (const mat of m.materials) expect(isMatId(mat.name), `${s.model}.${name} material ${mat.name}`).toBe(true);
        const tris = m.lods.map((l) => l.indices.length / 3);
        expect(tris[0]!, `${s.model}.${name}`).toBeGreaterThan(0);
        expect(tris[1]!).toBeLessThanOrEqual(tris[0]!);
        expect(tris[2]!).toBeLessThanOrEqual(tris[1]!);
      }
    }
  });

  it('every mesh has unit normals, orthonormal tangents, no degenerate triangles and watertight solids', () => {
    const seen = new Set<SiteVisual>();
    for (const s of visuals) {
      if (seen.has(s.visual)) continue;
      seen.add(s.visual);
      for (const [name, m] of Object.entries(s.visual.models)) {
        m.lods.forEach((mesh, lod) => {
          const r = checkMesh(mesh);
          const where = `${s.model}.${name} LOD${lod}`;
          expect(r.badNormals, `${where}: normals`).toBe(0);
          expect(r.badTangents, `${where}: tangents`).toBe(0);
          expect(r.degenerate, `${where}: degenerate triangles`).toBe(0);
          expect(r.leaks, `${where}: leaking closed components`).toEqual([]);
          expect(r.insideOut, `${where}: inside-out solids`).toEqual([]);
          expect(r.flipped, `${where}: flipped triangles ${JSON.stringify(r.flippedByTag)}`).toBe(0);
        });
      }
    }
  });

  it('every structure stands on the pad surface and none floats or is buried', () => {
    for (const s of visuals) {
      for (let lod = 0; lod < 3; lod++) {
        const e = extent(s.visual, REST, lod, all);
        expect(e.items, `${s.model} LOD${lod}`).toBeGreaterThan(0);
        if (s.model === 'pad.catenary') {
          // Wires strung between the mast tops: the only structure that is meant to hang in the air.
          expect(e.yMin, `${s.model} LOD${lod}`).toBeGreaterThan(60);
          continue;
        }
        if (s.model === 'pad.vehicle') {
          // A parked vehicle stands on the slab or the stone pad under it, which lie 0.1 to 0.3 m over the pad plane.
          expect(e.yMin, `${s.model} LOD${lod}`).toBeGreaterThan(0.05);
          expect(e.yMin, `${s.model} LOD${lod} floats`).toBeLessThan(0.36);
          continue;
        }
        // The lowest point is at or just below the surface (foundations, the flame trench), never above it.
        expect(e.yMin, `${s.model} LOD${lod} floats`).toBeLessThanOrEqual(0.02);
        expect(e.yMin, `${s.model} LOD${lod} buried`).toBeGreaterThan(-30);
        expect(e.yMax, `${s.model} LOD${lod}`).toBeGreaterThan(-0.5);
      }
    }
  });

  it('earthworks, roads, fences and pipe supports are built on the surveyed ground: fill above it, feet below it', () => {
    let checked = 0;
    for (const site of Object.values(defs.sites)) {
      const survey = siteSurvey(defs, site);
      // (A site without a survey is level ground, which the test above covers.)
      if (!survey) continue;
      // The survey bounds the terrain: it is not level, and its bounds are ordered.
      expect(Math.max(...survey.hiCm) - Math.min(...survey.loCm)).toBeGreaterThan(50);
      for (let k = 0; k < survey.hiCm.length; k++) expect(survey.hiCm[k]!).toBeGreaterThanOrEqual(survey.loCm[k]!);
      site.structures.forEach((s, index) => {
        if (s.model !== 'pad.groundworks' && s.model !== 'pad.fence' && s.model !== 'pad.pipeRun') return;
        const ground = structureGround(siteGround(defs, site), s.offsetEnu, s.headingDeg);
        const v = visuals.find((x) => x.site === site.id && x.index === index)!.visual;
        for (const [name, model] of Object.entries(v.models)) {
          model.lods.forEach((mesh, lod) => {
            const p = mesh.positions;
            const n = mesh.normals;
            const where = `${s.model}.${name} LOD${lod}`;
            if (name === 'ground') {
              // Every vertex of the ground model is either fill over the highest terrain or a foot under the lowest:
              // none lies inside the band the terrain occupies, where a surface could be buried or show its edge.
              for (let k = 0; k < p.length; k += 3) {
                const hi = ground.hi(p[k]!, p[k + 2]!);
                const lo = ground.lo(p[k]!, p[k + 2]!);
                const y = p[k + 1]!;
                expect(y >= hi + 0.02 || y <= lo - 0.3, `${where}: vertex at ${p[k]!.toFixed(1)}, ${p[k + 2]!.toFixed(1)} is at ${y.toFixed(2)} m, terrain ${lo.toFixed(2)} .. ${hi.toFixed(2)} m`).toBe(true);
                checked++;
              }
              // And the level faces between them stay above the terrain all the way across (centres of the triangles).
              const ix = mesh.indices;
              for (let t = 0; t < ix.length; t += 3) {
                const a = ix[t]! * 3;
                const c = ix[t + 1]! * 3;
                const d = ix[t + 2]! * 3;
                if (Math.min(n[a + 1]!, n[c + 1]!, n[d + 1]!) < 0.99) continue;
                const x = (p[a]! + p[c]! + p[d]!) / 3;
                const z = (p[a + 2]! + p[c + 2]! + p[d + 2]!) / 3;
                const y = (p[a + 1]! + p[c + 1]! + p[d + 1]!) / 3;
                expect(y, `${where}: face at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBeGreaterThan(ground.hi(x, z));
              }
            } else if (name !== 'shadow' && name !== 'pole-lamps') {
              // Posts, plinths, berms and fabric: the lowest point of the model is under the terrain there
              // (shadow stand-ins and lamp lenses are not on the ground).
              let yMin = Infinity;
              let at = 0;
              for (let k = 0; k < p.length; k += 3) {
                if (p[k + 1]! < yMin) {
                  yMin = p[k + 1]!;
                  at = k;
                }
              }
              if (p.length > 0) expect(yMin, where).toBeLessThanOrEqual(ground.lo(p[at]!, p[at + 2]!) + 1e-6);
            }
          });
        }
      });
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('swing arms and the crew arm move away from the vehicle when they retract, and nothing else moves', () => {
    let towers = 0;
    for (const s of visuals) {
      const names = Object.keys(s.visual.models);
      const arms = names.filter((n) => /^arm\d+$/.test(n));
      // The crew access arm, and the tail service mast of the launch mount (it tilts back with the arms).
      const crew = names.filter((n) => n === 'crewArm' || n === 'mast');
      if (arms.length + crew.length === 0) {
        // Static structure: the pose does not depend on the arm state.
        const a = extent(s.visual, REST, 0, all);
        const b = extent(s.visual, { night: 1, arms: 1, crewArm: 1 }, 0, all);
        expect(b, s.model).toEqual(a);
        continue;
      }
      towers++;
      // The pad axis (the vehicle) in the structure's frame: the structure stands at offsetEnu = (east, north, up).
      const axis: [number, number] = [-s.offset[0], s.offset[1]];
      for (const name of [...arms, ...crew]) {
        const is = (n: string): boolean => n === name;
        const connected = extent(s.visual, REST, 0, is, axis, 5);
        const retracted = extent(s.visual, { night: 0, arms: 1, crewArm: 1 }, 0, is, axis, 5);
        expect(connected.items, `${s.model}.${name}`).toBe(1);
        // Connected: the arm reaches to within 7 m of the pad axis (the stack is up to 4.2 m in radius).
        expect(connected.nearest, `${s.model}.${name} connected`).toBeLessThan(7);
        expect(connected.nearest, `${s.model}.${name} inside the vehicle`).toBeGreaterThan(1.4);
        // Retracted: clear of the vehicle's flight path by more than the largest radius of the stack.
        console.log(`${s.model}.${name}: nearest to the pad axis ${connected.nearest.toFixed(2)} m connected, ${retracted.nearest.toFixed(2)} m retracted`);
        expect(retracted.nearest - connected.nearest, `${s.model}.${name} retracts`).toBeGreaterThan(name === 'mast' ? 1 : 3);
        expect(retracted.nearest, `${s.model}.${name} retracted`).toBeGreaterThan(name === 'mast' ? 5.5 : 7.5);
      }
    }
    expect(towers).toBeGreaterThanOrEqual(1);
  });

  it('lamps: floodlights and tower lamps give lights in front of a lamp model', () => {
    let lit = 0;
    for (const s of visuals) {
      const lights = s.visual.lights ?? [];
      if (lights.length === 0) continue;
      lit++;
      for (const l of lights) {
        expect(Math.max(...l.intensity), s.model).toBeGreaterThan(1000);
        expect(l.range, s.model).toBeGreaterThan(10);
        expect(Number.isFinite(l.pos[0] + l.pos[1] + l.pos[2])).toBe(true);
        expect(l.pos[1], `${s.model} lamp height`).toBeGreaterThan(1);
      }
    }
    expect(lit).toBeGreaterThanOrEqual(6);
  });

  it('triangle budget of the whole complex', () => {
    const totals = [0, 0, 0];
    const rows: string[] = [];
    for (const s of visuals) {
      const t = [0, 1, 2].map((lod) => extent(s.visual, REST, lod, all).triangles);
      t.forEach((n, i) => (totals[i] = totals[i]! + n));
      rows.push(`  ${s.model.padEnd(22)} ${t.join(' / ')}`);
    }
    console.log(`launch complex: ${visuals.length} structures, triangles LOD0 ${totals[0]} LOD1 ${totals[1]} LOD2 ${totals[2]}\n${rows.join('\n')}`);
    expect(totals[0]!).toBeLessThan(900_000);
    expect(totals[1]!).toBeLessThan(260_000);
    expect(totals[2]!).toBeLessThan(40_000);
  });
});

describe('nozzle temperature model', () => {
  it('equilibrium rises with throttle and stays within the radiative range', () => {
    expect(nozzleEquilibrium(0)).toBeGreaterThan(500);
    expect(nozzleEquilibrium(1)).toBeLessThan(1600);
    expect(nozzleEquilibrium(0.5)).toBeGreaterThan(nozzleEquilibrium(0.2));
    expect(nozzleEquilibrium(1)).toBeGreaterThan(nozzleEquilibrium(0.5));
    expect(nozzleEquilibrium(7)).toBe(nozzleEquilibrium(1));
  });

  it('heats toward the equilibrium without overshoot and is independent of the step size', () => {
    const target = nozzleEquilibrium(1);
    let T = 260;
    let prev = T;
    for (let i = 0; i < 600; i++) {
      T = stepNozzleTemp(T, true, 1, 1 / 60);
      expect(T).toBeGreaterThanOrEqual(prev);
      expect(T).toBeLessThanOrEqual(target + 1e-6);
      prev = T;
    }
    expect(T).toBeGreaterThan(target - 30);
    // 10 s in one step is the same as 600 steps of 1/60 s.
    expect(stepNozzleTemp(260, true, 1, 10)).toBeCloseTo(T, 3);
    expect(stepNozzleTemp(900, true, 1, 0)).toBe(900);
  });

  it('cools monotonically after shutdown, fast while it glows and slowly afterwards', () => {
    const hot = nozzleEquilibrium(1);
    let T = hot;
    let t = 0;
    let at10 = 0;
    for (let i = 0; i < 60 * 240; i++) {
      const next = stepNozzleTemp(T, false, 0, 1 / 60);
      expect(next).toBeLessThanOrEqual(T + 1e-9);
      T = next;
      t += 1 / 60;
      if (Math.abs(t - 10) < 1 / 120) at10 = T;
    }
    // Still visibly glowing 10 s after shutdown, dark (below the 800 K where emission is visible) well within minutes.
    expect(at10).toBeGreaterThan(820);
    expect(at10).toBeLessThan(hot - 150);
    expect(T).toBeLessThan(700);
    expect(T).toBeGreaterThanOrEqual(260);
    // Large steps land near the fine-stepped result.
    let coarse = hot;
    for (let i = 0; i < 24; i++) coarse = stepNozzleTemp(coarse, false, 0, 10);
    expect(Math.abs(coarse - T)).toBeLessThan(25);
  });
});
