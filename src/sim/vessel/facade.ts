/**
 * What the world orchestrator reads from a vessel: staging info, snapshot building, vessel-level
 * readouts, the integration predicate and the state hash.
 */
import type { TimedStageAction } from '@/core/contracts/defs';
import type { ChuteEnvelope, CraftSnapshot, FidelityTier, PartSnapshot, Readouts, StageInfo, VesselSituation, VesselSnapshot } from '@/core/contracts/sim';
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import { quat } from '@/core/math/quat';
import { G0 } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { rcsTranslationActive } from '../control/allocation';
import { partSkinTemperature } from '../dynamics/thermal';
import { cloneModuleState } from './assemble';
import { stateHash } from './codec';
import { partKeyOf } from './ids';
import { computeMassProps, isGroundFixed, partDryMass } from './massProps';
import { anyEngineBurning, ispAt } from './modules/engine';
import { anyChuteDeployed, chuteEnvelope } from './modules/parachute';
import { anyPending, helmCraft, legsDeployed, nextLiveStage } from './staging';
import { structureOf } from './structure';
import { G_DOSE_LIMIT, type EngineDef, type Vessel } from './types';

// ---------------------------------------------------------------------------------------- snapshots

/** Poses and module states of every part (deep copies; no environment needed). Fits FakeSimOptions.parts. */
export function vesselPartSnapshots(vessel: Vessel): PartSnapshot[] {
  structureOf(vessel);
  return vessel.parts.map((p) => {
    const [temp, maxTemp] = partSkinTemperature(p.temps, p.def.thermal.surfaces);
    const resources: Record<string, number> = {};
    const defs = p.def.resources ?? [];
    for (let k = 0; k < defs.length; k++) resources[defs[k]!.resource] = p.resources[k]!;
    const craft = vessel.crafts[p.craft]!;
    return {
      instanceId: p.instanceId,
      craftId: craft.craftId,
      stageGroup: p.stageGroup,
      stageLabel: craft.vehicle.stageGroups.find((g) => g.id === p.stageGroup)?.label ?? p.stageGroup,
      def: p.def.id,
      localPos: v3.clone(p.pos),
      localRot: quat.clone(p.rot),
      tempSkin: temp,
      maxTemp,
      resources,
      modules: p.modules.map(cloneModuleState),
      shielded: p.shielded,
    };
  });
}

/** 'prelaunch' / 'landed' / 'splashed' when the vessel itself knows its situation, else null (orbit-dependent: the orchestrator decides). */
export function surfaceSituation(vessel: Vessel): Extract<VesselSituation, 'prelaunch' | 'landed' | 'splashed'> | null {
  return vessel.surface === 'none' ? null : vessel.surface;
}

export function isControllable(vessel: Vessel): boolean {
  return vessel.parts.some((p) => p.def.modules.some((m) => m.type === 'command'));
}

export interface WorldSideSnapshotFields {
  bodyId: string;
  tier: FidelityTier;
  situation: VesselSituation;
  translationMode: VesselSnapshot['translationMode'];
  rRoot: Vec3;
  vRoot: Vec3;
  sunVisibility: number;
  /** Local gravitational acceleration at the vessel, m/s^2: what a held vessel's g load is shown as. Absent = the filtered g load as it is. */
  gravity?: number;
  /** Stage figures of craft `craft` of the vessel (an index into its craft list); without it every craft lists no stages. */
  stages?: (craft: number) => StageInfo[];
  /** Counter that changes when the vessel's orbit or plan changes (`VesselSnapshot.revision`). */
  revision?: number;
}

/** The craft of a vessel as the snapshot shows them, base craft first. */
export function craftSnapshots(vessel: Vessel, stages?: (craft: number) => StageInfo[]): CraftSnapshot[] {
  return vessel.crafts.map((c, ci) => {
    const command = vessel.parts.find((p) => p.craft === ci && p.command !== null);
    const chase = c.vehicle.cameras.chase;
    return {
      id: c.craftId,
      // Lineage: the craft this one left as a piece; null for a launched craft (a consumer never takes an id apart).
      parent: c.parent,
      vehicleId: c.vehicleId,
      name: c.name,
      ownerId: c.ownerId,
      // A callsign is the universe's knowledge of an account; a vessel knows the account id only.
      ownerCallsign: null,
      commandPart: command ? command.instanceId : null,
      // The cockpit of the command part, as the part carries it (ARCHITECTURE 7.2): nothing looks it up in the library.
      cockpit: command && command.command ? { id: command.command.cockpit, cameraSeat: command.command.cameraSeat, sensorMount: command.command.sensorCamera } : null,
      staging: { nextStage: nextLiveStage(vessel, ci), stages: stages ? stages(ci) : [], lockout: c.stageLockout > 0 },
      chase: { defaultDistance: chase.defaultDistance, minDistance: chase.minDistance, maxDistance: chase.maxDistance },
      policy: { lendAttitude: c.policy.lendAttitude, lendEngines: c.policy.lendEngines, lendPropellant: c.policy.lendPropellant, helm: typeof c.policy.helm === 'string' ? c.policy.helm : c.policy.helm.slice() },
    };
  });
}

/** Immutable snapshot of a vessel; the orchestrator supplies the fields only it knows. */
export function toVesselSnapshot(vessel: Vessel, world: WorldSideSnapshotFields): VesselSnapshot {
  const st = structureOf(vessel);
  if (!(vessel.mp.mass > 0)) computeMassProps(vessel);
  const a = vessel.aero;
  return {
    id: vessel.id,
    name: vessel.name,
    vehicleId: vessel.crafts[0]!.vehicleId,
    crafts: craftSnapshots(vessel, world.stages),
    links: vessel.links.map((l) => ({ a: partKeyOf(vessel, l.a), b: partKeyOf(vessel, l.b), roll: l.roll })),
    helm: {
      accountId: vessel.helm.accountId,
      callsign: null,
      craftId: vessel.crafts[vessel.helm.craft]!.craftId,
      controlPart: vessel.parts.length > 0 ? partKeyOf(vessel, Math.min(vessel.helm.controlPart, vessel.parts.length - 1)) : '',
    },
    presence: 'solid',
    timeOffset: 0,
    revision: world.revision ?? 0,
    controllable: isControllable(vessel),
    tier: world.tier,
    situation: world.situation,
    translationMode: world.translationMode,
    bodyId: world.bodyId,
    r: v3.clone(vessel.r),
    v: v3.clone(vessel.v),
    rRoot: v3.clone(world.rRoot),
    vRoot: v3.clone(world.vRoot),
    q: quat.clone(vessel.q),
    w: v3.clone(vessel.w),
    mass: vessel.mp.mass,
    comLocal: v3.clone(vessel.mp.com),
    boundingRadius: st.boundingRadius,
    parts: vesselPartSnapshots(vessel),
    aero: {
      q: a.q,
      mach: reportedMach(vessel),
      aoa: a.aoa,
      airDensity: a.density,
      pressure: a.pressure,
      temperature: a.temperature,
      airVelocity: v3.clone(a.airVelocity),
      heatFlux: a.heatFlux,
      plasmaIntensity: a.plasmaIntensity,
    },
    gLoad: shownGLoad(vessel, world.gravity),
    properAccel: v3.clone(vessel.properAccel),
    contact: { ...vessel.contact },
    sunVisibility: world.sunVisibility,
    thrust: vessel.thrust,
    age: vessel.age,
  };
}

// ------------------------------------------------------------------------------------- staging info

interface ModelPart {
  alive: boolean;
  parent: number;
  /** Craft index and instance id: a stage action names parts of its own craft. */
  craft: number;
  id: string;
  /** Flow group key: the stage group, qualified by the craft in a vessel of several. */
  group: string;
  dry: number;
  resources: number[];
  resIds: string[];
  capacities: number[];
  engines: { def: EngineDef; active: boolean }[];
}

interface Model {
  parts: ModelPart[];
  /** Dock links between model parts (indices). */
  links: { a: number; b: number }[];
  /** The craft whose stage stack is being modelled. */
  craft: number;
}

function buildModel(vessel: Vessel, craft: number): Model {
  const several = vessel.crafts.length > 1;
  return {
    craft,
    links: vessel.links.map((l) => ({ a: l.a, b: l.b })),
    parts: vessel.parts.map((p) => {
      const engines: ModelPart['engines'] = [];
      for (let m = 0; m < p.def.modules.length; m++) {
        const md = p.def.modules[m]!;
        const ms = p.modules[m]!;
        if (md.type === 'engine' && ms.type === 'engine' && !md.fixedBurn) {
          engines.push({ def: md, active: ms.active && !ms.flameout && (ms.ignitionsLeft === null || ms.ignitionsLeft > 0 || ms.throttleActual > 0) });
        }
      }
      return {
        alive: true,
        parent: p.parent,
        craft: p.craft,
        id: p.instanceId,
        group: several ? `${p.craft}/${p.stageGroup}` : p.stageGroup,
        dry: isGroundFixed(p) ? 0 : partDryMass(p),
        resources: isGroundFixed(p) ? [] : p.resources.slice(),
        resIds: (p.def.resources ?? []).map((r) => r.resource),
        capacities: (p.def.resources ?? []).map((r) => r.capacity),
        engines,
      };
    }),
  };
}

function cloneModel(m: Model): Model {
  return { craft: m.craft, links: m.links, parts: m.parts.map((p) => ({ ...p, resources: p.resources.slice(), engines: p.engines.map((e) => ({ ...e })) })) };
}

function modelMass(m: Model): number {
  let s = 0;
  for (const p of m.parts) {
    if (!p.alive) continue;
    s += p.dry;
    for (const r of p.resources) s += r;
  }
  return s;
}

/**
 * Cut the joint between part `index` and its parent: what is no longer connected to the first part of the
 * model (over tree edges and dock links) leaves it. In a vessel without links that is the subtree of `index`.
 */
function removeSubtree(m: Model, index: number): void {
  if (m.links.length === 0) {
    const dead = new Set<number>([index]);
    m.parts[index]!.alive = false;
    for (let i = index + 1; i < m.parts.length; i++) {
      if (dead.has(m.parts[i]!.parent)) {
        dead.add(i);
        m.parts[i]!.alive = false;
      }
    }
    return;
  }
  m.parts[index]!.parent = -1;
  keepConnected(m);
}

/** Release every dock link of part `index`: what is no longer connected to the first part of the model leaves it. */
function releaseLinks(m: Model, index: number): void {
  m.links = m.links.filter((l) => l.a !== index && l.b !== index);
  keepConnected(m);
}

/** Keep the parts connected to the first live part (the vessel the craft at the helm stays with). */
function keepConnected(m: Model): void {
  const n = m.parts.length;
  const reach = new Array<boolean>(n).fill(false);
  const first = m.parts.findIndex((p) => p.alive);
  if (first < 0) return;
  reach[first] = true;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < n; i++) {
      const p = m.parts[i]!;
      if (!p.alive || p.parent < 0 || !m.parts[p.parent]!.alive) continue;
      if (reach[i] !== reach[p.parent]) {
        reach[i] = reach[p.parent] = true;
        changed = true;
      }
    }
    for (const l of m.links) {
      if (!m.parts[l.a]!.alive || !m.parts[l.b]!.alive) continue;
      if (reach[l.a] !== reach[l.b]) {
        reach[l.a] = reach[l.b] = true;
        changed = true;
      }
    }
  }
  for (let i = 0; i < n; i++) if (!reach[i]) m.parts[i]!.alive = false;
}

/** Index of the live part `id` of the modelled craft. */
function modelIndex(m: Model, id: string): number {
  for (let i = 0; i < m.parts.length; i++) if (m.parts[i]!.alive && m.parts[i]!.craft === m.craft && m.parts[i]!.id === id) return i;
  return -1;
}

function applyToModel(m: Model, actions: readonly TimedStageAction[]): void {
  for (const a of actions) {
    switch (a.kind) {
      case 'igniteEngines':
        for (const id of a.parts) {
          const i = modelIndex(m, id);
          if (i >= 0) for (const e of m.parts[i]!.engines) e.active = true;
        }
        break;
      case 'shutdownEngines':
        for (const id of a.parts) {
          const i = modelIndex(m, id);
          if (i >= 0) for (const e of m.parts[i]!.engines) e.active = false;
        }
        break;
      case 'decouple':
      case 'jettisonLES':
      case 'jettisonFairing': {
        const i = modelIndex(m, a.part);
        if (i > 0) removeSubtree(m, i);
        break;
      }
      case 'releaseClamps':
        for (const id of a.parts) {
          const i = modelIndex(m, id);
          if (i > 0) removeSubtree(m, i);
        }
        break;
      case 'undock': {
        const i = modelIndex(m, a.part);
        if (i >= 0) releaseLinks(m, i);
        break;
      }
      default:
        break;
    }
  }
}

/** A stage that only drops inert mass or toggles equipment: no ignition, no shutdown, no loss of a running engine. */
function isInertStage(m: Model, actions: readonly TimedStageAction[]): boolean {
  for (const a of actions) {
    if (a.kind === 'shutdownEngines') return false;
    if (a.kind === 'igniteEngines') {
      for (const id of a.parts) {
        const i = modelIndex(m, id);
        if (i >= 0 && m.parts[i]!.engines.length > 0) return false;
      }
    }
  }
  const trial = cloneModel(m);
  applyToModel(trial, actions);
  for (let i = 0; i < m.parts.length; i++) {
    if (m.parts[i]!.alive && !trial.parts[i]!.alive && m.parts[i]!.engines.some((e) => e.active)) return false;
  }
  return true;
}

function ignitesEngine(m: Model, actions: readonly TimedStageAction[]): boolean {
  for (const a of actions) {
    if (a.kind !== 'igniteEngines') continue;
    for (const id of a.parts) {
      const i = modelIndex(m, id);
      if (i >= 0 && m.parts[i]!.engines.length > 0) return true;
    }
  }
  return false;
}

interface BurnResult {
  dvVac: number;
  dvNow: number;
  thrustNow: number;
  burnTime: number;
  fraction: number | null;
  mass0: number;
}

/** Burn every active engine to depletion of its stage group (Tsiolkovsky, piecewise if groups differ). Mutates the model. */
function burnModel(m: Model, pressure: number): BurnResult {
  const mass0 = modelMass(m);
  interface Group {
    id: string;
    mdot: number;
    fVac: number;
    fNow: number;
    need: Map<string, number>;
  }
  const groups = new Map<string, Group>();
  for (const p of m.parts) {
    if (!p.alive) continue;
    for (const e of p.engines) {
      if (!e.active) continue;
      let g = groups.get(p.group);
      if (!g) {
        g = { id: p.group, mdot: 0, fVac: 0, fNow: 0, need: new Map() };
        groups.set(p.group, g);
      }
      const mdot = e.def.thrustVac / (e.def.ispVac * G0);
      g.mdot += mdot;
      g.fVac += e.def.thrustVac;
      g.fNow += Math.max(0, mdot * G0 * ispAt(e.def, pressure));
      for (const pr of e.def.propellants) g.need.set(pr.resource, (g.need.get(pr.resource) ?? 0) + mdot * pr.ratio);
    }
  }
  const amount = (group: string, res: string): number => {
    let s = 0;
    for (const p of m.parts) {
      if (!p.alive || p.group !== group) continue;
      for (let k = 0; k < p.resIds.length; k++) if (p.resIds[k] === res) s += p.resources[k]!;
    }
    return s;
  };
  let remaining = 0;
  let capacity = 0;
  for (const g of groups.values()) {
    for (const res of g.need.keys()) {
      remaining += amount(g.id, res);
      for (const p of m.parts) {
        if (!p.alive || p.group !== g.id) continue;
        for (let k = 0; k < p.resIds.length; k++) if (p.resIds[k] === res) capacity += p.capacities[k]!;
      }
    }
  }
  const live = [...groups.values()];
  let thrustNow = 0;
  for (const g of live) thrustNow += g.fNow;
  let mass = mass0;
  let dvVac = 0;
  let dvNow = 0;
  let time = 0;
  for (let guard = 0; guard < 16 && live.length > 0; guard++) {
    // Time until the first group runs dry.
    let tMin = Infinity;
    const times: number[] = [];
    for (const g of live) {
      let t = Infinity;
      for (const [res, rate] of g.need) if (rate > 0) t = Math.min(t, amount(g.id, res) / rate);
      times.push(t);
      if (t < tMin) tMin = t;
    }
    if (!Number.isFinite(tMin)) break;
    let mdot = 0;
    let fVac = 0;
    let fNow = 0;
    for (const g of live) {
      mdot += g.mdot;
      fVac += g.fVac;
      fNow += g.fNow;
    }
    if (tMin > 0 && mdot > 0) {
      const m1 = mass - mdot * tMin;
      if (m1 > 0) {
        const ln = Math.log(mass / m1);
        dvVac += (fVac / mdot) * ln;
        dvNow += (fNow / mdot) * ln;
      }
      mass = m1;
      time += tMin;
      for (const g of live) {
        for (const [res, rate] of g.need) {
          const total = amount(g.id, res);
          const keep = total > 0 ? Math.max(0, 1 - (rate * tMin) / total) : 0;
          for (const p of m.parts) {
            if (!p.alive || p.group !== g.id) continue;
            for (let k = 0; k < p.resIds.length; k++) if (p.resIds[k] === res) p.resources[k] = p.resources[k]! * keep;
          }
        }
      }
    }
    for (let i = live.length - 1; i >= 0; i--) if (times[i]! <= tMin * (1 + 1e-12)) live.splice(i, 1);
  }
  return { dvVac, dvNow, thrustNow, burnTime: time, fraction: capacity > 0 ? remaining / capacity : groups.size > 0 ? 0 : null, mass0 };
}

/**
 * Per-stage information for the staging stack.
 *
 * Delta-v is Tsiolkovsky with current masses. For a stage that has not fired yet, the stages before it
 * are assumed to burn to depletion, and inert stages that directly follow it (jettisons, gear) are
 * assumed fired right after its ignition - so the M-2 figure is the one after tower and fairing
 * jettison. For the stage whose engines are running now, the figure uses the mass actually attached.
 */
export function stagingInfo(vessel: Vessel, env: VesselEnvironment, craft: number = vessel.helm.craft): StageInfo[] {
  const record = vessel.crafts[craft]!;
  const stages = record.vehicle.stages;
  const rl = v3.len(vessel.r);
  const radius = rl > 0 ? rl : env.radius;
  const g = env.mu / (radius * radius);
  const pressure = env.atmosphereAt(radius - env.radius).pressure;
  const model = buildModel(vessel, craft);
  // Delayed actions already under way (an ignition a second after separation) count as done.
  applyToModel(model, record.pending.map((p) => p.action));
  // Stages the next press will pass over (nothing left for them to do, e.g. after an abort) show as done.
  const next = nextLiveStage(vessel, craft);
  const infos: StageInfo[] = stages.map((s, i) => ({
    label: s.label,
    icon: s.icon,
    fired: i < next,
    deltaVVac: 0,
    deltaVNow: 0,
    twr: 0,
    burnTime: 0,
    propellantFraction: null,
    actionKinds: s.actions.map((a) => a.kind),
  }));
  const fill = (i: number, b: BurnResult): void => {
    const info = infos[i]!;
    info.deltaVVac = b.dvVac;
    info.deltaVNow = b.dvNow;
    info.twr = b.mass0 > 0 ? b.thrustNow / (b.mass0 * g) : 0;
    info.burnTime = b.burnTime;
    info.propellantFraction = b.fraction;
  };
  // The fired stage that owns the engines running (or armed) now.
  let owner = -1;
  for (let i = Math.min(record.nextStage, stages.length) - 1; i >= 0 && owner < 0; i--) {
    for (const a of stages[i]!.actions) {
      if (a.kind !== 'igniteEngines') continue;
      for (const id of a.parts) {
        const k = modelIndex(model, id);
        if (k >= 0 && model.parts[k]!.engines.some((e) => e.active)) owner = i;
      }
    }
  }
  if (owner >= 0) fill(owner, burnModel(model, pressure));
  for (let s = record.nextStage; s < stages.length; s++) {
    const ignites = ignitesEngine(model, stages[s]!.actions);
    applyToModel(model, stages[s]!.actions);
    if (!ignites) continue;
    const ahead = cloneModel(model);
    for (let t = s + 1; t < stages.length; t++) {
      if (!isInertStage(ahead, stages[t]!.actions)) break;
      applyToModel(ahead, stages[t]!.actions);
    }
    fill(s, burnModel(ahead, pressure));
    burnModel(model, pressure);
  }
  return infos;
}

// ----------------------------------------------------------------------------------------- readouts

export type VesselReadouts = Pick<
  Readouts,
  | 'throttle'
  | 'thrust'
  | 'twr'
  | 'mass'
  | 'gLoad'
  | 'gDose'
  | 'gDoseLimit'
  | 'dynamicPressure'
  | 'mach'
  | 'angleOfAttack'
  | 'heatFlux'
  | 'ablatorFraction'
  | 'maxTempFraction'
  | 'sasEnabled'
  | 'sasMode'
  | 'rcsEnabled'
  | 'fineControl'
  | 'legsDeployed'
  | 'lightsOn'
  | 'chuteEnvelope'
  | 'rcsFraction'
  | 'deltaVTotal'
  | 'liftVectorUp'
  | 'tiltFromVertical'
>;

/**
 * The Mach number a vessel reports: 0 where there is no air (above an atmosphere's top, on an airless body),
 * the model's Mach number inside an atmosphere (request flight-ui-6: in vacuum the model's value is the speed
 * over a nominal speed of sound, which is no reading).
 */
export function reportedMach(vessel: Vessel): number {
  return vessel.aero.density > 0 ? vessel.aero.mach : 0;
}

/**
 * Envelope light of the next parachute stage that has not fired, for the current flight condition; null
 * when no chute stage remains AND where there is no air (above the simulated atmosphere, on a body without
 * one): a parachute needs air, and altitude, Mach number and dynamic pressure say nothing about it there
 * (request flight-ui-9). Inside an atmosphere the light is what it was.
 */
export function nextChuteEnvelope(vessel: Vessel, env: VesselEnvironment): ChuteEnvelope | null {
  const craft = vessel.helm.craft;
  const record = helmCraft(vessel);
  const stages = record.vehicle.stages;
  const rl = v3.len(vessel.r);
  const altitude = rl - env.radius;
  // The air at the vessel now (not the aerodynamic state of its last integrated step: a held vessel has none).
  if (!(env.atmosphereAt(altitude).density > 0)) return null;
  const speed = v3.len(vessel.aero.airVelocity);
  for (let s = record.nextStage; s < stages.length; s++) {
    let worst: ChuteEnvelope | null = null;
    for (const a of stages[s]!.actions) {
      if (a.kind !== 'deployParachute') continue;
      for (const id of a.parts) {
        const part = vessel.parts.find((p) => p.craft === craft && p.instanceId === id);
        if (!part) continue;
        for (let m = 0; m < part.def.modules.length; m++) {
          const md = part.def.modules[m]!;
          const ms = part.modules[m]!;
          if (md.type !== 'parachute' || ms.type !== 'parachute' || md.mode !== a.mode || ms.state !== 'stowed') continue;
          const e = chuteEnvelope(md, altitude, vessel.aero.mach, speed, vessel.aero.q);
          if (worst === null || e === 'unsafe' || (e === 'risky' && worst === 'safe')) worst = e;
        }
      }
    }
    if (worst !== null) return worst;
  }
  return null;
}

/**
 * Vessel-level readouts. `stages` = an already computed stagingInfo(vessel, env) for the same state (the
 * orchestrator caches it); omitted, it is computed here.
 */
export function vesselReadouts(vessel: Vessel, env: VesselEnvironment, stages?: readonly StageInfo[]): VesselReadouts {
  structureOf(vessel);
  if (!(vessel.mp.mass > 0)) computeMassProps(vessel);
  const rl = v3.len(vessel.r);
  const g = rl > 0 ? env.mu / (rl * rl) : env.mu / (env.radius * env.radius);
  let ablator: number | null = null;
  let maxTempFraction = 0;
  let rcs = 0;
  let rcsCap = 0;
  const rcsResources = new Set<string>();
  for (const p of vessel.parts) for (const md of p.def.modules) if (md.type === 'rcs') rcsResources.add(md.resource);
  for (const p of vessel.parts) {
    for (const m of p.modules) if (m.type === 'heatShield') ablator = ablator === null ? m.ablatorFraction : Math.min(ablator, m.ablatorFraction);
    const [t, max] = partSkinTemperature(p.temps, p.def.thermal.surfaces);
    if (max > 0 && t / max > maxTempFraction) maxTempFraction = t / max;
    const res = p.def.resources ?? [];
    for (let k = 0; k < res.length; k++) {
      if (rcsResources.has(res[k]!.resource)) {
        rcs += p.resources[k]!;
        rcsCap += res[k]!.capacity;
      }
    }
  }
  let dv = 0;
  for (const s of stages ?? stagingInfo(vessel, env)) dv += s.deltaVVac;
  const up = rl > 0 ? v3.scale(vessel.r, 1 / rl) : v3.unitY();
  const nose = quat.rotate(vessel.q, v3.unitY());
  let liftUp: boolean | null = null;
  if (vessel.aero.liftDirVes) liftUp = v3.dot(quat.rotate(vessel.q, vessel.aero.liftDirVes), up) > 0;
  return {
    throttle: vessel.throttle,
    thrust: vessel.thrust,
    twr: vessel.mp.mass > 0 ? vessel.thrust / (vessel.mp.mass * g) : 0,
    mass: vessel.mp.mass,
    gLoad: shownGLoad(vessel, rl > 0 ? env.mu / (rl * rl) : undefined),
    gDose: vessel.gDose,
    gDoseLimit: G_DOSE_LIMIT,
    dynamicPressure: vessel.aero.q,
    mach: reportedMach(vessel),
    angleOfAttack: vessel.aero.aoa,
    heatFlux: vessel.aero.heatFlux,
    ablatorFraction: ablator,
    maxTempFraction,
    sasEnabled: vessel.sas.enabled,
    sasMode: vessel.sas.mode,
    rcsEnabled: vessel.rcsEnabled,
    fineControl: vessel.fineControl,
    legsDeployed: legsDeployed(vessel),
    lightsOn: vessel.lightsOn,
    chuteEnvelope: nextChuteEnvelope(vessel, env),
    rcsFraction: rcsCap > 0 ? rcs / rcsCap : null,
    deltaVTotal: dv,
    liftVectorUp: liftUp,
    tiltFromVertical: v3.angle(nose, up),
  };
}

/**
 * The g load a read-out shows. A vessel that is held (on the launch clamps, landed at rest, asleep) is
 * pressed on its support by the local gravity: it shows |g| / g0 (1.00 on the pad, 0.17 on the Moon),
 * not the filtered proper acceleration, which settles for a moment after the vessel is put down and is not
 * integrated while it is held (request flight-ui-9). In flight it is the vessel's filtered g load. The
 * vessel's state (`Vessel.gLoad`, the crew's dose) is not touched.
 */
export function shownGLoad(vessel: Vessel, gravity: number | undefined): number {
  return vessel.hold !== null && gravity !== undefined && Number.isFinite(gravity) ? gravity / G0 : vessel.gLoad;
}

/**
 * Height of the lowest contact probe above terrain or sea, m (0 while held on the ground). One band-limited
 * terrain query under the vessel; exact per-probe values are in vessel.groundClearance while a step is
 * within contact range. This is what the simulation's own rules read (milestone triggers, the warp clamp,
 * the records of a milestone): a held vessel is on the ground.
 */
export function radarAltitude(vessel: Vessel, env: VesselEnvironment): number {
  return vessel.hold !== null ? 0 : probeClearance(vessel, env);
}

/**
 * The radar altitude a read-out shows: the same quantity held or flying (request flight-ui-9). While the
 * launch clamps hold the vessel it is the height of the VEHICLE's lowest probe (the clamps are ground
 * equipment that stays behind), so the number goes on through the release instead of jumping from 0;
 * landed at rest it is the clearance of the feet, which is zero to the depth they have settled.
 */
export function shownRadarAltitude(vessel: Vessel, env: VesselEnvironment): number {
  return probeClearance(vessel, env);
}

function probeClearance(vessel: Vessel, env: VesselEnvironment): number {
  const st = structureOf(vessel);
  const clamped = vessel.hold === 'clamps';
  const rl = v3.len(vessel.r);
  if (!(rl > 0)) return 0;
  const alt = rl - env.radius;
  const dir = quat.rotateInv(env.qFixedToInertial, v3.scale(vessel.r, 1 / rl));
  let surface = env.terrainHeight(dir, Math.max(0.3, 0.02 * Math.max(alt, 0)));
  if (env.ocean !== null && env.surfaceKind(dir) === 'water') surface = Math.max(surface, env.ocean.waterHeight(dir));
  let lowest = rl;
  const consider = (x: number, y: number, z: number, radius: number): void => {
    const p = v3.add(vessel.r, quat.rotate(vessel.q, { x, y, z }));
    lowest = Math.min(lowest, v3.len(p) - radius);
  };
  for (const pr of st.probes) {
    if (clamped && isGroundFixed(vessel.parts[pr.part]!)) continue;
    consider(pr.x, pr.y, pr.z, pr.radius);
  }
  for (const lg of st.legs) for (let l = 0; l < lg.probes.length; l++) if (lg.state.deploy >= 0.999 && !lg.state.broken[l]) consider(lg.probes[l]!.x, lg.probes[l]!.y, lg.probes[l]!.z, lg.probes[l]!.radius);
  return Math.max(0, lowest - env.radius - surface);
}

// ------------------------------------------------------------------------------ integration predicate

/** Radar altitude below which a vessel near terrain must be integrated, m. */
export const TERRAIN_PROXIMITY = 2500;
/** Seconds after a staging action during which the vessel stays integrated. */
export const POST_STAGING_TIME = 1.0;

/**
 * True when the next advance of this vessel must integrate forces (sim-design 4.1, rules 1-5; rule 6,
 * proximity of other vessels, is the orchestrator's). A vessel held on the ground needs integration only
 * while something on it burns or a delayed stage action is pending.
 */
export function needsIntegration(vessel: Vessel, env: VesselEnvironment): boolean {
  if (vessel.destroyed || vessel.parts.length === 0) return false;
  if (anyPending(vessel) || vessel.crafts.some((c) => c.stageLockout > 0)) return true;
  if (anyEngineBurning(vessel)) return true;
  if (vessel.hold === 'ground') return false;
  if (vessel.hold !== null) return false;
  if (rcsTranslationActive(vessel, vessel.appliedControls.translate)) return true;
  if (vessel.crafts.some((c) => c.sinceStaging < POST_STAGING_TIME)) return true;
  if (vessel.contact.anyContact || vessel.contact.waterSubmersion > 0 || anyChuteDeployed(vessel)) return true;
  const rl = v3.len(vessel.r);
  if (!(rl > 0)) return false;
  const alt = rl - env.radius;
  if (env.atmosphereAt(alt).density > 0) return true;
  const st = structureOf(vessel);
  if (alt - st.boundingRadius < 25000) {
    const dir = quat.rotateInv(env.qFixedToInertial, v3.scale(vessel.r, 1 / rl));
    const h = env.terrainHeight(dir, Math.max(0.3, 0.02 * Math.max(alt, 0)));
    if (alt - h - st.boundingRadius < TERRAIN_PROXIMITY) return true;
  }
  return false;
}

// --------------------------------------------------------------------------------------- state hash

/**
 * Stable hash (16 hex digits) of the complete dynamic state of a vessel: the hash of its codec body
 * (./codec.ts), so whatever the codec carries is hashed and nothing else is.
 */
export function vesselStateHash(vessel: Vessel): string {
  return stateHash(vessel);
}
