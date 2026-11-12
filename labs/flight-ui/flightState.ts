/**
 * Lab-only flight physics for the flight-ui lab's scenes, so that every number a scene shows follows from one
 * state (the FakeSim coasts on circular orbits and reports a constant mass): the vessel's mass and the stage
 * figures from its parts, a ballistic entry integrated from the entry interface (the plain and the high-g entry
 * views are two moments of the same entry), the osculating conic of a state that the lab sets (an entry that
 * meets the surface, a translunar ellipse), the navball markers of that state, and the speed of sound of the
 * standard atmosphere for the Mach number. Never loaded by the app.
 */
import type { DefLibrary, VehicleDef } from '@/core/contracts/defs';
import type { NavballMarkers, Patch, PartSnapshot, SimSnapshot, StageInfo } from '@/core/contracts/sim';
import { conicApsides, conicFromState, conicPosition, conicTrueAnomaly, timeSincePeriapsis } from '@/core/math/conic';
import { quat } from '@/core/math/quat';
import { G0 } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';

/** Exponential atmosphere of the FakeSim (sea-level density kg/m^3, scale height m). */
export const RHO0 = 1.225;
export const SCALE_HEIGHT = 7200;
export const airDensity = (h: number): number => RHO0 * Math.exp(-h / SCALE_HEIGHT);

/** US Standard Atmosphere 1976 temperature, K (isothermal above 86 km). */
export function us76Temperature(h: number): number {
  const km = h / 1000;
  if (km < 11) return 288.15 - 6.5 * km;
  if (km < 20) return 216.65;
  if (km < 32) return 216.65 + (km - 20);
  if (km < 47) return 228.65 + 2.8 * (km - 32);
  if (km < 51) return 270.65;
  if (km < 71) return 270.65 - 2.8 * (km - 51);
  if (km < 86) return 214.65 - 2 * (km - 71);
  return 184.65;
}

/** Speed of sound of the standard atmosphere at height h, m/s. */
export const speedOfSound = (h: number): number => Math.sqrt(1.4 * 287.053 * us76Temperature(Math.max(0, h)));

// ------------------------------------------------------------------------------------------- the entry

export interface EntrySample {
  /** Time since the entry interface, s. */
  t: number;
  /** Height, m; speed over the ground (relative to the air), m/s; flight-path angle, rad (negative: down). */
  h: number;
  v: number;
  gamma: number;
  /** Drag deceleration (the g load the crew feels), g. */
  g: number;
  /** Ground range flown since the entry interface, m. */
  x: number;
}

/**
 * A ballistic capsule's entry (no lift), integrated from the entry interface in the plane of flight over a round,
 * non-rotating body: drag q / beta (beta = m / (Cd A), kg/m^2) in the exponential atmosphere, gravity, and the
 * path bending down as the capsule slows. Until the speed falls below 30 m/s or the ground is reached.
 */
export function integrateEntry(mu: number, radius: number, beta: number, h0: number, v0: number, gamma0: number, dt = 0.05): EntrySample[] {
  let h = h0;
  let v = v0;
  let gamma = gamma0;
  let t = 0;
  let x = 0;
  const out: EntrySample[] = [];
  while (h > 0 && v > 30) {
    const r = radius + h;
    const drag = (airDensity(h) * v * v) / (2 * beta);
    const g = mu / (r * r);
    out.push({ t, h, v, gamma, g: drag / G0, x });
    const dv = -drag - g * Math.sin(gamma);
    const dGamma = (v / r - g / v) * Math.cos(gamma);
    h += v * Math.sin(gamma) * dt;
    x += v * Math.cos(gamma) * (radius / r) * dt;
    v += dv * dt;
    gamma += dGamma * dt;
    t += dt;
  }
  out.push({ t, h: Math.max(0, h), v, gamma, g: (airDensity(Math.max(0, h)) * v * v) / (2 * beta) / G0, x });
  return out;
}

/** The first moment of the entry at which the deceleration reaches `g` (the peak when it never does). */
export function entryAtG(samples: readonly EntrySample[], g: number): EntrySample {
  let peak = samples[0]!;
  for (const s of samples) {
    if (s.g >= g) return s;
    if (s.g > peak.g) peak = s;
  }
  return peak;
}

/** Speed and flight-path angle (rad, positive outbound) at radius r on the ellipse with these apsis radii. */
export function ellipseState(mu: number, rp: number, ra: number, r: number): { speed: number; gamma: number } {
  const a = 0.5 * (rp + ra);
  const speed = Math.sqrt(mu * (2 / r - 1 / a));
  const angular = Math.sqrt((mu * 2 * rp * ra) / (rp + ra));
  return { speed, gamma: Math.acos(Math.min(1, angular / r / speed)) };
}

// -------------------------------------------------------------------------------------- a state set by the lab

export interface LabTrajectory {
  /** Height above the reference radius, m, and of the ground under the vessel. */
  altitude: number;
  ground: number;
  /** Speed (m/s) and flight-path angle (rad, positive up), in the frame named. */
  speed: number;
  gamma: number;
  frame: 'surface' | 'inertial';
}

/**
 * The snapshot with the active vessel at the given height and velocity (the FakeSim's place and direction of
 * travel kept), and everything that follows from that state replaced: position and velocity, the readouts'
 * altitudes, speeds and osculating elements (the times to the apsides as the sim reports them), the current
 * patch's conic, the navball's frame markers (in the navball's mode) and the angle of attack.
 */
export function withTrajectory(s: SimSnapshot, defs: DefLibrary, t: LabTrajectory): SimSnapshot {
  const v = s.vessels.find((x) => x.id === s.activeVesselId);
  const bodyDef = v ? defs.bodies[v.bodyId] : undefined;
  const body = v ? s.bodies.find((b) => b.id === v.bodyId) : undefined;
  if (!v || !bodyDef || !body) return s;
  const R = bodyDef.radius;
  const up = v3.normalize(v.r);
  const r = v3.scale(up, R + t.altitude);
  const spin = body.spinRoot;
  // The direction of travel over the ground: the FakeSim's (a vessel standing still or moving straight up or
  // down travels east).
  const along = (vel: Vec3): Vec3 | null => {
    const hz = v3.reject(vel, up);
    return v3.len(hz) > 1e-3 ? v3.normalize(hz) : null;
  };
  const east = v3.normalize(v3.reject(v3.cross(v3.unitZ(), up), up));
  const vSurfFake = v3.sub(v.v, v3.cross(spin, v.r));
  const dir = (t.frame === 'surface' ? along(vSurfFake) : along(v.v)) ?? along(v.v) ?? east;
  const vel = v3.add(v3.scale(dir, t.speed * Math.cos(t.gamma)), v3.scale(up, t.speed * Math.sin(t.gamma)));
  const vIn = t.frame === 'inertial' ? vel : v3.add(vel, v3.cross(spin, r));
  const vSurf = t.frame === 'surface' ? vel : v3.sub(vel, v3.cross(spin, r));

  const conic = conicFromState(bodyDef.mu, r, vIn, s.ut);
  const { rp, ra } = conicApsides(conic);
  const nu = conicTrueAnomaly(conic, r);
  const period = conic.period;
  const tsp = timeSincePeriapsis(conic, nu);
  const wrap = (x: number): number => (period ? ((x % period) + period) % period : x);
  const vertical = v3.dot(vSurf, up);
  const nose = quat.rotate(v.q, v3.unitY());

  // Frame markers of the navball (as the sim sets them: prograde along the velocity of the navball's mode).
  const toVes = (d: Vec3): Vec3 => quat.rotateInv(v.q, d);
  // (A vessel at rest has its prograde straight up, as the FakeSim sets it.)
  const frameVel = s.navball.mode === 'surface' ? vSurf : vIn;
  const prograde = v3.len(frameVel) < 0.05 ? up : v3.normalize(frameVel);
  let normal = v3.cross(up, prograde);
  normal = v3.len(normal) < 1e-6 ? v3.anyOrthogonal(prograde) : v3.normalize(normal);
  const radialOut = v3.cross(prograde, normal);
  const markers: NavballMarkers = {
    ...s.navball.markers,
    prograde: toVes(prograde),
    retrograde: toVes(v3.neg(prograde)),
    normal: toVes(normal),
    antinormal: toVes(v3.neg(normal)),
    radialOut: toVes(radialOut),
    radialIn: toVes(v3.neg(radialOut)),
  };

  const current = s.patches.current.map((p, i): Patch => {
    if (i !== 0) return p;
    const others = p.markers.filter((m) => m.kind !== 'periapsis' && m.kind !== 'apoapsis');
    const apsides = period
      ? [
          { kind: 'periapsis' as const, ut: s.ut + wrap(-tsp), bodyId: body.id, r: conicPosition(conic, 0), altitude: rp - R },
          { kind: 'apoapsis' as const, ut: s.ut + wrap(0.5 * period - tsp), bodyId: body.id, r: conicPosition(conic, Math.PI), altitude: ra - R },
        ]
      : [];
    return { ...p, conic, tStart: s.ut, nuStart: nu, nuEnd: period ? nu + 2 * Math.PI : nu + 2, markers: [...apsides, ...others] };
  });

  return {
    ...s,
    vessels: s.vessels.map((x) => (x.id === v.id ? { ...x, r, v: vIn, rRoot: v3.add(body.rRoot, r), vRoot: v3.add(body.vRoot, vIn) } : x)),
    patches: { ...s.patches, current },
    navball: { ...s.navball, markers },
    readouts: {
      ...s.readouts,
      altitudeAsl: t.altitude,
      altitudeRadar: t.altitude - t.ground,
      speedOrbital: v3.len(vIn),
      speedSurface: v3.len(vSurf),
      verticalSpeed: vertical,
      horizontalSpeed: v3.len(v3.reject(vSurf, up)),
      apoapsisAltitude: period ? ra - R : Infinity,
      periapsisAltitude: rp - R,
      timeToApoapsis: period ? wrap(0.5 * period - tsp) : null,
      timeToPeriapsis: period ? wrap(-tsp) : null,
      inclination: conic.inc,
      eccentricity: conic.e,
      period,
      angleOfAttack: v3.len(vSurf) > 1 ? v3.angle(nose, vSurf) : 0,
    },
  };
}

// --------------------------------------------------------------------------------------- mass and stages

/** Mass of the parts (dry mass and every resource), kg. */
export function partsMass(defs: DefLibrary, parts: readonly PartSnapshot[]): number {
  let m = 0;
  for (const p of parts) {
    m += defs.parts[p.def]?.dryMass ?? 0;
    for (const amount of Object.values(p.resources)) m += amount;
  }
  return m;
}

/** The stage group of the engines a stage ignites, or null (a stage that lights no engine). */
export function stageEngineGroup(vehicle: VehicleDef, index: number): string | null {
  for (const a of vehicle.stages[index]?.actions ?? []) {
    if (a.kind !== 'igniteEngines') continue;
    for (const id of a.parts) {
      const g = vehicle.parts.find((p) => p.id === id)?.stageGroup;
      if (g) return g;
    }
  }
  return null;
}

/**
 * Stage figures as the sim reports them (src/sim/vessel/facade.ts stagingInfo) for the parts the vessel carries:
 * every engine stage that has not fired, with the stack it will lift once the stages before it have burnt out and
 * separated, and the fired stage that owns the running engines (`active`), with the mass actually attached. Delta-v
 * is Tsiolkovsky at the vacuum Isp, TWR is at local gravity at full throttle, the burn time at full throttle; every
 * other fired stage, and every stage without engines, carries none. `deltaVNow` is the same at the ambient pressure
 * (`pressureShare` of sea level's: the Isp falls linearly from its vacuum toward its sea-level value, as the sim's
 * engines do). Returns the stages and the total delta-v (vacuum, as Readouts.deltaVTotal).
 */
export function labStageFigures(defs: DefLibrary, vehicle: VehicleDef, parts: readonly PartSnapshot[], stages: readonly StageInfo[], active: number, gLocal: number, pressureShare = 0): { stages: StageInfo[]; total: number } {
  const order = vehicle.stageGroups.map((g) => g.id);
  const groupOf = new Map(vehicle.parts.map((p) => [p.id, p.stageGroup]));
  const groupMass = new Map<string, number>();
  const groupProp = new Map<string, { amount: number; capacity: number }>();
  const groupEngine = new Map<string, { thrust: number; isp: number; ispSL: number }>();
  for (const p of parts) {
    const g = groupOf.get(p.instanceId);
    const def = defs.parts[p.def];
    if (!g || !def) continue;
    groupMass.set(g, (groupMass.get(g) ?? 0) + partsMass(defs, [p]));
    for (const m of def.modules) {
      if (m.type !== 'engine') continue;
      const e = groupEngine.get(g) ?? { thrust: 0, isp: m.ispVac, ispSL: m.ispSL };
      groupEngine.set(g, { thrust: e.thrust + m.thrustVac, isp: m.ispVac, ispSL: m.ispSL });
    }
  }
  // Propellant: what the group's engines burn, held in the group's tanks.
  for (const p of parts) {
    const g = groupOf.get(p.instanceId);
    const def = defs.parts[p.def];
    if (!g || !def) continue;
    const burns = new Set<string>();
    for (const q of parts) {
      if (groupOf.get(q.instanceId) !== g) continue;
      for (const m of defs.parts[q.def]?.modules ?? []) if (m.type === 'engine') for (const pr of m.propellants) burns.add(pr.resource);
    }
    for (const r of def.resources ?? []) {
      if (!burns.has(r.resource)) continue;
      const e = groupProp.get(g) ?? { amount: 0, capacity: 0 };
      groupProp.set(g, { amount: e.amount + (p.resources[r.resource] ?? 0), capacity: e.capacity + r.capacity });
    }
  }
  let total = 0;
  const out = stages.map((info, i): StageInfo => {
    const none: StageInfo = { ...info, propellantFraction: null, deltaVVac: 0, deltaVNow: 0, twr: 0, burnTime: 0 };
    const g = stageEngineGroup(vehicle, i);
    const engine = g ? groupEngine.get(g) : undefined;
    const prop = g ? groupProp.get(g) : undefined;
    if (!g || !engine || !prop || (info.fired && i !== active)) return none;
    // The stack this stage lifts: its own group and every group above it that the vessel still carries.
    const from = order.indexOf(g);
    let mass0 = 0;
    for (const [id, m] of groupMass) if (order.indexOf(id) >= from) mass0 += m;
    const ve = engine.isp * G0;
    const ratio = Math.log(mass0 / Math.max(1, mass0 - prop.amount));
    const dv = ve * ratio;
    const dvNow = (engine.isp + (engine.ispSL - engine.isp) * Math.min(1, Math.max(0, pressureShare))) * G0 * ratio;
    total += dv;
    return {
      ...info,
      propellantFraction: prop.capacity > 0 ? prop.amount / prop.capacity : 0,
      deltaVVac: dv,
      deltaVNow: dvNow,
      twr: engine.thrust / (mass0 * gLocal),
      burnTime: prop.amount / (engine.thrust / ve),
    };
  });
  return { stages: out, total };
}
