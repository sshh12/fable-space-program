/**
 * Chase rig (mode 'chase', kind 'external'): orbits the active vessel's centre of mass.
 *
 * Reference frame (the "level" of the camera) follows the navball mode:
 *  - surface: up = local vertical at the vessel, azimuth measured from local north;
 *  - orbit:   the orbit plane: azimuth 0 = along the orbital velocity, up = the in-plane perpendicular to it
 *    (radial-out for a circular orbit), so the camera keeps its place relative to the track around the orbit.
 * When the mode changes, the frame is blended over BLEND_SECONDS with the C-infinity smooth step while the
 * camera angles are re-expressed in the new frame, so the view itself does not swing.
 *
 * Distance: VehicleDef.cameras.chase (default, min, max). Vessels without a vehicle definition (debris of an
 * unknown vehicle, the FakeSim) use multiples of their bounding radius: default 2.4 r, min 1.15 r, max 60 r.
 * The minimum is always kept above 1.05 x the bounding radius.
 *
 * Terrain: with a TerrainProvider the eye stays `clearance` metres above the collision surface (or above the
 * sea where the body has an ocean); without one, above the body's datum sphere (and its sea level).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraInput, CameraState } from '@/core/contracts/render';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { activeVessel, approach, bodyById, bodyDef, enuAt, lookRotation, smoothBlend, vesselComRoot, viewForward, type FlightCameraRig } from './cameraMath';

export interface ChaseRigOptions {
  defs: DefLibrary;
  terrain?: TerrainProvider;
  /** Vertical field of view, rad (55 deg). */
  fovY?: number;
  /** Minimum eye height above the ground, m (2.5). */
  clearance?: number;
  /** Initial elevation of the camera above the reference plane, rad (12 deg). */
  elevation?: number;
}

export const CHASE_FRAME_BLEND_SECONDS = 1.6;
const MAX_ELEVATION = 89 * DEG;

type RefMode = 'surface' | 'orbit';

/** Reference frame -> ROOT. Frame axes: X = azimuth zero, Y = Z x X, Z = up. */
export function chaseReferenceFrame(s: SimSnapshot, v: VesselSnapshot, mode: RefMode): Quat {
  const body = bodyById(s, v.bodyId);
  if (mode === 'surface') {
    const { n, u } = enuAt(v.r, body.qFixedToRoot);
    return quat.fromBasis(n, v3.cross(u, n), u);
  }
  const speed = v3.len(v.v);
  const radial = v3.normalize(v.r);
  if (speed < 1e-3) {
    const { n, u } = enuAt(v.r, body.qFixedToRoot);
    return quat.fromBasis(n, v3.cross(u, n), u);
  }
  const x = v3.scale(v.v, 1 / speed);
  let z = v3.reject(radial, x);
  z = v3.len(z) < 1e-9 ? v3.anyOrthogonal(x) : v3.normalize(z);
  return quat.fromBasis(x, v3.cross(z, x), z);
}

/** Offset direction (from the target to the eye) for azimuth / elevation in a reference frame. */
function offsetDir(frame: Quat, azimuth: number, elevation: number): Vec3 {
  const c = Math.cos(elevation);
  return quat.rotate(frame, { x: c * Math.cos(azimuth), y: c * Math.sin(azimuth), z: Math.sin(elevation) });
}

function anglesOf(frame: Quat, dirRoot: Vec3): { azimuth: number; elevation: number } {
  const d = quat.rotateInv(frame, dirRoot);
  return { azimuth: Math.atan2(d.y, d.x), elevation: Math.asin(Math.max(-1, Math.min(1, d.z))) };
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export function chaseDistanceLimits(defs: DefLibrary, v: VesselSnapshot): { def: number; min: number; max: number } {
  const r = Math.max(0.5, v.boundingRadius);
  const chase = defs.vehicles[v.vehicleId]?.cameras.chase;
  if (chase) {
    const min = Math.max(chase.minDistance, 1.05 * r);
    const max = Math.max(min, chase.maxDistance);
    return { def: clamp(chase.defaultDistance, min, max), min, max };
  }
  return { def: 2.4 * r, min: 1.15 * r, max: 60 * r };
}

export function createChaseRig(opts: ChaseRigOptions): FlightCameraRig & { setOrbit(azimuth: number, elevation: number, distance: number): void; readonly distance: number } {
  const defs = opts.defs;
  const fovY = opts.fovY ?? 55 * DEG;
  const clearance = opts.clearance ?? 2.5;
  const initialElevation = opts.elevation ?? 12 * DEG;

  let initialised = false;
  let vesselId = '';
  let refMode: RefMode = 'surface';
  let azimuth = 0;
  let elevation = initialElevation;
  let distance = 0;
  let distanceTarget = 0;
  // Frame blend: previous mode and the angles the camera had in it, progress 0..1.
  let blend: { from: RefMode; azimuth: number; elevation: number; t: number } | null = null;
  let pendingOrbit: { azimuth: number; elevation: number; distance: number } | null = null;

  const init = (s: SimSnapshot, v: VesselSnapshot, from: CameraState | null): void => {
    vesselId = v.id;
    refMode = s.navball.mode;
    blend = null;
    const lim = chaseDistanceLimits(defs, v);
    distance = distanceTarget = lim.def;
    const frame = chaseReferenceFrame(s, v, refMode);
    let dir: Vec3;
    if (from && from.kind !== 'map') {
      // Start behind the previous view direction so the switch reads as one continuous move.
      dir = v3.neg(viewForward(from.qViewToRoot));
    } else {
      // Behind the nose when it is not vertical, else facing the ventral side; slightly above the plane.
      const nose = quat.rotate(v.q, v3.unitY());
      const up = quat.rotate(frame, v3.unitZ());
      let h = v3.reject(v3.neg(nose), up);
      if (v3.len(h) < 0.2) h = v3.reject(quat.rotate(v.q, v3.new(0, 0, -1)), up);
      if (v3.len(h) < 1e-6) h = quat.rotate(frame, v3.unitX());
      dir = v3.normalize(h);
    }
    const a = anglesOf(frame, dir);
    azimuth = a.azimuth;
    elevation = from && from.kind !== 'map' ? clamp(a.elevation, -MAX_ELEVATION, MAX_ELEVATION) : initialElevation;
    initialised = true;
  };

  const groundRadius = (s: SimSnapshot, v: VesselSnapshot, eyeRoot: Vec3): { centre: Vec3; radius: number } => {
    const body = bodyById(s, v.bodyId);
    const def = bodyDef(defs, v.bodyId);
    let ground = def.radius;
    if (opts.terrain && def.terrain) {
      const rel = v3.sub(eyeRoot, body.rRoot);
      const dirFixed = v3.normalize(quat.rotateInv(body.qFixedToRoot, rel));
      ground = def.radius + opts.terrain.heightAt(def.id, dirFixed, 0.5);
    }
    if (def.ocean) ground = Math.max(ground, def.radius + def.ocean.seaLevel);
    return { centre: body.rRoot, radius: ground };
  };

  return {
    mode: 'chase',
    kind: 'external',
    get distance() {
      return distance;
    },
    isAvailable: (s) => s.vessels.some((x) => x.id === s.activeVesselId),
    setOrbit(az, el, dist) {
      pendingOrbit = { azimuth: az, elevation: el, distance: dist };
    },
    activate(from, s) {
      init(s, activeVessel(s), from);
    },
    update(s: SimSnapshot, input: CameraInput, realDt: number): CameraState {
      const v = activeVessel(s);
      if (!initialised || v.id !== vesselId) init(s, v, null);
      const lim = chaseDistanceLimits(defs, v);

      // Navball-mode change: start a frame blend that keeps the current view direction.
      if (s.navball.mode !== refMode) {
        const oldFrame = chaseReferenceFrame(s, v, refMode);
        const dir = offsetDir(oldFrame, azimuth, elevation);
        const prev = { from: refMode, azimuth, elevation, t: 0 };
        refMode = s.navball.mode;
        const a = anglesOf(chaseReferenceFrame(s, v, refMode), dir);
        azimuth = a.azimuth;
        elevation = a.elevation;
        blend = prev;
      }

      // Player input (grab-the-scene convention: positive yaw turns the view right).
      azimuth -= input.yaw;
      elevation = clamp(elevation - input.pitch, -MAX_ELEVATION, MAX_ELEVATION);
      if (blend) {
        blend.azimuth -= input.yaw;
        blend.elevation = clamp(blend.elevation - input.pitch, -MAX_ELEVATION, MAX_ELEVATION);
      }
      if (input.zoom > 0 && Number.isFinite(input.zoom)) distanceTarget *= input.zoom;
      if (pendingOrbit) {
        azimuth = pendingOrbit.azimuth;
        elevation = clamp(pendingOrbit.elevation, -MAX_ELEVATION, MAX_ELEVATION);
        distanceTarget = distance = pendingOrbit.distance;
        blend = null;
        pendingOrbit = null;
      }
      distanceTarget = clamp(distanceTarget, lim.min, lim.max);
      distance = clamp(Math.exp(Math.log(distance) + (Math.log(distanceTarget) - Math.log(distance)) * approach(realDt, 0.12)), lim.min, lim.max);

      let frame = chaseReferenceFrame(s, v, refMode);
      let dir = offsetDir(frame, azimuth, elevation);
      if (blend) {
        blend.t = Math.min(1, blend.t + Math.max(0, realDt) / CHASE_FRAME_BLEND_SECONDS);
        const k = smoothBlend(blend.t);
        const fromFrame = chaseReferenceFrame(s, v, blend.from);
        const fromDir = offsetDir(fromFrame, blend.azimuth, blend.elevation);
        frame = quat.slerp(fromFrame, frame, k);
        dir = v3.normalize(v3.lerp(fromDir, dir, k));
        if (blend.t >= 1) blend = null;
      }

      const target = vesselComRoot(v);
      let eye = v3.addScaled(target, dir, distance);
      // Never below the ground: lift the eye radially to `clearance` above the surface under it.
      const g = groundRadius(s, v, eye);
      const rel = v3.sub(eye, g.centre);
      const r = v3.len(rel);
      if (r < g.radius + clearance) eye = v3.addScaled(g.centre, rel, (g.radius + clearance) / r);

      const up = quat.rotate(frame, v3.unitZ());
      return {
        mode: 'chase',
        kind: 'external',
        positionRoot: eye,
        qViewToRoot: lookRotation(v3.sub(target, eye), up),
        fovY,
        insideVesselId: null,
        focusVesselId: v.id,
        focusBodyId: v.bodyId,
        exposureCompensation: 0,
        minEv100: null,
        fillLight: 0,
      };
    },
  };
}
