/**
 * What is known about a vehicle before it flies (docs/ARCHITECTURE.md 9.2; contracts/vehicle.ts): every
 * read-out the hangar shows and the generic pilots plan with, COMPUTED from the definitions, never authored.
 *
 *   analyzeVehicle(defs, vehicle): VehicleCapabilities
 *
 * The vehicle is assembled by the simulation's own assembler and its stages are fired structurally, in order,
 * by the simulation's own staging (`applyStageInstant`): what a stage drops, ignites or releases is what the
 * simulation does with it. Between stages the engines that are lit burn at full throttle until their
 * propellant (drawn from the tanks of their flow group, as the engine model draws) is gone; a stage that only
 * jettisons (a fairing, an escape tower, a nose cap) is applied before the burn of the stage it follows, as a
 * pilot fires it early in that burn. Delta-v per segment is the rocket equation with the summed thrust over
 * the summed mass flow: in vacuum and at the launch body's sea-level pressure.
 *
 * The ascent: low orbit of the launch body at `parkingAltitude` costs its circular speed, less the eastward
 * speed of the ground at the launch site, plus ASCENT_LOSS (gravity, drag and steering of a hand-flown ascent:
 * the existing stack needs 9 250 to 9 450 m/s hand-flown, sim-design 13.2). The "ideal" sum counts the lift-off
 * stage at the mean of its sea-level and vacuum Isp (fleet-docking 2.2).
 *
 * Pure: the vehicle may be one the library does not hold (a builder's), and nothing is written to the library.
 */
import type { BodyDef, DefLibrary, ModuleDef, VehicleDef } from '@/core/contracts/defs';
import { DEFAULT_PAD_CLASS_LIMITS, type PadClass, type UniverseRules } from '@/core/contracts/net';
import type { PortCapability, ReachEntry, StageCapability, VehicleCapabilities } from '@/core/contracts/vehicle';
import { quat } from '@/core/math/quat';
import { G0 } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { stagnationFlux } from '../dynamics/thermal';
import { buildVehicle } from './assemble';
import { portConditions, portModulesOf } from './modules/dockingPortState';
import { applyStageInstant } from './staging';
import { legFootLocal, structureOf, type EngineRef } from './structure';
import type { PartRuntime, Vessel } from './types';

/** Gravity, drag and steering losses of a hand-flown ascent to low orbit, m/s (see the header). */
export const ASCENT_LOSS = 2000;
/** Altitude of the low parking orbit the ascent aims at, m. */
export const PARKING_ALTITUDE = 200000;
/** Flight-path angle of the design entry for the entry speed limit (a shallow return), deg. */
export const ENTRY_FLIGHT_PATH_DEG = 6;

export interface AnalysisOptions {
  /** The rules document whose pad class limits classify a vehicle without a padInterface (default: the contract's defaults). */
  rules?: UniverseRules;
  /** The body it launches from (default: the body of the library's first site by id). */
  launchBodyId?: string;
  /** Altitude of the low parking orbit about the launch body, m (default 200 km). */
  parkingAltitude?: number;
  /**
   * The propellants a depot of the universe carries through a port (what the caller knows of the depots that exist,
   * e.g. `analyzeVehicle(defs, depot).transferable`). The refuelled profile is offered only to a craft whose main
   * propellants are all among them and that can take them through a port of its own. Default: none.
   */
  depotPropellants?: readonly string[];
  /**
   * What reaching a body costs from low orbit of the launch body, passing it ('flyby') and captured about it
   * ('orbit'), m/s; efuelled: departing from the depot's high orbit with full tanks. Without it the ladder is
   * empty: the costs are solar-system-sim's deltaVToOrbit (src/sim/nav), which src/sim/vessel may not import
   * (ARCHITECTURE 2); the caller passes it with its options (tests/unit/fleet/reachTable.ts, reachCostFor).
   */
  reachCost?: (bodyId: string, refuelled: boolean) => ReachCost | null;
}

/** The library with `vehicle` in it (the definitions are shared, nothing is copied or written). */
function withVehicle(defs: DefLibrary, vehicle: VehicleDef): DefLibrary {
  return defs.vehicles[vehicle.id] === vehicle ? defs : { ...defs, vehicles: { ...defs.vehicles, [vehicle.id]: vehicle } };
}

const isClamp = (p: PartRuntime): boolean => p.def.modules.some((m) => m.type === 'launchClamp');
const partMass = (p: PartRuntime): number => p.def.dryMass + p.resources.reduce((s, r) => s + r, 0);
const vesselMassOf = (v: Vessel): number => v.parts.reduce((s, p) => s + partMass(p), 0);

/** The body a vehicle launches from: the stated one, or the body of the first site (by id) of the library. */
export function launchBodyOf(defs: DefLibrary, launchBodyId?: string): BodyDef {
  const id = launchBodyId ?? Object.values(defs.sites).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]?.bodyId;
  const body = id !== undefined ? defs.bodies[id] : undefined;
  if (!body) throw new Error(`analyzeVehicle: no launch body (${String(id)}): the library needs a site or the options a launchBodyId`);
  return body;
}

/** Height and largest diameter of a vessel's parts along and about its Y axis (clamps excluded; legs at their deployment). */
function envelope(vessel: Vessel): { height: number; diameter: number } {
  let yMin = Infinity;
  let yMax = -Infinity;
  let rMax = 0;
  for (const p of vessel.parts) {
    if (isClamp(p)) continue;
    const pts: [number, number, number][] = [];
    const legs = p.def.modules.find((m): m is Extract<ModuleDef, { type: 'legs' }> => m.type === 'legs');
    if (legs) {
      const state = p.modules.find((m) => m.type === 'legs') as { deploy: number } | undefined;
      legs.legs.forEach((l, i) => pts.push(legFootLocal(legs, i, state?.deploy ?? 0), l.hinge));
    } else {
      const b = p.def.bounds;
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        pts.push([b.radius * Math.sin(a), b.yMin, b.radius * Math.cos(a)], [b.radius * Math.sin(a), b.yMax, b.radius * Math.cos(a)]);
      }
    }
    for (const q of pts) {
      const w = v3.add(p.pos, quat.rotate(p.rot, v3.fromTuple(q)));
      yMin = Math.min(yMin, w.y);
      yMax = Math.max(yMax, w.y);
      rMax = Math.max(rMax, Math.hypot(w.x, w.z));
    }
  }
  return { height: Number.isFinite(yMax - yMin) ? yMax - yMin : 0, diameter: 2 * rMax };
}

/** One burn: the lit engines at full throttle until their propellant is gone. Mutates the vessel's tanks. */
interface Burn {
  deltaVVac: number;
  deltaVSeaLevel: number;
  burnTime: number;
  massStart: number;
  massEnd: number;
  thrustVac: number;
  thrustSeaLevel: number;
}

/** Thrust of an engine at full throttle at sea-level pressure, N (the engine model's linear Isp in pressure). */
const thrustSeaLevelOf = (e: EngineRef): number => Math.max(0, (e.def.thrustVac / e.def.ispVac) * e.def.ispSL);

function burnLitEngines(vessel: Vessel): Burn {
  const st = structureOf(vessel);
  const massStart = vesselMassOf(vessel);
  const amountOf = (tanks: readonly { part: number; res: number }[]): number => tanks.reduce((s, t) => s + vessel.parts[t.part]!.resources[t.res]!, 0);
  // An engine burns while every one of its propellants has something left in the tanks of its flow group.
  const fed = (e: EngineRef): boolean => e.def.propellants.every((_, k) => amountOf(e.tanks[k]!) > 1e-9);
  let live: EngineRef[] = st.engines.filter((e) => e.state.active && !e.def.fixedBurn && !e.state.flameout && e.mdotMax > 0 && (e.state.ignitionsLeft === null || e.state.ignitionsLeft > 0) && fed(e));
  const thrustVac = live.reduce((s, e) => s + e.def.thrustVac, 0);
  const thrustSeaLevel = live.reduce((s, e) => s + thrustSeaLevelOf(e), 0);
  let mass = massStart;
  let dvVac = 0;
  let dvSl = 0;
  let time = 0;
  // Segments: all live engines at full throttle until the first pool (one propellant's tanks) runs dry.
  while (live.length > 0) {
    const pools = new Map<string, { tanks: readonly { part: number; res: number }[]; rate: number }>();
    for (const e of live) {
      e.def.propellants.forEach((pr, k) => {
        const tanks = e.tanks[k]!;
        const key = tanks.map((t) => `${t.part}:${t.res}`).join(',');
        const pool = pools.get(key) ?? { tanks, rate: 0 };
        pool.rate += e.mdotMax * pr.ratio;
        pools.set(key, pool);
      });
    }
    let t = Infinity;
    for (const pool of pools.values()) if (pool.rate > 0) t = Math.min(t, amountOf(pool.tanks) / pool.rate);
    if (!(t > 0 && Number.isFinite(t))) break;
    const mdot = live.reduce((s, e) => s + e.mdotMax, 0);
    const tVac = live.reduce((s, e) => s + e.def.thrustVac, 0);
    const tSl = live.reduce((s, e) => s + thrustSeaLevelOf(e), 0);
    const m1 = mass - mdot * t;
    dvVac += (tVac / mdot) * Math.log(mass / m1);
    dvSl += (tSl / mdot) * Math.log(mass / m1);
    time += t;
    mass = m1;
    for (const pool of pools.values()) {
      const have = amountOf(pool.tanks);
      const keep = have > 0 ? Math.max(0, 1 - (pool.rate * t) / have) : 0;
      for (const tk of pool.tanks) {
        const res = vessel.parts[tk.part]!.resources;
        res[tk.res] = res[tk.res]! * (keep < 1e-12 ? 0 : keep);
      }
    }
    live = live.filter((e) => e.def.propellants.every((_, k) => amountOf(e.tanks[k]!) > 1e-6 * e.mdotMax));
  }
  return { deltaVVac: dvVac, deltaVSeaLevel: dvSl, burnTime: time, massStart, massEnd: vesselMassOf(vessel), thrustVac, thrustSeaLevel };
}

/** A stage that only jettisons (and lights nothing, cuts nothing that burns, releases nothing): fired early in the burn before it. */
function onlyJettisons(vehicle: VehicleDef, index: number): boolean {
  const s = vehicle.stages[index];
  return s !== undefined && s.actions.length > 0 && s.actions.every((a) => a.kind === 'jettisonFairing' || a.kind === 'jettisonLES' || a.kind === 'fireSeparationMotors' || a.kind === 'enableRcs');
}

/** The stage burns of a vehicle from the pad: one entry per stage, in order, and the vessel after the last stage that lights an engine. */
export interface StageBurn extends Burn {
  stageIndex: number;
  label: string;
}

export function stageBurns(defs: DefLibrary, vehicle: VehicleDef): { burns: StageBurn[]; vessels: Vessel[] } {
  const lib = withVehicle(defs, vehicle);
  const vessel = buildVehicle(lib, vehicle.id);
  const burns: StageBurn[] = [];
  const vessels: Vessel[] = [];
  const n = vehicle.stages.length;
  for (let k = 0; k < n; k++) {
    applyStageInstant(vessel, k);
    const early: number[] = [];
    while (k + 1 + early.length < n && onlyJettisons(vehicle, k + 1 + early.length)) {
      applyStageInstant(vessel, k + 1 + early.length);
      early.push(k + 1 + early.length);
    }
    const burn = burnLitEngines(vessel);
    burns.push({ stageIndex: k, label: vehicle.stages[k]!.label, ...burn });
    vessels.push(snapshotOf(vessel));
    for (const j of early) {
      burns.push({ stageIndex: j, label: vehicle.stages[j]!.label, deltaVVac: 0, deltaVSeaLevel: 0, burnTime: 0, massStart: burn.massEnd, massEnd: burn.massEnd, thrustVac: 0, thrustSeaLevel: 0 });
      vessels.push(snapshotOf(vessel));
    }
    k += early.length;
  }
  return { burns, vessels };
}

/** A copy of the parts' resources and identities enough for the read-outs taken after a stage (the vessel itself goes on). */
function snapshotOf(v: Vessel): Vessel {
  return { ...v, parts: v.parts.map((p) => ({ ...p, resources: p.resources.slice(), modules: p.modules.map((m) => ({ ...m })) as typeof p.modules })) };
}

/** Low orbit of the launch body from its first site: circular speed less the ground's eastward speed, plus the ascent loss. */
export function deltaVToLowOrbit(defs: DefLibrary, body: BodyDef, parkingAltitude = PARKING_ALTITUDE): number {
  const r = body.radius + parkingAltitude;
  const site = Object.values(defs.sites).filter((s) => s.bodyId === body.id).sort((x, y) => (x.id < y.id ? -1 : 1))[0];
  const rate = body.rotation.mode === 'fixedRate' ? (body.rotation.rateDegPerDay * Math.PI) / 180 / 86400 : 0;
  const ground = site ? rate * body.radius * Math.cos((site.location.latDeg * Math.PI) / 180) : 0;
  return Math.sqrt(body.mu / r) - ground + ASCENT_LOSS;
}

/** The atmosphere's density at altitude h as the analysis models it: the file's table or exponential, or the standard atmosphere's 40-90 km fit. */
function densityModel(body: BodyDef): ((h: number) => number) | null {
  const atm = body.atmosphere;
  if (!atm) return null;
  if (atm.model === 'exponential') return (h) => (atm.rho0 ?? 0) * Math.exp(-h / (atm.scaleHeight ?? 1));
  if (atm.model === 'table' && atm.table && atm.table.length > 1) {
    const rows = atm.table;
    return (h) => {
      const km = h / 1000;
      if (km <= rows[0]!.hKm) return rows[0]!.rho;
      for (let i = 1; i < rows.length; i++) {
        if (km <= rows[i]!.hKm) {
          const a = rows[i - 1]!;
          const b = rows[i]!;
          const t = (km - a.hKm) / (b.hKm - a.hKm);
          return Math.exp(Math.log(Math.max(a.rho, 1e-30)) * (1 - t) + Math.log(Math.max(b.rho, 1e-30)) * t);
        }
      }
      return 0;
    };
  }
  // The 1976 standard atmosphere between 40 and 90 km, where entry heating happens: 1.225 kg/m^3 at the datum, 7.2 km scale height.
  return (h) => 1.225 * Math.exp(-h / 7200);
}

/**
 * Fastest entry into the launch body's atmosphere that the heat shield of `vessel` survives, m/s: a ballistic
 * entry at ENTRY_FLIGHT_PATH_DEG from the atmosphere's top, heated at the stagnation point by the body's
 * convective and radiative model (the simulation's flux functions), ablating as the shield model ablates
 * (area x (flux - threshold) / effective heat of ablation); the limit is the entry speed that uses the whole
 * ablator. Null without a shield or an atmosphere.
 */
function entrySpeedLimit(body: BodyDef, vessel: Vessel): number | null {
  const rho = densityModel(body);
  const heating = body.atmosphere?.heating;
  let shield: { area: number; qThreshold: number; heff: number; ablator: number; noseRadius: number } | null = null;
  let cdA = 0;
  for (const p of vessel.parts) {
    for (const m of p.def.modules) {
      if (m.type !== 'heatShield') continue;
      const k = (p.def.resources ?? []).findIndex((r) => r.resource === m.ablatorResource);
      const nose = p.def.thermal.surfaces.find((s) => Array.isArray(s.normal) && s.normal[1] < -0.9)?.noseRadius ?? Math.sqrt(m.area / Math.PI);
      shield = { area: m.area, qThreshold: m.qThreshold, heff: m.heff, ablator: k >= 0 ? p.def.resources![k]!.capacity : 0, noseRadius: nose };
    }
    for (const a of p.def.aero ?? []) {
      if (a.kind === 'bluntCapsule') cdA = Math.max(cdA, a.refArea * (a.cdTable.at(-1)?.[1] ?? 1));
    }
  }
  if (!shield || !rho || !heating || !body.atmosphere) return null;
  const mass = vesselMassOf(vessel);
  if (!(cdA > 0)) cdA = shield.area;
  const sinG = Math.sin((ENTRY_FLIGHT_PATH_DEG * Math.PI) / 180);
  const g = body.mu / (body.radius * body.radius);
  const used = (vEntry: number): number => {
    let h = body.atmosphere!.simTop;
    let v = vEntry;
    let ablated = 0;
    const dt = 0.25;
    for (let i = 0; i < 40000 && h > 0 && v > 500; i++) {
      const d = rho(h);
      const q = stagnationFlux(heating, d, v, shield!.noseRadius);
      if (q > shield!.qThreshold) ablated += (shield!.area * (q - shield!.qThreshold) * dt) / shield!.heff;
      v += (-(d * v * v * cdA) / (2 * mass) + g * sinG) * dt;
      h -= v * sinG * dt;
    }
    return ablated;
  };
  let lo = 1000;
  let hi = 30000;
  if (used(hi) <= shield.ablator) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = 0.5 * (lo + hi);
    if (used(mid) <= shield.ablator) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** RCS delta-v of a vessel with its main propellant spent: every thruster's propellant, at their Isp. */
function rcsDeltaV(vessel: Vessel): number {
  const st = structureOf(vessel);
  if (st.rcs.length === 0) return 0;
  const rcsRes = new Set(st.rcs.map((r) => r.def.resource));
  let isp = 0;
  let n = 0;
  for (const r of st.rcs) {
    isp += r.def.isp;
    n++;
  }
  isp /= n;
  let prop = 0;
  let mass = 0;
  for (const p of vessel.parts) {
    mass += p.def.dryMass;
    (p.def.resources ?? []).forEach((r, k) => {
      if (rcsRes.has(r.resource)) {
        prop += p.resources[k]!;
        mass += p.resources[k]!;
      } else if (r.resource === 'Ablator' || !st.engines.some((e) => e.def.propellants.some((pr) => pr.resource === r.resource))) mass += p.resources[k]!;
    });
  }
  return prop > 0 && mass > prop ? isp * G0 * Math.log(mass / (mass - prop)) : 0;
}

/** The pad class a vehicle needs: its padInterface's, else the smallest class whose limits take its lift-off mass and diameter. */
function padClassFor(vehicle: VehicleDef, mass: number, diameter: number, rules?: UniverseRules): PadClass {
  if (vehicle.padInterface) return vehicle.padInterface.class;
  const limits = rules?.pads.classLimits ?? DEFAULT_PAD_CLASS_LIMITS;
  for (const c of ['light', 'medium', 'heavy'] as const) if (mass <= limits[c].maxLiftoffMass && diameter <= limits[c].maxDiameter) return c;
  return 'heavy';
}

/** Everything the menu and the generic pilots read about a vehicle. */
export function analyzeVehicle(defs: DefLibrary, vehicle: VehicleDef, options: AnalysisOptions = {}): VehicleCapabilities {
  const lib = withVehicle(defs, vehicle);
  const body = launchBodyOf(lib, options.launchBodyId);
  const pad = buildVehicle(lib, vehicle.id);
  structureOf(pad);
  const clampMass = pad.parts.filter(isClamp).reduce((s, p) => s + partMass(p), 0);
  const massWet = vesselMassOf(pad) - clampMass;
  const massDry = pad.parts.filter((p) => !isClamp(p)).reduce((s, p) => s + p.def.dryMass, 0);
  const { height, diameter } = envelope(pad);
  const g = body.mu / (body.radius * body.radius);
  // Sea level: the engines' sea-level Isp where the launch body has air; its vacuum where it has none.
  const air = body.atmosphere !== null;
  const { burns, vessels } = stageBurns(lib, vehicle);
  const stages: StageCapability[] = burns.map((b) => ({
    stageIndex: b.stageIndex,
    label: b.label,
    deltaVVac: b.deltaVVac,
    deltaVSeaLevel: air ? b.deltaVSeaLevel : b.deltaVVac,
    twrVac: b.thrustVac / (b.massStart * g),
    twrSeaLevel: (air ? b.thrustSeaLevel : b.thrustVac) / (b.massStart * g),
    burnTime: b.burnTime,
    massStart: b.massStart,
    massEnd: b.massEnd,
  }));
  const deltaVTotal = stages.reduce((s, x) => s + x.deltaVVac, 0);
  const ideal = idealDeltaV(stages);
  const toOrbit = deltaVToLowOrbit(lib, body, options.parkingAltitude);
  const deltaVInOrbit = ideal >= toOrbit ? ideal - toOrbit : null;
  // The craft that goes on after the ascent: the vessel when its last engine is lit.
  const lastLit = lastIndex(burns, (b) => b.thrustVac > 0);
  const craft = lastLit >= 0 ? vessels[lastLit]! : pad;
  // The same craft with full tanks (after a refill at a depot): the burn of that stage from full.
  const fullCraftDv = lastLit >= 0 ? fullTankDeltaV(lib, vehicle, lastLit) : 0;
  // The entry craft: the vessel before the first parachute stage (or the last vessel).
  const firstChute = vehicle.stages.findIndex((s) => s.actions.some((a) => a.kind === 'deployParachute'));
  const entryCraft = firstChute > 0 ? vessels[firstChute - 1]! : vessels.at(-1) ?? pad;
  const commands = pad.parts.flatMap((p) => p.def.modules.filter((m): m is Extract<ModuleDef, { type: 'command' }> => m.type === 'command'));
  const cockpit = vehicle.cockpit ?? commands.find((c) => typeof c.cockpit === 'string')?.cockpit ?? null;
  const ports: PortCapability[] = [];
  pad.parts.forEach((p, i) => {
    for (const { module, index } of portModulesOf(p)) {
      const c = portConditions(pad, i, index);
      ports.push({ part: p.instanceId, portType: module.portType, freeAtLaunch: c.occupiedBy === null && c.link === null });
    }
  });
  const has = (type: string): boolean => pad.parts.some((p) => p.def.modules.some((m) => m.type === type));
  // What the craft's ports carry and its tanks hold.
  const carried = new Set<string>();
  for (const p of craft.parts) for (const { module } of portModulesOf(p)) for (const r of module.transfer.resources) carried.add(r);
  const held = new Set<string>();
  for (const p of craft.parts) for (const r of p.def.resources ?? []) if (r.transferable !== false && carried.has(r.resource)) held.add(r.resource);
  const transferable = [...held].sort();
  const mainPropellants = new Set(structureOf(craft).engines.filter((e) => !e.def.fixedBurn).flatMap((e) => e.def.propellants.map((p) => p.resource)));
  // Refuelled: the craft takes its main propellants through a port of its own, and a depot carries them.
  const depot = new Set(options.depotPropellants ?? []);
  const refillable = mainPropellants.size > 0 && [...mainPropellants].every((r) => held.has(r) && depot.has(r));
  const reach = reachLadder(lib, body.id, deltaVInOrbit ?? ideal - toOrbit, refillable ? fullCraftDv : null, options.reachCost);
  return {
    vehicleId: vehicle.id,
    massWet,
    massDry,
    height,
    diameter,
    partCount: vehicle.parts.length,
    padClass: padClassFor(vehicle, massWet, diameter, options.rules),
    stages,
    deltaVTotal,
    deltaVInOrbit,
    crewCapacity: commands.reduce((s, c) => s + c.crewCapacity, 0),
    remote: commands.some((c) => c.remote === true),
    firstPerson: cockpit !== null ? 'cockpit' : 'sensorCamera',
    cockpit,
    ports,
    rcs: has('rcs'),
    rcsDeltaV: rcsDeltaV(craft),
    reactionWheels: has('reactionWheel'),
    entrySpeedLimit: entrySpeedLimit(body, entryCraft),
    parachutes: has('parachute'),
    legs: has('legs'),
    transferable,
    reach,
  };
}

function lastIndex<T>(list: readonly T[], test: (x: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i]!)) return i;
  return -1;
}

/** Ascent delta-v with the lift-off stage at the mean of its sea-level and vacuum delta-v, the others in vacuum (fleet-docking 2.2, "ideal"). */
export function idealDeltaV(stages: readonly StageCapability[]): number {
  return stages.reduce((s, x, i) => s + (i === 0 ? 0.5 * (x.deltaVVac + x.deltaVSeaLevel) : x.deltaVVac), 0);
}

/** The burn of stage `k`'s lit engines from full tanks (the craft refilled at a depot), m/s. */
function fullTankDeltaV(defs: DefLibrary, vehicle: VehicleDef, k: number): number {
  const vessel = buildVehicle(defs, vehicle.id);
  for (let i = 0; i <= k; i++) applyStageInstant(vessel, i);
  for (const p of vessel.parts) (p.def.resources ?? []).forEach((r, j) => (p.resources[j] = r.capacity));
  return burnLitEngines(vessel).deltaVVac;
}

/** What reaching a body costs from low orbit of the launch body, m/s (`AnalysisOptions.reachCost`). */
export interface ReachCost {
  flyby: number;
  orbit: number;
  /** The refuelled profile: what is burnt from low orbit to the refuel orbit, from the tanks the ascent left (`flyby` and `orbit` are then from the refuel orbit, with full tanks). */
  beforeRefuel?: number;
}

/**
 * The can-reach ladder, nearest first: every attractor of the library other than the launch body, passed and
 * captured, at the costs the caller's reach function states (src/sim/nav may not be imported from here; without
 * one the ladder is empty). The refuelled profile counts only when the craft can reach the refuel orbit with what
 * the ascent left, and its margin is the smaller of the two slacks.
 */
function reachLadder(defs: DefLibrary, launchId: string, available: number, refilled: number | null, cost?: AnalysisOptions['reachCost']): ReachEntry[] {
  const out: ReachEntry[] = [];
  if (!cost) return out;
  for (const b of Object.values(defs.bodies).sort((x, y) => (x.id < y.id ? -1 : 1))) {
    if (b.id === launchId || b.gravityRole !== 'attractor') continue;
    const direct = cost(b.id, false);
    if (!direct) continue;
    const viaDepot = refilled !== null ? cost(b.id, true) : null;
    for (const kind of ['flyby', 'orbit'] as const) {
      const need = direct[kind];
      const margin = available - need;
      const before = viaDepot?.beforeRefuel ?? 0;
      const refMargin = viaDepot && available >= before ? Math.min(available - before, refilled! - viaDepot[kind]) : -Infinity;
      if (margin < 0 && refMargin >= 0) out.push({ bodyId: b.id, kind, deltaVRequired: before + viaDepot![kind], margin: refMargin, needsRefuel: true });
      else out.push({ bodyId: b.id, kind, deltaVRequired: need, margin, needsRefuel: false });
    }
  }
  return out.sort((x, y) => x.deltaVRequired - y.deltaVRequired || (x.bodyId < y.bodyId ? -1 : 1));
}
