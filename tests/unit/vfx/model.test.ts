/**
 * vfx data section, the gas-dynamic plume model and the gathering of plume clusters from real assembled
 * parts (vessel facade).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import type { VesselSnapshot } from '@/core/contracts/sim';
import { createFakeSim } from '@/core/fakes/fakeSim';
import { fsDefSource } from '@/core/defs/fsSource';
import { DefError, getSection, loadDefs } from '@/core/defs/loader';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import {
  CELL_ETA_MAX,
  CELL_ETA_MIN,
  gatherPlumeClusters,
  jetBoundaryRadius,
  jetShape,
  loadVfxData,
  machFromPressureRatio,
  plumeLightIntensity,
  prandtlMeyer,
  shockCellSpacing,
  THETA_MIN,
  validateVfxData,
  VFX_SECTION,
  type VfxData,
} from '@/render/vfx';
import { lowestPoint } from '@/render/vfx/director';
import { assembleVessel, setModuleStateForLab, vesselPartSnapshots } from '@/sim/vessel/public';

const DEG = Math.PI / 180;
let defs: DefLibrary;
let data: VfxData;

beforeAll(async () => {
  defs = await loadDefs(fsDefSource());
  data = loadVfxData(defs);
});

const vesselOf = (stagesAlreadyFired: number): VesselSnapshot => {
  const vehicleId = Object.keys(defs.vehicles)[0]!;
  const parts = vesselPartSnapshots(assembleVessel(defs, vehicleId, { stagesAlreadyFired }));
  const base = createFakeSim(defs, { scene: 'pad' }).peek().vessels[0]!;
  return { ...base, parts, q: quat.identity() };
};

const engineOn = (vessel: VesselSnapshot, partDef: string, patch: Record<string, unknown>): void => {
  for (const p of vessel.parts) {
    if (p.def !== partDef) continue;
    const idx = defs.parts[p.def]!.modules.findIndex((m) => m.type === 'engine');
    setModuleStateForLab(vessel.parts, p.instanceId, idx, { active: true, throttleActual: 1, thrust: 3.9e6, massFlow: 1200, ambientPressure: 101325, ignitionAge: 30, shutdownAge: -1, ...patch });
  }
};

describe('vfx data section', () => {
  it('loads, validates and covers the plume id of every engine in the library', () => {
    const ids = new Set<string>();
    for (const part of Object.values(defs.parts)) for (const m of part.modules) if (m.type === 'engine') ids.add(m.plume);
    expect(ids.size).toBeGreaterThanOrEqual(5);
    for (const id of ids) expect(data.plumes[id], id).toBeDefined();
    expect(data.plumes[data.rcs.plume]).toBeDefined();
  });

  it('reports problems with the file and the JSON path', () => {
    const raw = structuredClone(getSection<Record<string, unknown>>(defs, VFX_SECTION));
    const broken = (mutate: (r: Record<string, any>) => void): string => {
      const copy = structuredClone(raw) as Record<string, any>;
      mutate(copy);
      try {
        validateVfxData(copy);
      } catch (e) {
        expect(e).toBeInstanceOf(DefError);
        return (e as Error).message;
      }
      return 'no error';
    };
    expect(broken((r) => delete r.plumes['plume.solid'].core.luminance)).toMatch(/visuals\/plumes\.json: \$\.plumes\["plume\.solid"\]\.core\.luminance: missing/);
    expect(broken((r) => (r.trail.smokeAlbedo = [1, 2]))).toMatch(/visuals\/plumes\.json: \$\.trail\.smokeAlbedo: expected a colour/);
    expect(broken((r) => (r.rcs.plume = 'plume.nothing'))).toMatch(/\$\.rcs\.plume: unknown plume look/);
    expect(broken((r) => (r.padSmoke.typo = 1))).toMatch(/\$\.padSmoke\.typo: unknown field/);
    expect(broken((r) => (r.particles.dust.speed = [9, 3]))).toMatch(/\$\.particles\.dust\.speed: expected \[min, max\]/);
    expect(broken((r) => (r.plumes['plume.rcs'].gamma = 1))).toMatch(/gamma: expected a ratio of specific heats/);
  });

  it('names the part file when an engine refers to a plume look that does not exist', () => {
    const lib = structuredClone(defs);
    const part = Object.values(lib.parts).find((p) => p.modules.some((m) => m.type === 'engine'))!;
    const m = part.modules.find((x) => x.type === 'engine')!;
    if (m.type === 'engine') m.plume = 'plume.unknown';
    expect(() => loadVfxData(lib)).toThrow(new RegExp(`parts/${part.id}\\.json: modules\\[\\d+\\]\\.plume "plume\\.unknown"`));
  });
});

describe('plume model', () => {
  it('Prandtl-Meyer function and isentropic Mach number match textbook values', () => {
    expect(prandtlMeyer(2, 1.4) / DEG).toBeCloseTo(26.38, 1);
    expect(prandtlMeyer(1, 1.4)).toBe(0);
    expect(machFromPressureRatio(7.8244, 1.4)).toBeCloseTo(2, 3);
    expect(machFromPressureRatio(0.5, 1.4)).toBe(0);
  });

  it('pinched at sea level, straight near the design altitude, ballooning in vacuum', () => {
    const look = data.plumes['plume.methalox-booster']!;
    const nozzle = { exitRadius: 0.95, exitPressure: 70e3, chamberPressure: 30e6 };
    const at = (p: number, thr = 1) => jetShape(look, nozzle, thr, p);
    const sl = at(101325);
    expect(sl.eta).toBeCloseTo(0.6908, 3);
    expect(sl.theta).toBeLessThan(0);
    expect(sl.theta / DEG).toBeGreaterThan(-4);
    // Minimum throttle at sea level: more over-expanded, at the clamp.
    expect(at(101325, 0.5).theta).toBeCloseTo(THETA_MIN, 6);
    // Design altitude (ambient = exit pressure): the lip angle is the nozzle wall angle.
    expect(at(70e3).theta / DEG).toBeCloseTo(look.nozzleHalfAngleDeg, 1);
    const angles = [101325, 26436, 1172, 20.3, 0].map((p) => at(p).theta);
    for (let i = 1; i < angles.length; i++) expect(angles[i]!).toBeGreaterThan(angles[i - 1]!);
    // Vacuum is counted as 1 Pa of ambient pressure: a turn of more than 70 degrees, below the 85 degree clamp.
    expect(angles[4]! / DEG).toBeGreaterThan(70);
    expect(angles[4]! / DEG).toBeLessThanOrEqual(85);
    expect(angles[1]! / DEG).toBeGreaterThan(8);
    expect(angles[1]! / DEG).toBeLessThan(20);
    // Boundary: starts at the exit radius with the lip angle as its slope.
    for (const s of [sl, at(26436), at(1172)]) {
      expect(jetBoundaryRadius(s, 0.95, 0)).toBeCloseTo(0.95, 9);
      const slope = (jetBoundaryRadius(s, 0.95, 0.002) - 0.95) / 0.002;
      expect(slope).toBeCloseTo(s.tanTheta, 2);
    }
    // The over-expanded jet contracts towards re sqrt(eta); the mixing layer widens it again downstream.
    expect(jetBoundaryRadius(sl, 0.95, 6)).toBeLessThan(0.95);
    expect(jetBoundaryRadius(sl, 0.95, 80)).toBeGreaterThan(0.95);
    expect(sl.mixSlope).toBeCloseTo(0.09, 6);
    expect(at(0).mixSlope).toBe(0);
  });

  it('shock cells: Prandtl-Pack spacing, visible only between pressure ratios of about 0.25 and 4', () => {
    const look = data.plumes['plume.methalox-booster']!;
    const nozzle = { exitRadius: 0.95, exitPressure: 70e3, chamberPressure: 30e6 };
    const sl = jetShape(look, nozzle, 1, 101325);
    const dj = 2 * 0.95 * Math.sqrt(sl.eta);
    expect(sl.shockSpacing).toBeCloseTo(1.306 * dj * Math.sqrt(sl.jetMach ** 2 - 1), 9);
    expect(shockCellSpacing(0.95, sl.eta, sl.jetMach)).toBe(sl.shockSpacing);
    expect(sl.cellAmp).toBeGreaterThan(0.5);
    // Lower throttle: shorter cells.
    expect(jetShape(look, nozzle, 0.5, 101325).shockSpacing).toBeLessThan(sl.shockSpacing);
    const amp = (eta: number): number => jetShape(look, nozzle, 1, 70e3 / eta).cellAmp;
    expect(amp(0.8 * CELL_ETA_MIN - 0.01)).toBe(0);
    expect(amp(CELL_ETA_MAX + 0.01)).toBe(0);
    expect(amp(0.5)).toBeGreaterThan(0.5);
    expect(amp(2.5)).toBeGreaterThan(0.5);
    // No afterburning without air, full at sea level.
    expect(jetShape(look, nozzle, 1, 0).oxygen).toBe(0);
    expect(sl.oxygen).toBeCloseTo(1, 6);
  });

  it('light intensity is proportional to thrust; the visible extent grows when less is counted as invisible', () => {
    const look = data.plumes['plume.methalox-booster']!;
    const a = plumeLightIntensity(look, 1e6);
    const b = plumeLightIntensity(look, 3e6);
    for (let i = 0; i < 3; i++) expect(b[i]! / a[i]!).toBeCloseTo(3, 9);
    expect(plumeLightIntensity(look, -5)).toEqual([0, 0, 0]);
    const nozzle = { exitRadius: 0.95, exitPressure: 70e3, chamberPressure: 30e6 };
    const near = jetShape(look, nozzle, 1, 0, { visibleFraction: 1e-3 });
    const far = jetShape(look, nozzle, 1, 0, { visibleFraction: 1e-6 });
    expect(far.visibleLength).toBeGreaterThan(near.visibleLength);
    expect(far.visibleRadius).toBeGreaterThan(near.visibleRadius);
  });
});

describe('plume clusters from the real vehicle', () => {
  it('nine booster engines form one cluster whose jets merge downstream', () => {
    const vessel = vesselOf(0);
    engineOn(vessel, 'atlas-9m', {});
    const clusters = gatherPlumeClusters(defs, data, vessel);
    expect(clusters).toHaveLength(1);
    const c = clusters[0]!;
    expect(c.kind).toBe('engine');
    expect(c.lookId).toBe('plume.methalox-booster');
    expect(c.nozzles).toHaveLength(9);
    expect(c.thrust).toBeCloseTo(9 * 3.9e6, 0);
    // Exhaust points down the stack (VES -Y); the exits are 99.9 m below the capsule.
    expect(c.axisVes.y).toBeCloseTo(-1, 6);
    expect(c.centreVes.y).toBeCloseTo(-99.9, 1);
    expect(c.merged).not.toBeNull();
    expect(c.merged!.exitRadius).toBeCloseTo(3.3 + 0.95, 2);
    expect(c.mergeDistance).toBeGreaterThan(2 * 0.95);
    expect(c.mergeDistance).toBeLessThanOrEqual(30 * 0.95 + 1e-9);
    expect(c.length).toBeGreaterThan(50);
    expect(c.coneR0).toBeGreaterThan(3.3 + 0.95);
    // The same call gives the same result.
    expect(JSON.stringify(gatherPlumeClusters(defs, data, vessel))).toBe(JSON.stringify(clusters));
  });

  it('gimbal deflects the jet as the simulation deflects the thrust', () => {
    const vessel = vesselOf(0);
    engineOn(vessel, 'atlas-9m', { gimbal: [5 * DEG, 0] });
    const c = gatherPlumeClusters(defs, data, vessel)[0]!;
    // e + gx (X x e) with e = -Y: -Y - gx Z.
    expect(Math.atan2(-c.axisVes.z, -c.axisVes.y) / DEG).toBeCloseTo(5, 1);
    expect(c.axisVes.x).toBeCloseTo(0, 6);
  });

  it('canted solid nozzles stay separate jets; a stopped engine leaves a residual flame, then nothing', () => {
    const vessel = vesselOf(0);
    engineOn(vessel, 'kestrel-les', { thrust: 8e5 });
    const les = gatherPlumeClusters(defs, data, vessel);
    expect(les).toHaveLength(1);
    expect(les[0]!.nozzles).toHaveLength(4);
    expect(les[0]!.merged).toBeNull();
    expect(les[0]!.lookId).toBe('plume.solid');

    const off = vesselOf(0);
    engineOn(off, 'atlas-9m', { throttleActual: 0, thrust: 0, shutdownAge: 0.1 });
    const residual = gatherPlumeClusters(defs, data, off);
    expect(residual).toHaveLength(1);
    expect(residual[0]!.nozzles[0]!.throttle).toBe(0);
    expect(residual[0]!.nozzles[0]!.residual).toBeGreaterThan(0.5);
    engineOn(off, 'atlas-9m', { throttleActual: 0, thrust: 0, shutdownAge: 10 });
    expect(gatherPlumeClusters(defs, data, off)).toHaveLength(0);
  });

  it('every firing RCS thruster is a small jet along its exhaust direction', () => {
    const vessel = vesselOf(6);
    const part = vessel.parts.find((p) => p.def === 'heron-descent-stage')!;
    const idx = defs.parts[part.def]!.modules.findIndex((m) => m.type === 'rcs');
    const levels = new Array(16).fill(0);
    levels[0] = 1;
    levels[3] = 0.5;
    levels[5] = 0.01;
    setModuleStateForLab(vessel.parts, part.instanceId, idx, { enabled: true, levels });
    const clusters = gatherPlumeClusters(defs, data, vessel);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.kind === 'rcs' && c.nozzles.length === 1)).toBe(true);
    expect(clusters[0]!.nozzles[0]!.throttle).toBe(1);
    const md = defs.parts[part.def]!.modules[idx]!;
    if (md.type !== 'rcs') throw new Error('expected an rcs module');
    const dir = quat.rotate(part.localRot, v3.fromTuple(md.thrusters[0]!.dir));
    expect(v3.dot(clusters[0]!.axisVes, dir)).toBeCloseTo(1, 6);
    setModuleStateForLab(vessel.parts, part.instanceId, idx, { enabled: false, levels });
    expect(gatherPlumeClusters(defs, data, vessel)).toHaveLength(0);
  });

  it('lowest point of a vessel along the local vertical follows its parts', () => {
    const stack = vesselOf(0);
    // Standing: the clamp bases, 101 m below the capsule.
    expect(lowestPoint(defs, stack, { x: 0, y: 1, z: 0 })).toBeCloseTo(-101, 0);
    // Lying on its side: the largest radius.
    expect(lowestPoint(defs, stack, { x: 0, y: 0, z: 1 })).toBeLessThan(-4.4);
  });
});
