/**
 * Lab vehicles for the audio lab and the audio unit tests: stacks of the REAL part definitions in
 * data/defs/parts (Atlas-9M, Vela-2, Vela-2V, Lyra-D, Lyra-A, the solid motors and the Kestrel capsule),
 * whose ModuleState the lab synthesises every frame with the sim's engine law (src/sim/vessel/modules/
 * engine.ts: throttleActual = minThrottle + (1 - minThrottle) lever, first-order spool lag, Isp linear in
 * ambient pressure, ignition/shutdown ages, fixed burns). The audio engine reads these parts exactly as it
 * reads the sim's: through DefLibrary.parts.
 *
 * Positions are in the VES frame of each lab stack (+Y nose); y = 0 is the nozzle-exit plane of the
 * lowest stage, so the capsule seat (the cockpit listener) sits at the top of the stack.
 */
import type { DefLibrary, ModuleDef, PartDef } from '@/core/contracts/defs';
import type { ModuleState, PartSnapshot } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { G0 } from '@/core/math/scalar';
import type { Vec3 } from '@/core/math/vec3';

type EngineModuleDef = Extract<ModuleDef, { type: 'engine' }>;

/** The real part definitions the lab stacks are built from. */
export const LAB_PARTS = {
  booster: 'atlas-9m',
  upper: 'vela-2',
  ullage: 'meridian-m2-ullage-motors',
  tli: 'vela-2v',
  descent: 'lyra-d',
  ascent: 'lyra-a',
  les: 'kestrel-les',
  capsule: 'kestrel-capsule',
} as const;

function engineModuleOf(def: PartDef | undefined): EngineModuleDef | null {
  const m = def?.modules.find((x) => x.type === 'engine');
  return m && m.type === 'engine' ? m : null;
}

/** True for solid motors and other fixed burns (they are staged, not throttled). */
export function isFixedBurn(lib: DefLibrary, def: string): boolean {
  return engineModuleOf(lib.parts[def])?.fixedBurn !== undefined;
}

export interface LabPlacement {
  instanceId: string;
  def: string;
  pos: Vec3;
}

export type LabStackId = 'booster' | 'upper' | 'tli' | 'lander' | 'ascent' | 'capsule';

/** Engine/capsule placements of each lab stack and where the commander's eye is (VES). */
export function labStack(lib: DefLibrary, id: LabStackId): { parts: LabPlacement[]; seat: Vec3; boundingRadius: number } {
  const need = (def: string): PartDef => {
    const d = lib.parts[def];
    if (!d) throw new Error(`audio lab: part definition "${def}" is missing from data/defs/parts`);
    return d;
  };
  const parts: LabPlacement[] = [];
  const add = (instanceId: string, def: string, x: number, y: number, z: number): void => {
    need(def);
    parts.push({ instanceId, def, pos: { x, y, z } });
  };
  /** Part-origin height that puts this engine's nozzle exit at `plane`. */
  const above = (def: string, plane: number): number => plane - (engineModuleOf(need(def))?.nozzles[0]?.pos[1] ?? 0);
  let capsuleY = 0;
  switch (id) {
    case 'booster':
      add('atlas-c', LAB_PARTS.booster, 0, above(LAB_PARTS.booster, 0), 0);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 2 * Math.PI;
        add(`atlas-${i + 1}`, LAB_PARTS.booster, 3.3 * Math.sin(a), above(LAB_PARTS.booster, 0), 3.3 * Math.cos(a));
      }
      capsuleY = 94;
      add('les', LAB_PARTS.les, 0, capsuleY + 3.3, 0);
      break;
    case 'upper':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 2 * Math.PI;
        add(`vela-${i + 1}`, LAB_PARTS.upper, 2.9 * Math.sin(a), above(LAB_PARTS.upper, 0), 2.9 * Math.cos(a));
      }
      add('ullage', LAB_PARTS.ullage, 0, 5.5, 0);
      capsuleY = 52;
      break;
    case 'tli':
      add('vela-2v', LAB_PARTS.tli, 0, above(LAB_PARTS.tli, 0), 0);
      capsuleY = 21;
      break;
    case 'lander':
      add('lyra-d', LAB_PARTS.descent, 0, above(LAB_PARTS.descent, 0), 0);
      capsuleY = 7.2;
      break;
    case 'ascent':
      add('lyra-a', LAB_PARTS.ascent, 0, above(LAB_PARTS.ascent, 0), 0);
      capsuleY = 3.8;
      break;
    case 'capsule':
      capsuleY = 0;
      break;
  }
  add('capsule', LAB_PARTS.capsule, 0, capsuleY, 0);
  const cmd = need(LAB_PARTS.capsule).modules.find((m) => m.type === 'command');
  const seat = cmd && cmd.type === 'command' ? cmd.seats[Math.floor(cmd.seats.length / 2)] : undefined;
  const top = capsuleY + 3.3;
  return { parts, seat: seat ? { x: seat.pos[0], y: capsuleY + seat.pos[1], z: seat.pos[2] } : { x: 0, y: capsuleY + 1, z: 0 }, boundingRadius: Math.max(5, top / 2 + 5) };
}

/** State of a non-propulsive module at rest on the pad (the lab does not simulate these). */
function restingState(md: ModuleDef): ModuleState {
  switch (md.type) {
    case 'command':
      return { type: 'command', crew: md.crewCapacity, crewAlive: true };
    case 'reactionWheel':
      return { type: 'reactionWheel', torque: { x: 0, y: 0, z: 0 } };
    case 'decoupler':
      return { type: 'decoupler', fired: false };
    case 'fairing':
      return { type: 'fairing', jettisoned: false };
    case 'launchClamp':
      return { type: 'launchClamp', released: false };
    case 'les':
      return { type: 'les', fired: false, jettisoned: false };
    case 'legs':
      return { type: 'legs', deploy: 0, compression: md.legs.map(() => 0), broken: md.legs.map(() => false), contact: md.legs.map(() => false) };
    case 'parachute':
      return { type: 'parachute', state: 'stowed', inflation: 0, deployAge: -1, envelope: 'safe', lineDir: { x: 0, y: 1, z: 0 } };
    case 'heatShield':
      return { type: 'heatShield', ablatorFraction: 1, surfaceTemp: 290 };
    case 'light':
      return { type: 'light', on: false };
    case 'antenna':
      return { type: 'antenna', deployed: false };
    case 'engine':
    case 'rcs':
      throw new Error('propulsion modules are synthesised by LabEngines');
  }
}

/**
 * Approximate VES placement of a real vehicle's parts for listening in the lab: stacked parts mate their
 * attach nodes (identity rotation), radial parts use their explicit position. The real assembly lives in
 * src/sim/vessel; this only has to put engines and the cockpit roughly where they are.
 */
export function placeVehicle(lib: DefLibrary, vehicleId: string): { parts: LabPlacement[]; seat: Vec3 } {
  const v = lib.vehicles[vehicleId];
  if (!v) throw new Error(`unknown vehicle ${vehicleId}`);
  const pos = new Map<string, Vec3>();
  const byId = new Map(v.parts.map((p) => [p.id, p]));
  const place = (id: string): Vec3 => {
    const done = pos.get(id);
    if (done) return done;
    const p = byId.get(id)!;
    let at: Vec3 = { x: 0, y: 0, z: 0 };
    if (p.parent !== null) {
      const parentPos = place(p.parent);
      const parentDef = lib.parts[byId.get(p.parent)!.def];
      const def = lib.parts[p.def];
      if (p.position) at = { x: parentPos.x + p.position[0], y: parentPos.y + p.position[1], z: parentPos.z + p.position[2] };
      else {
        const pn = parentDef?.attachNodes.find((n) => n.id === p.parentNode)?.pos ?? [0, 0, 0];
        const cn = def?.attachNodes.find((n) => n.id === p.node)?.pos ?? [0, 0, 0];
        at = { x: parentPos.x + pn[0] - cn[0], y: parentPos.y + pn[1] - cn[1], z: parentPos.z + pn[2] - cn[2] };
      }
    }
    pos.set(id, at);
    return at;
  };
  const parts = v.parts.map((p) => ({ instanceId: p.id, def: p.def, pos: place(p.id) }));
  const cockpit = v.cameras.cockpit;
  const cmd = lib.parts[byId.get(cockpit.part)?.def ?? '']?.modules.find((m) => m.type === 'command');
  const seat = cmd && cmd.type === 'command' ? cmd.seats.find((s) => s.id === cockpit.seat) : undefined;
  const base = pos.get(cockpit.part) ?? { x: 0, y: 0, z: 0 };
  return { parts, seat: seat ? { x: base.x + seat.pos[0], y: base.y + seat.pos[1], z: base.z + seat.pos[2] } : base };
}

interface EngineRuntime {
  active: boolean;
  lit: boolean;
  throttleActual: number;
  ignitionAge: number;
  shutdownAge: number;
  burnLeft: number | null;
}

/** The sim's ignition and shutdown thresholds on the spooled throttle (src/sim/vessel/modules/engine.ts). */
const IGNITION_THRESHOLD = 0.02;
const SHUTDOWN_THRESHOLD = 0.01;

/** Effective throttle for a lever position: a copy of the sim's throttleTarget (labs may not import src/sim). */
export function labThrottleTarget(m: EngineModuleDef, lever: number): number {
  if (m.fixedBurn) return 1;
  if (!m.throttleable) return lever > 0 ? 1 : 0;
  return lever <= 0 ? 0 : m.minThrottle + (1 - m.minThrottle) * Math.min(1, lever);
}

/**
 * Synthesised engine module states for a lab stack: the sim's engine law (sim-design.md 7.1,
 * src/sim/vessel/modules/engine.ts throttleTarget / updateEngines, copied because labs may not import
 * src/sim) - effective throttle minThrottle + (1 - minThrottle) lever (0 / 1 for engines that cannot
 * throttle), exact first-order spool lag, thrust = throttleActual x full thrust at the ambient pressure
 * (Isp linear in pressure), ignition when the spooled throttle first exceeds 0.02, shutdown when it falls
 * below 0.01 with the lever at 0, ignitionAge counting while lit and shutdownAge after, fixed-burn solids
 * that ignore the lever. Propellant is unlimited (no flame-out).
 */
export class LabEngines {
  private readonly rt = new Map<string, EngineRuntime>();
  rcsLevels: number[] = [];

  constructor(
    readonly stack: LabPlacement[],
    private readonly defs: Record<string, PartDef>,
  ) {
    for (const p of stack) this.rt.set(p.instanceId, { active: false, lit: false, throttleActual: 0, ignitionAge: -1, shutdownAge: -1, burnLeft: null });
  }

  /** Activate (stage) engines; fixed-burn solids light at once. */
  activate(filter: (p: LabPlacement) => boolean): void {
    for (const p of this.stack) {
      if (!filter(p)) continue;
      const r = this.rt.get(p.instanceId)!;
      const m = engineModuleOf(this.defs[p.def]);
      if (!m) continue;
      r.active = true;
      if (m.fixedBurn) r.burnLeft = m.fixedBurn.duration;
    }
  }

  shutdown(filter: (p: LabPlacement) => boolean): void {
    for (const p of this.stack) if (filter(p)) this.rt.get(p.instanceId)!.active = false;
  }

  /** Advance by dt with the shared throttle lever (0..1). */
  step(dt: number, lever: number): void {
    if (!(dt > 0)) return;
    for (const p of this.stack) {
      const m = engineModuleOf(this.defs[p.def]);
      if (!m) continue;
      const r = this.rt.get(p.instanceId)!;
      if (r.lit) r.ignitionAge += dt;
      else if (r.shutdownAge >= 0) r.shutdownAge += dt;
      let target = 0;
      if (r.active) {
        if (m.fixedBurn) target = (r.burnLeft ?? 0) > 0 ? 1 : 0;
        else target = labThrottleTarget(m, lever);
      }
      if (target === 0 && r.throttleActual === 0 && !r.lit) continue;
      const tau = target > r.throttleActual ? m.spoolUp : m.spoolDown;
      const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
      let actual = r.throttleActual + (target - r.throttleActual) * k;
      if (!r.lit && actual > IGNITION_THRESHOLD) {
        r.lit = true;
        r.ignitionAge = 0;
        r.shutdownAge = -1;
      }
      if (target === 0 && actual < SHUTDOWN_THRESHOLD) {
        actual = 0;
        if (r.lit) {
          r.lit = false;
          r.shutdownAge = 0;
        }
      }
      r.throttleActual = actual;
      if (m.fixedBurn && r.burnLeft !== null && actual > 0) {
        r.burnLeft = Math.max(0, r.burnLeft - dt);
        if (r.burnLeft === 0) r.active = false;
      }
    }
  }

  /** PartSnapshots of the stack with current module states, at this ambient pressure at the nozzles. */
  parts(ambientPressure: number): PartSnapshot[] {
    return this.stack.map((p) => {
      const def = this.defs[p.def]!;
      const r = this.rt.get(p.instanceId)!;
      const modules: ModuleState[] = def.modules.map((md): ModuleState => {
        if (md.type === 'engine') {
          // As the sim: Isp linear in pressure, mass flow = throttleActual x full mass flow.
          const isp = md.ispVac - (md.ispVac - md.ispSL) * (ambientPressure / 101325);
          const massFlow = (r.throttleActual * md.thrustVac) / (md.ispVac * G0);
          const pExit = (md.nozzles[0]?.exitPressure ?? 0) * r.throttleActual;
          return {
            type: 'engine',
            active: r.active,
            throttleActual: r.throttleActual,
            thrust: Math.max(0, massFlow * G0 * isp),
            massFlow,
            ambientPressure,
            pressureRatio: ambientPressure > 0 ? Math.min(1e6, pExit / ambientPressure) : 1e6,
            gimbal: [0, 0],
            ignitionAge: r.ignitionAge,
            shutdownAge: r.shutdownAge,
            ignitionsLeft: null,
            flameout: false,
          };
        }
        if (md.type === 'rcs') return { type: 'rcs', enabled: true, levels: md.thrusters.map((_, j) => this.rcsLevels[j] ?? 0) };
        return restingState(md);
      });
      return {
        instanceId: p.instanceId,
        def: p.def,
        localPos: { ...p.pos },
        localRot: quat.identity(),
        tempSkin: 290,
        maxTemp: 1500,
        resources: {},
        modules,
        shielded: false,
      };
    });
  }
}
