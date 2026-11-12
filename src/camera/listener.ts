/**
 * AudioListener and LOD observers derived from the presented camera.
 */
import type { AudioListener } from '@/core/contracts/audio';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState, LodObserver } from '@/core/contracts/render';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat } from '@/core/math/quat';
import { v3 } from '@/core/math/vec3';
import { activeVessel, bodyById, vesselComRoot, viewForward, viewUp } from './cameraMath';

/** Vessels closer than this to a surface are LOD observers (terrain under the gear at full detail). */
export const OBSERVER_SURFACE_DISTANCE = 2000;
/** Margin around a vessel's footprint within which the ground counts as under it, m. */
export const OBSERVER_FOOTPRINT_MARGIN = 2;

/**
 * Where a vessel meets the ground, as a LOD observer: the point on the vertical through its centre of mass
 * at the height of its lowest part, with the radius of its footprint about that vertical as the bias (the
 * envelope cylinders of its parts, `PartDef.bounds`, in their attitude: a stack standing on the pad has the
 * footprint of its base, the same stack lying on its side that of its length). The ground within the
 * footprint is then at distance zero, and beyond it the levels fall off as they would for a camera at the
 * vessel's foot. The bounding sphere about the centre of mass that was used before is mostly air for a tall
 * vehicle: 40 m of bias around a 5 m base asked for five times the finest tiles the gear can touch (request
 * app-integration-7). A vessel whose parts have no envelope keeps the bounding sphere.
 */
export function vesselGroundObserver(defs: DefLibrary, v: VesselSnapshot): LodObserver {
  const com = vesselComRoot(v);
  const rl = v3.len(v.r);
  if (!(rl > 0)) return { positionRoot: com, radiusBias: v.boundingRadius };
  const down = v3.scale(v.r, -1 / rl);
  let below = -Infinity;
  let lateral = 0;
  for (const p of v.parts) {
    const b = defs.parts[p.def]?.bounds;
    if (!b) continue;
    const q = quat.mul(v.q, p.localRot);
    const axis = quat.rotate(q, v3.unitY());
    const half = 0.5 * (b.yMax - b.yMin);
    const centre = v3.add(v.rRoot, v3.add(quat.rotate(v.q, p.localPos), v3.scale(axis, 0.5 * (b.yMax + b.yMin))));
    const rel = v3.sub(centre, com);
    const along = v3.dot(rel, down);
    const cos = Math.abs(v3.dot(axis, down));
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    below = Math.max(below, along + half * cos + b.radius * sin);
    lateral = Math.max(lateral, v3.len(v3.addScaled(rel, down, -along)) + half * sin + b.radius * cos);
  }
  if (below === -Infinity) return { positionRoot: com, radiusBias: v.boundingRadius };
  return { positionRoot: v3.addScaled(com, down, Math.max(0, below)), radiusBias: Math.min(v.boundingRadius, lateral + OBSERVER_FOOTPRINT_MARGIN) };
}

/**
 * Static pressure at the camera. The vessel's own ambient pressure is carried to the eye with the isothermal
 * barometric formula over the height difference (scale height R T / g from the body's gas constant and the
 * vessel's air temperature); above the atmosphere's simulation top, or on an airless body, it is 0.
 */
export function pressureAtCamera(defs: DefLibrary, s: SimSnapshot, v: VesselSnapshot, eyeRoot: { x: number; y: number; z: number }): number {
  const body = defs.bodies[v.bodyId];
  const atm = body?.atmosphere;
  if (!body || !atm || v.aero.pressure <= 0) return 0;
  const centre = bodyById(s, v.bodyId).rRoot;
  const hEye = v3.dist(eyeRoot, centre) - body.radius;
  if (hEye > atm.simTop) return 0;
  const hVessel = v3.len(v.r) - body.radius;
  const g = body.mu / v3.lenSq(v.r);
  const T = v.aero.temperature > 1 ? v.aero.temperature : 250;
  const H = (atm.gasConstant * T) / g;
  return v.aero.pressure * Math.exp(-(hEye - hVessel) / H);
}

export function buildAudioListener(defs: DefLibrary, s: SimSnapshot, camera: CameraState): AudioListener {
  const v = activeVessel(s);
  const rel = v3.sub(camera.positionRoot, v.rRoot);
  return {
    mode: camera.mode,
    kind: camera.kind,
    insideVesselId: camera.insideVesselId,
    // Only an external flight rig follows a vessel rigidly; the map orbits its focus from 100 km or more.
    attachedVesselId: camera.kind === 'external' ? camera.focusVesselId : null,
    positionVes: quat.rotateInv(v.q, rel),
    forwardVes: quat.rotateInv(v.q, viewForward(camera.qViewToRoot)),
    upVes: quat.rotateInv(v.q, viewUp(camera.qViewToRoot)),
    ambientPressure: pressureAtCamera(defs, s, v, camera.positionRoot),
  };
}

/**
 * The camera plus every vessel within OBSERVER_SURFACE_DISTANCE of a surface (as `vesselGroundObserver`). The
 * active vessel uses its radar altitude; other vessels the TerrainProvider when given, else their height
 * above the body's datum sphere.
 */
export function buildLodObservers(defs: DefLibrary, s: SimSnapshot, camera: CameraState, terrain?: TerrainProvider): LodObserver[] {
  const out: LodObserver[] = [{ positionRoot: v3.clone(camera.positionRoot), radiusBias: 0 }];
  for (const v of s.vessels) {
    const body = defs.bodies[v.bodyId];
    if (!body) continue;
    let height: number;
    if (v.id === s.activeVesselId) height = s.readouts.altitudeRadar;
    else {
      const r = v3.len(v.r);
      height = r - body.radius;
      if (terrain && body.terrain) {
        const b = bodyById(s, v.bodyId);
        const dirFixed = v3.normalize(quat.rotateInv(b.qFixedToRoot, v.r));
        height = r - body.radius - terrain.heightAt(body.id, dirFixed, 10);
      }
    }
    if (height < OBSERVER_SURFACE_DISTANCE) out.push(vesselGroundObserver(defs, v));
  }
  return out;
}
