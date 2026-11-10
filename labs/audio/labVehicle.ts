/**
 * Lab vehicle for the audio lab and the audio unit tests. Until data/defs/vehicles exists the FakeSim has
 * no engines, so this module supplies engine part DEFINITIONS that mirror the stage table of
 * docs/research/sim-design.md 13.1 (thrust, Isp, nozzle exits, sound ids) and synthesises their
 * ModuleState every frame with the sim's documented engine law (spool lag, Isp(p), ignition/shutdown
 * ages). The audio engine reads these parts exactly as it reads real ones: through DefLibrary.parts.
 *
 * Positions are in the VES frame of each lab stack (+Y nose); y = 0 is the engine plane of the lowest
 * stage, so the capsule seat (the cockpit listener) sits at the top of the stack.
 */
import type { DefLibrary, ModuleDef, PartDef } from '@/core/contracts/defs';
import type { ModuleState, PartSnapshot } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { G0 } from '@/core/math/scalar';
import type { Vec3 } from '@/core/math/vec3';

type EngineModuleDef = Extract<ModuleDef, { type: 'engine' }>;

function engineDef(id: string, name: string, m: { thrustVac: number; ispVac: number; ispSL: number; exitDiameter: number; exitPressure: number; minThrottle: number; spoolUp: number; spoolDown: number; sound: string; fixedBurn?: number; radius: number; height: number }): PartDef {
  const module: EngineModuleDef = {
    type: 'engine',
    thrustVac: m.thrustVac,
    ispVac: m.ispVac,
    ispSL: m.ispSL,
    minThrottle: m.minThrottle,
    throttleable: m.fixedBurn === undefined,
    spoolUp: m.spoolUp,
    spoolDown: m.spoolDown,
    maxIgnitions: null,
    propellants: [{ resource: 'lab-propellant', ratio: 1 }],
    nozzles: [{ pos: [0, -m.height, 0], dir: [0, -1, 0], exitDiameter: m.exitDiameter, exitPressure: m.exitPressure }],
    ...(m.fixedBurn !== undefined ? { fixedBurn: { duration: m.fixedBurn } } : {}),
    chamberPressure: 2e7,
    plume: 'lab',
    sound: m.sound,
  };
  return {
    id,
    name,
    category: 'engine',
    dryMass: 1000,
    comOffset: [0, -m.height / 2, 0],
    inertiaShape: { kind: 'solidCylinder', r: m.radius, h: m.height },
    bounds: { radius: m.radius, yMin: -m.height, yMax: 0 },
    attachNodes: [],
    thermal: { surfaces: [] },
    joint: { maxAccelG: 20 },
    modules: [module],
    visual: null,
  };
}

const capsule: PartDef = {
  id: 'lab-capsule',
  name: 'Lab capsule with RCS',
  category: 'command',
  dryMass: 5000,
  comOffset: [0, 1.2, 0],
  inertiaShape: { kind: 'cone', r: 2, h: 3.3 },
  bounds: { radius: 2, yMin: 0, yMax: 3.3 },
  attachNodes: [],
  thermal: { surfaces: [] },
  joint: { maxAccelG: 20 },
  modules: [
    { type: 'command', crewCapacity: 3, sas: true, maxRateDegPerS: 10, seats: [{ id: 'cdr', pos: [0, 1.4, 0.4], lookDir: [0, 1, 0], upDir: [0, 0, 1] }] },
    {
      type: 'rcs',
      isp: 290,
      resource: 'lab-propellant',
      thrusters: Array.from({ length: 12 }, (_, i) => {
        const a = (i / 12) * 2 * Math.PI;
        return { pos: [1.7 * Math.sin(a), 2.2, 1.7 * Math.cos(a)] as [number, number, number], dir: [Math.cos(a), 0, -Math.sin(a)] as [number, number, number], thrust: 220 };
      }),
    },
  ],
  visual: null,
};

/** Engine part definitions (numbers from sim-design.md 13.1) keyed by id. */
export const LAB_PART_DEFS: Record<string, PartDef> = {
  'lab-atlas-9m': engineDef('lab-atlas-9m', 'Atlas-9M (lab)', { thrustVac: 4.174e6, ispVac: 350, ispSL: 327, exitDiameter: 1.9, exitPressure: 70e3, minThrottle: 0.5, spoolUp: 1.2, spoolDown: 0.4, sound: 'engine.methalox-booster', radius: 1.1, height: 3.2 }),
  'lab-vela-2': engineDef('lab-vela-2', 'Vela-2 (lab)', { thrustVac: 1.1e6, ispVac: 445, ispSL: 300, exitDiameter: 2.6, exitPressure: 12e3, minThrottle: 0.6, spoolUp: 0.8, spoolDown: 0.3, sound: 'engine.hydrolox-vacuum', radius: 1.4, height: 4 }),
  'lab-vela-2v': engineDef('lab-vela-2v', 'Vela-2V (lab)', { thrustVac: 1.0e6, ispVac: 452, ispSL: 290, exitDiameter: 2.9, exitPressure: 6e3, minThrottle: 0.6, spoolUp: 0.8, spoolDown: 0.3, sound: 'engine.hydrolox-vacuum', radius: 1.5, height: 4.4 }),
  'lab-lyra-d': engineDef('lab-lyra-d', 'Lyra-D (lab)', { thrustVac: 200e3, ispVac: 360, ispSL: 280, exitDiameter: 1.7, exitPressure: 8e3, minThrottle: 0.1, spoolUp: 0.25, spoolDown: 0.15, sound: 'engine.lander-descent', radius: 0.9, height: 2.2 }),
  'lab-lyra-a': engineDef('lab-lyra-a', 'Lyra-A (lab)', { thrustVac: 60e3, ispVac: 355, ispSL: 270, exitDiameter: 0.9, exitPressure: 10e3, minThrottle: 0.2, spoolUp: 0.25, spoolDown: 0.15, sound: 'engine.lander-ascent', radius: 0.5, height: 1.4 }),
  'lab-les-motor': engineDef('lab-les-motor', 'LES motor (lab)', { thrustVac: 800e3, ispVac: 250, ispSL: 240, exitDiameter: 0.4, exitPressure: 50e3, minThrottle: 1, spoolUp: 0.05, spoolDown: 0.1, sound: 'engine.solid', fixedBurn: 3.5, radius: 0.45, height: 1.0 }),
  'lab-sep-motor': engineDef('lab-sep-motor', 'Separation motor (lab)', { thrustVac: 60e3, ispVac: 240, ispSL: 230, exitDiameter: 0.25, exitPressure: 40e3, minThrottle: 1, spoolUp: 0.05, spoolDown: 0.1, sound: 'engine.solid', fixedBurn: 1.5, radius: 0.15, height: 0.8 }),
  'lab-capsule': capsule,
};

/** The library with the lab parts added (and a lab propellant), leaving every real definition untouched. */
export function withLabParts(lib: DefLibrary): DefLibrary {
  return {
    ...lib,
    parts: { ...lib.parts, ...LAB_PART_DEFS },
    resources: { ...lib.resources, 'lab-propellant': { id: 'lab-propellant', name: 'Lab propellant', density: 1000 } },
  };
}

export interface LabPlacement {
  instanceId: string;
  def: string;
  pos: Vec3;
}

export type LabStackId = 'booster' | 'upper' | 'tli' | 'lander' | 'ascent' | 'capsule';

/** Engine/capsule placements of each lab stack and where the commander's eye is (VES). */
export function labStack(id: LabStackId): { parts: LabPlacement[]; seat: Vec3; boundingRadius: number } {
  const parts: LabPlacement[] = [];
  const add = (instanceId: string, def: string, x: number, y: number, z: number): void => {
    parts.push({ instanceId, def, pos: { x, y, z } });
  };
  let capsuleY = 0;
  switch (id) {
    case 'booster':
      add('atlas-c', 'lab-atlas-9m', 0, 3.2, 0);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 2 * Math.PI;
        add(`atlas-${i + 1}`, 'lab-atlas-9m', 3.3 * Math.sin(a), 3.2, 3.3 * Math.cos(a));
      }
      capsuleY = 94;
      add('les', 'lab-les-motor', 0, capsuleY + 7, 0);
      break;
    case 'upper':
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 2 * Math.PI;
        add(`vela-${i + 1}`, 'lab-vela-2', 2.9 * Math.sin(a), 4, 2.9 * Math.cos(a));
      }
      for (let i = 0; i < 4; i++) {
        const a = ((i + 0.5) / 4) * 2 * Math.PI;
        add(`ullage-${i + 1}`, 'lab-sep-motor', 4.3 * Math.sin(a), 6, 4.3 * Math.cos(a));
      }
      capsuleY = 52;
      break;
    case 'tli':
      add('vela-2v', 'lab-vela-2v', 0, 4.4, 0);
      capsuleY = 21;
      break;
    case 'lander':
      add('lyra-d', 'lab-lyra-d', 0, 2.2, 0);
      capsuleY = 7.2;
      break;
    case 'ascent':
      add('lyra-a', 'lab-lyra-a', 0, 1.4, 0);
      capsuleY = 3.8;
      break;
    case 'capsule':
      capsuleY = 0;
      break;
  }
  add('capsule', 'lab-capsule', 0, capsuleY, 0);
  const top = capsuleY + 3.3;
  return { parts, seat: { x: 0, y: capsuleY + 1.4, z: 0.4 }, boundingRadius: Math.max(5, top / 2 + 5) };
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
  throttleActual: number;
  ignitionAge: number;
  shutdownAge: number;
  burnLeft: number | null;
}

/**
 * Synthesised engine module states for a lab stack: the sim's engine law (sim-design.md 7.1) - effective
 * throttle with minThrottle, first-order spool lag, Isp linear in ambient pressure, ignition when the
 * spooled throttle first exceeds 0.02, shutdown below 0.01, fixed-burn solids that ignore the throttle.
 */
export class LabEngines {
  private readonly rt = new Map<string, EngineRuntime>();
  rcsLevels: number[] = [];

  constructor(
    readonly stack: LabPlacement[],
    private readonly defs: Record<string, PartDef>,
  ) {
    for (const p of stack) this.rt.set(p.instanceId, { active: false, throttleActual: 0, ignitionAge: -1, shutdownAge: -1, burnLeft: null });
  }

  /** Activate (stage) engines; fixed-burn solids light at once. */
  activate(filter: (p: LabPlacement) => boolean): void {
    for (const p of this.stack) {
      if (!filter(p)) continue;
      const r = this.rt.get(p.instanceId)!;
      const m = this.engineModule(p);
      if (!m) continue;
      r.active = true;
      if (m.fixedBurn) r.burnLeft = m.fixedBurn.duration;
    }
  }

  shutdown(filter: (p: LabPlacement) => boolean): void {
    for (const p of this.stack) if (filter(p)) this.rt.get(p.instanceId)!.active = false;
  }

  private engineModule(p: LabPlacement): EngineModuleDef | null {
    const m = this.defs[p.def]?.modules.find((x) => x.type === 'engine');
    return m && m.type === 'engine' ? m : null;
  }

  /** Advance by dt with the shared throttle lever and the ambient pressure at the nozzles. */
  step(dt: number, throttle: number): void {
    for (const p of this.stack) {
      const m = this.engineModule(p);
      if (!m) continue;
      const r = this.rt.get(p.instanceId)!;
      let target = 0;
      if (r.active) {
        if (m.fixedBurn) {
          target = (r.burnLeft ?? 0) > 0 ? 1 : 0;
          if (r.burnLeft !== null) r.burnLeft = Math.max(0, r.burnLeft - dt);
        } else target = throttle <= 0 ? 0 : m.minThrottle + (1 - m.minThrottle) * throttle;
      }
      const tau = target > r.throttleActual ? m.spoolUp : m.spoolDown;
      const before = r.throttleActual;
      r.throttleActual += (target - r.throttleActual) * Math.min(1, dt / Math.max(1e-3, tau));
      if (r.throttleActual < 1e-4 && target === 0) r.throttleActual = 0;
      if (r.ignitionAge >= 0) r.ignitionAge += dt;
      if (r.shutdownAge >= 0) r.shutdownAge += dt;
      const running = r.shutdownAge < 0 && r.ignitionAge >= 0;
      if (before <= 0.02 && r.throttleActual > 0.02 && !running) {
        r.ignitionAge = 0;
        r.shutdownAge = -1;
      } else if (running && r.throttleActual < 0.01) {
        r.shutdownAge = 0;
      }
    }
  }

  /** PartSnapshots of the stack with current module states. */
  parts(ambientPressure: number): PartSnapshot[] {
    return this.stack.map((p) => {
      const def = this.defs[p.def]!;
      const r = this.rt.get(p.instanceId)!;
      const modules: ModuleState[] = def.modules.map((md): ModuleState => {
        if (md.type === 'engine') {
          const running = r.ignitionAge >= 0 && r.shutdownAge < 0;
          const isp = md.ispVac - (md.ispVac - md.ispSL) * Math.min(1, ambientPressure / 101325);
          const massFlow = running ? (r.throttleActual * md.thrustVac) / (md.ispVac * G0) : 0;
          const exit = md.nozzles[0]?.exitPressure ?? 1e4;
          return {
            type: 'engine',
            active: r.active,
            throttleActual: r.throttleActual,
            thrust: Math.max(0, massFlow * G0 * isp),
            massFlow,
            ambientPressure,
            pressureRatio: Math.min(1e6, exit / Math.max(ambientPressure, 1e-3)),
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
