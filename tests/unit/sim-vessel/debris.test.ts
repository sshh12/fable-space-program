/**
 * Every fragment collides with the ground. A part that flies on its own after a break-up - including the
 * parts whose definitions list no contact points (their probes are derived from the bounds), a gear
 * assembly with stowed or broken legs, a fairing panel - comes to rest on the surface or is destroyed
 * by the impact; nothing sinks into the terrain, and a vessel that does get below it is removed.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary, PartDef } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { EXPLOSION_MAX_DELTA_V } from '@/sim/dynamics/failure';
import { assembleVessel, fireNextStage, needsIntegration, setRcsEnabled, setSasEnabled, splitForStage, stepVessel, structureOf, type Vessel } from '@/sim/vessel';
import { createPart, emptyVessel } from '@/sim/vessel/assemble';
import { controls, DT, isFiniteVessel, loadLibrary, makeEnv, MOON_MU, MOON_RADIUS, run, VEHICLE, type FakeEnv } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

const moon = (): FakeEnv => makeEnv({ mu: MOON_MU, radius: MOON_RADIUS, friction: 0.7 });
const altitude = (v: Vessel, env: FakeEnv): number => v3.len(v.r) - env.radius;

/** One part of `def` as a vessel of its own. */
function fragment(def: PartDef): Vessel {
  const v = emptyVessel(`frag-${def.id}`, def.name, defs.vehicles[VEHICLE]!);
  v.parts.push(createPart(def.id, def, 'debris'));
  return v;
}

/** Lowest point of the part's bounds cylinder above the ground for the vessel's current attitude, m. */
function boundsClearance(v: Vessel, env: FakeEnv): number {
  const b = v.parts[0]!.def.bounds;
  let low = Infinity;
  for (const y of [b.yMin, b.yMax]) {
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      const p = v3.add(v.r, quat.rotate(v.q, { x: b.radius * Math.sin(a), y, z: b.radius * Math.cos(a) }));
      low = Math.min(low, v3.len(p) - env.radius);
    }
  }
  return low;
}

interface DropResult {
  events: SimEvent[];
  lowest: number;
  rest: boolean;
}

/** Drop a fragment with its lowest point `gap` above the ground at `speed` m/s down and follow it for `seconds`. */
function drop(v: Vessel, env: FakeEnv, attitude: { x: number; y: number; z: number; w: number }, gap: number, speed: number, seconds: number): DropResult {
  v.q = attitude;
  v.r = { x: 0, y: env.radius + 100, z: 0 };
  v.r.y += gap - boundsClearance(v, env);
  v.v = { x: 0, y: -speed, z: 0 };
  v.w = v3.zero();
  const out: DropResult = { events: [], lowest: Infinity, rest: false };
  const reach = structureOf(v).boundingRadius;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps && !v.destroyed; i++) {
    const res = stepVessel(v, env, controls(), DT);
    env.advance(DT);
    out.events.push(...res.events);
    expect(res.spawned).toHaveLength(0);
    out.lowest = Math.min(out.lowest, altitude(v, env) + reach);
    if (v.hold === 'asleep') {
      out.rest = true;
      break;
    }
  }
  return out;
}

const ATTITUDES = [
  { name: 'upright', q: quat.identity() },
  { name: 'on its side', q: quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, 90 * DEG) },
  { name: 'inverted', q: quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, 180 * DEG) },
  { name: 'skew', q: quat.fromAxisAngle(v3.normalize({ x: 1, y: 0.3, z: -0.7 }), 57 * DEG) },
];

describe('single-part fragments meet the ground', () => {
  it('every part definition has contact probes, also the ones that list none', () => {
    const none: string[] = [];
    for (const def of Object.values(defs.parts)) {
      const v = fragment(def);
      const st = structureOf(v);
      if (!def.contactPoints || def.contactPoints.length === 0) none.push(def.id);
      expect(st.probes.length, def.id).toBeGreaterThanOrEqual(def.modules.some((m) => m.type === 'legs') ? 4 : 2);
      // Probes lie within the bounds cylinder (leg hinges and pads within the leg envelope).
      const b = def.bounds;
      for (const pr of st.probes) {
        expect(Math.hypot(pr.x, pr.z), def.id).toBeLessThanOrEqual(b.radius + 1e-5);
        expect(pr.y - pr.radius, def.id).toBeGreaterThanOrEqual(b.yMin - 0.31);
        expect(pr.y + pr.radius, def.id).toBeLessThanOrEqual(b.yMax + 0.31);
      }
    }
    console.log(`part definitions without contactPoints (probes derived from bounds): ${none.join(', ')}`);
    expect(none.length).toBeGreaterThanOrEqual(6);
  });

  it('a gentle drop of each part, in four attitudes, ends at rest on the surface', () => {
    const log: string[] = [];
    const broke: string[] = [];
    for (const def of Object.values(defs.parts)) {
      for (const att of ATTITUDES) {
        const env = moon();
        const v = fragment(def);
        // 0.3 m at lunar gravity: about 1 m/s at contact, below every crash tolerance.
        const r = drop(v, env, att.q, 0.3, 0, 90);
        const label = `${def.id}, ${att.name}`;
        expect(isFiniteVessel(v), label).toBe(true);
        expect(r.events.some((e) => e.type === 'touchdown'), label).toBe(true);
        expect(r.lowest, label).toBeGreaterThan(0);
        if (v.destroyed) {
          // A fragile part (2-3 m/s tolerance) that topples from a tilted attitude may break as its far end
          // slaps down: an impact at the surface, and never when it is set down upright.
          expect(att.name, label).not.toBe('upright');
          const destroyed = r.events.find((e) => e.type === 'partDestroyed');
          expect(destroyed && destroyed.type === 'partDestroyed' ? destroyed.cause : '', label).toBe('impact');
          broke.push(label);
          continue;
        }
        // A part whose probes are derived from its bounds lies on the ground as that cylinder: rings of eight
        // points sag 8 % of the radius between neighbours, no more. (Authored probe sets follow the real
        // shape - a cone, a tower, a bell - which the bounds cylinder only encloses.)
        if (!def.contactPoints || def.contactPoints.length === 0) expect(boundsClearance(v, env), label).toBeGreaterThan(-(0.08 * def.bounds.radius + 0.1));
        expect(altitude(v, env), label).toBeLessThan(structureOf(v).boundingRadius + 0.5);
        expect(r.rest, `${label} comes to rest`).toBe(true);
        expect(needsIntegration(v, env), label).toBe(false);
        if (att.name === 'upright') log.push(`${def.id}: asleep after ${v.age.toFixed(1)} s`);
      }
    }
    console.log(`${log.join('\n')}\nbroken by toppling over: ${broke.join('; ') || 'none'}`);
    expect(broke.length).toBeLessThan(10);
  }, 240000);

  it('a hard impact destroys the part at the surface instead of letting it through', () => {
    for (const def of Object.values(defs.parts)) {
      for (const att of [ATTITUDES[0]!, ATTITUDES[3]!]) {
        const env = moon();
        const v = fragment(def);
        // 250 m/s: two metres per step, far beyond every crash tolerance.
        const r = drop(v, env, att.q, 40, 250, 5);
        const label = `${def.id}, ${att.name}`;
        expect(v.destroyed, label).toBe(true);
        const destroyed = r.events.find((e) => e.type === 'partDestroyed');
        expect(destroyed && destroyed.type === 'partDestroyed' ? destroyed.cause : '', label).toBe('impact');
        // Destroyed within one step's travel of the surface.
        expect(r.lowest, label).toBeGreaterThan(-2.5);
      }
    }
  });

  it('a jettisoned fairing panel lands too', () => {
    const env = moon();
    const s = splitForStage(defs, assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 2 }), 2);
    const panel = s.spawned.find((x) => x.id.endsWith('#panel1'))!;
    panel.w = v3.zero();
    panel.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, 80 * DEG);
    panel.r = { x: 0, y: env.radius + 6, z: 0 };
    panel.v = { x: 0.5, y: 0, z: 0 };
    const res = run(panel, env, 120, controls());
    expect(res.events.some((e) => e.type === 'touchdown')).toBe(true);
    expect(panel.destroyed || panel.hold === 'asleep' || panel.contact.anyContact).toBe(true);
    expect(altitude(panel, env)).toBeGreaterThan(-structureOf(panel).boundingRadius);
  });

  it('a gear assembly with all legs broken rests on its hinge fittings', () => {
    const env = moon();
    const v = fragment(defs.parts['heron-landing-legs']!);
    const legs = v.parts[0]!.modules[0]!;
    if (legs.type !== 'legs') throw new Error('no legs');
    legs.deploy = 1;
    legs.broken = legs.broken.map(() => true);
    const rt = v.parts[0]!.rt[0]!;
    if (rt.type === 'legs') rt.target = 1;
    const r = drop(v, env, quat.identity(), 0.5, 0, 60);
    expect(v.destroyed).toBe(false);
    expect(r.rest).toBe(true);
    // The hinges (0.15 m fittings, 2.25 m below the top of the bounds) carry it, not the broken feet.
    const def = defs.parts['heron-landing-legs']!.modules[0]!;
    if (def.type !== 'legs') throw new Error('no legs');
    expect(altitude(v, env) + def.legs[0]!.hinge[1]).toBeGreaterThan(0.1);
    expect(altitude(v, env) + def.legs[0]!.hinge[1]).toBeLessThan(0.2);
    expect(legs.contact).toEqual([false, false, false, false]);
  });

  it('backstop: a vessel that is entirely below the terrain is destroyed as an impact', () => {
    const env = moon();
    const v = fragment(defs.parts['meridian-m3']!);
    v.r = { x: 0, y: env.radius - 40, z: 0 };
    v.v = { x: 0, y: -300, z: 0 };
    const res = stepVessel(v, env, controls(), DT);
    expect(v.destroyed).toBe(true);
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({ type: 'partDestroyed', cause: 'impact' });
    // Half buried is not "entirely below": the probes deal with that.
    const w = fragment(defs.parts['meridian-m3']!);
    w.r = { x: 0, y: env.radius - 5, z: 0 };
    expect(structureOf(w).boundingRadius).toBeGreaterThan(5);
    stepVessel(w, env, controls(), DT);
    expect(structureOf(w).buried).toBe(false);
  });
});

describe('break-up debris', () => {
  it('lander staged in flight: the abandoned descent stage crashes and every fragment stays on the surface', () => {
    const env = moon();
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 6 });
    v.r = { x: 0, y: env.radius + 2000, z: 0 };
    v.v = { x: 20, y: -30, z: 0 };
    setSasEnabled(v, true);
    setRcsEnabled(v, true);
    const vessels = [v];
    const events: SimEvent[] = [];
    const lowest = new Map<string, number>();
    const fastest = new Map<string, number>();
    const fly = (seconds: number, throttle: number): void => {
      const steps = Math.round(seconds / DT);
      for (let i = 0; i < steps; i++) {
        for (let k = 0; k < vessels.length; k++) {
          const x = vessels[k]!;
          if (x.destroyed || (k > 0 && !needsIntegration(x, env))) continue;
          const res = stepVessel(x, env, k === 0 ? controls({ throttle }) : controls(), DT);
          events.push(...res.events);
          vessels.push(...res.spawned);
          for (const s of res.spawned) fastest.set(s.id, v3.len(s.v));
          if (k > 0 && !x.destroyed) {
            expect(isFiniteVessel(x)).toBe(true);
            lowest.set(x.id, Math.min(lowest.get(x.id) ?? Infinity, altitude(x, env) + structureOf(x).boundingRadius));
          }
        }
        env.advance(DT);
      }
    };
    fly(5, 0.3);
    const res = fireNextStage(v, env);
    vessels.push(...res.spawned);
    events.push(...res.events);
    // The crewed ascent stage climbs away; follow the debris for ten minutes.
    fly(600, 1);
    const debris = vessels.slice(1);
    expect(debris.length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'explosion')).toBe(true);
    expect(events.filter((e) => e.type === 'partDestroyed' && e.cause === 'impact').length).toBeGreaterThanOrEqual(1);
    const log: string[] = [];
    for (const d of debris) {
      const state = d.destroyed ? 'destroyed' : `alt ${altitude(d, env).toFixed(1)} m, ${v3.len(d.v).toFixed(1)} m/s, hold ${d.hold}`;
      log.push(`${d.id.replace('meridian-lunar~', '')}: ${state}; lowest point ${(lowest.get(d.id) ?? NaN).toFixed(2)} m; speed when created ${(fastest.get(d.id) ?? NaN).toFixed(0)} m/s`);
      // No fragment was ever entirely below the surface, and none is still falling after ten minutes.
      if (lowest.has(d.id)) expect(lowest.get(d.id)!, d.id).toBeGreaterThan(0);
      expect(d.destroyed || !needsIntegration(d, env), `${d.id} is destroyed or at rest`).toBe(true);
      if (!d.destroyed) expect(Math.abs(altitude(d, env)), d.id).toBeLessThan(structureOf(d).boundingRadius + 1);
      // Blast fragments leave at the crash speed plus at most the capped explosion delta-v.
      if (fastest.has(d.id)) expect(fastest.get(d.id)!, d.id).toBeLessThan(110 + EXPLOSION_MAX_DELTA_V);
    }
    console.log(log.join('\n'));
    expect(v.crewAlive).toBe(true);
    expect(altitude(v, env)).toBeGreaterThan(2000);
  }, 240000);
});
