/**
 * Shared fixtures of the sim-vessel tests: the real definition library and fake VesselEnvironments
 * (inverse-square gravity, exponential atmosphere, analytic ground and water).
 */
import { NEUTRAL_CONTROLS, type ControlInputs } from '@/core/contracts/controls';
import type { AtmosphereHeatingDef, DefLibrary } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { VACUUM, type AtmosphereSample, type VesselEnvironment } from '@/core/contracts/simInternal';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { quat, type Quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { stepVessel, type Vessel } from '@/sim/vessel';

export const VEHICLE = 'meridian-lunar';
export const DT = 1 / 120;
export const EARTH_MU = 3.986004418e14;
export const EARTH_RADIUS = 6371000;
export const MOON_MU = 4.9048695e12;
export const MOON_RADIUS = 1737400;

let cached: Promise<DefLibrary> | null = null;
export function loadLibrary(): Promise<DefLibrary> {
  cached ??= loadDefs(fsDefSource());
  return cached;
}

export interface FakeEnvOptions {
  mu?: number;
  radius?: number;
  /** Exponential atmosphere; omit for vacuum. */
  atmosphere?: { rho0: number; scaleHeight: number; temperature?: number; top?: number };
  /** Terrain height above the reference radius for a body-fixed unit direction (default: 0 everywhere). */
  terrain?: (dir: Vec3) => number;
  /** Ocean with a still or user-supplied surface (height above the reference radius). */
  ocean?: { density: number; height?: (dir: Vec3, ut: number) => number };
  /** Spin rate about +Z, rad/s (default 0). */
  spinRate?: number;
  heating?: AtmosphereHeatingDef | null;
  friction?: number;
}

export interface FakeEnv extends VesselEnvironment {
  /** Advance the environment clock (and the body rotation) by dt. */
  advance(dt: number): void;
}

export function makeEnv(o: FakeEnvOptions = {}): FakeEnv {
  const radius = o.radius ?? EARTH_RADIUS;
  const terrain = o.terrain ?? (() => 0);
  const spinRate = o.spinRate ?? 0;
  const atm = o.atmosphere;
  const temperature = atm?.temperature ?? 250;
  const speedOfSound = Math.sqrt(1.4 * 287.053 * temperature);
  const env: FakeEnv = {
    ut: 0,
    bodyId: 'test-body',
    mu: o.mu ?? EARTH_MU,
    radius,
    qFixedToInertial: quat.identity(),
    spin: { x: 0, y: 0, z: spinRate },
    atmosphereAt(altitude: number): AtmosphereSample {
      if (!atm || altitude > (atm.top ?? 140000)) return VACUUM;
      const density = atm.rho0 * Math.exp(-Math.max(altitude, -500) / atm.scaleHeight);
      return { density, pressure: density * 287.053 * temperature, temperature, speedOfSound };
    },
    heating: o.heating ?? null,
    terrainHeight: (dir: Vec3) => terrain(dir),
    terrainNormal(dir: Vec3, baseline = 1): Vec3 {
      // Central differences of the surface r(dir) = (radius + h(dir)) dir along two tangents.
      const t1 = v3.anyOrthogonal(dir);
      const t2 = v3.cross(dir, t1);
      const eps = baseline / radius;
      const point = (d: Vec3): Vec3 => {
        const n = v3.normalize(d);
        return v3.scale(n, radius + terrain(n));
      };
      const a = v3.sub(point(v3.addScaled(dir, t1, eps)), point(v3.addScaled(dir, t1, -eps)));
      const b = v3.sub(point(v3.addScaled(dir, t2, eps)), point(v3.addScaled(dir, t2, -eps)));
      const n = v3.normalize(v3.cross(a, b));
      return v3.dot(n, dir) < 0 ? v3.neg(n) : n;
    },
    surfaceKind: (dir: Vec3) => (o.ocean && terrain(dir) < (o.ocean.height ? o.ocean.height(dir, env.ut) : 0) ? 'water' : 'land'),
    surfaceFriction: o.friction ?? 0.8,
    ocean: o.ocean ? { density: o.ocean.density, waterHeight: (dir: Vec3) => (o.ocean!.height ? o.ocean!.height(dir, env.ut) : 0) } : null,
    sunDir: { x: 1, y: 0, z: 0 },
    sunVisibility: 1,
    advance(dt: number): void {
      env.ut += dt;
      if (spinRate !== 0) env.qFixedToInertial = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, spinRate * env.ut);
    },
  };
  return env;
}

export const earthAir = { rho0: 1.225, scaleHeight: 7200, temperature: 250 };

export function controls(partial: Partial<ControlInputs> = {}): ControlInputs {
  return { ...NEUTRAL_CONTROLS, translate: v3.zero(), ...partial };
}

/** Place a vessel with its VES origin `altitude` above the reference radius on the +Y axis of the body, nose up. */
export function placeUpright(vessel: Vessel, env: VesselEnvironment, altitude: number, q: Quat = quat.identity()): void {
  vessel.r = { x: 0, y: env.radius + altitude, z: 0 };
  vessel.v = v3.cross(env.spin, vessel.r);
  vessel.q = q;
  vessel.w = quat.rotateInv(q, env.spin);
  vessel.anchor = null;
}

export interface RunResult {
  events: SimEvent[];
  spawned: Vessel[];
}

/** Step one vessel for `seconds`, collecting events and spawned vessels (which are NOT stepped). */
export function run(vessel: Vessel, env: FakeEnv, seconds: number, c: ControlInputs | ((t: number) => ControlInputs), each?: (t: number) => void): RunResult {
  const out: RunResult = { events: [], spawned: [] };
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const res = stepVessel(vessel, env, typeof c === 'function' ? c(i * DT) : c, DT);
    env.advance(DT);
    out.events.push(...res.events);
    out.spawned.push(...res.spawned);
    each?.((i + 1) * DT);
    if (vessel.destroyed) break;
  }
  return out;
}

/** Step a set of vessels together (the first with `c`, the rest with neutral controls); spawned vessels join the set. */
export function runAll(vessels: Vessel[], env: FakeEnv, seconds: number, c: ControlInputs | ((t: number) => ControlInputs), each?: (t: number) => void): SimEvent[] {
  const events: SimEvent[] = [];
  const neutral = controls();
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    // Vessels spawned during a step are in the state of the step START, so they take the same step too.
    for (let k = 0; k < vessels.length; k++) {
      const v = vessels[k]!;
      if (v.destroyed) continue;
      const res = stepVessel(v, env, k === 0 ? (typeof c === 'function' ? c(i * DT) : c) : neutral, DT);
      events.push(...res.events);
      vessels.push(...res.spawned);
    }
    env.advance(DT);
    each?.((i + 1) * DT);
  }
  return events;
}

export function isFiniteVessel(v: Vessel): boolean {
  return v3.isFinite(v.r) && v3.isFinite(v.v) && quat.isFinite(v.q) && v3.isFinite(v.w) && Number.isFinite(v.gLoad) && v.parts.every((p) => p.temps.every(Number.isFinite) && p.resources.every(Number.isFinite));
}

/** Linear momentum (CoM velocity times mass) of a vessel in BCI. */
export function momentum(v: Vessel): Vec3 {
  const vc = v3.add(v.v, quat.rotate(v.q, v3.cross(v.w, v.mp.com)));
  return v3.scale(vc, v.mp.mass);
}

export function comPosition(v: Vessel): Vec3 {
  return v3.add(v.r, quat.rotate(v.q, v.mp.com));
}

export function findPart(v: Vessel, id: string): Vessel['parts'][number] {
  const p = v.parts.find((x) => x.instanceId === id);
  if (!p) throw new Error(`no part ${id}`);
  return p;
}
