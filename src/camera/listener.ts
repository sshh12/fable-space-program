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
    positionVes: quat.rotateInv(v.q, rel),
    forwardVes: quat.rotateInv(v.q, viewForward(camera.qViewToRoot)),
    upVes: quat.rotateInv(v.q, viewUp(camera.qViewToRoot)),
    ambientPressure: pressureAtCamera(defs, s, v, camera.positionRoot),
  };
}

/**
 * The camera plus every vessel within OBSERVER_SURFACE_DISTANCE of a surface. The active vessel uses its radar
 * altitude; other vessels the TerrainProvider when given, else their height above the body's datum sphere.
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
    if (height < OBSERVER_SURFACE_DISTANCE) out.push({ positionRoot: vesselComRoot(v), radiusBias: v.boundingRadius });
  }
  return out;
}
