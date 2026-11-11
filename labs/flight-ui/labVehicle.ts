/**
 * Lab-only test vehicle for the flight-ui lab and its tests: the mission stack in six stage groups (M-1, M-2,
 * M-3, the lander's descent and ascent stages, the capsule; labels as in data/defs/vehicles/meridian-lunar.json)
 * with resources, engines, legs, a heat shield and a command part whose seats are the capsule eye points of
 * data/defs/visuals/shared/kestrel-mouldline.json, and the mission's ten stages (labels, icons, action kinds;
 * the engine ignitions point at the lab parts, so the HUD can name what each stage burns; the stage figures are
 * computed from these parts, flightState.ts). It exists so the
 * HUD's per-group resource bars, its stage stack and the cockpit rig can be exercised against the FakeSim; it is
 * never loaded by the app.
 */
import type { CapsuleMouldLineDef, DefLibrary, ModuleDef, PartDef, ResourceDef, TimedStageAction, VehicleDef } from '@/core/contracts/defs';
import type { ModuleState, PartSnapshot, SimSnapshot } from '@/core/contracts/sim';
import { getSection } from '@/core/defs/loader';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';

export const LAB_VEHICLE_ID = 'lab-meridian';

const RESOURCES: ResourceDef[] = [
  { id: 'lab-rp1', name: 'RP-1', density: 810 },
  { id: 'lab-lox', name: 'Liquid oxygen', density: 1141 },
  { id: 'lab-mmh', name: 'MMH', density: 880 },
  { id: 'lab-nto', name: 'NTO', density: 1440 },
  { id: 'lab-ablator', name: 'Ablator', density: 500 },
];

function part(id: string, name: string, category: PartDef['category'], dryMass: number, radius: number, yMin: number, yMax: number, modules: ModuleDef[], resources: { resource: string; capacity: number }[] = []): PartDef {
  return {
    id,
    name,
    category,
    dryMass,
    comOffset: [0, (yMin + yMax) / 2, 0],
    inertiaShape: { kind: 'solidCylinder', r: radius, h: yMax - yMin },
    bounds: { radius, yMin, yMax },
    attachNodes: [
      { id: 'top', pos: [0, yMax, 0], dir: [0, 1, 0], size: radius },
      { id: 'bottom', pos: [0, yMin, 0], dir: [0, -1, 0], size: radius },
    ],
    resources: resources.map((r) => ({ ...r, tankBottomY: yMin, tankHeight: yMax - yMin })),
    thermal: { surfaces: [{ area: 2 * Math.PI * radius * (yMax - yMin), normal: 'axisym', noseRadius: radius, emissivity: 0.85, arealHeatCapacity: 9000, maxTemp: 1400 }] },
    joint: { maxAccelG: 12 },
    modules,
    visual: null,
  };
}

const engine = (thrustVac: number, ispVac: number, ispSL: number, res: [string, string]): ModuleDef => ({
  type: 'engine',
  thrustVac,
  ispVac,
  ispSL,
  minThrottle: 0.4,
  throttleable: true,
  spoolUp: 0.8,
  spoolDown: 0.3,
  maxIgnitions: null,
  propellants: [
    { resource: res[0], ratio: 0.3 },
    { resource: res[1], ratio: 0.7 },
  ],
  nozzles: [{ pos: [0, 0, 0], dir: [0, -1, 0], exitDiameter: 1.2, exitPressure: 60000 }],
  chamberPressure: 1.0e7,
  plume: 'lab',
  sound: 'lab',
});

/**
 * The mission's ten stages (labels, icons and action kinds of meridian-lunar.json) on the lab stack: engine
 * ignitions and shutdowns name the lab's engine parts, so the HUD can name what a stage burns; the tower and the
 * fairing (which the lab stack does not model) point at the part they sit on.
 */
export const LAB_STAGES: { label: string; icon: string; actions: TimedStageAction[] }[] = [
  { label: 'Launch', icon: 'engine', actions: [{ kind: 'igniteEngines', parts: ['m1-engines'] }, { kind: 'releaseClamps', parts: [] }] },
  {
    label: 'M-1 separation',
    icon: 'decoupler',
    actions: [{ kind: 'shutdownEngines', parts: ['m1-engines'] }, { kind: 'fireSeparationMotors', parts: ['m2-tank'] }, { kind: 'decouple', part: 'm2-tank' }, { kind: 'igniteEngines', parts: ['m2-engine'] }],
  },
  { label: 'Tower + fairing jettison', icon: 'fairing', actions: [{ kind: 'fireSeparationMotors', parts: ['capsule'] }, { kind: 'jettisonLES', part: 'capsule' }, { kind: 'jettisonFairing', part: 'descent' }] },
  {
    label: 'M-2 separation',
    icon: 'decoupler',
    actions: [{ kind: 'shutdownEngines', parts: ['m2-engine'] }, { kind: 'enableRcs', parts: ['m3-tank'] }, { kind: 'decouple', part: 'm3-tank' }, { kind: 'igniteEngines', parts: ['m3-engine'] }],
  },
  {
    label: 'M-3 separation',
    icon: 'decoupler',
    actions: [
      { kind: 'shutdownEngines', parts: ['m3-engine'] },
      { kind: 'enableRcs', parts: ['descent', 'ascent'] },
      { kind: 'decouple', part: 'descent' },
      { kind: 'fireSeparationMotors', parts: ['m3-tank'] },
      { kind: 'igniteEngines', parts: ['descent'] },
    ],
  },
  { label: 'Landing gear', icon: 'legs', actions: [{ kind: 'deployLegs', parts: ['descent'] }] },
  { label: 'Lunar lift-off', icon: 'engine', actions: [{ kind: 'shutdownEngines', parts: ['descent'] }, { kind: 'decouple', part: 'ascent' }, { kind: 'igniteEngines', parts: ['ascent'] }] },
  { label: 'Capsule separation', icon: 'decoupler', actions: [{ kind: 'shutdownEngines', parts: ['ascent'] }, { kind: 'decouple', part: 'capsule' }, { kind: 'enableRcs', parts: ['capsule'] }] },
  { label: 'Drogues', icon: 'chute', actions: [{ kind: 'decouple', part: 'capsule' }, { kind: 'deployParachute', parts: ['capsule'], mode: 'drogue' }] },
  { label: 'Mains', icon: 'chute', actions: [{ kind: 'cutParachute', parts: ['capsule'] }, { kind: 'deployParachute', parts: ['capsule'], mode: 'main' }] },
];

/** Adds the lab resources, parts and vehicle to a loaded library (in memory only). */
export function withLabVehicle(defs: DefLibrary): DefLibrary {
  const mould = getSection<CapsuleMouldLineDef>(defs, 'visuals/shared/kestrel-mouldline');
  const parts: PartDef[] = [
    part('lab-m1-tank', 'M-1 tankage', 'tank', 21000, 2.6, 0, 30, [], [
      { resource: 'lab-rp1', capacity: 120000 },
      { resource: 'lab-lox', capacity: 290000 },
    ]),
    part('lab-m1-engines', 'M-1 engine cluster', 'engine', 9000, 2.6, -3, 0, [engine(7.6e6, 311, 282, ['lab-rp1', 'lab-lox'])]),
    part('lab-m2-tank', 'M-2 tankage', 'tank', 4200, 2.6, 0, 12, [], [
      { resource: 'lab-rp1', capacity: 30000 },
      { resource: 'lab-lox', capacity: 72000 },
    ]),
    part('lab-m2-engine', 'M-2 engine', 'engine', 1500, 1.4, -2, 0, [engine(1.0e6, 348, 200, ['lab-rp1', 'lab-lox'])]),
    part('lab-m3-tank', 'M-3 tankage', 'tank', 2600, 2.1, 0, 8, [], [
      { resource: 'lab-rp1', capacity: 12000 },
      { resource: 'lab-lox', capacity: 29000 },
    ]),
    part('lab-m3-engine', 'M-3 engine', 'engine', 900, 1.1, -1.6, 0, [engine(2.4e5, 350, 180, ['lab-rp1', 'lab-lox'])]),
    part('lab-descent', 'Heron descent stage', 'tank', 2600, 2.1, 0, 3.2, [
      engine(8.2e4, 311, 120, ['lab-mmh', 'lab-nto']),
      { type: 'legs', legs: [], deployTime: 2.5 },
    ], [
      { resource: 'lab-mmh', capacity: 5300 },
      { resource: 'lab-nto', capacity: 8700 },
    ]),
    part('lab-ascent', 'Heron ascent stage', 'tank', 1800, 1.6, 0, 2.4, [engine(3.0e4, 311, 120, ['lab-mmh', 'lab-nto'])], [
      { resource: 'lab-mmh', capacity: 2400 },
      { resource: 'lab-nto', capacity: 4100 },
    ]),
    part('lab-capsule', 'Crew capsule', 'command', 5400, 2.0, -0.45, 2.85, [
      { type: 'command', crewCapacity: 3, sas: true, maxRateDegPerS: 10, seats: mould.seats.map((s) => ({ ...s })) },
      { type: 'heatShield', ablatorResource: 'lab-ablator', area: 12.6, qThreshold: 2e5, heff: 3e7, conductFraction: 0.02 },
      { type: 'light', params: {} },
    ], [{ resource: 'lab-ablator', capacity: 900 }]),
  ];
  const vehicle: VehicleDef = {
    id: LAB_VEHICLE_ID,
    name: 'Meridian',
    parts: [
      { id: 'm1-tank', def: 'lab-m1-tank', parent: null, stageGroup: 'booster' },
      { id: 'm1-engines', def: 'lab-m1-engines', parent: 'm1-tank', stageGroup: 'booster' },
      { id: 'm2-tank', def: 'lab-m2-tank', parent: 'm1-tank', stageGroup: 'upper' },
      { id: 'm2-engine', def: 'lab-m2-engine', parent: 'm2-tank', stageGroup: 'upper' },
      { id: 'm3-tank', def: 'lab-m3-tank', parent: 'm2-tank', stageGroup: 'm3' },
      { id: 'm3-engine', def: 'lab-m3-engine', parent: 'm3-tank', stageGroup: 'm3' },
      { id: 'descent', def: 'lab-descent', parent: 'm3-tank', stageGroup: 'descent' },
      { id: 'ascent', def: 'lab-ascent', parent: 'descent', stageGroup: 'ascent' },
      { id: 'capsule', def: 'lab-capsule', parent: 'ascent', stageGroup: 'capsule' },
    ],
    stageGroups: [
      { id: 'booster', label: 'Meridian M-1' },
      { id: 'upper', label: 'Meridian M-2' },
      { id: 'm3', label: 'Meridian M-3' },
      { id: 'descent', label: 'Heron descent stage' },
      { id: 'ascent', label: 'Heron ascent stage' },
      { id: 'capsule', label: 'Kestrel capsule' },
    ],
    stages: LAB_STAGES.map((s) => ({ label: s.label, icon: s.icon, actions: s.actions })),
    abort: [],
    actionGroups: {},
    crew: [{ seat: 'cdr', name: 'Commander' }],
    cameras: { cockpit: { part: 'capsule', seat: 'cdr' }, chase: { defaultDistance: 95, minDistance: 30, maxDistance: 2500 } },
    cockpit: 'lab',
  };
  return {
    ...defs,
    resources: { ...defs.resources, ...Object.fromEntries(RESOURCES.map((r) => [r.id, r])) },
    parts: { ...defs.parts, ...Object.fromEntries(parts.map((p) => [p.id, p])) },
    vehicles: { ...defs.vehicles, [vehicle.id]: vehicle },
  };
}

export type LabGroup = 'booster' | 'upper' | 'm3' | 'descent' | 'ascent' | 'capsule';
export const LAB_GROUPS: readonly LabGroup[] = ['booster', 'upper', 'm3', 'descent', 'ascent', 'capsule'];

/** Base of each part above the bottom of the full stack, m (the part origin sits at its bounds.yMin above it). */
const STACK_BASE: Record<string, number> = { 'm1-engines': 0, 'm1-tank': 3, 'm2-engine': 33, 'm2-tank': 35, 'm3-engine': 47, 'm3-tank': 48.6, descent: 56.6, ascent: 59.8, capsule: 62.2 };

/**
 * Part snapshots of the lab vehicle stacked along +Y for the given stage groups (what remains of the stack
 * after staging), with the bottom of the lowest included part at VES y = 0. `fill` sets the resource level per group.
 */
export function labVehicleParts(defs: DefLibrary, fill: Partial<Record<LabGroup, number>> = {}, groups: readonly LabGroup[] = LAB_GROUPS): PartSnapshot[] {
  const vehicle = defs.vehicles[LAB_VEHICLE_ID]!;
  const included = vehicle.parts.filter((p) => groups.includes(p.stageGroup as LabGroup));
  const base = Math.min(...included.map((p) => STACK_BASE[p.id] ?? 0));
  // The engines of the lowest remaining stage are the ones running (active) in the FakeSim.
  const activeGroup = included.find((p) => defs.parts[p.def]!.modules.some((m) => m.type === 'engine'))?.stageGroup;
  return included.map((placement) => {
    const def = defs.parts[placement.def]!;
    const f = fill[placement.stageGroup as keyof typeof fill] ?? 1;
    const modules: ModuleState[] = def.modules.map((m): ModuleState => {
      switch (m.type) {
        case 'engine':
          return { type: 'engine', active: placement.stageGroup === activeGroup, throttleActual: 0, thrust: 0, massFlow: 0, ambientPressure: 0, pressureRatio: 1, gimbal: [0, 0], ignitionAge: -1, shutdownAge: -1, ignitionsLeft: null, flameout: false };
        case 'command':
          return { type: 'command', crew: 1, crewAlive: true };
        case 'legs':
          return { type: 'legs', deploy: 0, compression: [], broken: [], contact: [] };
        case 'heatShield':
          return { type: 'heatShield', ablatorFraction: f, surfaceTemp: 290 };
        case 'light':
          return { type: 'light', on: false };
        default:
          throw new Error(`lab vehicle: module ${m.type} has no lab state`);
      }
    });
    return {
      instanceId: placement.id,
      def: placement.def,
      localPos: v3.new(0, (STACK_BASE[placement.id] ?? 0) - base - def.bounds.yMin, 0),
      localRot: quat.identity(),
      tempSkin: 290,
      maxTemp: 1400,
      resources: Object.fromEntries((def.resources ?? []).map((r) => [r.resource, r.capacity * f])),
      modules,
      shielded: false,
    };
  });
}

/**
 * The FakeSim reports vehicleId ''; the lab tags its snapshots with the lab vehicle. The FakeSim also reports a
 * heat shield only in its plasma scenes; the lab vehicle always carries one, so its ablator is reported as the
 * sim reports it (readouts.ablatorFraction null only for a vessel without a heat shield) and the MFD entry page
 * agrees with the systems page in every scene.
 */
export function tagLabVehicle(s: SimSnapshot): SimSnapshot {
  const active = s.vessels.find((v) => v.id === s.activeVesselId);
  let ablator = s.readouts.ablatorFraction;
  if (ablator === null && active) {
    for (const p of active.parts) for (const m of p.modules) if (m.type === 'heatShield') ablator = m.ablatorFraction;
  }
  return {
    ...s,
    vessels: s.vessels.map((v) => (v.id === s.activeVesselId ? { ...v, vehicleId: LAB_VEHICLE_ID, name: 'Meridian 1' } : v)),
    readouts: ablator === s.readouts.ablatorFraction ? s.readouts : { ...s.readouts, ablatorFraction: ablator },
  };
}

/** Cylinders (yMin, yMax, radius, dark band 0/1) of the given part snapshots for the lab backdrop. */
export function labCylinders(defs: DefLibrary, parts: PartSnapshot[]): [number, number, number, number][] {
  return parts.map((p) => {
    const d = defs.parts[p.def]!;
    const y = p.localPos.y;
    const dark = d.category === 'engine' || p.def === 'lab-descent' || p.def === 'lab-ascent' ? 1 : 0;
    return [y + d.bounds.yMin, y + d.bounds.yMax, d.category === 'command' ? d.bounds.radius * 0.8 : d.bounds.radius, dark];
  });
}
