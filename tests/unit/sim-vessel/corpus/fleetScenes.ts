/**
 * The fleet's scenes of the released-build corpus (fleet-data acceptance: "a codec fixture of each new vehicle is
 * added to the released-build corpus, so later definition changes are caught"): every vehicle of the fleet as it
 * stands on the pad, full and held by its clamps, its ports in their launch state; and the two vehicles with a
 * craft that docks, in orbit after their launcher left, a port armed. A blob of each is written by record.ts and
 * pinned in tools/dev/guard-pins.test.ts; a later change to a part's or a vehicle's simulated fields shows as a
 * blob that no longer decodes to its recorded state (or needs a migration).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { assembleVessel, type Vessel } from '@/sim/vessel/public';
import { armPort, portModulesOf } from '@/sim/vessel/modules/dockingPortState';

export const FLEET_PAD_VEHICLES = ['azimuth-pathfinder', 'solstice-kestrel', 'solstice-atoll', 'solstice-pelican', 'meridian-egret', 'meridian-albatross', 'meridian-pelican-heavy'] as const;

/** Scene name -> how the vessel is built. */
export const FLEET_SCENE_NAMES: readonly string[] = [...FLEET_PAD_VEHICLES.map((v) => `fleet-pad-${v}`), 'fleet-orbit-kestrel-lf', 'fleet-orbit-pelican'];

/** A fixed place and motion, so a scene is the same vessel at every build of it. */
function place(v: Vessel): Vessel {
  v.r = { x: 6578137, y: 1234.5, z: -876.25 };
  v.v = { x: 12.5, y: 7784.25, z: 3.125 };
  v.q = quat.normalize({ x: 0.1, y: 0.2, z: 0.3, w: 0.9 });
  v.w = v3.zero();
  return v;
}

export function buildFleetScene(defs: DefLibrary, scene: string): { vessel: Vessel } {
  const pad = FLEET_PAD_VEHICLES.find((v) => scene === `fleet-pad-${v}`);
  if (pad) return { vessel: assembleVessel(defs, pad) };
  if (scene === 'fleet-orbit-kestrel-lf' || scene === 'fleet-orbit-pelican') {
    // The spacecraft alone: launch, stage 1 separation, the jettison and the spacecraft's own separation fired.
    const vehicle = scene === 'fleet-orbit-kestrel-lf' ? 'solstice-kestrel' : 'solstice-pelican';
    const vessel = place(assembleVessel(defs, vehicle, { stagesAlreadyFired: 4 }));
    const i = vessel.parts.findIndex((p) => portModulesOf(p).length > 0);
    armPort(vessel, i, true);
    return { vessel };
  }
  throw new Error(`no fleet scene "${scene}"`);
}
