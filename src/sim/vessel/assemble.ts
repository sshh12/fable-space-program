/**
 * Builds a runtime Vessel from a VehicleDef: resolves attach nodes into part poses, creates module
 * states, and (for scenarios that start mid-mission) applies the stages that are considered already fired.
 */
import { NEUTRAL_CONTROLS } from '@/core/contracts/controls';
import type { DefLibrary, ModuleDef, PartDef, VehicleDef, VehiclePartPlacement } from '@/core/contracts/defs';
import type { ModuleState } from '@/core/contracts/sim';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { INITIAL_PART_TEMP, type ModuleRt, type PartRuntime, type Vessel } from './types';

export class VesselAssemblyError extends Error {
  constructor(vehicleId: string, message: string) {
    super(`vehicles/${vehicleId}.json: ${message}`);
    this.name = 'VesselAssemblyError';
  }
}

export function createModuleState(def: ModuleDef): ModuleState {
  switch (def.type) {
    case 'command':
      return { type: 'command', crew: 0, crewAlive: true };
    case 'engine':
      return {
        type: 'engine',
        active: false,
        throttleActual: 0,
        thrust: 0,
        massFlow: 0,
        ambientPressure: 0,
        pressureRatio: 1e6,
        gimbal: [0, 0],
        ignitionAge: -1,
        shutdownAge: -1,
        ignitionsLeft: def.maxIgnitions,
        flameout: false,
      };
    case 'rcs':
      return { type: 'rcs', enabled: false, levels: def.thrusters.map(() => 0) };
    case 'reactionWheel':
      return { type: 'reactionWheel', torque: v3.zero() };
    case 'decoupler':
      return { type: 'decoupler', fired: false };
    case 'fairing':
      return { type: 'fairing', jettisoned: false };
    case 'launchClamp':
      return { type: 'launchClamp', released: false };
    case 'les':
      return { type: 'les', fired: false, jettisoned: false };
    case 'legs':
      return { type: 'legs', deploy: 0, compression: def.legs.map(() => 0), broken: def.legs.map(() => false), contact: def.legs.map(() => false) };
    case 'parachute':
      return { type: 'parachute', state: 'stowed', inflation: 0, deployAge: -1, envelope: 'safe', lineDir: { x: 0, y: 1, z: 0 } };
    case 'heatShield':
      return { type: 'heatShield', ablatorFraction: 1, surfaceTemp: INITIAL_PART_TEMP };
    case 'light':
      return { type: 'light', on: false };
    case 'antenna':
      return { type: 'antenna', deployed: false };
  }
}

export function createModuleRt(def: ModuleDef): ModuleRt {
  switch (def.type) {
    case 'engine':
      return { type: 'engine', lit: false, burnLeft: def.fixedBurn ? def.fixedBurn.duration : 0, started: false, cmdX: 0, cmdZ: 0 };
    case 'rcs':
      return { type: 'rcs', pulseCooldown: 0, firing: false };
    case 'legs':
      return { type: 'legs', target: 0 };
    case 'parachute':
      return { type: 'parachute', canopies: def.count };
    default:
      return { type: 'none' };
  }
}

/** rotationDeg [rx, ry, rz]: rotate about the parent X axis, then Y, then Z (fixed parent axes). */
export function eulerDegToQuat(e: readonly [number, number, number] | undefined): Quat {
  if (!e) return quat.identity();
  const qx = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, e[0] * DEG);
  const qy = quat.fromAxisAngle({ x: 0, y: 1, z: 0 }, e[1] * DEG);
  const qz = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, e[2] * DEG);
  return quat.normalize(quat.mul(qz, quat.mul(qy, qx)));
}

/** Remove floating-point dust so stack parts with identity rotation stay exactly axis-aligned. */
function snapQuat(q: Quat): Quat {
  const s = (x: number): number => (Math.abs(x) < 1e-12 ? 0 : x);
  const out = { x: s(q.x), y: s(q.y), z: s(q.z), w: s(q.w) };
  if (out.x === 0 && out.y === 0 && out.z === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return quat.normalize(out);
}

function findNode(def: PartDef, id: string): PartDef['attachNodes'][number] | undefined {
  return def.attachNodes.find((n) => n.id === id);
}

/** Pose of a child part in the parent's part frame. */
function childPoseInParent(vehicleId: string, pl: VehiclePartPlacement, def: PartDef, parentDef: PartDef): { pos: Vec3; rot: Quat } {
  const twist = eulerDegToQuat(pl.rotationDeg);
  if (pl.position) return { pos: v3.fromTuple(pl.position), rot: snapQuat(twist) };
  if (pl.parentNode === undefined || pl.node === undefined) {
    throw new VesselAssemblyError(vehicleId, `part "${pl.id}" needs either node + parentNode or an explicit position`);
  }
  const pn = findNode(parentDef, pl.parentNode);
  const cn = findNode(def, pl.node);
  if (!pn) throw new VesselAssemblyError(vehicleId, `part "${pl.id}": parent def "${parentDef.id}" has no attach node "${pl.parentNode}"`);
  if (!cn) throw new VesselAssemblyError(vehicleId, `part "${pl.id}": def "${def.id}" has no attach node "${pl.node}"`);
  // The mated nodes face each other: the child's node direction is turned onto the opposite of the parent's.
  const align = quat.fromTo(v3.normalize(v3.fromTuple(cn.dir)), v3.neg(v3.normalize(v3.fromTuple(pn.dir))));
  const rot = snapQuat(quat.mul(twist, align));
  const pos = v3.sub(v3.fromTuple(pn.pos), quat.rotate(rot, v3.fromTuple(cn.pos)));
  return { pos, rot };
}

export function emptyVessel(id: string, name: string, vehicle: VehicleDef): Vessel {
  return {
    id,
    name,
    vehicleId: vehicle.id,
    vehicle,
    parts: [],
    r: v3.zero(),
    v: v3.zero(),
    q: quat.identity(),
    w: v3.zero(),
    age: 0,
    stepCount: 0,
    nextStage: 0,
    stageLockout: 0,
    pending: [],
    sinceStaging: Infinity,
    sas: {
      enabled: false,
      mode: 'stability',
      holdDir: null,
      target: quat.identity(),
      hasTarget: false,
      inputActive: [false, false, false],
      releaseTimer: [-1, -1, -1],
      hold: [1, 1, 1],
      externalTorque: [0, 0, 0],
    },
    rcsEnabled: false,
    fineControl: false,
    lightsOn: false,
    throttle: 0,
    appliedControls: { ...NEUTRAL_CONTROLS, translate: v3.zero() },
    hold: null,
    anchor: null,
    surface: 'none',
    mp: { mass: 0, com: v3.zero(), i: [1, 1, 1, 0, 0, 0], inv: [1, 1, 1, 0, 0, 0] },
    aero: {
      q: 0,
      mach: 0,
      aoa: 0,
      density: 0,
      pressure: 0,
      temperature: 4,
      airVelocity: v3.zero(),
      heatFlux: 0,
      plasmaIntensity: 0,
      liftDirVes: null,
      force: v3.zero(),
      torque: v3.zero(),
    },
    thrust: 0,
    authority: [0, 0, 0],
    gLoad: 0,
    properAccel: v3.zero(),
    gDose: 0,
    crewAlive: true,
    contact: { anyContact: false, maxForce: 0, waterSubmersion: 0 },
    groundClearance: Infinity,
    restTimer: 0,
    splashTimer: 0,
    airborneTime: Infinity,
    inWater: false,
    destroyed: false,
    struct: null,
  };
}

export function createPart(instanceId: string, def: PartDef, stageGroup: string): PartRuntime {
  return {
    instanceId,
    def,
    parent: -1,
    stageGroup,
    pos: v3.zero(),
    rot: quat.identity(),
    resources: (def.resources ?? []).map((r) => r.capacity),
    modules: def.modules.map(createModuleState),
    rt: def.modules.map(createModuleRt),
    temps: def.thermal.surfaces.map(() => INITIAL_PART_TEMP),
    shielded: false,
    panel: null,
    stress: 0,
  };
}

/** The complete vehicle as it stands on the pad (no stage fired). */
export function buildVehicle(defs: DefLibrary, vehicleId: string): Vessel {
  const vehicle = defs.vehicles[vehicleId];
  if (!vehicle) throw new VesselAssemblyError(vehicleId, 'unknown vehicle');
  const roots = vehicle.parts.filter((p) => p.parent === null);
  if (roots.length !== 1) throw new VesselAssemblyError(vehicleId, `expected exactly one root part (parent null), found ${roots.length}`);
  const groups = new Set(vehicle.stageGroups.map((g) => g.id));
  const vessel = emptyVessel(vehicle.id, vehicle.name, vehicle);

  // Order parts so that parents precede children, keeping the file order otherwise.
  const index = new Map<string, number>();
  const placed: VehiclePartPlacement[] = [];
  const remaining = vehicle.parts.slice();
  while (remaining.length > 0) {
    const before = remaining.length;
    for (let i = 0; i < remaining.length; ) {
      const pl = remaining[i]!;
      if (pl.parent === null || index.has(pl.parent)) {
        index.set(pl.id, placed.length);
        placed.push(pl);
        remaining.splice(i, 1);
      } else i++;
    }
    if (remaining.length === before) throw new VesselAssemblyError(vehicleId, `parts not connected to the root: ${remaining.map((p) => p.id).join(', ')}`);
  }

  for (const pl of placed) {
    const def = defs.parts[pl.def];
    if (!def) throw new VesselAssemblyError(vehicleId, `part "${pl.id}" uses unknown def "${pl.def}"`);
    if (!groups.has(pl.stageGroup)) throw new VesselAssemblyError(vehicleId, `part "${pl.id}" uses unknown stage group "${pl.stageGroup}"`);
    const part = createPart(pl.id, def, pl.stageGroup);
    if (pl.resources) {
      for (const [res, kg] of Object.entries(pl.resources)) {
        const k = (def.resources ?? []).findIndex((r) => r.resource === res);
        if (k < 0) throw new VesselAssemblyError(vehicleId, `part "${pl.id}" has no tank for "${res}"`);
        part.resources[k] = kg;
      }
    }
    if (pl.parent !== null) {
      const pi = index.get(pl.parent)!;
      const parent = vessel.parts[pi]!;
      const local = childPoseInParent(vehicleId, pl, def, parent.def);
      part.parent = pi;
      part.rot = snapQuat(quat.mul(parent.rot, local.rot));
      part.pos = v3.add(parent.pos, quat.rotate(parent.rot, local.pos));
    }
    // Crew: every crew entry whose seat exists on this command part.
    for (let m = 0; m < def.modules.length; m++) {
      const md = def.modules[m]!;
      const ms = part.modules[m]!;
      if (md.type === 'command' && ms.type === 'command') {
        ms.crew = vehicle.crew.filter((c) => md.seats.some((s) => s.id === c.seat)).length;
      }
      if (md.type === 'heatShield' && ms.type === 'heatShield') {
        const k = (def.resources ?? []).findIndex((r) => r.resource === md.ablatorResource);
        const cap = k >= 0 ? def.resources![k]!.capacity : 0;
        ms.ablatorFraction = cap > 0 ? part.resources[k]! / cap : 0;
      }
    }
    vessel.parts.push(part);
  }
  if (vessel.parts.some((p) => p.modules.some((m) => m.type === 'launchClamp'))) {
    vessel.hold = 'clamps';
    vessel.surface = 'prelaunch';
  }
  return vessel;
}

/** Deep copy of the dynamic state (definitions are shared). The structure cache is rebuilt on demand. */
export function cloneVessel(src: Vessel): Vessel {
  const out: Vessel = {
    ...src,
    parts: src.parts.map((p) => ({
      ...p,
      pos: v3.clone(p.pos),
      rot: quat.clone(p.rot),
      resources: p.resources.slice(),
      modules: p.modules.map(cloneModuleState),
      rt: p.rt.map((r) => ({ ...r })),
      temps: p.temps.slice(),
      panel: p.panel ? { ...p.panel } : null,
    })),
    r: v3.clone(src.r),
    v: v3.clone(src.v),
    q: quat.clone(src.q),
    w: v3.clone(src.w),
    pending: src.pending.map((p) => ({ ...p })),
    sas: {
      ...src.sas,
      holdDir: src.sas.holdDir ? v3.clone(src.sas.holdDir) : null,
      target: quat.clone(src.sas.target),
      inputActive: [...src.sas.inputActive],
      releaseTimer: [...src.sas.releaseTimer],
      hold: [...src.sas.hold],
      externalTorque: [...src.sas.externalTorque],
    },
    appliedControls: { ...src.appliedControls, translate: v3.clone(src.appliedControls.translate) },
    anchor: src.anchor ? { rFixed: v3.clone(src.anchor.rFixed), qFixed: quat.clone(src.anchor.qFixed) } : null,
    mp: { mass: src.mp.mass, com: v3.clone(src.mp.com), i: [...src.mp.i], inv: [...src.mp.inv] },
    aero: {
      ...src.aero,
      airVelocity: v3.clone(src.aero.airVelocity),
      liftDirVes: src.aero.liftDirVes ? v3.clone(src.aero.liftDirVes) : null,
      force: v3.clone(src.aero.force),
      torque: v3.clone(src.aero.torque),
    },
    authority: [...src.authority],
    properAccel: v3.clone(src.properAccel),
    contact: { ...src.contact },
    struct: null,
  };
  return out;
}

export function cloneModuleState(m: ModuleState): ModuleState {
  switch (m.type) {
    case 'engine':
      return { ...m, gimbal: [m.gimbal[0], m.gimbal[1]] };
    case 'rcs':
      return { ...m, levels: m.levels.slice() };
    case 'reactionWheel':
      return { ...m, torque: v3.clone(m.torque) };
    case 'legs':
      return { ...m, compression: m.compression.slice(), broken: m.broken.slice(), contact: m.contact.slice() };
    case 'parachute':
      return { ...m, lineDir: v3.clone(m.lineDir) };
    default:
      return { ...m };
  }
}
