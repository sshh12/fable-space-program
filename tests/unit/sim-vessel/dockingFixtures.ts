/**
 * Test vehicles with docking ports, built from the library's parts plus one synthetic port part (the fleet's
 * real ports arrive with the fleet data). `ferry`: a crewed capsule with a port on its nose, a separator, a
 * service module and an engine: two stages (engine; jettison of the service module). `hub`: an uncrewed core
 * with a port at each end. `tandem`: one vehicle whose file mates two ports (a capsule docked to a tug).
 */
import type { DefLibrary, PartDef, VehicleDef } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { assembleVessel, partKeyOf, type Vessel } from '@/sim/vessel';

const CHASE = { defaultDistance: 40, minDistance: 5, maxDistance: 500 };

/** The library with the test port and the three test vehicles added. */
export function dockingLibrary(defs: DefLibrary): DefLibrary {
  const separator = defs.parts['heron-stage-separator']!;
  const port: PartDef = {
    ...separator,
    id: 'test-port',
    name: 'Test docking port',
    dryMass: 80,
    bounds: { radius: 0.6, yMin: 0, yMax: 0.4 },
    attachNodes: [
      { id: 'bottom', pos: [0, 0, 0], dir: [0, -1, 0], size: 1 },
      { id: 'dock', pos: [0, 0.4, 0], dir: [0, 1, 0], size: 1, kind: 'dock' },
    ],
    modules: [],
  };
  const ferry: VehicleDef = {
    id: 'test-ferry',
    name: 'Test ferry',
    parts: [
      { id: 'capsule', def: 'kestrel-capsule', parent: null, stageGroup: 'capsule' },
      { id: 'port', def: 'test-port', parent: 'capsule', parentNode: 'top', node: 'bottom', stageGroup: 'capsule' },
      { id: 'sep', def: 'heron-stage-separator', parent: 'capsule', parentNode: 'bottom', node: 'top', stageGroup: 'main' },
      { id: 'tank', def: 'heron-ascent-stage', parent: 'sep', parentNode: 'bottom', node: 'top', stageGroup: 'main' },
      { id: 'engine', def: 'lyra-a', parent: 'tank', parentNode: 'engine', node: 'top', stageGroup: 'main' },
    ],
    stageGroups: [
      { id: 'capsule', label: 'Ferry capsule' },
      { id: 'main', label: 'Ferry service module' },
    ],
    stages: [
      { label: 'Engine', icon: 'engine', actions: [{ kind: 'igniteEngines', parts: ['engine'] }] },
      { label: 'Service module', icon: 'decoupler', actions: [{ kind: 'shutdownEngines', parts: ['engine'] }, { kind: 'decouple', part: 'sep' }] },
    ],
    abort: [],
    actionGroups: {},
    crew: [{ seat: 'cdr', name: 'Test Pilot' }],
    cameras: { cockpit: { part: 'capsule', seat: 'cdr' }, chase: CHASE },
    cockpit: 'kestrel',
  };
  const hub: VehicleDef = {
    id: 'test-hub',
    name: 'Test hub',
    parts: [
      { id: 'core', def: 'heron-ascent-stage', parent: null, stageGroup: 'core' },
      { id: 'port-top', def: 'test-port', parent: 'core', parentNode: 'top', node: 'bottom', stageGroup: 'core' },
      { id: 'port-bottom', def: 'test-port', parent: 'core', parentNode: 'bottom', node: 'bottom', stageGroup: 'core' },
    ],
    stageGroups: [{ id: 'core', label: 'Hub core' }],
    stages: [],
    abort: [],
    actionGroups: {},
    crew: [],
    cameras: { cockpit: { part: 'core', seat: 'none' }, chase: CHASE },
    cockpit: null,
  };
  // A tug whose port is on its flank: off the axis, its face turned 65 degrees from the axis and 20 degrees
  // out of the plane. Docked by it, the pair has no common axis of symmetry.
  const offset: VehicleDef = {
    id: 'test-offset',
    name: 'Test offset tug',
    parts: [
      { id: 'tank', def: 'heron-ascent-stage', parent: null, stageGroup: 'core' },
      { id: 'engine', def: 'lyra-a', parent: 'tank', parentNode: 'engine', node: 'top', stageGroup: 'core' },
      { id: 'side-port', def: 'test-port', parent: 'tank', position: [1.9, -0.7, 0.45], rotationDeg: [20, 0, -65], stageGroup: 'core' },
    ],
    stageGroups: [{ id: 'core', label: 'Offset tug' }],
    stages: [],
    abort: [],
    actionGroups: {},
    crew: [],
    cameras: { cockpit: { part: 'tank', seat: 'none' }, chase: CHASE },
    cockpit: null,
  };
  const tandem: VehicleDef = {
    id: 'test-tandem',
    name: 'Test tandem',
    parts: [
      { id: 'capsule', def: 'kestrel-capsule', parent: null, stageGroup: 'capsule' },
      { id: 'port', def: 'test-port', parent: 'capsule', parentNode: 'top', node: 'bottom', stageGroup: 'capsule' },
      // The tug's port is mated to the capsule's port in the file: dock node to dock node.
      { id: 'tug-port', def: 'test-port', parent: 'port', parentNode: 'dock', node: 'dock', stageGroup: 'tug' },
      { id: 'tug-tank', def: 'heron-ascent-stage', parent: 'tug-port', parentNode: 'bottom', node: 'top', stageGroup: 'tug' },
      { id: 'tug-engine', def: 'lyra-a', parent: 'tug-tank', parentNode: 'engine', node: 'top', stageGroup: 'tug' },
    ],
    stageGroups: [
      { id: 'capsule', label: 'Tandem capsule' },
      { id: 'tug', label: 'Tandem tug' },
    ],
    stages: [
      { label: 'Tug engine', icon: 'engine', actions: [{ kind: 'igniteEngines', parts: ['tug-engine'] }] },
      { label: 'Release the tug', icon: 'decoupler', actions: [{ kind: 'shutdownEngines', parts: ['tug-engine'] }, { kind: 'undock', part: 'tug-port' }] },
    ],
    abort: [],
    actionGroups: {},
    crew: [{ seat: 'cdr', name: 'Test Pilot' }],
    cameras: { cockpit: { part: 'capsule', seat: 'cdr' }, chase: CHASE },
    cockpit: 'kestrel',
  };
  return {
    ...defs,
    parts: { ...defs.parts, [port.id]: port },
    vehicles: { ...defs.vehicles, [ferry.id]: ferry, [hub.id]: hub, [tandem.id]: tandem, [offset.id]: offset },
  };
}

/** A ferry with craft id `craftId`. */
export const ferry = (lib: DefLibrary, craftId: string): Vessel => assembleVessel(lib, 'test-ferry', { craft: { craftId, ownerId: `owner-of-${craftId}`, name: craftId } });
export const offsetTug = (lib: DefLibrary, craftId: string): Vessel => assembleVessel(lib, 'test-offset', { craft: { craftId, name: craftId } });
export const hub = (lib: DefLibrary, craftId: string): Vessel => assembleVessel(lib, 'test-hub', { craft: { craftId, name: craftId } });

export const partIndex = (v: Vessel, key: string): number => v.parts.findIndex((_, i) => partKeyOf(v, i) === key);

/**
 * Place `other` so that the mating face of its part `otherPort` lies on the mating face of `base`'s part
 * `basePort`, faces opposed (each port part's dock node is on its +Y end), rolled by `roll` rad about the port axis.
 */
export function mate(base: Vessel, basePort: number, other: Vessel, otherPort: number, roll = 0): void {
  const pa = base.parts[basePort]!;
  const pb = other.parts[otherPort]!;
  const faceA = v3.add(pa.pos, quat.rotate(pa.rot, { x: 0, y: 0.4, z: 0 }));
  const dirA = quat.rotate(pa.rot, { x: 0, y: 1, z: 0 });
  const dirB = quat.rotate(pb.rot, { x: 0, y: 1, z: 0 });
  // Other's attitude relative to the base: its face direction opposed to the base's.
  const qRel = quat.normalize(quat.mul(quat.fromAxisAngle(dirA, roll), quat.fromTo(dirB, v3.neg(dirA))));
  const faceB = quat.rotate(qRel, v3.add(pb.pos, quat.rotate(pb.rot, { x: 0, y: 0.4, z: 0 })));
  other.q = quat.normalize(quat.mul(base.q, qRel));
  other.r = v3.add(base.r, quat.rotate(base.q, v3.sub(faceA, faceB)));
}

/** World position and attitude of every part, by part key. */
export function partPoses(vessels: readonly Vessel[]): Map<string, { pos: Vec3; x: Vec3; y: Vec3 }> {
  const out = new Map<string, { pos: Vec3; x: Vec3; y: Vec3 }>();
  for (const v of vessels) {
    v.parts.forEach((p, i) => {
      const q = quat.mul(v.q, p.rot);
      out.set(partKeyOf(v, i), { pos: v3.add(v.r, quat.rotate(v.q, p.pos)), x: quat.rotate(q, { x: 1, y: 0, z: 0 }), y: quat.rotate(q, { x: 0, y: 1, z: 0 }) });
    });
  }
  return out;
}
