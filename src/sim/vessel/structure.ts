/**
 * Derived, cached description of a vessel's structure: everything that only changes when parts are added
 * or removed (staging, failures) - actuator lists with VES-frame geometry, propellant flow groups, exposed
 * aerodynamic elements, contact probes, buoyancy spheres, thermal surfaces.
 */
import type { ContactPointDef, MachTable, PartDef } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import type {
  CommandDef,
  EngineDef,
  EngineState,
  HeatShieldDef,
  HeatShieldState,
  LegsDef,
  LegsState,
  ModuleRt,
  ParachuteDef,
  ParachuteState,
  PartRuntime,
  RcsDef,
  RcsState,
  Vessel,
} from './types';

export interface TankRef {
  part: number;
  res: number;
}

export interface EngineRef {
  part: number;
  mod: number;
  def: EngineDef;
  state: EngineState;
  rt: Extract<ModuleRt, { type: 'engine' }>;
  /** Nozzle positions and exhaust directions in VES, 3 numbers per nozzle. */
  nozzlePos: number[];
  nozzleDir: number[];
  /** Part X and Z axes in VES (gimbal axes). */
  axisX: Vec3;
  axisZ: Vec3;
  /** Tanks feeding each propellant (same stage group), parallel to def.propellants. */
  tanks: TankRef[][];
  mdotMax: number;
  gimbalRange: number;
  gimbalRate: number;
  /** Allocation weights of the two gimbal axes for the three VES torque axes (set each step). */
  wX: [number, number, number];
  wZ: [number, number, number];
}

export interface RcsRef {
  part: number;
  mod: number;
  def: RcsDef;
  state: RcsState;
  rt: Extract<ModuleRt, { type: 'rcs' }>;
  /** Thruster positions and unit FORCE directions (opposite to the exhaust) in VES, 3 numbers each. */
  pos: number[];
  force: number[];
  tanks: TankRef[];
  /** Torque per unit level about the CoM, 3 numbers per thruster (set each step). */
  arm: number[];
}

export interface ChuteRef {
  part: number;
  mod: number;
  def: ParachuteDef;
  state: ParachuteState;
  rt: Extract<ModuleRt, { type: 'parachute' }>;
  attach: Vec3;
}

export interface Probe {
  part: number;
  /** Position in VES (leg feet: updated every step). */
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Explicit stiffness / damping / friction, or NaN = vessel-scaled default. */
  k: number;
  c: number;
  mu: number;
  crash: number;
  crashWater: number;
  /** Leg foot: owning legs entry and leg index (null for structural probes). */
  legs: LegsRef | null;
  leg: number;
  inContact: boolean;
  wet: boolean;
  near: boolean;
  hasAnchor: boolean;
  /** Friction anchor in the body-fixed frame. */
  ax: number;
  ay: number;
  az: number;
  /** Cached terrain normal (BCI) for the current step and whether it is valid. */
  nx: number;
  ny: number;
  nz: number;
  hasNormal: boolean;
}

export interface LegsRef {
  part: number;
  mod: number;
  def: LegsDef;
  state: LegsState;
  rt: Extract<ModuleRt, { type: 'legs' }>;
  probes: Probe[];
  /** Per leg: unit strut axis (foot -> hinge) in VES for the deployed geometry. */
  strut: Vec3[];
}

export const AERO_AXISYM = 0;
export const AERO_CAPSULE = 1;
export const AERO_PLATE = 2;

export interface AeroElem {
  kind: number;
  part: number;
  /** Axis (+Y of the part, nose/apex direction) or plate normal, VES unit vector. */
  ax: number;
  ay: number;
  az: number;
  /** Centre of pressure for cross-flow / capsule reference point / plate position, VES. */
  px: number;
  py: number;
  pz: number;
  /** Axisym: forward and aft face centres, VES. */
  fx: number;
  fy: number;
  fz: number;
  bx: number;
  by: number;
  bz: number;
  area: number;
  /** Axisym: length * diameter and cross-flow coefficient. */
  ld: number;
  cdCross: number;
  /** Exposed fraction of the forward / aft face. */
  expF: number;
  expA: number;
  tabF: MachTable | null;
  tabA: MachTable | null;
  /** Coefficients at the current Mach number (refreshed once per step). */
  cdF: number;
  cdA: number;
  diameter: number;
  cn: number;
  cmAlpha: number;
  cmq: number;
}

export interface ThermalSurf {
  /** Index into PartRuntime.temps. */
  index: number;
  axisym: boolean;
  /** VES normal (flat) or part axis (axisym). */
  nx: number;
  ny: number;
  nz: number;
  area: number;
  noseRadius: number;
  emissivity: number;
  heatCap: number;
  maxTemp: number;
}

export interface ThermalRef {
  part: number;
  /** Centre and radius of the part envelope in VES (wake shadowing). */
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  surfaces: ThermalSurf[];
  /** Wake factor from upstream parts (1 = exposed, 0.03 = shadowed); refreshed periodically. */
  wake: number;
  shield: { def: HeatShieldDef; state: HeatShieldState; res: number } | null;
  /** True when the part has a flat surface (a blunt face) in addition to an axisymmetric skin. */
  hasFlat: boolean;
}

export interface BuoyRef {
  part: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  volume: number;
  wet: boolean;
  /** Water surface height above the reference radius under this sphere for the current step, m. */
  waterHeight: number;
}

export interface Structure {
  engines: EngineRef[];
  rcs: RcsRef[];
  chutes: ChuteRef[];
  legs: LegsRef[];
  /** Summed |torque| of all reaction wheels per VES axis, N m. */
  wheel: [number, number, number];
  wheelParts: { part: number; mod: number }[];
  aero: AeroElem[];
  thermal: ThermalRef[];
  probes: Probe[];
  buoy: BuoyRef[];
  buoyVolume: number;
  /** Open water under the vessel in the current step, and its surface height above the reference radius. */
  waterHere: boolean;
  waterHeight: number;
  boundingRadius: number;
  /** Lowest y of any probe or bound in VES (where the vessel rests). */
  baseY: number;
  sasAvailable: boolean;
  /** Maximum commanded rate, rad/s. */
  maxRate: number;
  crew: number;
  /** Occupied seat positions in VES, 3 numbers per seat (the g-load is felt there). */
  seats: number[];
  /** Set by the contact broad phase when the whole vessel is below the terrain surface. */
  buried: boolean;
  minJointG: number;
  anyQAlpha: boolean;
  /** Tumbling-average drag area for the reduced tier, m^2; lumped thermal properties. */
  cdAAverage: number;
  lumpHeatCap: number;
  lumpMaxTemp: number;
  lumpEmissivity: number;
}

const Y_AXIS: Vec3 = { x: 0, y: 1, z: 0 };

export function partPoint(p: PartRuntime, t: readonly [number, number, number]): Vec3 {
  const r = quat.rotate(p.rot, { x: t[0], y: t[1], z: t[2] });
  return { x: r.x + p.pos.x, y: r.y + p.pos.y, z: r.z + p.pos.z };
}

export function partDir(p: PartRuntime, t: readonly [number, number, number]): Vec3 {
  return quat.rotate(p.rot, { x: t[0], y: t[1], z: t[2] });
}

/** Azimuth (rad) of the centre of fairing panel `index` of `count`, measured about +Y from +Z toward +X. */
export function panelAzimuth(index: number, count: number): number {
  return ((index + 0.5) * 2 * Math.PI) / count;
}

/** Radial unit vector of a panel centre in the part frame. */
export function panelRadial(index: number, count: number): Vec3 {
  const az = panelAzimuth(index, count);
  return { x: Math.sin(az), y: 0, z: Math.cos(az) };
}

/** Centroid of a panel (thin cylindrical sector) in the part frame. */
export function panelCentroid(def: PartDef, index: number, count: number): Vec3 {
  const half = Math.PI / count;
  const rc = (def.bounds.radius * Math.sin(half)) / half;
  const rad = panelRadial(index, count);
  return { x: rad.x * rc, y: (def.bounds.yMin + def.bounds.yMax) / 2, z: rad.z * rc };
}

/** Crash tolerance of probes the engine synthesises (bounds-derived probes, leg hinges, fairing panels), m/s. */
const STRUCTURAL_CRASH_TOLERANCE = 6;
const DEFAULT_PROBE_RADIUS = 0.05;
const LEG_HINGE_PROBE_RADIUS = 0.15;

/** An end face counts as covered by the authored probes when one lies within this fraction of the part's length (at least 0.5 m) of it. */
const END_COVER_FRACTION = 0.25;
const END_COVER_MIN = 0.5;

/**
 * Contact points of a part: the authored ones, completed with probes derived from the bounds cylinder
 * (a ring of eight plus the axis point, inset so that the probe spheres touch the bounds from inside) on
 * every end face that the authored set leaves uncovered - both faces for a definition that lists none,
 * the mount face of an engine whose points describe the bell only. Every part therefore collides with
 * the ground in any attitude when it flies on its own after a break-up.
 */
function contactPointsOf(def: PartDef): ContactPointDef[] {
  const authored = def.contactPoints ?? [];
  const out = authored.slice();
  const b = def.bounds;
  const reach = Math.max(END_COVER_FRACTION * (b.yMax - b.yMin), END_COVER_MIN);
  const rad = Math.min(DEFAULT_PROBE_RADIUS, b.radius / 2, (b.yMax - b.yMin) / 2);
  const ring = b.radius - rad;
  for (const end of [b.yMin, b.yMax]) {
    if (authored.some((c) => Math.abs(c.pos[1] - end) <= reach)) continue;
    const y = end === b.yMin ? end + rad : end - rad;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      out.push({ pos: [ring * Math.sin(a), y, ring * Math.cos(a)], radius: rad, crashTolerance: STRUCTURAL_CRASH_TOLERANCE });
    }
    out.push({ pos: [0, y, 0], radius: rad, crashTolerance: STRUCTURAL_CRASH_TOLERANCE });
  }
  return out;
}

function isShieldedBy(parts: PartRuntime[], target: PartRuntime): boolean {
  for (const p of parts) {
    if (p === target || p.panel) continue;
    for (let m = 0; m < p.def.modules.length; m++) {
      const md = p.def.modules[m]!;
      const ms = p.modules[m]!;
      if (md.type === 'fairing' && ms.type === 'fairing' && !ms.jettisoned) {
        if (md.shields.includes(target.instanceId) || md.shields.includes(target.def.id)) return true;
      }
    }
  }
  return false;
}

function tanksFor(parts: PartRuntime[], group: string, resource: string): TankRef[] {
  const out: TankRef[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.stageGroup !== group || !p.def.resources) continue;
    for (let r = 0; r < p.def.resources.length; r++) {
      if (p.def.resources[r]!.resource === resource) out.push({ part: i, res: r });
    }
  }
  return out;
}

/** Largest (rQ / rP)^2 of the unshielded parts lying ahead (sign +1) or behind (-1) of part `i` along its axis. */
function coverFraction(parts: PartRuntime[], i: number, sign: number): number {
  const p = parts[i]!;
  const axis = quat.rotate(p.rot, Y_AXIS);
  const b = p.def.bounds;
  const centre = partPoint(p, [0, (b.yMin + b.yMax) / 2, 0]);
  const half = (b.yMax - b.yMin) / 2;
  let best = 0;
  for (let j = 0; j < parts.length; j++) {
    if (j === i) continue;
    const o = parts[j]!;
    if (o.shielded || o.panel) continue;
    const ob = o.def.bounds;
    const oc = partPoint(o, [0, (ob.yMin + ob.yMax) / 2, 0]);
    const d = v3.sub(oc, centre);
    const along = v3.dot(d, axis) * sign;
    // The other part must extend beyond this part's end face on that side.
    if (along + (ob.yMax - ob.yMin) / 2 <= half + 1e-6 || along <= 0) continue;
    const lateral = v3.len(v3.addScaled(d, axis, -v3.dot(d, axis)));
    if (lateral > 0.5 * b.radius) continue;
    const f = Math.min(1, (ob.radius * ob.radius) / (b.radius * b.radius));
    if (f > best) best = f;
  }
  return best;
}

function newProbe(part: number, pos: Vec3, radius: number, k: number, c: number, mu: number, crash: number, crashWater: number): Probe {
  return {
    part,
    x: pos.x,
    y: pos.y,
    z: pos.z,
    radius,
    k,
    c,
    mu,
    crash,
    crashWater,
    legs: null,
    leg: -1,
    inContact: false,
    wet: false,
    near: false,
    hasAnchor: false,
    ax: 0,
    ay: 0,
    az: 0,
    nx: 0,
    ny: 0,
    nz: 0,
    hasNormal: false,
  };
}

export function rebuildStructure(vessel: Vessel): Structure {
  const parts = vessel.parts;
  const n = parts.length;
  for (const p of parts) p.shielded = isShieldedBy(parts, p);

  const s: Structure = {
    engines: [],
    rcs: [],
    chutes: [],
    legs: [],
    wheel: [0, 0, 0],
    wheelParts: [],
    aero: [],
    thermal: [],
    probes: [],
    buoy: [],
    buoyVolume: 0,
    waterHere: false,
    waterHeight: -Infinity,
    boundingRadius: 0,
    baseY: Infinity,
    sasAvailable: false,
    maxRate: 10 * DEG,
    crew: 0,
    seats: [],
    buried: false,
    minJointG: Infinity,
    anyQAlpha: false,
    cdAAverage: 0,
    lumpHeatCap: Infinity,
    lumpMaxTemp: Infinity,
    lumpEmissivity: 0.8,
  };
  let maxRate = 0;

  for (let i = 0; i < n; i++) {
    const p = parts[i]!;
    const def = p.def;
    const b = def.bounds;
    const axis = quat.rotate(p.rot, Y_AXIS);
    const centre = partPoint(p, [0, (b.yMin + b.yMax) / 2, 0]);
    const halfH = (b.yMax - b.yMin) / 2;
    s.boundingRadius = Math.max(s.boundingRadius, v3.len(centre) + Math.hypot(b.radius, halfH));
    if (p.parent >= 0) {
      if (def.joint.maxAccelG < s.minJointG) s.minJointG = def.joint.maxAccelG;
      if (def.joint.maxQAlpha !== undefined) s.anyQAlpha = true;
    }
    let hasLegs = false;
    let isClamp = false;

    for (let m = 0; m < def.modules.length; m++) {
      const md = def.modules[m]!;
      const ms = p.modules[m]!;
      const rt = p.rt[m]!;
      if (md.type === 'engine' && ms.type === 'engine' && rt.type === 'engine') {
        const nozzlePos: number[] = [];
        const nozzleDir: number[] = [];
        for (const nz of md.nozzles) {
          const pp = partPoint(p, nz.pos);
          const dd = v3.normalize(partDir(p, nz.dir));
          nozzlePos.push(pp.x, pp.y, pp.z);
          nozzleDir.push(dd.x, dd.y, dd.z);
        }
        s.engines.push({
          part: i,
          mod: m,
          def: md,
          state: ms,
          rt,
          nozzlePos,
          nozzleDir,
          axisX: quat.rotate(p.rot, { x: 1, y: 0, z: 0 }),
          axisZ: quat.rotate(p.rot, { x: 0, y: 0, z: 1 }),
          tanks: md.propellants.map((pr) => tanksFor(parts, p.stageGroup, pr.resource)),
          mdotMax: md.thrustVac / (md.ispVac * 9.80665),
          gimbalRange: md.gimbal ? md.gimbal.rangeDeg * DEG : 0,
          gimbalRate: md.gimbal ? md.gimbal.rateDegPerS * DEG : 0,
          wX: [0, 0, 0],
          wZ: [0, 0, 0],
        });
      } else if (md.type === 'rcs' && ms.type === 'rcs' && rt.type === 'rcs') {
        const pos: number[] = [];
        const force: number[] = [];
        for (const t of md.thrusters) {
          const pp = partPoint(p, t.pos);
          const dd = v3.normalize(partDir(p, t.dir));
          pos.push(pp.x, pp.y, pp.z);
          force.push(-dd.x, -dd.y, -dd.z);
        }
        s.rcs.push({ part: i, mod: m, def: md, state: ms, rt, pos, force, tanks: tanksFor(parts, p.stageGroup, md.resource), arm: new Array<number>(pos.length).fill(0) });
      } else if (md.type === 'reactionWheel') {
        const t = partDir(p, md.torque);
        s.wheel[0] += Math.abs(t.x);
        s.wheel[1] += Math.abs(t.y);
        s.wheel[2] += Math.abs(t.z);
        s.wheelParts.push({ part: i, mod: m });
      } else if (md.type === 'parachute' && ms.type === 'parachute' && rt.type === 'parachute') {
        s.chutes.push({ part: i, mod: m, def: md, state: ms, rt, attach: partPoint(p, md.attach) });
      } else if (md.type === 'legs' && ms.type === 'legs' && rt.type === 'legs') {
        hasLegs = true;
        const ref: LegsRef = { part: i, mod: m, def: md, state: ms, rt, probes: [], strut: [] };
        for (let l = 0; l < md.legs.length; l++) {
          const leg = md.legs[l]!;
          const pad = def.contactPoints?.[l];
          const foot = partPoint(p, leg.footDeployed);
          const hinge = partPoint(p, leg.hinge);
          ref.strut.push(v3.normalize(v3.sub(hinge, foot)));
          const pr = newProbe(i, foot, pad?.radius ?? 0.3, leg.k, leg.c, pad?.mu ?? 0.9, pad?.crashTolerance ?? 4, pad?.crashToleranceWater ?? pad?.crashTolerance ?? 4);
          pr.legs = ref;
          pr.leg = l;
          ref.probes.push(pr);
          // The hinge fitting is a structural probe that is always active, so a gear assembly with stowed or
          // collapsed legs (or one flying alone after a break-up) still meets the ground.
          s.probes.push(newProbe(i, hinge, LEG_HINGE_PROBE_RADIUS, NaN, NaN, NaN, STRUCTURAL_CRASH_TOLERANCE, STRUCTURAL_CRASH_TOLERANCE));
          s.baseY = Math.min(s.baseY, hinge.y - LEG_HINGE_PROBE_RADIUS);
        }
        s.legs.push(ref);
      } else if (md.type === 'command' && ms.type === 'command') {
        const cmd: CommandDef = md;
        if (cmd.sas) s.sasAvailable = true;
        maxRate = Math.max(maxRate, cmd.maxRateDegPerS * DEG);
        if (ms.crewAlive) {
          s.crew += ms.crew;
          for (let k = 0; k < ms.crew && k < cmd.seats.length; k++) {
            const seat = partPoint(p, cmd.seats[k]!.pos);
            s.seats.push(seat.x, seat.y, seat.z);
          }
        }
      } else if (md.type === 'antenna' && ms.type === 'antenna') {
        // Antennas unfold once their part is out in the open (not inside a closed fairing or on the pad).
        ms.deployed = !p.shielded && vessel.hold !== 'clamps';
      } else if (md.type === 'launchClamp') {
        isClamp = true;
      }
    }

    // Contact probes (leg parts use their contactPoints as foot-pad descriptors and their hinges as structure).
    if (!hasLegs) {
      const pts = p.panel ? [] : contactPointsOf(def);
      for (const c of pts) {
        const pos = partPoint(p, c.pos);
        s.probes.push(
          newProbe(
            i,
            pos,
            c.radius,
            c.k ?? NaN,
            c.c ?? NaN,
            c.mu ?? NaN,
            c.crashTolerance,
            c.crashToleranceWater ?? c.crashTolerance,
          ),
        );
        if (!isClamp) s.baseY = Math.min(s.baseY, pos.y - c.radius);
      }
      if (p.panel) {
        const c = panelCentroid(def, p.panel.index, p.panel.count);
        s.probes.push(newProbe(i, partPoint(p, [c.x, c.y, c.z]), 0.3, NaN, NaN, NaN, 6, 6));
      }
    }
    if (isClamp) s.baseY = Math.min(s.baseY, partPoint(p, [0, b.yMin, 0]).y);

    for (const bs of p.panel ? [] : (def.buoyancy ?? [])) {
      const pos = partPoint(p, bs.pos);
      const volume = (4 / 3) * Math.PI * bs.radius ** 3;
      s.buoy.push({ part: i, x: pos.x, y: pos.y, z: pos.z, radius: bs.radius, volume, wet: false, waterHeight: -Infinity });
      s.buoyVolume += volume;
    }

    // Thermal surfaces.
    const surfaces: ThermalSurf[] = [];
    let hasFlat = false;
    for (let k = 0; k < def.thermal.surfaces.length; k++) {
      const sd = def.thermal.surfaces[k]!;
      const axisym = sd.normal === 'axisym';
      let nrm = axis;
      if (sd.normal !== 'axisym') {
        nrm = v3.normalize(partDir(p, sd.normal));
        hasFlat = true;
      }
      if (p.panel) nrm = partDir(p, v3.toTuple(panelRadial(p.panel.index, p.panel.count)));
      surfaces.push({
        index: k,
        axisym: axisym && !p.panel,
        nx: nrm.x,
        ny: nrm.y,
        nz: nrm.z,
        area: p.panel ? sd.area / p.panel.count : sd.area,
        noseRadius: sd.noseRadius,
        emissivity: sd.emissivity,
        heatCap: sd.arealHeatCapacity,
        maxTemp: sd.maxTemp,
      });
      if (sd.arealHeatCapacity < s.lumpHeatCap) s.lumpHeatCap = sd.arealHeatCapacity;
      if (sd.maxTemp < s.lumpMaxTemp) {
        s.lumpMaxTemp = sd.maxTemp;
        s.lumpEmissivity = sd.emissivity;
      }
    }
    let shield: ThermalRef['shield'] = null;
    for (let m = 0; m < def.modules.length; m++) {
      const md = def.modules[m]!;
      const ms = p.modules[m]!;
      if (md.type === 'heatShield' && ms.type === 'heatShield') {
        const res = (def.resources ?? []).findIndex((r) => r.resource === md.ablatorResource);
        shield = { def: md, state: ms, res };
      }
    }
    s.thermal.push({ part: i, cx: centre.x, cy: centre.y, cz: centre.z, radius: b.radius, surfaces, wake: 1, shield, hasFlat });
  }
  if (maxRate > 0) s.maxRate = maxRate;
  if (!Number.isFinite(s.baseY)) {
    for (const p of parts) s.baseY = Math.min(s.baseY, partPoint(p, [0, p.def.bounds.yMin, 0]).y);
  }

  // Aerodynamic elements with stack shadowing.
  for (let i = 0; i < n; i++) {
    const p = parts[i]!;
    if (p.shielded) continue;
    const def = p.def;
    const b = def.bounds;
    const axis = quat.rotate(p.rot, Y_AXIS);
    if (p.panel) {
      const half = Math.PI / p.panel.count;
      const nrm = partDir(p, v3.toTuple(panelRadial(p.panel.index, p.panel.count)));
      const c = panelCentroid(def, p.panel.index, p.panel.count);
      const pos = partPoint(p, [c.x, c.y, c.z]);
      const area = 2 * b.radius * Math.sin(half) * (b.yMax - b.yMin);
      s.aero.push(plate(i, nrm, pos, area));
      s.cdAAverage += (area * 1.28) / 2;
      continue;
    }
    // A blunt capsule flies on its capsule model while its shield face is uncovered (free flight); mated to
    // a stack below it, it is an ordinary axisymmetric nose and uses its axisymBody element instead.
    const capsuleFree = (def.aero ?? []).some((e) => e.kind === 'bluntCapsule') && coverFraction(parts, i, -1) <= 0.25;
    for (const e of def.aero ?? []) {
      if (e.kind === 'axisymBody') {
        if (capsuleFree) continue;
        const cp = partPoint(p, [0, b.yMin + e.cpFraction * e.length, 0]);
        const f = partPoint(p, [0, b.yMax, 0]);
        const a = partPoint(p, [0, b.yMin, 0]);
        s.aero.push({
          kind: AERO_AXISYM,
          part: i,
          ax: axis.x,
          ay: axis.y,
          az: axis.z,
          px: cp.x,
          py: cp.y,
          pz: cp.z,
          fx: f.x,
          fy: f.y,
          fz: f.z,
          bx: a.x,
          by: a.y,
          bz: a.z,
          area: e.refArea,
          ld: e.length * e.diameter,
          cdCross: e.cdCross,
          expF: 1 - coverFraction(parts, i, 1),
          expA: 1 - coverFraction(parts, i, -1),
          tabF: e.cdAxialFwd,
          tabA: e.cdAxialAft,
          cdF: 0,
          cdA: 0,
          diameter: e.diameter,
          cn: 0,
          cmAlpha: 0,
          cmq: 0,
        });
        s.cdAAverage += (e.refArea * 1.0 + 2 * e.length * e.diameter * e.cdCross) / 3;
      } else if (e.kind === 'bluntCapsule') {
        if (!capsuleFree) continue;
        const ref = partPoint(p, e.refPoint);
        s.aero.push({
          kind: AERO_CAPSULE,
          part: i,
          ax: axis.x,
          ay: axis.y,
          az: axis.z,
          px: ref.x,
          py: ref.y,
          pz: ref.z,
          fx: 0,
          fy: 0,
          fz: 0,
          bx: 0,
          by: 0,
          bz: 0,
          area: e.refArea,
          ld: 0,
          cdCross: 0,
          expF: 1,
          expA: 1,
          tabF: e.cdTable,
          tabA: null,
          cdF: 0,
          cdA: 0,
          diameter: e.diameter,
          cn: e.cn,
          cmAlpha: e.cmAlpha,
          cmq: e.cmq,
        });
        s.cdAAverage += e.refArea * 0.9;
      } else {
        s.aero.push(plate(i, v3.normalize(partDir(p, e.normal)), partPoint(p, e.pos), e.area));
        s.cdAAverage += (e.area * 1.28) / 2;
      }
    }
  }
  if (s.cdAAverage === 0) s.cdAAverage = Math.PI * s.boundingRadius * s.boundingRadius * 0.3;
  if (!Number.isFinite(s.lumpHeatCap)) s.lumpHeatCap = 6000;
  if (!Number.isFinite(s.lumpMaxTemp)) s.lumpMaxTemp = 800;
  vessel.struct = s;
  return s;
}

function plate(part: number, n: Vec3, pos: Vec3, area: number): AeroElem {
  return {
    kind: AERO_PLATE,
    part,
    ax: n.x,
    ay: n.y,
    az: n.z,
    px: pos.x,
    py: pos.y,
    pz: pos.z,
    fx: 0,
    fy: 0,
    fz: 0,
    bx: 0,
    by: 0,
    bz: 0,
    area,
    ld: 0,
    cdCross: 0,
    expF: 1,
    expA: 1,
    tabF: null,
    tabA: null,
    cdF: 0,
    cdA: 0,
    diameter: 0,
    cn: 0,
    cmAlpha: 0,
    cmq: 0,
  };
}

export function structureOf(vessel: Vessel): Structure {
  return (vessel.struct as Structure | null) ?? rebuildStructure(vessel);
}

/**
 * Lowest point of the vessel along its own Y axis, in VES (m): the base of the launch clamps while they
 * hold it, otherwise the lowest contact probe (deployed leg pads included). The orchestrator stands a
 * vessel on a surface by putting this point on the ground.
 */
export function vesselBaseY(vessel: Vessel): number {
  const st = structureOf(vessel);
  let base = st.baseY;
  for (const lg of st.legs) {
    if (lg.state.deploy < 0.999) continue;
    for (let l = 0; l < lg.probes.length; l++) if (!lg.state.broken[l]) base = Math.min(base, lg.probes[l]!.y - lg.probes[l]!.radius);
  }
  return base;
}

/** Pose of leg foot `l` in the part frame for a deployment fraction (smooth-stepped swing from stowed to deployed). */
export function legFootLocal(def: LegsDef, l: number, deploy: number): [number, number, number] {
  const leg = def.legs[l]!;
  const t = deploy * deploy * (3 - 2 * deploy);
  return [
    leg.footStowed[0] + (leg.footDeployed[0] - leg.footStowed[0]) * t,
    leg.footStowed[1] + (leg.footDeployed[1] - leg.footStowed[1]) * t,
    leg.footStowed[2] + (leg.footDeployed[2] - leg.footStowed[2]) * t,
  ];
}
